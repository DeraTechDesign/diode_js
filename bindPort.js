const net = require('net');
const { Buffer } = require('buffer');
const DiodeRPC = require('./rpc');
const logger = require('./logger');

class BindPort {
  constructor(connection, localPortOrPortsConfig, targetPort, deviceIdHex) {
    this.connection = connection;
    
    // Handle legacy constructor (connection, localPort, targetPort, deviceIdHex)
    if (typeof localPortOrPortsConfig === 'number' && targetPort !== undefined && deviceIdHex !== undefined) {
      this.portsConfig = {
        [localPortOrPortsConfig]: { targetPort, deviceIdHex }
      };
    } else {
      // New constructor (connection, portsConfig)
      this.portsConfig = localPortOrPortsConfig || {};
    }
    
    this.servers = new Map(); // Track server instances by localPort
    this.rpc = new DiodeRPC(this.connection);
    
    // Set up listener for unsolicited messages once
    this._setupMessageListener();
  }
  
  _setupMessageListener() {
    // Listen for data events from the device
    this.connection.on('unsolicited', (message) => {
      // message is [messageId, [messageType, ...]]
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
          clientSocket.write(data);
        } else {
          const connectionInfo = this.connection.getConnection(dataRef);
          if (connectionInfo) {
            logger.debug(`No client socket found for ref: ${dataRef.toString('hex')}, but connection exists for ${connectionInfo.host}:${connectionInfo.port}`);
          } else {
            logger.warn(`No client socket found for ref: ${dataRef.toString('hex')}`);
          }
        }
      } else if (messageType === 'portclose') {
        const refRaw = messageContent[1];
        const dataRef = Buffer.from(refRaw);

        // Close the associated client socket
        const clientSocket = this.connection.getClientSocket(dataRef);
        if (clientSocket) {
          clientSocket.end();
          this.connection.deleteClientSocket(dataRef);
          logger.info(`Port closed for ref: ${dataRef.toString('hex')}`);
        }
      } else {
        if (messageType != 'portopen') {
          logger.warn(`Unknown unsolicited message type: ${messageType}`);
        }
      }
    });
    
    // Handle device disconnect
    this.connection.on('end', () => {
      logger.info('Disconnected from Diode.io server');
      this.closeAllServers();
    });

    // Handle connection errors
    this.connection.on('error', (err) => {
      logger.error(`Connection error: ${err}`);
      this.closeAllServers();
    });
  }

  addPort(localPort, targetPort, deviceIdHex) {
    if (this.servers.has(localPort)) {
      logger.warn(`Port ${localPort} is already bound`);
      return false;
    }
    
    this.portsConfig[localPort] = { targetPort, deviceIdHex };
    
    this.bindSinglePort(localPort);
    
    return true;
  }
  
  removePort(localPort) {
    if (!this.portsConfig[localPort]) {
      logger.warn(`Port ${localPort} is not configured`);
      return false;
    }
    
    // Close the server if it's running
    if (this.servers.has(localPort)) {
      const server = this.servers.get(localPort);
      server.close(() => {
        logger.info(`Server on port ${localPort} closed`);
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
      logger.info(`Server on port ${localPort} closed`);
    }
    this.servers.clear();
  }
  
  bindSinglePort(localPort) {
    const config = this.portsConfig[localPort];
    if (!config) {
      logger.error(`No configuration found for port ${localPort}`);
      return false;
    }
    
    const { targetPort, deviceIdHex } = config;
    const deviceId = Buffer.from(deviceIdHex, 'hex');
    
    // Set up local server
    const server = net.createServer(async (clientSocket) => {
      logger.info(`Client connected to local server on port ${localPort}`);

      // Open a new port on the device for this client
      let ref;
      try {
        ref = await this.rpc.portOpen(deviceId, targetPort, 'rw');
        if (!ref) {
          logger.error(`Error opening port ${targetPort} on deviceId: ${deviceIdHex}`);
          clientSocket.destroy();
          return;
        } else {
          logger.info(`Port ${targetPort} opened on device with ref: ${ref.toString('hex')} for client`);
        }
      } catch (error) {
        logger.error(`Error opening port ${targetPort} on device: ${error}`);
        clientSocket.destroy();
        return;
      }

      // Store the client socket with the ref using connection's method
      this.connection.addClientSocket(ref, clientSocket);

      // When data is received from the client, send it to the device
      clientSocket.on('data', async (data) => {
        try {
          await this.rpc.portSend(ref, data);
        } catch (error) {
          logger.error(`Error sending data to device: ${error}`);
          clientSocket.destroy();
        }
      });

      // Handle client socket closure
      clientSocket.on('end', async () => {
        logger.info('Client disconnected');
        if (ref && this.connection.hasClientSocket(ref)) {
          try {
            await this.rpc.portClose(ref);
            logger.info(`Port closed on device for ref: ${ref.toString('hex')}`);
            this.connection.deleteClientSocket(ref);
          } catch (error) {
            logger.error(`Error closing port on device: ${error}`);
          }
        } else {
          logger.warn('Ref is invalid or no longer in clientSockets.');
        }
      });

      // Handle client socket errors
      clientSocket.on('error', (err) => {
        logger.error('Client socket error:', err);
      });
    });

    server.listen(localPort, () => {
      logger.info(`Local server listening on port ${localPort} forwarding to device port ${targetPort}`);
    });
    
    this.servers.set(parseInt(localPort), server);
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