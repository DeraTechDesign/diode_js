// publishPort.js

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const { Buffer } = require('buffer');
const EventEmitter = require('events');
const DiodeSocket = require('./diodeSocket');
const { updateRelayBackpressure, releaseRelayBackpressure } = require('./relayBackpressure');
const DiodeRPC = require('./rpc');
const { makeReadable, parseUInt, toBufferView } = require('./utils');
const nativeCrypto = require('./nativeCrypto');
const { bridgeNativeTcp } = require('./nativeTcpBridge');
const logger = require('./logger');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');

const MAX_NATIVE_QUEUE_BYTES = 1024 * 1024;
const MAX_TIMER_MS = 0x7fffffff;

function normalizeTimerMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_TIMER_MS);
}

function destroySocket(socket, error = undefined) {
  if (!socket) return;
  try {
    if (typeof socket.destroy === 'function') socket.destroy(error);
    else if (typeof socket.close === 'function') socket.close();
    else if (typeof socket.end === 'function') socket.end();
  } catch (_) {}
}

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

function isByteSequence(value, { nonEmpty = false, maxLength = Infinity } = {}) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return false;
  return (!nonEmpty || value.byteLength > 0) && value.byteLength <= maxLength;
}

function decodeMessageType(raw) {
  if (typeof raw === 'string') return raw;
  if (!isByteSequence(raw, { nonEmpty: true })) return null;
  return toBufferView(raw).toString('utf8');
}

function isPortField(value) {
  return (typeof value === 'number' && Number.isInteger(value))
    || (typeof value === 'string' && value.length > 0)
    || isByteSequence(value, { nonEmpty: true });
}

function isUIntField(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (typeof value === 'string') return /^(?:0x[0-9a-f]+|\d+)$/i.test(value);
  return isByteSequence(value, { maxLength: 6 });
}

function validatePublisherUnsolicited(message) {
  if (!Array.isArray(message) || message.length < 2) return { error: 'invalid envelope' };
  if (!isByteSequence(message[0], { nonEmpty: true })) return { error: 'invalid session id' };
  const messageContent = message[1];
  if (!Array.isArray(messageContent) || messageContent.length === 0) {
    return { error: 'invalid message content' };
  }
  const messageType = decodeMessageType(messageContent[0]);
  if (!messageType) return { error: 'invalid message type' };

  let valid = true;
  if (messageType === 'portopen') {
    valid = messageContent.length >= 4
      && isPortField(messageContent[1])
      && isByteSequence(messageContent[2], { nonEmpty: true })
      && isByteSequence(messageContent[3], { nonEmpty: true });
  } else if (messageType === 'portopen2') {
    valid = messageContent.length >= 5
      && isPortField(messageContent[1])
      && isUIntField(messageContent[2])
      && isByteSequence(messageContent[3], { nonEmpty: true })
      && (typeof messageContent[4] === 'string' || isByteSequence(messageContent[4]));
  } else if (messageType === 'portclose2') {
    valid = messageContent.length >= 2 && isUIntField(messageContent[1]);
  } else if (messageType === 'portsend' || messageType === 'data') {
    valid = messageContent.length >= 3
      && isByteSequence(messageContent[1], { nonEmpty: true })
      && isByteSequence(messageContent[2]);
  } else if (messageType === 'portclose') {
    valid = messageContent.length >= 2
      && isByteSequence(messageContent[1], { nonEmpty: true });
  }

  if (!valid) return { error: `invalid ${messageType} payload` };
  return { sessionIdRaw: message[0], messageContent, messageType };
}

function normalizePublishedPort(port) {
  if ((typeof port !== 'number' && typeof port !== 'string')
    || (typeof port === 'string' && port.trim() === '')) {
    throw new TypeError('PublishPort port must be a whole integer from 1 to 65535');
  }
  const normalized = typeof port === 'number' ? port : Number(port.trim());
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
    throw new RangeError('PublishPort port must be a whole integer from 1 to 65535');
  }
  return normalized;
}

function normalizePublishedPortConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('PublishPort config must be an object');
  }
  const hasHost = Object.prototype.hasOwnProperty.call(config, 'host');
  const rawHost = hasHost ? config.host : '127.0.0.1';
  if (typeof rawHost !== 'string') {
    throw new TypeError('PublishPort config.host must be a non-empty string');
  }

  const host = rawHost.trim();
  if (!host) {
    throw new TypeError('PublishPort config.host must be a non-empty string');
  }

  const rawMode = config.mode === undefined ? 'public' : config.mode;
  if (typeof rawMode !== 'string') {
    throw new TypeError('PublishPort config.mode must be public or private');
  }
  const mode = rawMode.trim().toLowerCase();
  if (mode !== 'public' && mode !== 'private') {
    throw new TypeError('PublishPort config.mode must be public or private');
  }

  let whitelist = [];
  if (mode === 'private') {
    const rawWhitelist = config.whitelist === undefined ? [] : config.whitelist;
    if (!Array.isArray(rawWhitelist)) {
      throw new TypeError('PublishPort config.whitelist must be an array');
    }
    whitelist = Array.from(new Set(rawWhitelist.map((address) => {
      if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) {
        throw new TypeError('PublishPort whitelist entries must be 20-byte 0x EVM addresses');
      }
      return address.toLowerCase();
    })));
  }

  return { mode, whitelist, host };
}

