// publishPort.js

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const { Duplex } = require('stream');
const DiodeRPC = require('./rpc');
const { makeReadable } = require('./utils');
const logger = require('./logger');

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
  constructor(connection, publishedPorts, _certPath = null) {
    super();
    this.connection = connection;
    this.rpc = new DiodeRPC(connection);
    
    // Convert publishedPorts to a Map with configurations
    this.publishedPorts = new Map();
    
    // Initialize with the provided ports
    if (publishedPorts) {
      this.addPorts(publishedPorts);
    }
    
    this.startListening();
    if (this.publishedPorts.size > 0) {
      logger.info(`Publishing ports: ${Array.from(this.publishedPorts.keys())}`);
    } else {
      logger.info("No ports published initially");
    }
  }

  // Add a single port with configuration
  addPort(port, config = { mode: 'public', whitelist: [] }) {
    const portNum = parseInt(port, 10);
    
    // Normalize the configuration
    const portConfig = {
      mode: config.mode || 'public',
      whitelist: Array.isArray(config.whitelist) ? config.whitelist : []
    };
    
    // Add to map
    this.publishedPorts.set(portNum, portConfig);
    logger.info(`Added published port ${portNum} with mode: ${portConfig.mode}`);
    
    return true;
  }
  
  // Remove a published port
  removePort(port) {
    const portNum = parseInt(port, 10);
    
    if (!this.publishedPorts.has(portNum)) {
      logger.warn(`Port ${portNum} is not published`);
      return false;
    }
    
    // Close any active connections for this port
    // This could require tracking active connections by port
    // For now, let's log about active connections
    const activeConnections = Array.from(this.connection.connections.values())
      .filter(conn => conn.port === portNum);
      
    if (activeConnections.length > 0) {
      logger.warn(`Removing port ${portNum} with ${activeConnections.length} active connections`);
      // We could close these connections, but they'll be rejected naturally on next data transfer
    }
    
    this.publishedPorts.delete(portNum);
    logger.info(`Removed published port ${portNum}`);
    
    return true;
  }
  
  // Add multiple ports at once (from array or object)
  addPorts(ports) {
    if (Array.isArray(ports)) {
      // Legacy array format - treat all ports as public
      ports.forEach(port => {
        this.addPort(port);
      });
    } else if (typeof ports === 'object' && ports !== null) {
      // New object format with configurations
      Object.entries(ports).forEach(([port, config]) => {
        this.addPort(port, config);
      });
    }
    
    return this;
  }
  
  // Get all published ports with their configurations
  getPublishedPorts() {
    return Object.fromEntries(this.publishedPorts.entries());
  }
  
  // Clear all published ports
  clearPorts() {
    const portCount = this.publishedPorts.size;
    this.publishedPorts.clear();
    logger.info(`Cleared ${portCount} published ports`);
    return portCount;
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
        if (messageType != 'data') {
          logger.warn(`Unknown unsolicited message type: ${messageType}`);
        }
      }
    });
  }

  handlePortOpen(sessionIdRaw, messageContent) {
    // messageContent: ['portopen', portString, ref, deviceId]
    const portStringRaw = messageContent[1];
    const refRaw = messageContent[2];
    const deviceIdRaw = messageContent[3];

    const sessionId = Buffer.from(sessionIdRaw);
    const portString = makeReadable(portStringRaw);
    const ref = Buffer.from(refRaw);
    const deviceId = `0x${Buffer.from(deviceIdRaw).toString('hex')}`;

    logger.info(`Received portopen request for portString ${portString} with ref ${ref.toString('hex')} from device ${deviceId}`);

    // Extract protocol and port number from portString
    var protocol = 'tcp';
    var port = 0;
    if (typeof portString == 'number') {
      port = portString;
    } else {
      var [protocol, portStr] = portString.split(':');
      if (!portStr) {
        portStr = protocol;
        protocol = 'tcp';
      }
      port = parseInt(portStr, 10);
    }

    // Check if the port is published
    if (!this.publishedPorts.has(port)) {
      logger.warn(`Port ${port} is not published. Rejecting request.`);
      // Send error response
      this.rpc.sendError(sessionId, ref, 'Port is not published');
      return;
    }

    // Get port configuration and check whitelist if in private mode
    const portConfig = this.publishedPorts.get(port);
    if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
      if (!portConfig.whitelist.includes(deviceId)) {
        logger.warn(`Device ${deviceId} is not whitelisted for port ${port}. Rejecting request.`);
        this.rpc.sendError(sessionId, ref, 'Device not whitelisted');
        return;
      }
      logger.info(`Device ${deviceId} is whitelisted for port ${port}. Accepting request.`);
    }

    // Handle based on protocol
    if (protocol === 'tcp') {
      this.handleTCPConnection(sessionId, ref, port, deviceId);
    } else if (protocol === 'tls') {
      this.handleTLSConnection(sessionId, ref, port, deviceId);
    } else if (protocol === 'udp') {
      this.handleUDPConnection(sessionId, ref, port, deviceId);
    } else {
      logger.warn(`Unsupported protocol: ${protocol}`);
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
        logger.info(`Local service disconnected`);
        // Send portclose message to Diode
        this.rpc.portClose(ref);
        this.connection.deleteConnection(ref);
      });

      localSocket.on('error', (err) => {
        logger.error(`Error with local service: ${err}`);
        // Send portclose message to Diode
        this.rpc.portClose(ref);
        this.connection.deleteConnection(ref);
      });
    }
  }

  handleTCPConnection(sessionId, ref, port, deviceId) {
    // Create a TCP connection to the local service on the specified port
    const localSocket = net.connect({ port: port }, () => {
      logger.info(`Connected to local TCP service on port ${port}`);
      // Send success response
      this.rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Handle data, end, and error events
    this.setupLocalSocketHandlers(localSocket, ref, 'tcp');

    // Store the local socket with the ref using connection's method
    this.connection.addConnection(ref, { socket: localSocket, protocol: 'tcp', port, deviceId });
  }

  handleTLSConnection(sessionId, ref, port, deviceId) {
    // Create a DiodeSocket instance
    const diodeSocket = new DiodeSocket(ref, this.rpc);

    let certPem = this.connection.getDeviceCertificate();

    // TLS options with your server's certificate and key
    const tlsOptions = {
      cert: certPem,
      key: certPem,
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
      logger.info(`Connected to local TCP service on port ${port}`);
      // Send success response
      this.rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Pipe data between the TLS socket and the local service
    tlsSocket.pipe(localSocket).pipe(tlsSocket);

    // Handle errors and cleanup
    tlsSocket.on('error', (err) => {
      logger.error(`TLS Socket error: ${err}`);
      this.rpc.portClose(ref);
      this.connection.deleteConnection(ref);
    });

    tlsSocket.on('close', () => {
      this.connection.deleteConnection(ref);
    });

    // Store the connection info using connection's method
    this.connection.addConnection(ref, {
      diodeSocket,
      tlsSocket,
      localSocket,
      protocol: 'tls',
      port,
      deviceId,
    });
  }

  handleUDPConnection(sessionId, ref, port, deviceId) {
    // Create a UDP socket
    const localSocket = dgram.createSocket('udp4');

    // Store the remote address and port from the Diode client
    const remoteInfo = {port, address: '127.0.0.1'};

    // Send success response
    this.rpc.sendResponse(sessionId, ref, 'ok');

    // Store the connection info using connection's method
    this.connection.addConnection(ref, {
      socket: localSocket,
      protocol: 'udp',
      remoteInfo,
      port,
      deviceId
    });

    logger.info(`UDP connection set up on port ${port}`);

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
      logger.error(`UDP Socket error: ${err}`);
      this.rpc.portClose(ref);
      this.connection.deleteConnection(ref);
    });
  }

  handlePortSend(sessionIdRaw, messageContent) {
    const refRaw = messageContent[1];
    const dataRaw = messageContent[2];

    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);
    const data = Buffer.from(dataRaw)//.slice(4);

    const connectionInfo = this.connection.getConnection(ref);
    // Check if the port is still open and address is still in whitelist
    if (connectionInfo) {
      const { socket: localSocket, protocol, remoteInfo, port, deviceId } = connectionInfo;

      if (!this.publishedPorts.has(port)) {
        logger.warn(`Port ${port} is not published. Sending portclose.`);
        this.rpc.portClose(ref);
        this.connection.deleteConnection(ref);
        return;
      }

      const portConfig = this.publishedPorts.get(port);
      if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
        if (!portConfig.whitelist.includes(deviceId)) {
          logger.warn(`Device ${deviceId} is not whitelisted for port ${port}. Sending portclose.`);
          this.rpc.portClose(ref);
          this.connection.deleteConnection(ref);
          return;
        }
      }

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
      const clientSocket = this.connection.getClientSocket(ref);
      if (clientSocket) {
        logger.debug(`No local connection found for ref: ${ref.toString('hex')}, but client socket exists`);
      } else {
        logger.warn(`No local connection found for ref ${ref.toString('hex')}. Sending portclose.`);
        this.rpc.sendError(sessionId, ref, 'No local connection found');
      }
    }
  }

  handlePortClose(sessionIdRaw, messageContent) {
    const refRaw = messageContent[1];
    const sessionId = Buffer.from(sessionIdRaw);
    const ref = Buffer.from(refRaw);

    logger.info(`Received portclose for ref ${ref.toString('hex')}`);

    const connectionInfo = this.connection.getConnection(ref);
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
      this.connection.deleteConnection(ref);
    }
  }
}

module.exports = PublishPort;
