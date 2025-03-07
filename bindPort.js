const net = require('net');
const { Buffer } = require('buffer');
const DiodeRPC = require('./rpc');
const logger = require('./logger');

class BindPort {
  constructor(connection, localPort, targetPort,deviceIdHex) {
    this.connection = connection;
    this.localPort = localPort;
    this.targetPort = targetPort;
    this.deviceIdHex = deviceIdHex;
  }

  bind () {
    const deviceId = Buffer.from(this.deviceIdHex, 'hex');
    // Remove local clientSockets map and use the one from connection
    const rpc = new DiodeRPC(this.connection);

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

    // Set up local server
    const server = net.createServer(async (clientSocket) => {
      logger.info('Client connected to local server');

      // Open a new port on the device for this client
      let ref;
      try {
        ref = await rpc.portOpen(deviceId, this.targetPort, 'rw');
        if (!ref) {
          logger.error('Error opening port on device');
          clientSocket.destroy();
          return
        } else {
          logger.info(`Port opened on device with ref: ${ref.toString('hex')} for client`);
        }
      } catch (error) {
        logger.error(`Error opening port on device: ${error}`);
        clientSocket.destroy();
        return;
      }

      // Store the client socket with the ref using connection's method
      this.connection.addClientSocket(ref, clientSocket);

      // When data is received from the client, send it to the device
      clientSocket.on('data', async (data) => {
        try {
          await rpc.portSend(ref, data);
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
            await rpc.portClose(ref);
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

    server.listen(this.localPort, () => {
      logger.info(`Local server listening on port ${this.localPort}`);
    });

    // Handle device disconnect
    this.connection.on('end', () => {
      logger.info('Disconnected from Diode.io server');
      server.close();
    });

    // Handle connection errors
    this.connection.on('error', (err) => {
      logger.error(`Connection error: ${err}`);
      server.close();
    });
  }
}

module.exports = BindPort;