class PublishPort extends EventEmitter {
  constructor(connection, publishedPorts, _certPath = null) {
    super();
    this.connection = connection;
    this._rpcByConnection = new WeakMap();
    this._trackedConnectionInfos = new Map();
    this.rpc = this._isManager() ? null : this._getRpcFor(connection);
    this._listening = false; // ensure startListening is idempotent
    this.nativeSessions = new Map();
    this._connectionIds = new WeakMap();
    this._nextConnectionId = 1;
    this.handshakeTimeoutMs = normalizeTimerMs(process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS, 10000);
    this.backendConnectTimeoutMs = normalizeTimerMs(process.env.DIODE_BACKEND_CONNECT_TIMEOUT_MS, 5000);
    this.ioTimeoutMs = normalizeTimerMs(process.env.DIODE_PORT_IO_TIMEOUT_MS, 10000);
    this.nativeQueueLimitBytes = parseInt(process.env.DIODE_NATIVE_QUEUE_LIMIT_BYTES, 10) || MAX_NATIVE_QUEUE_BYTES;
    this._closed = false;
    
    // Convert publishedPorts to a Map with configurations
    this.publishedPorts = new Map();
    
    // Initialize with the provided ports
    if (publishedPorts) {
      this.addPorts(publishedPorts);
    }
    
    this.startListening();
    this._setupConnectionLifecycle();
    if (this.publishedPorts.size > 0) {
      logger.info(() => `Publishing ports: ${Array.from(this.publishedPorts.keys())}`);
    } else {
      logger.info(() => "No ports published initially");
    }
  }

  // Add a single port with configuration
  addPort(port, config = { mode: 'public', whitelist: [] }) {
    const portNum = normalizePublishedPort(port);
    
    // Normalize the configuration
    const portConfig = normalizePublishedPortConfig(config);
    
    // Add to map
    this.publishedPorts.set(portNum, portConfig);
    logger.info(() => `Added published port ${portNum} with mode: ${portConfig.mode}, host: ${portConfig.host}`);
    
    return true;
  }
  
