// publishPort.js

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const { Duplex } = require('stream');
const DiodeRPC = require('./rpc');
const { makeReadable, parseUInt, toBufferView } = require('./utils');
const nativeCrypto = require('./nativeCrypto');
const logger = require('./logger');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');

function normalizeDeviceId(raw) {
  if (!raw) return '';
  let buf = toBufferView(raw);
  if (buf.length === 20) {
    return `0x${buf.toString('hex')}`;
  }
  if (buf.length === 32) {
    return `0x${buf.slice(12).toString('hex')}`;
  }
  if (buf.length === 33 || buf.length === 65) {
    try {
      const uncompressed = buf.length === 33 ? secp256k1.publicKeyConvert(buf, false) : buf;
      const addr = ethUtil.pubToAddress(uncompressed, true);
      return `0x${addr.toString('hex')}`;
    } catch (_) {
      // fallback below
    }
  }
  if (buf.length > 20) {
    return `0x${buf.slice(buf.length - 20).toString('hex')}`;
  }
  return '';
}

function normalizePublishedPortConfig(config = {}) {
  const hasHost = Object.prototype.hasOwnProperty.call(config, 'host');
  const rawHost = hasHost ? config.host : '127.0.0.1';
  if (typeof rawHost !== 'string') {
    throw new TypeError('PublishPort config.host must be a non-empty string');
  }

  const host = rawHost.trim();
  if (!host) {
    throw new TypeError('PublishPort config.host must be a non-empty string');
  }

  return {
    mode: config.mode || 'public',
    whitelist: Array.isArray(config.whitelist) ? config.whitelist : [],
    host,
  };
}

class DiodeSocket extends Duplex {
  constructor(ref, rpc) {
    super({ readableHighWaterMark: 256 * 1024, writableHighWaterMark: 256 * 1024, allowHalfOpen: false });
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
    this._rpcByConnection = new Map();
    this.rpc = this._isManager() ? null : this._getRpcFor(connection);
    this._listening = false; // ensure startListening is idempotent
    this.nativeSessions = new Map();
    this.handshakeTimeoutMs = parseInt(process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS, 10) || 10000;
    
    // Convert publishedPorts to a Map with configurations
    this.publishedPorts = new Map();
    
    // Initialize with the provided ports
    if (publishedPorts) {
      this.addPorts(publishedPorts);
    }
    
    this.startListening();
    if (this.publishedPorts.size > 0) {
      logger.info(() => `Publishing ports: ${Array.from(this.publishedPorts.keys())}`);
    } else {
      logger.info(() => "No ports published initially");
    }
  }

  // Add a single port with configuration
  addPort(port, config = { mode: 'public', whitelist: [] }) {
    const portNum = parseInt(port, 10);
    
    // Normalize the configuration
    const portConfig = normalizePublishedPortConfig(config);
    
    // Add to map
    this.publishedPorts.set(portNum, portConfig);
    logger.info(() => `Added published port ${portNum} with mode: ${portConfig.mode}, host: ${portConfig.host}`);
    
    return true;
  }
  
  // Remove a published port
  removePort(port) {
    const portNum = parseInt(port, 10);
    
    if (!this.publishedPorts.has(portNum)) {
      logger.warn(() => `Port ${portNum} is not published`);
      return false;
    }
    
    // Close any active connections for this port
    // This could require tracking active connections by port
    // For now, let's log about active connections
    let activeConnections = [];
    if (this.connection && typeof this.connection.getConnections === 'function') {
      for (const conn of this.connection.getConnections()) {
        if (conn && conn.connections) {
          activeConnections = activeConnections.concat(
            Array.from(conn.connections.values()).filter(info => info.port === portNum)
          );
        }
      }
    } else if (this.connection && this.connection.connections) {
      activeConnections = Array.from(this.connection.connections.values())
        .filter(conn => conn.port === portNum);
    }
      
    if (activeConnections.length > 0) {
      logger.warn(() => `Removing port ${portNum} with ${activeConnections.length} active connections`);
      // We could close these connections, but they'll be rejected naturally on next data transfer
    }
    
    this.publishedPorts.delete(portNum);
    logger.info(() => `Removed published port ${portNum}`);
    
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
    logger.info(() => `Cleared ${portCount} published ports`);
    return portCount;
  }

