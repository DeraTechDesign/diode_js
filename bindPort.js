const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const { Buffer } = require('buffer');
const { Duplex } = require('stream');
const DiodeRPC = require('./rpc');
const logger = require('./logger');

// Custom Duplex stream to handle the Diode connection
class DiodeSocket extends Duplex {
  constructor(ref, rpc) {
    super({ readableHighWaterMark: 256 * 1024, writableHighWaterMark: 256 * 1024, allowHalfOpen: false });
    this.ref = ref;
    this.rpc = rpc;
    this.destroyed = false;
  }

  _write(chunk, encoding, callback) {
    // Send data to the remote device via portSend
    this.rpc.portSend(this.ref, chunk)
      .then(() => callback())
      .catch((err) => callback(err));
  }

  _read(size) {
    // No need to implement this method for our use case
  }

  // Method to push data received from the remote device
  pushData(data) {
    if (!this.destroyed) {
      this.push(data);
    }
  }

  _destroy(err, callback) {
    this.destroyed = true;
    this.push(null);
    callback(err);
  }
}

class BindPort {
  constructor(connection, localPortOrPortsConfig, targetPort, deviceIdHex) {
    this.connection = connection;
    
    // Handle legacy constructor (connection, localPort, targetPort, deviceIdHex)
    if (typeof localPortOrPortsConfig === 'number' && targetPort !== undefined && deviceIdHex !== undefined) {
      this.portsConfig = {
        [localPortOrPortsConfig]: { 
          targetPort, 
          deviceIdHex: this._stripHexPrefix(deviceIdHex),
          protocol: 'tls' // Default protocol is tls
        }
      };
    } else {
      // New constructor (connection, portsConfig)
      this.portsConfig = localPortOrPortsConfig || {};
      
      // Strip 0x prefix from all deviceIdHex values in portsConfig
      // And ensure protocol is specified (default to tls)
      for (const port in this.portsConfig) {
        if (this.portsConfig[port].deviceIdHex) {
          this.portsConfig[port].deviceIdHex = this._stripHexPrefix(this.portsConfig[port].deviceIdHex);
        }
        // Set default protocol if not provided
        if (!this.portsConfig[port].protocol) {
          this.portsConfig[port].protocol = 'tls';
        }
        // Ensure protocol is uppercase
        this.portsConfig[port].protocol = this.portsConfig[port].protocol.toLowerCase();
      }
    }
    
    this.servers = new Map(); // Track server instances by localPort
    this.rpc = new DiodeRPC(this.connection);
    
    // Set up listener for unsolicited messages once
    this._setupMessageListener();
  }
  
  // Helper method to strip 0x prefix from hex strings
  _stripHexPrefix(hexString) {
    if (typeof hexString === 'string' && hexString.toLowerCase().startsWith('0x')) {
      return hexString.slice(2);
    }
    return hexString;
  }
  
  _setupMessageListener() {
    // Listen for data events from the device
    this.connection.on('unsolicited', (message) => {
      const [messageIdRaw, messageContent] = message;
      const messageTypeRaw = messageContent[0];
      const messageType = Buffer.from(messageTypeRaw).toString('utf8');

      if (messageType === 'data' || messageType === 'portsend') {
        const refRaw = messageContent[1];
        const dataRaw = messageContent[2];

        const dataRef = Buffer.from(refRaw);
        const data = Buffer.from(dataRaw);

        // Find the associated client socket from connection
        const clientSocket = this.connection.getClientSocket(dataRef);
        if (clientSocket) {
          if (clientSocket.diodeSocket) {
            // If it's a DiodeSocket, push data to it so tls can process
            clientSocket.diodeSocket.pushData(data);
          } else {
            // Otherwise write directly to the socket
            clientSocket.write(data);
          }
        } else {
          const connectionInfo = this.connection.getConnection(dataRef);
          if (connectionInfo) {
            logger.debug(() => `No client socket found for ref: ${dataRef.toString('hex')}, but connection exists for ${connectionInfo.host}:${connectionInfo.port}`);
          } else {
            logger.warn(() => `No client socket found for ref: ${dataRef.toString('hex')}`);
          }
        }
      } else if (messageType === 'portclose') {
        const refRaw = messageContent[1];
        const dataRef = Buffer.from(refRaw);

        // Close the associated client socket
        const clientSocket = this.connection.getClientSocket(dataRef);
        if (clientSocket) {
          if (clientSocket.diodeSocket) {
            clientSocket.diodeSocket._destroy(null, () => {});
          }
          clientSocket.end();
          this.connection.deleteClientSocket(dataRef);
          logger.info(() => `Port closed for ref: ${dataRef.toString('hex')}`);
        }
      } else {
        if (messageType != 'portopen') {
          logger.warn(() => `Unknown unsolicited message type: ${messageType}`);
        }
      }
    });
    
    // Handle device disconnect
    this.connection.on('end', () => {
      logger.info(() => 'Disconnected from Diode.io server');
      this.closeAllServers();
    });

    // Handle connection errors
    this.connection.on('error', (err) => {
      logger.error(() => `Connection error: ${err}`);
      this.closeAllServers();
    });
  }