  // Remove a published port
  removePort(port) {
    const portNum = normalizePublishedPort(port);
    
    if (!this.publishedPorts.has(portNum)) {
      logger.warn(() => `Port ${portNum} is not published`);
      return false;
    }
    
    this._cleanupConnections(null, { port: portNum, notifyRemote: true });
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
    this._cleanupConnections(null, { notifyRemote: true });
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

  _connectionKey(connection) {
    if (!connection) return 'unknown';
    if (connection._managerHostKey) return connection._managerHostKey;
    try {
      const serverId = connection.getServerEthereumAddress(true);
      if (serverId) return Buffer.isBuffer(serverId) ? serverId.toString('hex') : String(serverId).toLowerCase();
    } catch (_) {}
    return `${connection.host || 'unknown'}:${connection.port || ''}`;
  }

  _nativeSessionKey(connection, physicalPort) {
    if (connection && !this._connectionIds.has(connection)) {
      this._connectionIds.set(connection, this._nextConnectionId++);
    }
    const connectionId = connection ? this._connectionIds.get(connection) : 'unknown';
    return `${connectionId}:${this._connectionKey(connection)}:${Number(physicalPort)}`;
  }

  _getNativeSession(connection, physicalPort) {
    return this.nativeSessions.get(this._nativeSessionKey(connection, physicalPort));
  }

  _setupConnectionLifecycle() {
    if (!this.connection || typeof this.connection.on !== 'function') return;
    this._onDisconnect = (payload) => {
      const disconnected = payload && payload.connection
        ? payload.connection
        : (payload && payload.socket ? payload : (this._isManager() ? null : this.connection));
      this._cleanupConnections(disconnected, { notifyRemote: false });
    };
    this._onEnd = () => this._onDisconnect(this._isManager() ? null : this.connection);
    this.connection.on('disconnect', this._onDisconnect);
    this.connection.on('end', this._onEnd);
  }

  _connectionList(connection = null) {
    if (connection) return [connection];
    if (this._isManager()) return this.connection.getConnections();
    return this.connection ? [this.connection] : [];
  }

  _cleanupConnectionInfo(connection, ref, info, { notifyRemote = true } = {}) {
    if (!info) return;
    this._trackedConnectionInfos.delete(info);
    if (info._cleaned) return;
    info._cleaned = true;
    releaseRelayBackpressure(info._inboundState);
    const rpc = this._getRpcFor(connection);
    const sockets = new Set([
      info.diodeSocket,
      info.sendSocket,
      info.tlsSocket,
      info.socket,
      info.localSocket,
    ].filter(Boolean));
    for (const socket of sockets) destroySocket(socket);
    let currentInfo;
    let canInspectCurrent = false;
    try {
      if (connection && typeof connection.getConnection === 'function') {
        canInspectCurrent = true;
        currentInfo = connection.getConnection(ref);
      }
    } catch (_) {}
    const refWasReused = canInspectCurrent && currentInfo && currentInfo !== info;
    if (!canInspectCurrent || currentInfo === info) {
      try { connection.deleteConnection(ref); } catch (_) {}
    }
    if (notifyRemote && !info._remoteEnded && !refWasReused && rpc && ref && !info._remoteCloseStarted) {
      info._remoteCloseStarted = true;
      void Promise.resolve(rpc.portClose(ref, { timeoutMs: this.backendConnectTimeoutMs })).catch(() => {});
    }
  }

  _replaceConnectionInfo(connection, ref, info) {
    let existing;
    try { existing = connection.getConnection(ref); } catch (_) {}
    if (existing && existing !== info) {
      this._cleanupConnectionInfo(connection, ref, existing, { notifyRemote: false });
    }
    connection.addConnection(ref, info);
  }

  _writeBackend(connection, ref, info, data) {
    const socket = info && (info.socket || info.localSocket);
    if (!socket || socket.destroyed) return;
    if (!info._inboundState) {
      info._inboundState = {
        blocked: false, draining: false, queued: [], bytes: 0,
        relayReadTimeoutMs: this.ioTimeoutMs,
        onRelayReadStall: (error) => destroySocket(socket, error),
      };
    }
    const state = info._inboundState;
    const scheduleDrain = () => {
      if (!state.blocked || state.draining || typeof socket.once !== 'function') return;
      state.draining = true;
      socket.once('drain', () => {
        state.draining = false;
        state.blocked = false;
        while (!state.blocked && state.queued.length > 0 && !socket.destroyed) {
          const chunk = state.queued.shift();
          state.bytes -= chunk.length;
          state.blocked = socket.write(chunk) === false;
        }
        updateRelayBackpressure(connection, state, state.bytes);
        if (state.ending && !state.blocked && state.queued.length === 0) socket.end();
        scheduleDrain();
      });
    };
    if (state.blocked) {
      const copy = Buffer.from(data);
      state.queued.push(copy);
      state.bytes += copy.length;
      updateRelayBackpressure(connection, state, state.bytes);
      if (state.bytes > MAX_NATIVE_QUEUE_BYTES) {
        this._cleanupConnectionInfo(connection, ref, info, { notifyRemote: true });
        return;
      }
      scheduleDrain();
      return;
    }
    state.blocked = socket.write(data) === false;
    scheduleDrain();
  }

  _cleanupConnections(connection = null, { port = null, notifyRemote = true } = {}) {
    for (const [info, tracked] of Array.from(this._trackedConnectionInfos.entries())) {
      if (connection && tracked.connection !== connection) continue;
      if (port !== null && info.port !== port) continue;
      this._cleanupConnectionInfo(tracked.connection, tracked.ref, info, { notifyRemote });
    }
    for (const conn of this._connectionList(connection)) {
      if (!conn || !conn.connections) continue;
      for (const [refHex, info] of Array.from(conn.connections.entries())) {
        if (port !== null && info.port !== port) continue;
        this._cleanupConnectionInfo(conn, Buffer.from(refHex, 'hex'), info, { notifyRemote });
      }
    }
    for (const session of Array.from(this.nativeSessions.values())) {
      if (connection && session.connection !== connection) continue;
      if (port !== null && session.port !== port) continue;
      this._cleanupNativeSession(session);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.stopListening();
    if (this.connection && typeof this.connection.off === 'function') {
      if (this._onDisconnect) this.connection.off('disconnect', this._onDisconnect);
      if (this._onEnd) this.connection.off('end', this._onEnd);
    }
    this._cleanupConnections(null, { notifyRemote: true });
  }

  startListening() {
    if (this._closed) return this;
    if (this._listening) return this; // idempotent
    // Listen for unsolicited messages from the connection
    this._onUnsolicited = (message, sourceConnection) => {
      try {
        const connection = sourceConnection || this.connection;
        if (!connection) {
          logger.warn(() => 'Received unsolicited message without a valid connection context');
          return;
        }
        const validated = validatePublisherUnsolicited(message);
        if (validated.error) {
          logger.warn(() => `Ignoring malformed unsolicited publisher frame: ${validated.error}`);
          return;
        }
        const { sessionIdRaw, messageContent, messageType } = validated;

        if (messageType === 'portopen') {
          this.handlePortOpen(sessionIdRaw, messageContent, connection);
        } else if (messageType === 'portopen2') {
          this.handlePortOpen2(sessionIdRaw, messageContent, connection);
        } else if (messageType === 'portclose2') {
          this.handlePortClose2(sessionIdRaw, messageContent, connection);
        } else if (messageType === 'portsend' || messageType === 'data') {
          // Accept both synonyms for payload delivery
          this.handlePortSend(sessionIdRaw, messageContent, connection);
        } else if (messageType === 'portclose') {
          this.handlePortClose(sessionIdRaw, messageContent, connection);
        } else if (messageType !== 'ticket_request' && messageType !== 'response') {
          logger.warn(() => `Unknown unsolicited message type: ${messageType}`);
        }
      } catch (error) {
        logger.error(() => `Publisher unsolicited dispatcher failed: ${error}`);
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
    if (this._closed) return;
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

    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Invalid port')).catch(() => {});
      return;
    }

    // Check if the port is published
    if (!this.publishedPorts.has(port)) {
      logger.warn(() => `Port ${port} is not published. Rejecting request.`);
      // Send error response
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Port is not published')).catch(() => {});
      return;
    }

    // Get port configuration and check whitelist if in private mode
    const portConfig = this._getPublishedPortConfig(port);
    if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
      if (!portConfig.whitelist.includes(deviceId)) {
        logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Rejecting request.`);
        void Promise.resolve(rpc.sendError(sessionId, ref, 'Device not whitelisted')).catch(() => {});
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
      void Promise.resolve(rpc.sendError(sessionId, ref, `Unsupported protocol: ${protocol}`)).catch(() => {});
    }
  }

  handleTLSHandshake(sessionId, ref, port, deviceId, connection) {
    const rpc = this._getRpcFor(connection);
    if (this._closed) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Publisher is shutting down')).catch(() => {});
      return;
    }
    const certPem = connection.getDeviceCertificate();
    if (!certPem) {
      logger.error(() => 'No device certificate available for TLS handshake');
      void Promise.resolve(rpc.sendError(sessionId, ref, 'No device certificate available')).catch(() => {});
      return;
    }
    const diodeSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs, connection);

    const tlsOptions = {
      cert: certPem,
      key: certPem,
      rejectUnauthorized: false,
      ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
      ecdhCurve: 'secp256k1',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };

    let tlsSocket;
    try {
      tlsSocket = new tls.TLSSocket(diodeSocket, {
        isServer: true,
        ...tlsOptions,
      });
    } catch (error) {
      destroySocket(diodeSocket);
      void Promise.resolve(rpc.sendError(sessionId, ref, 'TLS setup failed')).catch(() => {});
      return;
    }
    tlsSocket.setNoDelay(true);

    const connectionInfo = {
      diodeSocket,
      tlsSocket,
      protocol: 'tls',
      port,
      deviceId,
      handshake: true,
    };
    this._trackedConnectionInfos.set(connectionInfo, { connection, ref: Buffer.from(ref) });
    if (this._closed) {
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      return;
    }
    this._replaceConnectionInfo(connection, ref, connectionInfo);
    if (this._closed || connectionInfo._cleaned) {
      destroySocket(tlsSocket);
      destroySocket(diodeSocket);
      try {
        if (typeof connection.getConnection !== 'function' || connection.getConnection(ref) === connectionInfo) {
          connection.deleteConnection(ref);
        }
      } catch (_) {}
      return;
    }
    tlsSocket.on('error', (error) => {
      logger.error(() => `Native handshake TLS socket error: ${error}`);
    });

    const handshakePromise = (async () => {
      let session = null;
      const ensureCurrent = () => {
        if (this._closed || connectionInfo._cleaned || !session || session._cleaned
          || this._getNativeSession(connection, session.physicalPort) !== session) {
          throw new Error('Native session closed during handshake');
        }
      };
      try {
        const peerMessage = await nativeCrypto.readHandshakeMessage(tlsSocket, this.handshakeTimeoutMs);
        const candidate = this._getNativeSession(connection, Number(peerMessage.physicalPort));
        if (!candidate || candidate._cleaned) {
          throw new Error(`No native session for physical port ${peerMessage.physicalPort}`);
        }
        if (candidate.ready || candidate.handshakeInProgress) throw new Error('Native session handshake already established or in progress');
        if (candidate.port !== port) throw new Error('Native handshake target port mismatch');

        const verification = nativeCrypto.verifyHandshakeMessage(peerMessage, {
          expectedRole: 'bind',
          expectedDeviceId: candidate.deviceId,
          expectedPhysicalPort: candidate.physicalPort,
        });
        if (!verification.ok) {
          throw new Error(`Handshake verification failed: ${verification.reason}`);
        }
        session = candidate;
        session.handshakeInProgress = true;
        session.handshakeRef = ref;
        session.handshakeInfo = connectionInfo;
        ensureCurrent();

        const localDeviceId = connection.getEthereumAddress().toLowerCase();
        const { message, privKey, nonce } = nativeCrypto.createHandshakeMessage({
          role: 'publish',
          deviceId: localDeviceId,
          physicalPort: session.physicalPort,
          privateKey: connection.getPrivateKey()
        });

        // The handshake ref is closed in finally. Wait until TLS has accepted
        // and the relay has acknowledged the signed response. Do not append
        // TLS close_notify to this completed message exchange: either peer
        // may already be releasing the temporary API ref.
        await nativeCrypto.writeHandshakeMessage(tlsSocket, message);
        await diodeSocket.flush();
        ensureCurrent();

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

        this._flushNativeTCPRelayPending(session);

        if (session.protocol === 'udp' && session.relaySocket && session.session) {
          const probe = nativeCrypto.createUdpPacket(session.session, Buffer.alloc(0));
          session.relaySocket.send(probe);
        }
      } catch (error) {
        logger.error(() => `TLS handshake failed: ${error}`);
        if (session) {
          session.error = error;
          this._cleanupNativeSession(session);
        }
      } finally {
        if (session && session.handshakeInfo === connectionInfo) {
          session.handshakeInfo = null;
          session.handshakeRef = null;
          session.handshakeInProgress = false;
        }
        this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      }
    })();
    // Acknowledge only after the ref and handshake data listeners are ready,
    // so an immediate first portsend cannot be lost.
    void Promise.resolve(rpc.sendResponse(sessionId, ref, 'ok')).catch((error) => {
      logger.error(() => `Failed to acknowledge native TLS handshake: ${error}`);
      void handshakePromise.catch(() => {});
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
    });
  }

  handlePortOpen2(sessionIdRaw, messageContent, connection) {
    if (this._closed) return;
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

    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      logger.warn(() => `Invalid port in portopen2: ${portName}`);
      void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, 'Invalid port')).catch(() => {});
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
      void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, 'Port is not published')).catch(() => {});
      return;
    }

    // Get port configuration and check whitelist if in private mode
    const portConfig = this._getPublishedPortConfig(port);
    if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
      if (!portConfig.whitelist.includes(deviceId)) {
        logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Rejecting request.`);
        void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, 'Device not whitelisted')).catch(() => {});
        return;
      }
      logger.info(() => `Device ${deviceId} is whitelisted for port ${port}. Accepting request.`);
    }

