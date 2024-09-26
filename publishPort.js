// publishPort.js

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const { Duplex } = require('stream');
const DiodeRPC = require('./rpc');

class DiodeSocket extends Duplex {
  constructor(ref, rpc) {
    super();
    this.ref = ref;
    this.rpc = rpc;
  }

  _write(chunk, encoding, callback) {
    // Send data to the Diode client via portSend
    this.rpc.portSend(this.ref, chunk)
      .then(() => callback())
      .catch((err) => callback(err));
  }

  _read(size) {
    // No need to implement this method
  }

  // Method to push data received from Diode client
  pushData(data) {
    this.push(data);
  }
}

class PublishPort extends EventEmitter {
  constructor(connection, publishedPorts, certPath) {
    super();
    this.connection = connection;
    this.publishedPorts = publishedPorts; // Array of ports to publish
    this.connections = new Map(); // Map to store active connections
    this.startListening();
    this.rpc = new DiodeRPC(connection);
    this.certPath = certPath;
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

    const sessionId = Buffer.from(sessionIdRaw);
    const portString = Buffer.from(portStringRaw).toString('utf8');
    const ref = Buffer.from(refRaw);
    const deviceId = Buffer.from(deviceIdRaw).toString('hex');

    console.log(`Received portopen request for portString ${portString} with ref ${ref.toString('hex')} from device ${deviceId}`);

    // Extract protocol and port number from portString
    const [protocol, portStr] = portString.split(':');
    const port = parseInt(portStr, 10);

    // Check if the port is published
    if (!this.publishedPorts.includes(port)) {
      console.warn(`Port ${port} is not published. Rejecting request.`);
      // Send error response
      this.rpc.sendError(sessionId, ref, 'Port is not published');
      return;
    }

    // Handle based on protocol
    if (protocol === 'tcp') {
      this.handleTCPConnection(sessionId, ref, port);
    } else if (protocol === 'tls') {
      this.handleTLSConnection(sessionId, ref, port);
    } else if (protocol === 'udp') {
      this.handleUDPConnection(sessionId, ref, port);
    } else {
      console.warn(`Unsupported protocol: ${protocol}`);
      this.rpc.sendError(sessionId, ref, `Unsupported protocol: ${protocol}`);
    }
  }

  setupLocalSocketHandlers(localSocket, ref, protocol) {
    if (protocol === 'udp') {
      
    } else {
      localSocket.on('data', (data) => {
        // When data is received from the local service, send it back via Diode
        this.rpc.portSend(ref, data);
      });

      localSocket.on('end', () => {
        console.log(`Local service disconnected`);
        // Send portclose message to Diode
        this.rpc.portClose(ref);
        this.connections.delete(ref.toString('hex'));
      });

      localSocket.on('error', (err) => {
        console.error(`Error with local service:`, err);
        // Send portclose message to Diode
        this.rpc.portClose(ref);
        this.connections.delete(ref.toString('hex'));
      });
    }
  }