  _isManager() {
    return this.connection && typeof this.connection.getConnections === 'function';
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

  _getPublishedPortConfig(port) {
    return this.publishedPorts.get(port);
  }

  startListening() {
    if (this._listening) return this; // idempotent
    // Listen for unsolicited messages from the connection
    this._onUnsolicited = (message, sourceConnection) => {
      const connection = sourceConnection || this.connection;
      if (!connection) {
        logger.warn(() => 'Received unsolicited message without a valid connection context');
        return;
      }
      const [sessionIdRaw, messageContent] = message;
      const messageTypeRaw = messageContent[0];
      const messageType = toBufferView(messageTypeRaw).toString('utf8');

      if (messageType === 'portopen') {
        this.handlePortOpen(sessionIdRaw, messageContent, connection);
      } else if (messageType === 'portopen2') {
        this.handlePortOpen2(sessionIdRaw, messageContent, connection);
      } else if (messageType === 'portclose2') {
        logger.debug(() => 'Received portclose2');
      } else if (messageType === 'portsend' || messageType === 'data') {
        // Accept both synonyms for payload delivery
        this.handlePortSend(sessionIdRaw, messageContent, connection);
      } else if (messageType === 'portclose') {
        this.handlePortClose(sessionIdRaw, messageContent, connection);
      } else {
        if (messageType !== 'ticket_request') {
          logger.warn(() => `Unknown unsolicited message type: ${messageType}`);
        }
      }
    };
    this.connection.on('unsolicited', this._onUnsolicited);
    this._listening = true;
    return this;
  }

  stopListening() {
    if (!this._listening) return this;
    if (this._onUnsolicited) {
      this.connection.off('unsolicited', this._onUnsolicited);
    }
    this._listening = false;
    return this;
  }

  handlePortOpen(sessionIdRaw, messageContent, connection) {
    const rpc = this._getRpcFor(connection);
    // messageContent: ['portopen', portString, ref, deviceId]
    const portStringRaw = messageContent[1];
    const refRaw = messageContent[2];
    const deviceIdRaw = messageContent[3];

    const sessionId = toBufferView(sessionIdRaw);
    const portString = makeReadable(portStringRaw);
    const ref = toBufferView(refRaw);
    const deviceId = normalizeDeviceId(deviceIdRaw);

    logger.info(() => `Received portopen request for portString ${portString} with ref ${ref.toString('hex')} from device ${deviceId}`);

    const isHandshake = typeof portString === 'string' && portString.includes('#hs');

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
      logger.warn(() => `Port ${port} is not published. Rejecting request.`);
      // Send error response
      rpc.sendError(sessionId, ref, 'Port is not published');
      return;
    }

    // Get port configuration and check whitelist if in private mode
    const portConfig = this._getPublishedPortConfig(port);
    if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
      if (!portConfig.whitelist.includes(deviceId)) {
        logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Rejecting request.`);
        rpc.sendError(sessionId, ref, 'Device not whitelisted');
        return;
      }
      logger.info(() => `Device ${deviceId} is whitelisted for port ${port}. Accepting request.`);
    }

    // Handle based on protocol
    if (protocol === 'tcp') {
      this.handleTCPConnection(sessionId, ref, port, deviceId, portConfig, connection);
    } else if (protocol === 'tls') {
      if (isHandshake) {
        this.handleTLSHandshake(sessionId, ref, port, deviceId, connection);
      } else {
        this.handleTLSConnection(sessionId, ref, port, deviceId, portConfig, connection);
      }
    } else if (protocol === 'udp') {
      this.handleUDPConnection(sessionId, ref, port, deviceId, portConfig, connection);
    } else {
      logger.warn(() => `Unsupported protocol: ${protocol}`);
      rpc.sendError(sessionId, ref, `Unsupported protocol: ${protocol}`);
    }
  }

  handleTLSHandshake(sessionId, ref, port, deviceId, connection) {
    const rpc = this._getRpcFor(connection);
    rpc.sendResponse(sessionId, ref, 'ok');

    const diodeSocket = new DiodeSocket(ref, rpc);
    const certPem = connection.getDeviceCertificate();
    if (!certPem) {
      logger.error(() => 'No device certificate available for TLS handshake');
      return;
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

    const tlsSocket = new tls.TLSSocket(diodeSocket, {
      isServer: true,
      ...tlsOptions,
    });
    tlsSocket.setNoDelay(true);

    connection.addConnection(ref, {
      diodeSocket,
      tlsSocket,
      protocol: 'tls',
      port,
      deviceId,
      handshake: true,
    });

    (async () => {
      let session = null;
      try {
        const peerMessage = await nativeCrypto.readHandshakeMessage(tlsSocket, this.handshakeTimeoutMs);
        session = this.nativeSessions.get(Number(peerMessage.physicalPort));
        if (!session) {
          throw new Error(`No native session for physical port ${peerMessage.physicalPort}`);
        }

        const verification = nativeCrypto.verifyHandshakeMessage(peerMessage, {
          expectedRole: 'bind',
          expectedDeviceId: session.deviceId,
          expectedPhysicalPort: session.physicalPort,
        });
        if (!verification.ok) {
          throw new Error(`Handshake verification failed: ${verification.reason}`);
        }

        const localDeviceId = connection.getEthereumAddress().toLowerCase();
        const { message, privKey, nonce } = nativeCrypto.createHandshakeMessage({
          role: 'publish',
          deviceId: localDeviceId,
          physicalPort: session.physicalPort,
          privateKey: connection.getPrivateKey()
        });

        nativeCrypto.writeHandshakeMessage(tlsSocket, message);

        session.session = nativeCrypto.deriveSessionKeys({
          role: 'publish',
          localDeviceId,
          remoteDeviceId: verification.deviceId,
          localEphPriv: privKey,
          remoteEphPub: verification.ephPub,
          localNonce: nonce,
          remoteNonce: verification.nonce,
          physicalPort: session.physicalPort,
        });
        session.ready = true;
        if (session.timer) {
          clearTimeout(session.timer);
          session.timer = null;
        }

        if (session.localSocket && typeof session.localSocket.resume === 'function') {
          session.localSocket.resume();
        }

        if (session.protocol === 'udp' && session.relaySocket && session.session) {
          const probe = nativeCrypto.createUdpPacket(session.session, Buffer.alloc(0));
          session.relaySocket.send(probe);
        }
      } catch (error) {
        logger.error(() => `TLS handshake failed: ${error}`);
        if (session) {
          session.error = error;
        }
      } finally {
        try { tlsSocket.end(); } catch {}
        try { rpc.portClose(ref); } catch {}
        try { connection.deleteConnection(ref); } catch {}
      }
    })();
  }

  handlePortOpen2(sessionIdRaw, messageContent, connection) {
    const rpc = this._getRpcFor(connection);
    // messageContent: ['portopen2', portName, physicalPort, sourceDeviceAddress, flags]
    const portNameRaw = messageContent[1];
    const physicalPortRaw = messageContent[2];
    const sourceDeviceRaw = messageContent[3];
    const flagsRaw = messageContent[4];

    const sessionId = toBufferView(sessionIdRaw);
    const portName = makeReadable(portNameRaw);
    const physicalPort = parseUInt(physicalPortRaw);
    const physicalPortRef = Number.isFinite(physicalPort) ? physicalPort : physicalPortRaw;
    const flags = flagsRaw ? makeReadable(flagsRaw) : '';
    const deviceId = normalizeDeviceId(sourceDeviceRaw);

    logger.info(() => `Received portopen2 request for ${portName} on relay port ${physicalPort} from device ${deviceId}`);

    // Parse port and protocol from portName
    let port = 0;
    let protocolFromName = null;
    if (typeof portName === 'number') {
      port = portName;
    } else if (typeof portName === 'string') {
      const parts = portName.split(':');
      if (parts.length === 2) {
        protocolFromName = parts[0].toLowerCase();
        port = parseInt(parts[1], 10);
      } else {
        port = parseInt(portName, 10);
      }
    }

    if (!Number.isFinite(port) || port <= 0) {
      logger.warn(() => `Invalid port in portopen2: ${portName}`);
      rpc.sendError(sessionId, physicalPortRef, 'Invalid port');
      return;
    }

    // Determine protocol
    let protocol = (typeof flags === 'string' && flags.includes('u')) ? 'udp' : 'tcp';
    if (protocolFromName === 'udp' || protocolFromName === 'tcp') {
      protocol = protocolFromName;
    }

    // Check if the port is published
    if (!this.publishedPorts.has(port)) {
      logger.warn(() => `Port ${port} is not published. Rejecting request.`);
      rpc.sendError(sessionId, physicalPortRef, 'Port is not published');
      return;
    }

    // Get port configuration and check whitelist if in private mode
    const portConfig = this._getPublishedPortConfig(port);
    if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
      if (!portConfig.whitelist.includes(deviceId)) {
        logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Rejecting request.`);
        rpc.sendError(sessionId, physicalPortRef, 'Device not whitelisted');
        return;
      }
      logger.info(() => `Device ${deviceId} is whitelisted for port ${port}. Accepting request.`);
    }

    if (!physicalPort) {
      logger.warn(() => `Invalid physical port in portopen2: ${physicalPortRaw}`);
      rpc.sendError(sessionId, physicalPortRef, 'Invalid physical port');
      return;
    }

    const existing = this.nativeSessions.get(physicalPort);
    if (existing) {
      this._cleanupNativeSession(existing);
    }

    const session = {
      physicalPort,
      port,
      host: portConfig.host,
      protocol,
      deviceId: deviceId.toLowerCase(),
      connection,
      ready: false,
      session: null,
      relaySocket: null,
      localSocket: null,
      timer: null,
    };
    session.timer = setTimeout(() => {
      if (!session.ready) {
        logger.warn(() => `Handshake timeout for native session on physical port ${physicalPort}`);
        this._cleanupNativeSession(session);
      }
    }, Math.max(15000, this.handshakeTimeoutMs * 2));

    this.nativeSessions.set(physicalPort, session);

    if (protocol === 'udp') {
      this.handleNativeUDPRelay(sessionId, physicalPortRef, session, connection);
    } else {
      this.handleNativeTCPRelay(sessionId, physicalPortRef, session, connection);
    }
  }

  _cleanupNativeSession(session) {
    if (!session) return;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.relaySocket) {
      try {
        if (typeof session.relaySocket.close === 'function') {
          session.relaySocket.close();
        } else {
          session.relaySocket.destroy();
        }
      } catch (_) {}
    }
    if (session.localSocket) {
      try {
        if (typeof session.localSocket.close === 'function') {
          session.localSocket.close();
        } else {
          session.localSocket.destroy();
        }
      } catch (_) {}
    }
    this.nativeSessions.delete(session.physicalPort);
  }

  handleNativeTCPRelay(sessionId, physicalPortRef, session, connection) {
    const rpc = this._getRpcFor(connection);
    const { physicalPort, port, host, deviceId } = session;
    let responded = false;
    const sendOk = () => {
      if (responded) return;
      responded = true;
      rpc.sendResponse(sessionId, physicalPortRef, 'ok');
    };
    const sendError = (reason) => {
      if (responded) return;
      responded = true;
      rpc.sendError(sessionId, physicalPortRef, reason);
    };

    const relayHost = connection.getServerRelayHost();
    const relaySocket = net.connect({ host: relayHost, port: physicalPort }, () => {
      relaySocket.setNoDelay(true);
    });
    const localSocket = net.connect({ port, host }, () => {
      localSocket.setNoDelay(true);
    });
    localSocket.pause();

    session.relaySocket = relaySocket;
    session.localSocket = localSocket;

    let relayReady = false;
    let localReady = false;
    const maybeReady = () => {
      if (relayReady && localReady) {
        sendOk();
      }
    };

    relaySocket.on('connect', () => {
      relayReady = true;
      maybeReady();
    });
    localSocket.on('connect', () => {
      localReady = true;
      maybeReady();
    });

    const cleanup = () => {
      if (!relaySocket.destroyed) relaySocket.destroy();
      if (!localSocket.destroyed) localSocket.destroy();
      this._cleanupNativeSession(session);
    };

    relaySocket.on('error', (err) => {
      logger.error(() => `Relay socket error (${deviceId}): ${err}`);
      sendError('Relay connection failed');
      cleanup();
    });
    localSocket.on('error', (err) => {
      logger.error(() => `Local TCP service error (${deviceId}): ${err}`);
      sendError('Local service connection failed');
      cleanup();
    });

    relaySocket.on('end', cleanup);
    localSocket.on('end', cleanup);

    relaySocket.on('data', (data) => {
      if (!session.ready || !session.session) return;
      try {
        const messages = nativeCrypto.consumeTcpFrames(session.session, data);
        for (const msg of messages) {
          localSocket.write(msg);
        }
      } catch (error) {
        logger.error(() => `TCP decrypt error (${deviceId}): ${error}`);
        cleanup();
      }
    });

    localSocket.on('data', (data) => {
      if (!session.ready || !session.session) return;
      try {
        const frame = nativeCrypto.createTcpFrame(session.session, data);
        relaySocket.write(frame);
      } catch (error) {
        logger.error(() => `TCP encrypt error (${deviceId}): ${error}`);
        cleanup();
      }
    });
  }

  handleNativeUDPRelay(sessionId, physicalPortRef, session, connection) {
    const rpc = this._getRpcFor(connection);
    const { physicalPort, port, host, deviceId } = session;
    let responded = false;
    const sendOk = () => {
      if (responded) return;
      responded = true;
      rpc.sendResponse(sessionId, physicalPortRef, 'ok');
    };
    const sendError = (reason) => {
      if (responded) return;
      responded = true;
      rpc.sendError(sessionId, physicalPortRef, reason);
    };

    const relaySocket = dgram.createSocket('udp4');
    const localSocket = dgram.createSocket('udp4');

    let relayReady = false;
    let localReady = false;
    const maybeReady = () => {
      if (relayReady && localReady) {
        sendOk();
      }
    };

    relaySocket.on('message', (msg) => {
      if (!session.ready || !session.session) return;
      const plaintext = nativeCrypto.parseUdpPacket(session.session, msg);
      if (!plaintext) return;
      localSocket.send(plaintext);
    });
    localSocket.on('message', (msg) => {
      if (!session.ready || !session.session) return;
      const packet = nativeCrypto.createUdpPacket(session.session, msg);
      relaySocket.send(packet);
    });

    relaySocket.on('error', (err) => {
      logger.error(() => `Relay UDP socket error (${deviceId}): ${err}`);
      sendError('Relay UDP error');
      try { relaySocket.close(); } catch {}
      try { localSocket.close(); } catch {}
      this._cleanupNativeSession(session);
    });
    localSocket.on('error', (err) => {
      logger.error(() => `Local UDP service error (${deviceId}): ${err}`);
      sendError('Local UDP error');
      try { relaySocket.close(); } catch {}
      try { localSocket.close(); } catch {}
      this._cleanupNativeSession(session);
    });

    const relayHost = connection.getServerRelayHost();
    relaySocket.connect(physicalPort, relayHost, () => {
      relayReady = true;
      maybeReady();
    });
    localSocket.connect(port, host, () => {
      localReady = true;
      maybeReady();
    });

    session.relaySocket = relaySocket;
    session.localSocket = localSocket;
  }

  setupLocalSocketHandlers(localSocket, ref, protocol, rpc, connection) {
    if (protocol === 'udp') {
      
    } else {
      localSocket.on('data', (data) => {
        // When data is received from the local service, send it back via Diode
        rpc.portSend(ref, data);
      });

      localSocket.on('end', () => {
        logger.info(() => `Local service disconnected`);
        // Send portclose message to Diode
        rpc.portClose(ref);
        connection.deleteConnection(ref);
      });

      localSocket.on('error', (err) => {
        logger.error(() => `Error with local service: ${err}`);
        // Send portclose message to Diode
        rpc.portClose(ref);
        connection.deleteConnection(ref);
      });
    }
  }

  handleTCPConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    // Create a TCP connection to the local service on the specified port
    const localSocket = net.connect({ port, host: portConfig.host }, () => {
      localSocket.setNoDelay(true);
      logger.info(() => `Connected to local TCP service on ${portConfig.host}:${port}`);
      // Send success response
      rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Handle data, end, and error events
    this.setupLocalSocketHandlers(localSocket, ref, 'tcp', rpc, connection);

    // Store the local socket with the ref using connection's method
    connection.addConnection(ref, { socket: localSocket, protocol: 'tcp', port, host: portConfig.host, deviceId });
  }

  handleTLSConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    // Create a DiodeSocket instance
    const diodeSocket = new DiodeSocket(ref, rpc);

    const certPem = connection.getDeviceCertificate();

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
    tlsSocket.setNoDelay(true);
    // Connect to the local service (TCP or TLS as needed)
    const localSocket = net.connect({ port, host: portConfig.host }, () => {
      logger.info(() => `Connected to local TCP service on ${portConfig.host}:${port}`);
      // Send success response
      rpc.sendResponse(sessionId, ref, 'ok');
    });

    // Pipe data between the TLS socket and the local service
    tlsSocket.pipe(localSocket).pipe(tlsSocket);

    // Handle errors and cleanup
    tlsSocket.on('error', (err) => {
      logger.error(() => `TLS Socket error: ${err}`);
      rpc.portClose(ref);
      connection.deleteConnection(ref);
    });

    tlsSocket.on('close', () => {
      connection.deleteConnection(ref);
    });

    // Store the connection info using connection's method
    connection.addConnection(ref, {
      diodeSocket,
      tlsSocket,
      localSocket,
      protocol: 'tls',
      port,
      host: portConfig.host,
      deviceId,
    });
  }

  handleUDPConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    // Create a UDP socket
    const localSocket = dgram.createSocket('udp4');

    // Try larger kernel buffers if available
    localSocket.on('listening', () => {
      try {
        localSocket.setRecvBufferSize(1 << 20); // ~1MB
        localSocket.setSendBufferSize(1 << 20);
      } catch (e) {
        logger.debug(() => `UDP buffer sizing not supported: ${e.message}`);
      }
    });

    // Store the remote address and port from the Diode client
    const remoteInfo = { port, address: portConfig.host };

    // Send success response
    rpc.sendResponse(sessionId, ref, 'ok');

    // Store the connection info using connection's method
    connection.addConnection(ref, {
      socket: localSocket,
      protocol: 'udp',
      remoteInfo,
      port,
      host: portConfig.host,
      deviceId
    });

    logger.info(() => `UDP connection set up for ${portConfig.host}:${port}`);

    // Handle messages from the local UDP service
    localSocket.on('message', (msg, rinfo) => {
      rpc.portSend(ref, msg);
    });

    localSocket.on('error', (err) => {
      logger.error(() => `UDP Socket error: ${err}`);
      rpc.portClose(ref);
      connection.deleteConnection(ref);
    });
  }

  handlePortSend(sessionIdRaw, messageContent, connection) {
    const rpc = this._getRpcFor(connection);
    const refRaw = messageContent[1];
    const dataRaw = messageContent[2];

    const sessionId = toBufferView(sessionIdRaw);
    const ref = toBufferView(refRaw);
    const data = toBufferView(dataRaw);//.slice(4);

    const connectionInfo = connection.getConnection(ref);
    // Check if the port is still open and address is still in whitelist
    if (connectionInfo) {
      const { socket: localSocket, protocol, remoteInfo, port, host, deviceId } = connectionInfo;

      if (!this.publishedPorts.has(port)) {
        logger.warn(() => `Port ${port} is not published. Sending portclose.`);
        rpc.portClose(ref);
        connection.deleteConnection(ref);
        return;
      }

      const portConfig = this._getPublishedPortConfig(port);
      if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
        if (!portConfig.whitelist.includes(deviceId)) {
          logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Sending portclose.`);
          rpc.portClose(ref);
          connection.deleteConnection(ref);
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
          localSocket.remoteAddress = host || (remoteInfo && remoteInfo.address) || portConfig.host;
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
      const clientSocket = connection.getClientSocket(ref);
      if (clientSocket) {
        logger.debug(() => `No local connection found for ref: ${ref.toString('hex')}, but client socket exists`);
      } else {
        logger.warn(() => `No local connection found for ref ${ref.toString('hex')}. Sending portclose.`);
        rpc.sendError(sessionId, ref, 'No local connection found');
      }
    }
  }

  handlePortClose(sessionIdRaw, messageContent, connection) {
    const refRaw = messageContent[1];
    const sessionId = toBufferView(sessionIdRaw);
    const ref = toBufferView(refRaw);

    logger.info(() => `Received portclose for ref ${ref.toString('hex')}`);

    const connectionInfo = connection.getConnection(ref);
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
      connection.deleteConnection(ref);
    }
  }
}

module.exports = PublishPort;