    if (!physicalPort || physicalPort > 65535) {
      logger.warn(() => `Invalid physical port in portopen2: ${physicalPortRaw}`);
      void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, 'Invalid physical port')).catch(() => {});
      return;
    }

    const sessionKey = this._nativeSessionKey(connection, physicalPort);
    const existing = this.nativeSessions.get(sessionKey);
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
      sessionKey,
      ready: false,
      session: null,
      relaySocket: null,
      localSocket: null,
      timer: null,
      pendingRelayChunks: [],
      nativeLease: true,
    };
    connection._diodeActiveNativeSessions = Number(connection._diodeActiveNativeSessions || 0) + 1;
    const sessionTimeoutMs = normalizeTimerMs(
      Math.max(15000, this.handshakeTimeoutMs * 2),
      20000
    );
    session.timer = setTimeout(() => {
      if (!session.ready) {
        logger.warn(() => `Handshake timeout for native session on physical port ${physicalPort}`);
        this._cleanupNativeSession(session);
      }
    }, sessionTimeoutMs);
    if (typeof session.timer.unref === 'function') session.timer.unref();

    this.nativeSessions.set(sessionKey, session);

    if (protocol === 'udp') {
      this.handleNativeUDPRelay(sessionId, physicalPortRef, session, connection);
    } else {
      this.handleNativeTCPRelay(sessionId, physicalPortRef, session, connection);
    }
  }

  _cleanupNativeSession(session) {
    if (!session || session._cleaned) return;
    session._cleaned = true;
    session.ready = false;
    if (session.bridge) session.bridge.destroy();
    if (session.handshakeInfo) {
      this._cleanupConnectionInfo(session.connection, session.handshakeRef, session.handshakeInfo, { notifyRemote: true });
      session.handshakeInfo = null;
      session.handshakeRef = null;
    }
    if (session.pendingRelayChunks) session.pendingRelayChunks.length = 0;
    session.pendingRelayBytes = 0;
    if (session.nativeLease && session.connection) {
      session.connection._diodeActiveNativeSessions = Math.max(
        0,
        Number(session.connection._diodeActiveNativeSessions || 0) - 1
      );
      session.nativeLease = false;
    }
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.connectTimer) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
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
    const sessionKey = session.sessionKey || this._nativeSessionKey(session.connection, session.physicalPort);
    if (this.nativeSessions.get(sessionKey) === session) {
      this.nativeSessions.delete(sessionKey);
    }
  }

  handlePortClose2(sessionIdRaw, messageContent, connection) {
    const rpc = this._getRpcFor(connection);
    const physicalPort = parseUInt(messageContent[1]);
    if (!Number.isFinite(physicalPort)) {
      logger.warn(() => 'Received portclose2 with invalid physical port');
      return;
    }
    const session = this._getNativeSession(connection, physicalPort);
    if (session) {
      logger.debug(() => `Closing native session ${session.sessionKey}`);
      this._cleanupNativeSession(session);
    }
    void Promise.resolve(
      rpc.sendResponse(toBufferView(sessionIdRaw), Number(physicalPort), 'ok')
    ).catch(() => {});
  }

  _flushNativeTCPRelayPending(session) {
    if (!session || session._cleaned || session.protocol !== 'tcp' || !session.ready || !session.session || session.bridge) {
      return;
    }
    session.bridge = bridgeNativeTcp({
      localSocket: session.localSocket,
      relaySocket: session.relaySocket,
      session: session.session,
      onError: (error) => logger.error(() => `Native TCP stream error (${session.deviceId}): ${error}`),
      onClose: () => this._cleanupNativeSession(session),
    });
  }

  handleNativeTCPRelay(sessionId, physicalPortRef, session, connection) {
    const rpc = this._getRpcFor(connection);
    const { physicalPort, port, host, deviceId } = session;
    let responded = false;
    const sendOk = () => {
      if (responded) return;
      responded = true;
      void Promise.resolve(rpc.sendResponse(sessionId, physicalPortRef, 'ok')).catch((error) => {
        logger.error(() => `Failed to acknowledge native TCP portopen: ${error}`);
        this._cleanupNativeSession(session);
      });
    };
    const sendError = (reason) => {
      if (responded) return;
      responded = true;
      void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, reason)).catch(() => {});
    };

    let relaySocket;
    let localSocket;
    const cleanup = () => this._cleanupNativeSession(session);
    try {
      const relayHost = connection.getServerRelayHost();
      relaySocket = net.connect({ host: relayHost, port: physicalPort, allowHalfOpen: true, autoSelectFamily: false });
      session.relaySocket = relaySocket;
      relaySocket.pause();
      if (this._closed || session._cleaned) {
        destroySocket(relaySocket);
        cleanup();
        return;
      }
      localSocket = net.connect({ port, host, allowHalfOpen: true, autoSelectFamily: false });
      session.localSocket = localSocket;
      localSocket.pause();
      if (this._closed || session._cleaned) {
        destroySocket(localSocket);
        cleanup();
        return;
      }
    } catch (error) {
      sendError('Native TCP socket setup failed');
      cleanup();
      return;
    }

    let relayReady = false;
    let localReady = false;
    const maybeReady = () => {
      if (!this._closed && !session._cleaned && relayReady && localReady) {
        if (session.connectTimer) {
          clearTimeout(session.connectTimer);
          session.connectTimer = null;
        }
        sendOk();
      }
    };
    session.connectTimer = setTimeout(() => {
      sendError('Native relay connection timed out');
      cleanup();
    }, normalizeTimerMs(this.backendConnectTimeoutMs, 5000));
    if (typeof session.connectTimer.unref === 'function') session.connectTimer.unref();

    relaySocket.on('connect', () => {
      relaySocket.setNoDelay(true);
      relayReady = true;
      maybeReady();
    });
    localSocket.on('connect', () => {
      localSocket.setNoDelay(true);
      localReady = true;
      maybeReady();
    });

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

    // Before authentication, paused Node sockets retain only their bounded
    // receive buffers. After authentication the bridge owns EOF and drainage.
    const onPreHandshakeClose = () => { if (!session.bridge) cleanup(); };
    relaySocket.on('close', onPreHandshakeClose);
    localSocket.on('close', onPreHandshakeClose);
  }

  handleNativeUDPRelay(sessionId, physicalPortRef, session, connection) {
    const rpc = this._getRpcFor(connection);
    const { physicalPort, port, host, deviceId } = session;
    let responded = false;
    const sendOk = () => {
      if (responded) return;
      responded = true;
      void Promise.resolve(rpc.sendResponse(sessionId, physicalPortRef, 'ok')).catch((error) => {
        logger.error(() => `Failed to acknowledge native UDP portopen: ${error}`);
        this._cleanupNativeSession(session);
      });
    };
    const sendError = (reason) => {
      if (responded) return;
      responded = true;
      void Promise.resolve(rpc.sendError(sessionId, physicalPortRef, reason)).catch(() => {});
    };

    let relaySocket;
    let localSocket;
    try {
      relaySocket = dgram.createSocket('udp4');
      session.relaySocket = relaySocket;
      if (this._closed || session._cleaned) {
        destroySocket(relaySocket);
        this._cleanupNativeSession(session);
        return;
      }
      localSocket = dgram.createSocket('udp4');
      session.localSocket = localSocket;
      if (this._closed || session._cleaned) {
        destroySocket(localSocket);
        this._cleanupNativeSession(session);
        return;
      }
    } catch (error) {
      sendError('Native UDP socket setup failed');
      this._cleanupNativeSession(session);
      return;
    }

    let relayReady = false;
    let localReady = false;
    const maybeReady = () => {
      if (!this._closed && !session._cleaned && relayReady && localReady) {
        if (session.connectTimer) {
          clearTimeout(session.connectTimer);
          session.connectTimer = null;
        }
        sendOk();
      }
    };
    session.connectTimer = setTimeout(() => {
      sendError('Native UDP connection timed out');
      this._cleanupNativeSession(session);
    }, normalizeTimerMs(this.backendConnectTimeoutMs, 5000));
    if (typeof session.connectTimer.unref === 'function') session.connectTimer.unref();

    relaySocket.on('message', (msg) => {
      if (!session.ready || !session.session) return;
      try {
        const plaintext = nativeCrypto.parseUdpPacket(session.session, msg);
        if (!plaintext) return;
        localSocket.send(plaintext);
      } catch (error) {
        logger.error(() => `Native UDP decode failed (${deviceId}): ${error}`);
        this._cleanupNativeSession(session);
      }
    });
    localSocket.on('message', (msg) => {
      if (!session.ready || !session.session) return;
      try {
        const packet = nativeCrypto.createUdpPacket(session.session, msg);
        relaySocket.send(packet);
      } catch (error) {
        logger.error(() => `Native UDP encode failed (${deviceId}): ${error}`);
        this._cleanupNativeSession(session);
      }
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
    relaySocket.on('close', () => this._cleanupNativeSession(session));
    localSocket.on('close', () => this._cleanupNativeSession(session));

    try {
      const relayHost = connection.getServerRelayHost();
      relaySocket.connect(physicalPort, relayHost, () => {
        relayReady = true;
        maybeReady();
      });
      localSocket.connect(port, host, () => {
        localReady = true;
        maybeReady();
      });
    } catch (error) {
      sendError('Native UDP socket connection failed');
      this._cleanupNativeSession(session);
    }

  }

  setupLocalSocketHandlers(localSocket, ref, protocol, rpc, connection, opening = null, connectionInfo = null) {
    if (protocol === 'udp') {
      
    } else {
      const info = connectionInfo || connection.getConnection(ref);
      const sendSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs);
      if (info) info.sendSocket = sendSocket;
      const cleanup = (notifyRemote = true) => {
        this._cleanupConnectionInfo(connection, ref, info, { notifyRemote });
        destroySocket(sendSocket);
        destroySocket(localSocket);
      };
      let finishing = false;
      const finishWrites = () => {
        if (finishing) return;
        finishing = true;
        // The backend may close with a final response still in the send window.
        // _final waits for every relay ACK before the ref can be closed.
        sendSocket.end(() => cleanup());
      };
      sendSocket.on('error', (error) => {
        logger.error(() => `Error sending data to device: ${error}`);
        cleanup();
      });
      localSocket.on('end', finishWrites);
      localSocket.on('close', (hadError) => {
        if (hadError || localSocket.readableAborted) cleanup();
        else finishWrites();
      });

      localSocket.on('error', (err) => {
        logger.error(() => `Error with local service: ${err}`);
        const failedDuringOpen = !!(opening && !opening.responded);
        if (failedDuringOpen) {
          opening.responded = true;
          void Promise.resolve(rpc.sendError(opening.sessionId, ref, 'Local service connection failed')).catch(() => {});
        }
        cleanup(!failedDuringOpen);
      });
      localSocket.pipe(sendSocket);
    }
  }

  handleTCPConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    if (this._closed) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Publisher is shutting down')).catch(() => {});
      return;
    }
    const opening = { responded: false, sessionId };
    let connectTimer = null;
    // Create a TCP connection to the local service on the specified port
    let localSocket;
    let connectionInfo = null;
    try {
      localSocket = net.connect({ port, host: portConfig.host, autoSelectFamily: false }, () => {
        if (this._closed || !connectionInfo || connectionInfo._cleaned || localSocket.destroyed) {
          destroySocket(localSocket);
          return;
        }
        clearTimeout(connectTimer);
        localSocket.setNoDelay(true);
        logger.info(() => `Connected to local TCP service on ${portConfig.host}:${port}`);
        if (!opening.responded) {
          opening.responded = true;
          void Promise.resolve(rpc.sendResponse(sessionId, ref, 'ok')).catch((error) => {
            logger.error(() => `Failed to acknowledge TCP portopen: ${error}`);
            this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
          });
        }
      });
    } catch (error) {
      logger.error(() => `Could not create local TCP backend socket: ${error}`);
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection failed')).catch(() => {});
      return;
    }

    connectionInfo = { socket: localSocket, protocol: 'tcp', port, host: portConfig.host, deviceId };
    this._trackedConnectionInfos.set(connectionInfo, { connection, ref: Buffer.from(ref) });
    if (this._closed) {
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      return;
    }

    // Handle data, end, and error events
    this.setupLocalSocketHandlers(localSocket, ref, 'tcp', rpc, connection, opening, connectionInfo);

    // Store the local socket with the ref using connection's method
    this._replaceConnectionInfo(connection, ref, connectionInfo);
    if (this._closed || connectionInfo._cleaned) {
      destroySocket(localSocket);
      try {
        if (typeof connection.getConnection !== 'function' || connection.getConnection(ref) === connectionInfo) {
          connection.deleteConnection(ref);
        }
      } catch (_) {}
      return;
    }
    connectTimer = setTimeout(() => {
      if (opening.responded) return;
      opening.responded = true;
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection timed out')).catch(() => {});
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
    }, normalizeTimerMs(this.backendConnectTimeoutMs, 5000));
    if (typeof connectTimer.unref === 'function') connectTimer.unref();
    localSocket.once('close', () => clearTimeout(connectTimer));
  }

  handleTLSConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    if (this._closed) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Publisher is shutting down')).catch(() => {});
      return;
    }
    const certPem = connection.getDeviceCertificate();
    if (!certPem) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'No device certificate available')).catch(() => {});
      return;
    }
    // Create a DiodeSocket instance
    const diodeSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs, connection);

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
    let tlsSocket;
    try {
      tlsSocket = new tls.TLSSocket(diodeSocket, {
        isServer: true,
        ...tlsOptions,
      });
    } catch (error) {
      logger.error(() => `Could not create publisher TLS socket: ${error}`);
      destroySocket(diodeSocket);
      void Promise.resolve(rpc.sendError(sessionId, ref, 'TLS setup failed')).catch(() => {});
      return;
    }
    tlsSocket.setNoDelay(true);
    let responded = false;
    let connectTimer = null;
    // Connect to the local service (TCP or TLS as needed)
    let localSocket;
    let connectionInfo = null;
    try {
      localSocket = net.connect({ port, host: portConfig.host, autoSelectFamily: false }, () => {
        if (this._closed || !connectionInfo || connectionInfo._cleaned || localSocket.destroyed) {
          destroySocket(localSocket);
          return;
        }
        if (connectTimer) clearTimeout(connectTimer);
        localSocket.setNoDelay(true);
        logger.info(() => `Connected to local TCP service on ${portConfig.host}:${port}`);
        if (!responded) {
          responded = true;
          void Promise.resolve(rpc.sendResponse(sessionId, ref, 'ok')).catch((error) => {
            logger.error(() => `Failed to acknowledge TLS portopen: ${error}`);
            this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
          });
        }
      });
    } catch (error) {
      logger.error(() => `Could not create local TLS backend socket: ${error}`);
      destroySocket(tlsSocket);
      destroySocket(diodeSocket);
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection failed')).catch(() => {});
      return;
    }

    connectionInfo = {
      diodeSocket,
      tlsSocket,
      localSocket,
      protocol: 'tls',
      port,
      host: portConfig.host,
      deviceId,
    };
    this._trackedConnectionInfos.set(connectionInfo, { connection, ref: Buffer.from(ref) });
    if (this._closed) {
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      return;
    }
    this._replaceConnectionInfo(connection, ref, connectionInfo);
    if (this._closed || connectionInfo._cleaned) {
      destroySocket(localSocket);
      destroySocket(tlsSocket);
      destroySocket(diodeSocket);
      try {
        if (typeof connection.getConnection !== 'function' || connection.getConnection(ref) === connectionInfo) {
          connection.deleteConnection(ref);
        }
      } catch (_) {}
      return;
    }

    // Pipe data between the TLS socket and the local service
    tlsSocket.pipe(localSocket).pipe(tlsSocket);

    // Handle errors and cleanup
    tlsSocket.on('error', (err) => {
      logger.error(() => `TLS Socket error: ${err}`);
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: responded });
    });

    tlsSocket.on('close', () => {
      // Node must drain decrypted bytes queued for the backend before the
      // local socket's close handler releases the connection resources.
      if (!localSocket.destroyed) localSocket.end();
    });
    localSocket.on('error', (err) => {
      logger.error(() => `Local TLS backend error: ${err}`);
      const failedDuringOpen = !responded;
      if (failedDuringOpen) {
        responded = true;
        void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection failed')).catch(() => {});
      }
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: !failedDuringOpen });
    });
    localSocket.on('close', (hadError) => {
      if (connectTimer) clearTimeout(connectTimer);
      if (!hadError && localSocket.readableEnded && !connectionInfo._cleaned) {
        void diodeSocket.finishTlsWrites(tlsSocket)
          .catch((error) => logger.debug(() => `Publish TLS write shutdown: ${error.message}`))
          .finally(() => this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: responded }));
      } else {
        this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: responded });
      }
    });
    connectTimer = setTimeout(() => {
      if (responded) return;
      responded = true;
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection timed out')).catch(() => {});
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
    }, normalizeTimerMs(this.backendConnectTimeoutMs, 5000));
    if (typeof connectTimer.unref === 'function') connectTimer.unref();
  }

  handleUDPConnection(sessionId, ref, port, deviceId, portConfig, connection) {
    const rpc = this._getRpcFor(connection);
    if (this._closed) {
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Publisher is shutting down')).catch(() => {});
      return;
    }
    // Create a UDP socket
    let localSocket;
    try {
      localSocket = dgram.createSocket('udp4');
    } catch (error) {
      logger.error(() => `Could not create local UDP backend socket: ${error}`);
      void Promise.resolve(rpc.sendError(sessionId, ref, 'Local service connection failed')).catch(() => {});
      return;
    }

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

    // Store the connection info using connection's method
    const connectionInfo = {
      socket: localSocket,
      protocol: 'udp',
      remoteInfo,
      port,
      host: portConfig.host,
      deviceId
    };
    this._trackedConnectionInfos.set(connectionInfo, { connection, ref: Buffer.from(ref) });
    if (this._closed) {
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      return;
    }
    this._replaceConnectionInfo(connection, ref, connectionInfo);
    if (this._closed || connectionInfo._cleaned) {
      destroySocket(localSocket);
      try {
        if (typeof connection.getConnection !== 'function' || connection.getConnection(ref) === connectionInfo) {
          connection.deleteConnection(ref);
        }
      } catch (_) {}
      return;
    }

    logger.info(() => `UDP connection set up for ${portConfig.host}:${port}`);

    // Handle messages from the local UDP service
    localSocket.on('message', (msg, rinfo) => {
      void Promise.resolve(rpc.portSend(ref, msg, { timeoutMs: this.ioTimeoutMs })).catch((error) => {
        logger.error(() => `Error sending UDP data to device: ${error}`);
        this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
      });
    });

    localSocket.on('error', (err) => {
      logger.error(() => `UDP Socket error: ${err}`);
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
    });
    // Acknowledge only after routing and error handlers are installed.
    void Promise.resolve(rpc.sendResponse(sessionId, ref, 'ok')).catch((error) => {
      logger.error(() => `Failed to acknowledge UDP portopen: ${error}`);
      this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
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
        this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
        return;
      }

      const portConfig = this._getPublishedPortConfig(port);
      if (portConfig.mode === 'private' && Array.isArray(portConfig.whitelist)) {
        if (!portConfig.whitelist.includes(deviceId)) {
          logger.warn(() => `Device ${deviceId} is not whitelisted for port ${port}. Sending portclose.`);
          this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
          return;
        }
      }

      if (protocol === 'udp') {
        // Send data to the local UDP service
        // Since UDP is connectionless, we need to specify the address and port
        localSocket.send(data, remoteInfo.port, remoteInfo.address, (err) => {
          if (err) {
            logger.error(() => `Error sending UDP data: ${err}`);
            this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: true });
          }
        });

        // Update remoteInfo if not set
        if (!localSocket.remoteAddress) {
          localSocket.remoteAddress = host || (remoteInfo && remoteInfo.address) || portConfig.host;
          localSocket.remotePort = port;
        }
      } else if (protocol === 'tcp') {
        // Write data to the local service
        this._writeBackend(connection, ref, connectionInfo, data);
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
        void Promise.resolve(rpc.sendError(sessionId, ref, 'No local connection found')).catch(() => {});
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
      connectionInfo._remoteEnded = true;
      if (connectionInfo.protocol === 'tls' && typeof connectionInfo.diodeSocket?.endReadable === 'function') {
        connectionInfo.diodeSocket.endReadable();
      } else if (connectionInfo.protocol === 'tcp' && connectionInfo.socket) {
        const state = connectionInfo._inboundState;
        if (state && (state.blocked || state.queued.length > 0)) {
          state.ending = true;
        } else {
          connectionInfo.socket.end();
        }
      } else {
        this._cleanupConnectionInfo(connection, ref, connectionInfo, { notifyRemote: false });
      }
    }
  }
}

module.exports = PublishPort;
