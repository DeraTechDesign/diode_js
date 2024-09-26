const net = require('net');
const { Buffer } = require('buffer');
const DiodeRPC = require('./rpc');

class BindPort {
  constructor(connection, localPort, targetPort,deviceIdHex) {
    this.connection = connection;
    this.localPort = localPort;
    this.targetPort = targetPort;
    this.deviceIdHex = deviceIdHex;
  }

  bind () {
    const deviceId = Buffer.from(this.deviceIdHex, 'hex');
    const clientSockets = new Map();

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

        // Find the associated client socket
        const clientSocket = clientSockets.get(dataRef.toString('hex'));
        if (clientSocket) {
          clientSocket.write(data);
        } else {
          console.warn(`No client socket found for ref: ${dataRef.toString('hex')}`);
        }
      } else if (messageType === 'portclose') {
        const refRaw = messageContent[1];

        const dataRef = Buffer.from(refRaw);

        // Close the associated client socket
        const clientSocket = clientSockets.get(dataRef.toString('hex'));
        if (clientSocket) {
          clientSocket.end();
          clientSockets.delete(dataRef.toString('hex'));
          console.log(`Port closed for ref: ${dataRef.toString('hex')}`);
        }
      } else {
        console.warn(`Unknown unsolicited message type: ${messageType}`);
      }
    });

    // Set up local server
    const server = net.createServer(async (clientSocket) => {
      console.log('Client connected to local server');

      // Open a new port on the device for this client
      let ref;
      try {
        ref = await rpc.portOpen(deviceId, this.targetPort, 'rw');
        console.log(`Port opened on device with ref: ${ref.toString('hex')} for client`);
      } catch (error) {
        console.error('Error opening port on device:', error);
        clientSocket.destroy();
        return;
      }

      // Store the client socket with the ref (using hex string as key)
      clientSockets.set(ref.toString('hex'), clientSocket);

      // When data is received from the client, send it to the device
      clientSocket.on('data', async (data) => {
        try {
          await rpc.portSend(ref, data);
        } catch (error) {
          console.error('Error sending data to device:', error);
          clientSocket.destroy();
        }
      });

      // Handle client socket closure
      clientSocket.on('end', async () => {
        console.log('Client disconnected');
        clientSockets.delete(ref.toString('hex'));
        try {
          console.log(`Port closed on device for ref: ${ref.toString('hex')}`);
        } catch (error) {
          console.error('Error closing port on device:', error);
        }
      });

      // Handle client socket errors
      clientSocket.on('error', (err) => {
        console.error('Client socket error:', err);
      });
    });

    server.listen(this.localPort, () => {
      console.log(`Local server listening on port ${this.localPort}`);
    });

    // Handle device disconnect
    this.connection.on('end', () => {
      console.log('Disconnected from Diode.io server');
      server.close();
    });

    // Handle connection errors
    this.connection.on('error', (err) => {
      console.error('Connection error:', err);
      server.close();
    });
  }
}

module.exports = BindPort;