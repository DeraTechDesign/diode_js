const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const { Buffer } = require('buffer');
const { toBufferView } = require('./utils');
const { Duplex } = require('stream');
const DiodeRPC = require('./rpc');
const nativeCrypto = require('./nativeCrypto');
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
          protocol: 'tls', // Default protocol is tls
          transport: 'api'
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
        // Ensure protocol is lowercase
        this.portsConfig[port].protocol = this.portsConfig[port].protocol.toLowerCase();

        // Normalize transport (api or native)
        const transportValue = this.portsConfig[port].transport !== undefined
          ? this.portsConfig[port].transport
          : this.portsConfig[port].native;
        this.portsConfig[port].transport = this._normalizeTransport(transportValue);
      }
    }
    
    this.servers = new Map(); // Track server instances by localPort
    this._rpcByConnection = new Map();
    this.rpc = this._isManager() ? null : this._getRpcFor(this.connection);
    this.handshakeTimeoutMs = parseInt(process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS, 10) || 10000;
    
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

  _normalizeTransport(value) {
    if (value === true) return 'native';
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'native') return 'native';
      if (lower === 'api') return 'api';
    }
    return 'api';
  }

  _isManager() {
    return this.connection && typeof this.connection.getConnectionForDevice === 'function';
  }

  _getRpcFor(connection) {
    if (!connection) return null;
    let rpc = this._rpcByConnection.get(connection);
    if (!rpc) {
      rpc = connection.RPC || new DiodeRPC(connection);
      this._rpcByConnection.set(connection, rpc);
    }
    return rpc;
  }

  async _resolveConnectionForDevice(deviceId) {
    if (this._isManager()) {
      return this.connection.getConnectionForDevice(deviceId);
    }
    return this.connection;
  }

  async _openTlsHandshakeChannel(connection, rpc, ref) {
    const diodeSocket = new DiodeSocket(ref, rpc);
    const certPem = connection.getDeviceCertificate();
    if (!certPem) {
      throw new Error('No device certificate available');
    }

    const tlsOptions = {
      cert: certPem,
      key: certPem,
      rejectUnauthorized: false,
      ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
      ecdhCurve: 'secp256k1',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };

    const tlsSocket = tls.connect({
      socket: diodeSocket,
      ...tlsOptions
    });
    tlsSocket.setNoDelay(true);

    const socketWrapper = {
      diodeSocket,
      tlsSocket,
      end: () => {
        try { tlsSocket.end(); } catch {}
        try { diodeSocket._destroy(null, () => {}); } catch {}
      }
    };

    connection.addClientSocket(ref, socketWrapper);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TLS handshake timeout')), this.handshakeTimeoutMs);
      tlsSocket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      tlsSocket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    return { tlsSocket, socketWrapper };
  }

  async _performNativeHandshake(connection, rpc, deviceId, targetPort, physicalPort) {
    const handshakePort = `tls:${targetPort}#hs`;
    const ref = await rpc.portOpen(deviceId, handshakePort, 'rw');
    if (!ref) {
      throw new Error('Handshake portopen failed');
    }

    let tlsSocket;
    try {
      ({ tlsSocket } = await this._openTlsHandshakeChannel(connection, rpc, ref));

      const localDeviceId = connection.getEthereumAddress().toLowerCase();
      const remoteDeviceId = `0x${Buffer.from(deviceId).toString('hex')}`.toLowerCase();
      const { message, privKey, nonce } = nativeCrypto.createHandshakeMessage({
        role: 'bind',
        deviceId: localDeviceId,
        physicalPort,
        privateKey: connection.getPrivateKey()
      });

      nativeCrypto.writeHandshakeMessage(tlsSocket, message);

      const peerMessage = await nativeCrypto.readHandshakeMessage(tlsSocket, this.handshakeTimeoutMs);
      const verification = nativeCrypto.verifyHandshakeMessage(peerMessage, {
        expectedRole: 'publish',
        expectedDeviceId: remoteDeviceId,
        expectedPhysicalPort: physicalPort
      });
      if (!verification.ok) {
        throw new Error(`Handshake verification failed: ${verification.reason}`);
      }

      const session = nativeCrypto.deriveSessionKeys({
        role: 'bind',
        localDeviceId,
        remoteDeviceId,
        localEphPriv: privKey,
        remoteEphPub: verification.ephPub,
        localNonce: nonce,
        remoteNonce: verification.nonce,
        physicalPort,
      });

      return session;
    } finally {
      try { if (tlsSocket) tlsSocket.end(); } catch {}
      try { await rpc.portClose(ref); } catch {}
      try { connection.deleteClientSocket(ref); } catch {}
    }
  }
  
  _setupMessageListener() {
    // Listen for data events from the device
    this.connection.on('unsolicited', (message, sourceConnection) => {
      const connection = sourceConnection || this.connection;
      if (!connection || typeof connection.getClientSocket !== 'function') {
        logger.warn(() => 'Received unsolicited message without a valid connection context');
        return;
      }
      const [messageIdRaw, messageContent] = message;
      const messageTypeRaw = messageContent[0];
      const messageType = toBufferView(messageTypeRaw).toString('utf8');

      if (messageType === 'data' || messageType === 'portsend') {
        const refRaw = messageContent[1];
        const dataRaw = messageContent[2];

        const dataRef = toBufferView(refRaw);
        const data = toBufferView(dataRaw);

        // Find the associated client socket from connection
        const clientSocket = connection.getClientSocket(dataRef);
        if (clientSocket) {
          if (clientSocket.diodeSocket) {
            // If it's a DiodeSocket, push data to it so tls can process
            clientSocket.diodeSocket.pushData(data);
          } else {
            // Otherwise write directly to the socket
            clientSocket.write(data);
          }
        } else {
          const connectionInfo = connection.getConnection(dataRef);
          if (connectionInfo) {
            logger.debug(() => `No client socket found for ref: ${dataRef.toString('hex')}, but connection exists for ${connectionInfo.host}:${connectionInfo.port}`);
          } else {
            logger.warn(() => `No client socket found for ref: ${dataRef.toString('hex')}`);
          }
        }
      } else if (messageType === 'portclose') {
        const refRaw = messageContent[1];
        const dataRef = toBufferView(refRaw);

        // Close the associated client socket
        const clientSocket = connection.getClientSocket(dataRef);
        if (clientSocket) {
          if (clientSocket.diodeSocket) {
            clientSocket.diodeSocket._destroy(null, () => {});
          }
          clientSocket.end();
          connection.deleteClientSocket(dataRef);
          logger.info(() => `Port closed for ref: ${dataRef.toString('hex')}`);
        }
      } else {
        if (messageType != 'portopen' && messageType != 'portopen2' && messageType != 'ticket_request') {
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

  addPort(localPort, targetPort, deviceIdHex, protocol = 'tls', transport = undefined) {
    if (this.servers.has(localPort)) {
      logger.warn(() => `Port ${localPort} is already bound`);
      return false;
    }
    
    this.portsConfig[localPort] = { 
      targetPort, 
      deviceIdHex: this._stripHexPrefix(deviceIdHex),
      protocol: protocol.toLowerCase(),
      transport: this._normalizeTransport(transport)
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
    const transport = config.transport || 'api';
    const useNative = transport === 'native' && (protocol === 'tcp' || protocol === 'udp');
    if (transport === 'native' && protocol === 'tls') {
      logger.warn(() => `Native transport does not support TLS for port ${localPort}. Falling back to API relay.`);
    }
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
        const clientKey = `${rinfo.address}:${rinfo.port}`;
        if (useNative) {
          if (!server.nativeRelays) server.nativeRelays = {};
          let relayInfo = server.nativeRelays[clientKey];
          if (!relayInfo) {
            let connection;
            try {
              connection = await this._resolveConnectionForDevice(deviceId);
            } catch (error) {
              logger.error(() => `Error resolving relay for device ${deviceIdHex}: ${error}`);
              return;
            }
            if (!connection) {
              logger.error(() => `No relay connection available for device ${deviceIdHex}`);
              return;
            }
            const rpc = this._getRpcFor(connection);
            try {
              const flags = config.flags || 'rwu';
              const physicalPort = await rpc.portOpen2(deviceId, formattedTargetPort, flags);
              if (!physicalPort) {
                logger.error(() => `Error opening portopen2 ${formattedTargetPort} on deviceId: ${deviceIdHex}`);
                return;
              }

              const relaySocket = dgram.createSocket('udp4');
              relaySocket.on('message', (msg) => {
                if (!relayInfo || !relayInfo.session) return;
                const plaintext = nativeCrypto.parseUdpPacket(relayInfo.session, msg);
                if (!plaintext) return;
                server.send(plaintext, rinfo.port, rinfo.address);
              });
              relaySocket.on('error', (err) => {
                logger.error(() => `udp relay socket error: ${err}`);
                try { relaySocket.close(); } catch {}
                delete server.nativeRelays[clientKey];
              });
              relaySocket.bind(0);

              relayInfo = {
                socket: relaySocket,
                physicalPort,
                relayHost: connection.getServerRelayHost(),
                connection,
                session: null,
                handshakePromise: null,
                client: { address: rinfo.address, port: rinfo.port }
              };
              server.nativeRelays[clientKey] = relayInfo;
              logger.info(() => `Portopen2 ${formattedTargetPort} opened with server port ${physicalPort} for udp client ${clientKey}`);
            } catch (error) {
              logger.error(() => `Error opening portopen2 ${formattedTargetPort} on device: ${error}`);
              return;
            }
          }

          if (!relayInfo.handshakePromise) {
            const rpc = this._getRpcFor(relayInfo.connection);
            relayInfo.handshakePromise = this._performNativeHandshake(
              relayInfo.connection,
              rpc,
              deviceId,
              targetPort,
              relayInfo.physicalPort
            ).then((session) => {
              relayInfo.session = session;
              return session;
            }).catch((error) => {
              logger.error(() => `Native UDP handshake failed: ${error}`);
              try { relayInfo.socket.close(); } catch {}
              delete server.nativeRelays[clientKey];
              throw error;
            });
          }

          try {
            await relayInfo.handshakePromise;
          } catch (_) {
            return;
          }

          if (!relayInfo.session) return;

          // Send encrypted data to the server relay port
          try {
            const packet = nativeCrypto.createUdpPacket(relayInfo.session, data);
            relayInfo.socket.send(packet, relayInfo.physicalPort, relayInfo.relayHost);
          } catch (error) {
            logger.error(() => `Error sending udp data to relay: ${error}`);
          }
          return;
        }

        // Legacy API relay
        let entry = server.clientRefs && server.clientRefs[clientKey];
        
        if (!entry) {
          let connection;
          try {
            connection = await this._resolveConnectionForDevice(deviceId);
          } catch (error) {
            logger.error(() => `Error resolving relay for device ${deviceIdHex}: ${error}`);
            return;
          }
          if (!connection) {
            logger.error(() => `No relay connection available for device ${deviceIdHex}`);
            return;
          }
          const rpc = this._getRpcFor(connection);
          try {
            const ref = await rpc.portOpen(deviceId, formattedTargetPort, 'rw');
            if (!ref) {
              logger.error(() => `Error opening port ${formattedTargetPort} on deviceId: ${deviceIdHex}`);
              return;
            } else {
              logger.info(() => `Port ${formattedTargetPort} opened on device with ref: ${ref.toString('hex')} for udp client ${clientKey}`);
              if (!server.clientRefs) server.clientRefs = {};
              entry = { ref, connection };
              server.clientRefs[clientKey] = entry;
              
              // Store the client info
              connection.addClientSocket(ref, {
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
          const rpc = this._getRpcFor(entry.connection);
          await rpc.portSend(entry.ref, data);
        } catch (error) {
          logger.error(() => `Error sending udp data to device: ${error}`);
        }
      });
      
      server.on('error', (err) => {
        logger.error(() => `udp Server error: ${err}`);
      });
      
      server.on('close', () => {
        if (server.nativeRelays) {
          for (const relayInfo of Object.values(server.nativeRelays)) {
            try { relayInfo.socket.close(); } catch {}
          }
          server.nativeRelays = null;
        }
      });

      server.bind(localPort);
      this.servers.set(parseInt(localPort), server);
    } else {
      // For TCP and tls protocols, use TCP server locally
      const server = net.createServer(async (clientSocket) => {
        logger.info(() => `Client connected to local server on port ${localPort}`);
        clientSocket.setNoDelay(true);

        let connection;
        try {
          connection = await this._resolveConnectionForDevice(deviceId);
        } catch (error) {
          logger.error(() => `Error resolving relay for device ${deviceIdHex}: ${error}`);
          clientSocket.destroy();
          return;
        }
        if (!connection) {
          logger.error(() => `No relay connection available for device ${deviceIdHex}`);
          clientSocket.destroy();
          return;
        }
        const rpc = this._getRpcFor(connection);

        let ref;
        if (useNative) {
          // Open a new native relay port on the device for this client
          let physicalPort;
          try {
            const flags = config.flags || 'rw';
            physicalPort = await rpc.portOpen2(deviceId, formattedTargetPort, flags);
            if (!physicalPort) {
              logger.error(() => `Error opening portopen2 ${formattedTargetPort} on deviceId: ${deviceIdHex}`);
              clientSocket.destroy();
              return;
            }
          } catch (error) {
            logger.error(() => `Error opening portopen2 ${formattedTargetPort} on device: ${error}`);
            clientSocket.destroy();
            return;
          }

          let session;
          try {
            session = await this._performNativeHandshake(connection, rpc, deviceId, targetPort, physicalPort);
          } catch (error) {
            logger.error(() => `Native TCP handshake failed: ${error}`);
            clientSocket.destroy();
            return;
          }

          const relayHost = connection.getServerRelayHost();
          const relaySocket = net.connect({ host: relayHost, port: physicalPort }, () => {
            logger.info(() => `Connected to relay ${relayHost}:${physicalPort} for ${formattedTargetPort}`);
          });
          relaySocket.setNoDelay(true);

          let relayReady = false;
          const pendingChunks = [];

          const cleanup = () => {
            if (!clientSocket.destroyed) clientSocket.destroy();
            if (!relaySocket.destroyed) relaySocket.destroy();
          };

          relaySocket.on('connect', () => {
            relayReady = true;
            while (pendingChunks.length > 0) {
              const chunk = pendingChunks.shift();
              try {
                const frame = nativeCrypto.createTcpFrame(session, chunk);
                relaySocket.write(frame);
              } catch (error) {
                logger.error(() => `Error sending TCP frame: ${error}`);
                cleanup();
                break;
              }
            }
          });

          relaySocket.on('data', (data) => {
            try {
              const messages = nativeCrypto.consumeTcpFrames(session, data);
              for (const msg of messages) {
                clientSocket.write(msg);
              }
            } catch (error) {
              logger.error(() => `TCP decrypt error: ${error}`);
              cleanup();
            }
          });

          clientSocket.on('data', (data) => {
            if (!relayReady) {
              pendingChunks.push(data);
              return;
            }
            try {
              const frame = nativeCrypto.createTcpFrame(session, data);
              relaySocket.write(frame);
            } catch (error) {
              logger.error(() => `Error sending TCP frame: ${error}`);
              cleanup();
            }
          });

          relaySocket.on('error', (err) => {
            logger.error(() => `Relay socket error: ${err}`);
            cleanup();
          });
          clientSocket.on('error', (err) => {
            logger.error(() => `Client socket error: ${err}`);
            cleanup();
          });
          clientSocket.on('end', cleanup);
          relaySocket.on('end', cleanup);

          return;
        }

        // Legacy API relay
        try {
          ref = await rpc.portOpen(deviceId, formattedTargetPort, 'rw');
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
            const diodeSocket = new DiodeSocket(ref, rpc);
            
            // Get the device certificate for tls
            const certPem = connection.getDeviceCertificate();
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
            connection.addClientSocket(ref, socketWrapper);
            
          } catch (error) {
            logger.error(() => `Error setting up tls connection: ${error}`);
            clientSocket.destroy();
            return;
          }
        } else {
          // For TCP protocol, just use the raw socket
          connection.addClientSocket(ref, clientSocket);
          
          // Handle data from client to device
          clientSocket.on('data', async (data) => {
            try {
              await rpc.portSend(ref, data);
            } catch (error) {
              logger.error(() => `Error sending data to device: ${error}`);
              clientSocket.destroy();
            }
          });
        }

        // Handle client socket closure (common for all protocols)
        clientSocket.on('end', async () => {
          logger.info(() => 'Client disconnected');
          if (ref && connection.hasClientSocket(ref)) {
            try {
              await rpc.portClose(ref);
              logger.info(() => `Port closed on device for ref: ${ref.toString('hex')}`);
              connection.deleteClientSocket(ref);
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
