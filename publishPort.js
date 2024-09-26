// publishPort.js

const net = require('net');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const { makeReadable } = require('./utils');

class PublishPort extends EventEmitter {
  constructor(connection, publishedPorts) {
    super();
    this.connection = connection;
    this.publishedPorts = publishedPorts; // Array of ports to publish
    this.connections = new Map(); // Map to store active connections
    this.startListening();
  }

  startListening() {
    // Listen for unsolicited messages from the connection
    this.connection.on('unsolicited', (message) => {
      const [sessionIdRaw, messageContent] = message;
      const messageTypeRaw = messageContent[0];
      const messageType = Buffer.from(messageTypeRaw).toString('utf8');

      if (messageType === 'portopen') {
        this.handlePortOpen(sessionIdRaw, messageContent);
      } else if (messageType === 'portsend') {
        this.handlePortSend(sessionIdRaw, messageContent);
      } else if (messageType === 'portclose') {
        this.handlePortClose(sessionIdRaw, messageContent);
      } else {
        console.warn(`Unknown unsolicited message type: ${messageType}`);
      }
    });
  }

  handlePortOpen(sessionIdRaw, messageContent) {
    // messageContent: ['portopen', portString, ref, deviceId]
    const portStringRaw = messageContent[1];
    const refRaw = messageContent[2];
    const deviceIdRaw = messageContent[3];
    console.log('refRaw:', makeReadable(refRaw));
    const sessionId = Buffer.from(sessionIdRaw);
    const portString = Buffer.from(portStringRaw).toString('utf8');
    const ref = Buffer.from(refRaw);
    const deviceId = Buffer.from(deviceIdRaw).toString('hex');

    console.log(`Received portopen request for portString ${portString} with ref ${ref.toString('hex')} from device ${deviceId}`);

    // Extract port number from portString
    const [protocol, portStr] = portString.split(':');
    const port = parseInt(portStr, 10);

    // Check if the port is published
    if (!this.publishedPorts.includes(port)) {
      console.warn(`Port ${port} is not published. Rejecting request.`);
      // Send error response
      this.connection.sendCommandWithSessionId(['response', ref, 'error', 'Port not published'], sessionId);
      return;
    }

    // Create a connection to the local service on the specified port
    const localSocket = net.connect({ port: port }, () => {
      console.log(`Connected to local service on port ${port}`);
      // Send success response
      this.connection.sendCommandWithSessionId(['response', ref, 'ok'], sessionId);
    });

    localSocket.on('data', (data) => {
      // When data is received from the local service, send it back via Diode
      this.connection.sendCommandWithSessionId(['portsend', ref, data], sessionId);
    });

    localSocket.on('end', () => {
      console.log(`Local service on port ${port} disconnected`);
      // Send portclose message to Diode
      // this.connection.sendCommandWithSessionId(['portclose', ref], sessionId);
      // this.connections.delete(ref.toString('hex'));
    });

    localSocket.on('error', (err) => {
      console.error(`Error with local service on port ${port}:`, err);
      // Send portclose message to Diode
      this.connection.sendCommandWithSessionId(['portclose', ref], sessionId);
      this.connections.delete(ref.toString('hex'));
    });

    // Store the local socket with the ref
    this.connections.set(ref.toString('hex'), localSocket);
  }

  handlePortSend(sessionIdRaw, messageContent) {
    // messageContent: ['portsend', ref, data]
    const refRaw = messageContent[1];
    const dataRaw = messageContent[2];

    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);
    const data = Buffer.from(dataRaw);

    const localSocket = this.connections.get(ref.toString('hex'));
    if (localSocket) {
      // Write data to the local service
      localSocket.write(data);
      // Send success response
      // this.connection.sendCommandWithSessionId(['response', 'ok'], sessionId);
    } else {
      console.warn(`No local connection found for ref ${ref.toString('hex')}. Sending portclose.`);
      // Send error response
      this.connection.sendCommandWithSessionId(['response', 'error', 'No local connection found'], sessionId);
    }
  }

  handlePortClose(sessionIdRaw, messageContent) {
    // messageContent: ['portclose', ref]
    const refRaw = messageContent[1];
    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);

    console.log(`Received portclose for ref ${ref.toString('hex')}`);

    const localSocket = this.connections.get(ref.toString('hex'));
    if (localSocket) {
      // Close the local connection
      localSocket.end();
      this.connections.delete(ref.toString('hex'));
    }

    // Send success response
    // this.connection.sendCommandWithSessionId(['response', 'ok'], sessionId);
  }
}

module.exports = PublishPort;