  handleTCPConnection(sessionId, ref, port) {
    // Create a TCP connection to the local service on the specified port
    const localSocket = net.connect({ port: port }, () => {
      console.log(`Connected to local TCP service on port ${port}`);
      // Send success response
      this.rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Handle data, end, and error events
    this.setupLocalSocketHandlers(localSocket, ref, 'tcp');

    // Store the local socket with the ref
    this.connections.set(ref.toString('hex'), { socket: localSocket, protocol: 'tcp' });
  }

  handleTLSConnection(sessionId, ref, port) {
    // Create a DiodeSocket instance
    const diodeSocket = new DiodeSocket(ref, this.rpc);

    // TLS options with your server's certificate and key
    const tlsOptions = {
      cert: fs.readFileSync(this.certPath),
      key: fs.readFileSync(this.certPath),
      rejectUnauthorized: false,
      ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
      ecdhCurve: 'secp256k1',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };

    // Create a TLS socket in server mode using the DiodeSocket
    const tlsSocket = new tls.TLSSocket(diodeSocket, {
      isServer: true,
      ...tlsOptions,
    });

    // Connect to the local service (TCP or TLS as needed)
    const localSocket = net.connect({ port: port }, () => {
      console.log(`Connected to local TCP service on port ${port}`);
      // Send success response
      this.rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Pipe data between the TLS socket and the local service
    tlsSocket.pipe(localSocket).pipe(tlsSocket);

    // Handle errors and cleanup
    tlsSocket.on('error', (err) => {
      console.error('TLS Socket error:', err);
      this.rpc.portClose(ref);
      this.connections.delete(ref.toString('hex'));
    });

    tlsSocket.on('close', () => {
      console.log('TLS Socket closed');
      this.connections.delete(ref.toString('hex'));
    });

    // Store the connection info
    this.connections.set(ref.toString('hex'), {
      diodeSocket,
      tlsSocket,
      localSocket,
      protocol: 'tls',
    });
  }

  handleUDPConnection(sessionId, ref, port) {
    // Create a UDP socket
    const localSocket = dgram.createSocket('udp4');

    // Store the remote address and port from the Diode client
    const remoteInfo = {port, address: '127.0.0.1'};

    // Send success response
    this.rpc.sendResponse(sessionId, ref, 'ok');

    // Store the connection info
    this.connections.set(ref.toString('hex'), {
      socket: localSocket,
      protocol: 'udp',
      remoteInfo,
    });

    // Handle messages from the local UDP service
    localSocket.on('message', (msg, rinfo) => {
      //need to add 4 bytes of data length to the beginning of the message but it's Big Endian
      const dataLength = Buffer.alloc(4);
      dataLength.writeUInt32LE(msg.length, 0);
      const data = Buffer.concat([dataLength, msg]);
      // Send the data back to the Diode client via portSend
      this.rpc.portSend(ref, data);
    });

    localSocket.on('error', (err) => {
      console.error(`UDP Socket error:`, err);
      this.rpc.portClose(ref);
      this.connections.delete(ref.toString('hex'));
    });
  }

  handlePortSend(sessionIdRaw, messageContent) {
    const refRaw = messageContent[1];
    const dataRaw = messageContent[2];

    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);
    const data = Buffer.from(dataRaw).slice(4);

    const connectionInfo = this.connections.get(ref.toString('hex'));
    if (connectionInfo) {
      const { socket: localSocket, protocol, remoteInfo } = connectionInfo;

      if (protocol === 'udp') {
        // Send data to the local UDP service
        // Since UDP is connectionless, we need to specify the address and port
        localSocket.send(data, remoteInfo.port, remoteInfo.address, (err) => {
          if (err) {
            console.error(`Error sending UDP data:`, err);
          }
        });

        // Update remoteInfo if not set
        if (!localSocket.remoteAddress) {
          localSocket.remoteAddress = '127.0.0.1'; // Assuming local service is on localhost
          localSocket.remotePort = port;
        }
      } else if (protocol === 'tcp') {
        // Write data to the local service
        localSocket.write(data);
      } else if (protocol === 'tls') {
        const { diodeSocket } = connectionInfo;
        // Push data into the DiodeSocket
        diodeSocket.pushData(data);
      }
    } else {
      console.warn(`No local connection found for ref ${ref.toString('hex')}. Sending portclose.`);
      this.rpc.sendError(sessionId, ref, 'No local connection found');
    }
  }

  handlePortClose(sessionIdRaw, messageContent) {
    const refRaw = messageContent[1];
    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);

    console.log(`Received portclose for ref ${ref.toString('hex')}`);

    const connectionInfo = this.connections.get(ref.toString('hex'));
    if (connectionInfo) {
      const { diodeSocket, tlsSocket, socket: localSocket } = connectionInfo;
      // End all sockets
      if (diodeSocket) diodeSocket.end();
      if (tlsSocket) tlsSocket.end();
      if (localSocket) {
        if (localSocket.type === 'udp4' || localSocket.type === 'udp6') {
          localSocket.close();
        } else {
          localSocket.end();
        }
      }
      this.connections.delete(ref.toString('hex'));
    }
  }
}

module.exports = PublishPort;