  addPort(localPort, targetPort, deviceIdHex, protocol = 'tls') {
    if (this.servers.has(localPort)) {
      logger.warn(() => `Port ${localPort} is already bound`);
      return false;
    }
    
    this.portsConfig[localPort] = { 
      targetPort, 
      deviceIdHex: this._stripHexPrefix(deviceIdHex),
      protocol: protocol.toLowerCase()
    };
    
    this.bindSinglePort(localPort);
    
    return true;
  }
  
  removePort(localPort) {
    if (!this.portsConfig[localPort]) {
      logger.warn(() => `Port ${localPort} is not configured`);
      return false;
    }
    
    // Close the server if it's running
    if (this.servers.has(localPort)) {
      const server = this.servers.get(localPort);
      server.close(() => {
        logger.info(() => `Server on port ${localPort} closed`);
      });
      this.servers.delete(localPort);
    }
    
    // Remove from config
    delete this.portsConfig[localPort];
    return true;
  }
  
  closeAllServers() {
    for (const [localPort, server] of this.servers.entries()) {
      server.close();
      logger.info(() => `Server on port ${localPort} closed`);
    }
    this.servers.clear();
  }
  
  bindSinglePort(localPort) {
    const config = this.portsConfig[localPort];
    if (!config) {
      logger.error(() => `No configuration found for port ${localPort}`);
      return false;
    }
    
    const { targetPort, deviceIdHex, protocol = 'tls' } = config;
    const deviceId = Buffer.from(deviceIdHex, 'hex');
    
    // Format the target port with protocol prefix for the remote connection
    const formattedTargetPort = `${protocol}:${targetPort}`;
    logger.info(() => `Binding local port ${localPort} to remote ${formattedTargetPort}`);
    
    // For udp protocol, use udp server
    if (protocol === 'udp') {
      const server = dgram.createSocket('udp4');
      
      server.on('listening', () => {
        logger.info(() => `udp server listening on port ${localPort} forwarding to device port ${targetPort}`);
      });
      
      server.on('message', async (data, rinfo) => {
        // Open a new port on the device if this is a new client
        const clientKey = `${rinfo.address}:${rinfo.port}`;
        let ref = server.clientRefs && server.clientRefs[clientKey];
        
        if (!ref) {
          try {
            ref = await this.rpc.portOpen(deviceId, formattedTargetPort, 'rw');
            if (!ref) {
              logger.error(() => `Error opening port ${formattedTargetPort} on deviceId: ${deviceIdHex}`);
              return;
            } else {
              logger.info(() => `Port ${formattedTargetPort} opened on device with ref: ${ref.toString('hex')} for udp client ${clientKey}`);
              if (!server.clientRefs) server.clientRefs = {};
              server.clientRefs[clientKey] = ref;
              
              // Store the client info
              this.connection.addClientSocket(ref, {
                address: rinfo.address,
                port: rinfo.port,
                protocol: 'udp',
                write: (data) => {
                  server.send(data, rinfo.port, rinfo.address);
                }
              });
            }
          } catch (error) {
            logger.error(() => `Error opening port ${formattedTargetPort} on device: ${error}`);
            return;
          }
        }
        
        // Send data to the device
        try {
          await this.rpc.portSend(ref, data);
        } catch (error) {
          logger.error(() => `Error sending udp data to device: ${error}`);
        }
      });
      
      server.on('error', (err) => {
        logger.error(() => `udp Server error: ${err}`);
      });
      
      server.bind(localPort);
      this.servers.set(parseInt(localPort), server);
    } else {
      // For TCP and tls protocols, use TCP server locally
      const server = net.createServer(async (clientSocket) => {
        logger.info(() => `Client connected to local server on port ${localPort}`);
        clientSocket.setNoDelay(true);

        // Open a new port on the device for this client
        let ref;
        try {
          ref = await this.rpc.portOpen(deviceId, formattedTargetPort, 'rw');
          if (!ref) {
            logger.error(() => `Error opening port ${formattedTargetPort} on deviceId: ${deviceIdHex}`);
            clientSocket.destroy();
            return;
          } else {
            logger.info(() => `Port ${formattedTargetPort} opened on device with ref: ${ref.toString('hex')} for client`);
          }
        } catch (error) {
          logger.error(() => `Error opening port ${formattedTargetPort} on device: ${error}`);
          clientSocket.destroy();
          return;
        }

        if (protocol === 'tls') {
          // For tls protocol, create a proper tls connection
          try {
            // Create a DiodeSocket to handle communication with the device
            const diodeSocket = new DiodeSocket(ref, this.rpc);
            
            // Get the device certificate for tls
            const certPem = this.connection.getDeviceCertificate();
            if (!certPem) {
              throw new Error('No device certificate available');
            }
            
            // Setup tls options for client mode
            const tlsOptions = {
              cert: certPem,
              key: certPem,
              rejectUnauthorized: false,
              ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
              ecdhCurve: 'secp256k1',
              minVersion: 'TLSv1.2',
              maxVersion: 'TLSv1.2',
            };
            
            // Create tls socket as client (not server)
            const tlsSocket = tls.connect({
              socket: diodeSocket,
              ...tlsOptions
            }, () => {
              logger.info(() => `tls connection established to device ${deviceIdHex}`);
            });
            tlsSocket.setNoDelay(true);
            
            // Pipe data between the client socket and the tls socket
            tlsSocket.pipe(clientSocket).pipe(tlsSocket);
            
            // Handle tls socket errors
            tlsSocket.on('error', (err) => {
              logger.error(() => `tls Socket error: ${err}`);
              clientSocket.destroy();
            });
            
            // Store reference to the diodeSocket so we can push data to it
            const socketWrapper = {
              diodeSocket,
              tlsSocket,
              end: () => {
                tlsSocket.end();
                diodeSocket._destroy(null, () => {});
              }
            };
            
            // Store the socket wrapper
            this.connection.addClientSocket(ref, socketWrapper);
            
          } catch (error) {
            logger.error(() => `Error setting up tls connection: ${error}`);
            clientSocket.destroy();
            return;
          }
        } else {
          // For TCP protocol, just use the raw socket
          this.connection.addClientSocket(ref, clientSocket);
          
          // Handle data from client to device
          clientSocket.on('data', async (data) => {
            try {
              await this.rpc.portSend(ref, data);
            } catch (error) {
              logger.error(() => `Error sending data to device: ${error}`);
              clientSocket.destroy();
            }
          });
        }

        // Handle client socket closure (common for all protocols)
        clientSocket.on('end', async () => {
          logger.info(() => 'Client disconnected');
          if (ref && this.connection.hasClientSocket(ref)) {
            try {
              await this.rpc.portClose(ref);
              logger.info(() => `Port closed on device for ref: ${ref.toString('hex')}`);
              this.connection.deleteClientSocket(ref);
            } catch (error) {
              logger.error(() => `Error closing port on device: ${error}`);
            }
          } else {
            logger.warn(() => 'Ref is invalid or no longer in clientSockets.');
          }
        });

        // Handle client socket errors
        clientSocket.on('error', (err) => {
          logger.error(() => `Client socket error: ${err}`);
        });
      });

      server.listen(localPort, () => {
        logger.info(() => `Local server listening on port ${localPort} forwarding to device ${protocol} port ${targetPort}`);
      });
      
      this.servers.set(parseInt(localPort), server);
    }
    
    return true;
  }

  bind() {
    // Close any existing servers first
    this.closeAllServers();
    
    // Create servers for each port in the config
    for (const localPort in this.portsConfig) {
      this.bindSinglePort(parseInt(localPort));
    }
  }
}

module.exports = BindPort;