const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const { Buffer } = require('buffer');
const { toBufferView } = require('./utils');
const DiodeSocket = require('./diodeSocket');
const { updateRelayBackpressure, releaseRelayBackpressure } = require('./relayBackpressure');
const EventEmitter = require('events');
const DiodeRPC = require('./rpc');
const nativeCrypto = require('./nativeCrypto');
const { bridgeNativeTcp } = require('./nativeTcpBridge');
const logger = require('./logger');

const BIND_PORT_LISTENER_STATE = Symbol.for('diodejs.bindPort.listenerState');
const SOCKET_BACKPRESSURE_STATE = Symbol('diodejs.bindPort.backpressure');
const MAX_SOCKET_QUEUE_BYTES = 1024 * 1024;
const MAX_TIMER_MS = 0x7fffffff;

function normalizeTimerMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_TIMER_MS);
}

function isByteSequence(value, { nonEmpty = false } = {}) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return false;
  return !nonEmpty || value.byteLength > 0;
}

function decodeMessageType(raw) {
  if (typeof raw === 'string') return raw;
  if (!isByteSequence(raw, { nonEmpty: true })) return null;
  return toBufferView(raw).toString('utf8');
}

function validateBindUnsolicited(message) {
  if (!Array.isArray(message) || message.length < 2) return { error: 'invalid envelope' };
  if (!isByteSequence(message[0], { nonEmpty: true })) return { error: 'invalid session id' };
  const messageContent = message[1];
  if (!Array.isArray(messageContent) || messageContent.length === 0) {
    return { error: 'invalid message content' };
  }
  const messageType = decodeMessageType(messageContent[0]);
  if (!messageType) return { error: 'invalid message type' };
  if (messageType === 'data' || messageType === 'portsend') {
    if (messageContent.length < 3
      || !isByteSequence(messageContent[1], { nonEmpty: true })
      || !isByteSequence(messageContent[2])) {
      return { error: `invalid ${messageType} payload` };
    }
  } else if (messageType === 'portclose') {
    if (messageContent.length < 2 || !isByteSequence(messageContent[1], { nonEmpty: true })) {
      return { error: 'invalid portclose payload' };
    }
  }
  return { messageContent, messageType };
}

function destroySocket(socket, error = undefined) {
  if (!socket) return;
  try {
    if (typeof socket.destroy === 'function') socket.destroy(error);
    else if (typeof socket.close === 'function') socket.close();
    else if (typeof socket.end === 'function') socket.end();
  } catch (_) {}
}

function scheduleSocketDrain(socket, state) {
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
    updateRelayBackpressure(state.connection, state, state.bytes);
    if (state.ending && !state.blocked && state.queued.length === 0) socket.end();
    scheduleSocketDrain(socket, state);
  });
}

function writeWithBoundedBackpressure(socket, data, connection = null) {
  if (!socket || socket.destroyed) return false;
  let state = socket[SOCKET_BACKPRESSURE_STATE];
  if (!state) {
    state = {
      blocked: false, queued: [], bytes: 0, draining: false, connection,
      relayReadTimeoutMs: socket._diodeOwner?.ioTimeoutMs,
      onRelayReadStall: (error) => destroySocket(socket, error),
    };
    socket[SOCKET_BACKPRESSURE_STATE] = state;
    if (typeof socket.once === 'function') socket.once('close', () => releaseRelayBackpressure(state));
  }
  if (state.blocked) {
    const copy = Buffer.from(data);
    state.bytes += copy.length;
    updateRelayBackpressure(state.connection, state, state.bytes);
    if (state.bytes > MAX_SOCKET_QUEUE_BYTES) {
      destroySocket(socket, new Error('Diode inbound socket queue limit exceeded'));
      return false;
    }
    state.queued.push(copy);
    scheduleSocketDrain(socket, state);
    return false;
  }

  state.blocked = socket.write(data) === false;
  scheduleSocketDrain(socket, state);
  return !state.blocked;
}

function endSocketWhenDrained(socket) {
  const state = socket && socket[SOCKET_BACKPRESSURE_STATE];
  if (!socket || socket.destroyed) return;
  if (state && (state.blocked || state.queued.length > 0)) {
    state.ending = true;
    scheduleSocketDrain(socket, state);
  } else {
    socket.end();
  }
}

class BindPort extends EventEmitter {
  constructor(connection, localPortOrPortsConfig, targetPort, deviceIdHex) {
    super();
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
    this._rpcByConnection = new WeakMap();
    this.rpc = this._isManager() ? null : this._getRpcFor(this.connection);
    this.handshakeTimeoutMs = normalizeTimerMs(process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS, 10000);
    this.portOpenTimeoutMs = normalizeTimerMs(process.env.DIODE_PORTOPEN_TIMEOUT_MS, 5000);
    this.ioTimeoutMs = normalizeTimerMs(process.env.DIODE_PORT_IO_TIMEOUT_MS, 10000);
    const targetConnectMs = Number(connection?.relaySelection?.targetConnectTimeoutMs || 10000);
    this.relayResolveTimeoutMs = normalizeTimerMs(
      process.env.DIODE_RELAY_RESOLVE_TIMEOUT_MS,
      normalizeTimerMs(Math.max(this.portOpenTimeoutMs, targetConnectMs + this.portOpenTimeoutMs), 15000)
    );
    this.nativeQueueLimitBytes = parseInt(process.env.DIODE_NATIVE_QUEUE_LIMIT_BYTES, 10) || MAX_SOCKET_QUEUE_BYTES;
    this.udpSessionIdleTimeoutMs = normalizeTimerMs(process.env.DIODE_UDP_SESSION_IDLE_TIMEOUT_MS, 300000);
    this._activeContexts = new Set();
    this._disposed = false;
    
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

  _connectionKey(connection) {
    if (!connection) return '';
    if (connection._managerHostKey) return connection._managerHostKey;
    if (connection.host && connection.port) return `${connection.host}:${connection.port}`;
    return '';
  }

  async _withTimeout(promiseOrFactory, timeoutMs, label) {
    const boundedTimeoutMs = normalizeTimerMs(timeoutMs, this.portOpenTimeoutMs || 5000);
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => (
          typeof promiseOrFactory === 'function' ? promiseOrFactory() : promiseOrFactory
        )),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`)), boundedTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _isUsableConnection(connection) {
    if (!connection) return false;
    if (typeof connection.isReady === 'function') {
      return connection.isReady();
    }
    if (connection._managerReady === false || connection.ready === false) {
      return false;
    }
    return !!(connection.socket && !connection.socket.destroyed && connection.socket.writable !== false);
  }

  _trackContext(server, localPort, context) {
    context.server = server;
    context.localPort = Number(localPort);
    context.closed = false;
    context.sockets = context.sockets || new Set();
    this._activeContexts.add(context);
    if (!server._diodeContexts) server._diodeContexts = new Set();
    server._diodeContexts.add(context);
    this._acquireNativeLease(context);
    return context;
  }

  _touchContext(context) {
    if (!context || context.closed || !context.udp) return;
    if (context.idleTimer) clearTimeout(context.idleTimer);
    context.idleTimer = setTimeout(
      () => this._closeContext(context),
      normalizeTimerMs(this.udpSessionIdleTimeoutMs, 300000)
    );
    if (typeof context.idleTimer.unref === 'function') context.idleTimer.unref();
  }

  _endContextFromRemote(context) {
    if (!context || context.closed || context.remoteEnded) return;
    context.remoteEnded = true;
    const wrapper = context.clientSocketWrapper;
    if (context.udp || !wrapper) {
      this._closeContext(context, { notifyRemote: false });
    } else if (wrapper.diodeSocket) {
      // Preserve queued ciphertext and decrypted plaintext until the client
      // consumes them. A relay EOF is not a reset of the local TCP socket.
      wrapper.diodeSocket.endReadable();
    } else {
      endSocketWhenDrained(wrapper);
    }
  }

  _acquireNativeLease(context) {
    if (!context || context.closed || context.nativeLease || !context.physicalPort || !context.connection) return;
    context.nativeLease = true;
    context.connection._diodeActiveNativeSessions = Number(context.connection._diodeActiveNativeSessions || 0) + 1;
  }

  _closeNativePort(context) {
    if (!context || !context.physicalPort || !context.connection || context.nativeCloseStarted) return;
    context.nativeCloseStarted = true;
    const rpc = context.rpc || this._getRpcFor(context.connection);
    try {
      if (rpc && typeof rpc.portClose2 === 'function') {
        void Promise.resolve(rpc.portClose2(context.physicalPort, { timeoutMs: this.portOpenTimeoutMs })).catch(() => {});
      } else if (typeof context.connection.sendCommand === 'function') {
        void Promise.resolve(context.connection.sendCommand(
          ['portclose2', context.physicalPort],
          { timeoutMs: this.portOpenTimeoutMs }
        )).catch(() => {});
      }
    } catch (_) {}
  }

  _replaceClientSocket(connection, ref, socketWrapper) {
    let existing;
    try { existing = connection.getClientSocket(ref); } catch (_) {}
    if (existing && existing !== socketWrapper) {
      if (existing._diodeOwner && existing._diodeContext) {
        existing._diodeOwner._closeContext(existing._diodeContext, { notifyRemote: false });
      } else {
        destroySocket(existing.tlsSocket || existing.diodeSocket || existing);
        try {
          if (connection.getClientSocket(ref) === existing) connection.deleteClientSocket(ref);
        } catch (_) {}
      }
    }
    connection.addClientSocket(ref, socketWrapper);
  }

  _closeContext(context, { notifyRemote = true } = {}) {
    if (!context || context.closed) return;
    context.closed = true;
    if (context.idleTimer) {
      clearTimeout(context.idleTimer);
      context.idleTimer = null;
    }
    if (context.nativeLease && context.connection) {
      context.connection._diodeActiveNativeSessions = Math.max(
        0,
        Number(context.connection._diodeActiveNativeSessions || 0) - 1
      );
      context.nativeLease = false;
    }
    this._activeContexts.delete(context);
    if (context.server && context.server._diodeContexts) {
      context.server._diodeContexts.delete(context);
    }

    if (typeof context.cleanup === 'function') {
      try { context.cleanup(); } catch (_) {}
    }
    for (const socket of context.sockets || []) {
      releaseRelayBackpressure(socket[SOCKET_BACKPRESSURE_STATE]);
      destroySocket(socket);
    }

    if (context.ref && context.connection) {
      let currentWrapper;
      let canInspectCurrent = false;
      try {
        if (typeof context.connection.getClientSocket === 'function') {
          canInspectCurrent = true;
          currentWrapper = context.connection.getClientSocket(context.ref);
        }
      } catch (_) {}
      const ownsCurrentRef = !canInspectCurrent
        || currentWrapper === context.clientSocketWrapper
        || (currentWrapper && currentWrapper._diodeContext === context);
      const refWasReused = canInspectCurrent && currentWrapper && !ownsCurrentRef;
      if (ownsCurrentRef) {
        try { context.connection.deleteClientSocket(context.ref); } catch (_) {}
      }
      if (notifyRemote && !refWasReused && !context.remoteCloseStarted && context.rpc) {
        context.remoteCloseStarted = true;
        void Promise.resolve(context.rpc.portClose(context.ref, { timeoutMs: this.portOpenTimeoutMs })).catch(() => {});
      }
    }
    if (notifyRemote) this._closeNativePort(context);
  }

  _closeServerContexts(server, options) {
    if (!server || !server._diodeContexts) return;
    for (const context of Array.from(server._diodeContexts)) {
      this._closeContext(context, options);
    }
  }

  _closeConnectionContexts(connection, options) {
    for (const context of Array.from(this._activeContexts)) {
      if (!connection || context.connection === connection) {
        this._closeContext(context, options);
      }
    }
  }

  _clearDeviceRelayCache(deviceIdHex) {
    const cache = this.connection && this.connection.deviceRelayCache;
    if (!cache || typeof cache.delete !== 'function') {
      return;
    }
    const normalized = this._stripHexPrefix(deviceIdHex || '').toLowerCase();
    cache.delete(normalized);
    cache.delete(`0x${normalized}`);
  }

  async _getApiRelayCandidates(deviceId, deviceIdHex) {
    const candidates = [];
    const seen = new Set();
    const push = (connection) => {
      if (!this._isUsableConnection(connection)) {
        return;
      }
      const key = this._connectionKey(connection) || String(candidates.length);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push(connection);
    };

    try {
      push(await this._withTimeout(
        () => this._resolveConnectionForDevice(deviceId),
        this.relayResolveTimeoutMs,
        `Relay resolution for ${deviceIdHex}`
      ));
    } catch (error) {
      logger.warn(() => `Error resolving relay for device ${deviceIdHex}: ${error}`);
    }

    if (typeof (this.connection && this.connection.getNearestConnection) === 'function') {
      push(this.connection.getNearestConnection());
    }

    if (typeof (this.connection && this.connection.getConnections) === 'function') {
      for (const connection of this.connection.getConnections()) {
        push(connection);
      }
    } else {
      push(this.connection);
    }

    return candidates;
  }

  _openApiPortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, flags = 'rw') {
    return this._openPortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, flags, false);
  }

  _openNativePortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, flags = 'rw') {
    return this._openPortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, flags, true);
  }

  async _openPortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, flags, native) {
    let candidates = await this._getApiRelayCandidates(deviceId, deviceIdHex);
    let clearedCache = false;
    let lastError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const connection = candidates[index];
      const rpc = this._getRpcFor(connection);
      const relayKey = this._connectionKey(connection) || 'unknown relay';

      try {
        const ref = await this._withTimeout(
          () => native
            ? rpc.portOpen2(deviceId, formattedTargetPort, flags, { timeoutMs: this.portOpenTimeoutMs })
            : rpc.portOpen(deviceId, formattedTargetPort, flags, { timeoutMs: this.portOpenTimeoutMs }),
          this.portOpenTimeoutMs,
          `${native ? 'portopen2' : 'portopen'} ${formattedTargetPort} via ${relayKey}`
        );
        if (native ? Number.isInteger(ref) && ref > 0 && ref <= 65535 : ref) {
          if (index > 0) {
            logger.info(() => `Port ${formattedTargetPort} opened via fallback relay ${relayKey}`);
          }
          return native ? { connection, rpc, physicalPort: ref } : { connection, rpc, ref };
        }
        lastError = new Error(`${native ? 'portopen2 returned no valid port' : 'portopen returned no ref'} via ${relayKey}`);
      } catch (error) {
        lastError = error;
      }

      logger.warn(() => `Port ${formattedTargetPort} did not open via ${relayKey}: ${lastError}`);
      if (!clearedCache) {
        clearedCache = true;
        this._clearDeviceRelayCache(deviceIdHex);
        const refreshed = await this._getApiRelayCandidates(deviceId, deviceIdHex);
        for (const candidate of refreshed) {
          const key = this._connectionKey(candidate) || String(candidates.length);
          const exists = candidates.some((existing) => (this._connectionKey(existing) || '') === key);
          if (!exists) {
            candidates.push(candidate);
          }
        }
      }
    }

    throw lastError || new Error('No relay connection available');
  }

  async _openTlsHandshakeChannel(connection, rpc, ref, context = null) {
    const diodeSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs);
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
        try { diodeSocket.destroy(); } catch {}
      }
    };

    // The secure/read/write helpers install temporary error listeners. Keep
    // one for the full channel lifetime, including the final relay ACK wait.
    tlsSocket.on('error', (error) => {
      logger.error(() => `Native handshake TLS socket error: ${error}`);
      if (context) this._closeContext(context);
      destroySocket(tlsSocket);
      destroySocket(diodeSocket);
      try {
        if (connection.getClientSocket(ref) === socketWrapper) connection.deleteClientSocket(ref);
      } catch (_) {}
    });

    if (context) context.clientSocketWrapper = socketWrapper;
    this._replaceClientSocket(connection, ref, socketWrapper);
    if (context) {
      context.sockets.add(tlsSocket);
      context.sockets.add(diodeSocket);
      if (context.closed) {
        destroySocket(tlsSocket);
        destroySocket(diodeSocket);
        throw new Error('Native handshake was cancelled');
      }
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tlsSocket.off('secureConnect', onSecure);
        tlsSocket.off('error', onError);
        tlsSocket.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onSecure = () => finish();
      const onError = (error) => finish(error);
      const onClose = () => finish(new Error('TLS handshake socket closed'));
      const timer = setTimeout(() => {
        finish(new Error('TLS handshake timeout'));
        destroySocket(tlsSocket);
      }, normalizeTimerMs(this.handshakeTimeoutMs, 10000));
      tlsSocket.once('secureConnect', onSecure);
      tlsSocket.once('error', onError);
      tlsSocket.once('close', onClose);
    });

    return { tlsSocket, socketWrapper };
  }

  async _performNativeHandshake(connection, rpc, deviceId, targetPort, physicalPort, context = null) {
    const handshakePort = `tls:${targetPort}#hs`;
    const ref = await this._withTimeout(
      () => rpc.portOpen(deviceId, handshakePort, 'rw', { timeoutMs: this.portOpenTimeoutMs }),
      this.portOpenTimeoutMs,
      `native handshake portopen ${handshakePort}`
    );
    if (!ref) {
      throw new Error('Handshake portopen failed');
    }

    let tlsSocket;
    let diodeSocket;
    let socketWrapper;
    let handshakeComplete = false;
    try {
      if (context && context.closed) throw new Error('Native handshake was cancelled');
      ({ tlsSocket, socketWrapper } = await this._openTlsHandshakeChannel(
        connection,
        rpc,
        ref,
        context
      ));
      diodeSocket = socketWrapper.diodeSocket;
      if (context && context.closed) throw new Error('Native handshake was cancelled');

      const localDeviceId = connection.getEthereumAddress().toLowerCase();
      const remoteDeviceId = `0x${Buffer.from(deviceId).toString('hex')}`.toLowerCase();
      const { message, privKey, nonce } = nativeCrypto.createHandshakeMessage({
        role: 'bind',
        deviceId: localDeviceId,
        physicalPort,
        privateKey: connection.getPrivateKey()
      });

      const reading = nativeCrypto.readHandshakeMessage(tlsSocket, this.handshakeTimeoutMs);
      const [, peerMessage] = await Promise.all([
        nativeCrypto.writeHandshakeMessage(tlsSocket, message),
        reading,
      ]);
      if (context && context.closed) throw new Error('Native handshake was cancelled');
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

      handshakeComplete = true;
      return session;
    } finally {
      // This short-lived channel carries one complete, signed exchange. Flush
      // its relay ACKs without writing close_notify: the peer can already have
      // released the API ref after its reply, so a new TLS alert can fail and
      // incorrectly tear down the authenticated native session.
      if (handshakeComplete && diodeSocket && tlsSocket && !diodeSocket.destroyed) {
        try { await diodeSocket.flush(); } catch (_) {}
      }
      let currentWrapper;
      try { currentWrapper = connection.getClientSocket(ref); } catch {}
      const expectedWrapper = socketWrapper || (context && context.clientSocketWrapper);
      const refWasReused = currentWrapper && expectedWrapper && currentWrapper !== expectedWrapper;
      if (!refWasReused) {
        try { await rpc.portClose(ref, { timeoutMs: this.portOpenTimeoutMs }); } catch {}
        try {
          if (!currentWrapper || connection.getClientSocket(ref) === expectedWrapper) {
            connection.deleteClientSocket(ref);
          }
        } catch {}
      }
      if (context) {
        if (tlsSocket) context.sockets.delete(tlsSocket);
        if (diodeSocket) context.sockets.delete(diodeSocket);
      }
      destroySocket(tlsSocket);
      destroySocket(diodeSocket);
    }
  }
  
  _setupMessageListener() {
    const rootConnection = this.connection;
    if (!rootConnection || typeof rootConnection.on !== 'function') {
      return;
    }

    let state = rootConnection[BIND_PORT_LISTENER_STATE];
    if (!state) {
      state = { weakInstances: new Set() };
      rootConnection[BIND_PORT_LISTENER_STATE] = state;
      state.notify = (method, ...args) => {
        for (const weakInstance of Array.from(state.weakInstances)) {
          const instance = weakInstance.deref();
          if (!instance) {
            state.weakInstances.delete(weakInstance);
          } else {
            instance[method](...args);
          }
        }
      };

      // Data routing is shared per manager. The dispatcher does not retain any
      // BindPort instance; the registered client wrapper owns its own cleanup.
      state.onUnsolicited = (message, sourceConnection) => {
        try {
          const connection = sourceConnection || rootConnection;
          if (!connection || typeof connection.getClientSocket !== 'function') return;
          const validated = validateBindUnsolicited(message);
          if (validated.error) {
            logger.warn(() => `Ignoring malformed unsolicited bind frame: ${validated.error}`);
            return;
          }
          const { messageContent, messageType } = validated;

          if (messageType === 'data' || messageType === 'portsend') {
            const dataRef = toBufferView(messageContent[1]);
            const data = toBufferView(messageContent[2]);
            const clientSocket = connection.getClientSocket(dataRef);
            if (!clientSocket) {
              logger.debug(() => `No bind client socket for ref: ${dataRef.toString('hex')}`);
              return;
            }
            if (clientSocket._diodeOwner && clientSocket._diodeContext) {
              clientSocket._diodeOwner._touchContext(clientSocket._diodeContext);
            }
            if (clientSocket.diodeSocket) clientSocket.diodeSocket.pushData(data);
            else writeWithBoundedBackpressure(clientSocket, data, connection);
            return;
          }

          if (messageType === 'portclose') {
            const dataRef = toBufferView(messageContent[1]);
            const clientSocket = connection.getClientSocket(dataRef);
            if (clientSocket && clientSocket._diodeOwner && clientSocket._diodeContext) {
              clientSocket._diodeOwner._endContextFromRemote(clientSocket._diodeContext);
            } else {
              destroySocket(clientSocket && (clientSocket.tlsSocket || clientSocket.diodeSocket || clientSocket));
              try { connection.deleteClientSocket(dataRef); } catch (_) {}
            }
            logger.info(() => `Port closed for ref: ${dataRef.toString('hex')}`);
          }
        } catch (error) {
          logger.error(() => `Bind unsolicited dispatcher failed: ${error}`);
        }
      };
      rootConnection.on('unsolicited', state.onUnsolicited);
      state.onDisconnect = (payload) => state.notify('_handleRootDisconnect', payload);
      state.onEnd = () => state.notify('_handleRootDisconnect', null);
      state.onError = (error, sourceConnection) => {
        logger.error(() => `Connection error: ${error}`);
        state.notify('_handleRootDisconnect', sourceConnection || null);
      };
      rootConnection.on('disconnect', state.onDisconnect);
      rootConnection.on('end', state.onEnd);
      rootConnection.on('error', state.onError);
    }
    this._listenerState = state;
    this._listenerRef = new WeakRef(this);
    state.weakInstances.add(this._listenerRef);
  }

  _handleRootDisconnect(payload) {
    const disconnected = payload && payload.connection
      ? payload.connection
      : (payload && payload.socket ? payload : (this._isManager() ? null : this.connection));
    this._closeConnectionContexts(disconnected, { notifyRemote: false });
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
      server._diodeClosed = true;
      this._closeServerContexts(server);
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
      server._diodeClosed = true;
      this._closeServerContexts(server);
      try { server.close(); } catch (_) {}
      logger.info(() => `Server on port ${localPort} closed`);
    }
    this.servers.clear();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.closeAllServers();
    if (this._listenerState && this._listenerRef) {
      this._listenerState.weakInstances.delete(this._listenerRef);
      if (this._listenerState.weakInstances.size === 0
        && this.connection && typeof this.connection.off === 'function') {
        this.connection.off('unsolicited', this._listenerState.onUnsolicited);
        this.connection.off('disconnect', this._listenerState.onDisconnect);
        this.connection.off('end', this._listenerState.onEnd);
        this.connection.off('error', this._listenerState.onError);
        if (this.connection[BIND_PORT_LISTENER_STATE] === this._listenerState) {
          delete this.connection[BIND_PORT_LISTENER_STATE];
        }
      }
    }
  }

  _handleServerError(error, localPort, server) {
    logger.error(() => `Local bind server error on port ${localPort}: ${error}`);
    server._diodeClosed = true;
    this._closeServerContexts(server);
    const portKey = Number(localPort);
    if (this.servers.get(portKey) === server) {
      this.servers.delete(portKey);
    }
    try { server.close(); } catch (_) {}
    this.emit('bindError', error, { localPort: Number(localPort) });
    if (this.listenerCount('error') > 0) {
      this.emit('error', error, { localPort: Number(localPort) });
    }
  }

  async _getOrOpenNativeUdpRelay(server, clientKey, options) {
    if (server._diodeClosed) throw new Error('UDP bind server is closed');
    if (!server.nativeRelays) server.nativeRelays = Object.create(null);
    const existing = server.nativeRelays[clientKey];
    if (existing) return existing.openPromise ? existing.openPromise : existing;

    const opening = { openPromise: null };
    server.nativeRelays[clientKey] = opening;
    opening.openPromise = (async () => {
      const {
        deviceId,
        deviceIdHex,
        formattedTargetPort,
        config,
        localPort,
        targetPort,
        rinfo,
      } = options;
      let connection;
      let rpc;
      let physicalPort;
      let relayInfo = null;
      try {
        const flags = config.flags || 'rwu';
        ({ connection, rpc, physicalPort } = await this._openNativePortWithRelayFallback(
          deviceId, deviceIdHex, formattedTargetPort, flags
        ));
        if (server._diodeClosed) {
          throw new Error('UDP bind server closed during portopen2');
        }

        const relaySocket = dgram.createSocket('udp4');
        relayInfo = {
          socket: relaySocket,
          physicalPort,
          relayHost: connection.getServerRelayHost(),
          connection,
          session: null,
          handshakePromise: null,
          client: { address: rinfo.address, port: rinfo.port },
        };
        relaySocket.on('message', (msg) => {
          if (!relayInfo.session || relayInfo.context.closed) return;
          this._touchContext(relayInfo.context);
          const plaintext = nativeCrypto.parseUdpPacket(relayInfo.session, msg);
          if (!plaintext) return;
          server.send(plaintext, rinfo.port, rinfo.address);
        });
        relaySocket.on('error', (error) => {
          logger.error(() => `UDP relay socket error: ${error}`);
          if (relayInfo.context) this._closeContext(relayInfo.context);
          else destroySocket(relaySocket);
        });
        relayInfo.context = this._trackContext(server, localPort, {
          connection,
          rpc,
          physicalPort,
          udp: true,
          sockets: new Set([relaySocket]),
          cleanup: () => {
            if (server.nativeRelays && server.nativeRelays[clientKey] === relayInfo) {
              delete server.nativeRelays[clientKey];
            }
          },
        });
        relaySocket.bind(0);
        if (server._diodeClosed || server.nativeRelays[clientKey] !== opening) {
          this._closeContext(relayInfo.context);
          throw new Error('UDP bind server closed during native relay setup');
        }
        server.nativeRelays[clientKey] = relayInfo;
        this._touchContext(relayInfo.context);
        logger.info(() => `Portopen2 ${formattedTargetPort} opened with server port ${physicalPort} for udp client ${clientKey}`);
        return relayInfo;
      } catch (error) {
        if (relayInfo && relayInfo.context) this._closeContext(relayInfo.context);
        else if (physicalPort && connection) this._closeNativePort({ connection, rpc, physicalPort });
        throw error;
      } finally {
        if (server.nativeRelays && server.nativeRelays[clientKey] === opening && server._diodeClosed) {
          delete server.nativeRelays[clientKey];
        }
      }
    })();

    try {
      return await opening.openPromise;
    } catch (error) {
      if (server.nativeRelays && server.nativeRelays[clientKey] === opening) {
        delete server.nativeRelays[clientKey];
      }
      throw error;
    }
  }

  async _getOrOpenApiUdpEntry(server, clientKey, options) {
    if (server._diodeClosed) throw new Error('UDP bind server is closed');
    if (!server.clientRefs) server.clientRefs = Object.create(null);
    const existing = server.clientRefs[clientKey];
    if (existing) return existing.openPromise ? existing.openPromise : existing;

    const opening = { openPromise: null };
    server.clientRefs[clientKey] = opening;
    opening.openPromise = (async () => {
      const { deviceId, deviceIdHex, formattedTargetPort, localPort, rinfo } = options;
      let opened;
      let entry = null;
      try {
        opened = await this._openApiPortWithRelayFallback(
          deviceId,
          deviceIdHex,
          formattedTargetPort,
          'rw'
        );
        const { ref, connection, rpc } = opened;
        if (server._diodeClosed) {
          void Promise.resolve(rpc.portClose(ref, { timeoutMs: this.portOpenTimeoutMs })).catch(() => {});
          throw new Error('UDP bind server closed during portopen');
        }
        entry = { ref, connection, rpc };
        const socketWrapper = {
          address: rinfo.address,
          port: rinfo.port,
          protocol: 'udp',
          write: (data) => server.send(data, rinfo.port, rinfo.address),
        };
        const context = this._trackContext(server, localPort, {
          connection,
          rpc,
          ref,
          udp: true,
          cleanup: () => {
            if (server.clientRefs && server.clientRefs[clientKey] === entry) {
              delete server.clientRefs[clientKey];
            }
          },
        });
        entry.context = context;
        socketWrapper._diodeOwner = this;
        socketWrapper._diodeContext = context;
        context.clientSocketWrapper = socketWrapper;
        this._replaceClientSocket(connection, ref, socketWrapper);
        if (server._diodeClosed || server.clientRefs[clientKey] !== opening) {
          this._closeContext(context);
          throw new Error('UDP bind server closed during API relay setup');
        }
        server.clientRefs[clientKey] = entry;
        this._touchContext(context);
        logger.info(() => `Port ${formattedTargetPort} opened on device with ref ${ref.toString('hex')} for udp client ${clientKey}`);
        return entry;
      } catch (error) {
        if (entry && entry.context) this._closeContext(entry.context);
        throw error;
      }
    })();

    try {
      return await opening.openPromise;
    } catch (error) {
      if (server.clientRefs && server.clientRefs[clientKey] === opening) {
        delete server.clientRefs[clientKey];
      }
      throw error;
    }
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
      server._diodeClosed = false;
      
      server.on('listening', () => {
        logger.info(() => `udp server listening on port ${localPort} forwarding to device port ${targetPort}`);
        this.emit('listening', {
          localPort: Number(server.address().port),
          requestedLocalPort: Number(localPort),
          address: server.address(),
          targetPort: Number(targetPort),
          protocol: 'udp',
        });
      });
      
      server.on('message', async (data, rinfo) => {
        const clientKey = `${rinfo.address}:${rinfo.port}`;
        if (useNative) {
          let relayInfo;
          try {
            relayInfo = await this._getOrOpenNativeUdpRelay(server, clientKey, {
              deviceId,
              deviceIdHex,
              formattedTargetPort,
              config,
              localPort,
              targetPort,
              rinfo,
            });
          } catch (error) {
            logger.error(() => `Error opening native UDP ${formattedTargetPort} on device: ${error}`);
            return;
          }

          if (!relayInfo || relayInfo.context.closed || server._diodeClosed) return;

          if (!relayInfo.handshakePromise) {
            const rpc = this._getRpcFor(relayInfo.connection);
            relayInfo.handshakePromise = this._performNativeHandshake(
              relayInfo.connection,
              rpc,
              deviceId,
              targetPort,
              relayInfo.physicalPort,
              relayInfo.context
            ).then((session) => {
              if (relayInfo.context.closed) {
                throw new Error('Native UDP session closed during handshake');
              }
              relayInfo.session = session;
              return session;
            }).catch((error) => {
              logger.error(() => `Native UDP handshake failed: ${error}`);
              this._closeContext(relayInfo.context);
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
            this._touchContext(relayInfo.context);
            const packet = nativeCrypto.createUdpPacket(relayInfo.session, data);
            relayInfo.socket.send(packet, relayInfo.physicalPort, relayInfo.relayHost);
          } catch (error) {
            logger.error(() => `Error sending udp data to relay: ${error}`);
          }
          return;
        }

        // Legacy API relay
        let entry;
        try {
          entry = await this._getOrOpenApiUdpEntry(server, clientKey, {
            deviceId,
            deviceIdHex,
            formattedTargetPort,
            localPort,
            rinfo,
          });
        } catch (error) {
          logger.error(() => `Error opening UDP ${formattedTargetPort} on device: ${error}`);
          return;
        }

        if (!entry || entry.context.closed || server._diodeClosed) return;
        
        // Send data to the device
        try {
          this._touchContext(entry.context);
          const rpc = this._getRpcFor(entry.connection);
          await rpc.portSend(entry.ref, data, { timeoutMs: this.ioTimeoutMs });
        } catch (error) {
          logger.error(() => `Error sending udp data to device: ${error}`);
          this._closeContext(entry.context);
        }
      });
      
      server.on('error', (err) => this._handleServerError(err, localPort, server));
      
      server.on('close', () => {
        server._diodeClosed = true;
        this._closeServerContexts(server);
        server.nativeRelays = null;
        server.clientRefs = null;
      });

      server.bind(localPort);
      this.servers.set(parseInt(localPort), server);
    } else {
      // For TCP and tls protocols, use TCP server locally
      const server = net.createServer({ allowHalfOpen: useNative }, async (clientSocket) => {
        logger.info(() => `Client connected to local server on port ${localPort}`);
        clientSocket.setNoDelay(true);
        // Do not consume application bytes until a remote ref and all routing
        // handlers are installed. This also bounds pre-open buffering in Node.
        clientSocket.pause();

        const context = this._trackContext(server, localPort, {
          connection: null,
          rpc: null,
          ref: null,
          sockets: new Set([clientSocket]),
        });

        let connection = null;
        let rpc = null;

        let ref;
        let clientClosed = false;
        let remoteCleanupStarted = false;
        let tlsSocketWrapper = null;

        const closeRemoteRef = async () => {
          if (remoteCleanupStarted) return;
          remoteCleanupStarted = true;
          this._closeContext(context, { notifyRemote: !context.remoteEnded });
        };

        const finishClientWrites = () => {
          if (!context.finishWrites) return closeRemoteRef();
          if (!context.finishingWrites) {
            context.finishingWrites = Promise.resolve().then(() => context.finishWrites())
              .catch((error) => logger.debug(() => `Bind write shutdown: ${error.message}`))
              .finally(closeRemoteRef);
          }
          return context.finishingWrites;
        };

        clientSocket.once('close', (hadError) => {
          clientClosed = true;
          if (!hadError && clientSocket.readableEnded) finishClientWrites();
          else closeRemoteRef();
        });
        clientSocket.once('error', (err) => {
          logger.error(() => `Client socket error: ${err}`);
        });

        if (useNative) {
          // Open a new native relay port on the device for this client
          let physicalPort;
          try {
            const flags = config.flags || 'rw';
            ({ connection, rpc, physicalPort } = await this._openNativePortWithRelayFallback(
              deviceId, deviceIdHex, formattedTargetPort, flags
            ));
          } catch (error) {
            logger.error(() => `Error opening portopen2 ${formattedTargetPort} on device: ${error}`);
            clientSocket.destroy();
            return;
          }
          context.connection = connection;
          context.rpc = rpc;
          context.physicalPort = physicalPort;
          this._acquireNativeLease(context);
          if (clientClosed || context.closed || clientSocket.destroyed) {
            this._closeNativePort(context);
            return;
          }

          const relayHost = connection.getServerRelayHost();
          let relaySocket;
          try {
            relaySocket = net.connect({ host: relayHost, port: physicalPort, allowHalfOpen: true, autoSelectFamily: false });
          } catch (error) {
            logger.error(() => `Could not create native relay socket: ${error}`);
            this._closeContext(context);
            return;
          }
          relaySocket.setNoDelay(true);
          relaySocket.pause();
          context.sockets.add(relaySocket);

          let session = null;
          let bridge = null;
          const cleanup = () => {
            this._closeContext(context);
          };

          relaySocket.on('error', (err) => {
            logger.error(() => `Relay socket error: ${err}`);
            cleanup();
          });
          relaySocket.on('close', () => { if (!bridge) cleanup(); });

          try {
            await new Promise((resolve, reject) => {
              let settled = false;
              const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                relaySocket.off('connect', onConnect);
                relaySocket.off('error', onConnectError);
                relaySocket.off('close', onConnectClose);
                if (error) reject(error);
                else resolve();
              };
              const onConnect = () => finish();
              const onConnectError = (error) => finish(error);
              const onConnectClose = () => finish(new Error('Relay socket closed before connect'));
              const timer = setTimeout(
                () => finish(new Error(`Relay socket connection timed out for ${relayHost}:${physicalPort}`)),
                normalizeTimerMs(this.portOpenTimeoutMs, 5000)
              );
              relaySocket.once('connect', onConnect);
              relaySocket.once('error', onConnectError);
              relaySocket.once('close', onConnectClose);
            });
          } catch (error) {
            logger.error(() => `Native TCP relay connection failed: ${error}`);
            cleanup();
            return;
          }
          logger.info(() => `Connected to relay ${relayHost}:${physicalPort} for ${formattedTargetPort}`);

          if (clientClosed || context.closed || clientSocket.destroyed) {
            cleanup();
            return;
          }

          // Establish the native relay socket before completing the crypto
          // handshake. The publisher resumes its backend immediately after the
          // handshake, so reversing this order can lose an SSH/banner first byte.
          try {
            session = await this._performNativeHandshake(
              connection,
              rpc,
              deviceId,
              targetPort,
              physicalPort,
              context
            );
          } catch (error) {
            logger.error(() => `Native TCP handshake failed: ${error}`);
            cleanup();
            return;
          }

          if (clientClosed || context.closed || clientSocket.destroyed) {
            cleanup();
            return;
          }

          // Both sockets stayed paused during authentication. Stream pipes now
          // bound each direction and propagate FIN after queued bytes drain.
          bridge = bridgeNativeTcp({
            localSocket: clientSocket,
            relaySocket,
            session,
            onClose: cleanup,
            onError: (error) => logger.error(() => `Native TCP stream failed: ${error}`),
          });
          context.cleanup = () => bridge.destroy();
          context.finishWrites = () => bridge.closed;

          return;
        }

        // Legacy API relay
        try {
          const opened = await this._openApiPortWithRelayFallback(deviceId, deviceIdHex, formattedTargetPort, 'rw');
          connection = opened.connection;
          rpc = opened.rpc;
          ref = opened.ref;
          context.connection = connection;
          context.rpc = rpc;
          context.ref = ref;
          logger.info(() => `Port ${formattedTargetPort} opened on device with ref: ${ref.toString('hex')} for client`);
        } catch (error) {
          logger.error(() => `Error opening port ${formattedTargetPort} on device: ${error}`);
          clientSocket.destroy();
          return;
        }

        if (clientClosed || clientSocket.destroyed) {
          logger.warn(() => `Local client disconnected before port ${formattedTargetPort} opened; closing ref ${ref.toString('hex')}`);
          try { connection.deleteClientSocket(ref); } catch (_) {}
          try { await rpc.portClose(ref, { timeoutMs: this.portOpenTimeoutMs }); } catch (_) {}
          return;
        }

        if (protocol === 'tls') {
          // For tls protocol, create a proper tls connection
          try {
            // Create a DiodeSocket to handle communication with the device
            const diodeSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs, connection);
            
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
              closeRemoteRef();
            });
            
            // Store reference to the diodeSocket so we can push data to it
            const socketWrapper = {
              diodeSocket,
              tlsSocket,
              end: () => {
                try { tlsSocket.end(); } catch {}
                try { diodeSocket.destroy(); } catch {}
              }
            };
            tlsSocketWrapper = socketWrapper;
            context.finishWrites = () => diodeSocket.finishTlsWrites(tlsSocket);
            socketWrapper._diodeOwner = this;
            socketWrapper._diodeContext = context;
            context.sockets.add(tlsSocket);
            context.sockets.add(diodeSocket);
            
            // Store the socket wrapper
            context.clientSocketWrapper = socketWrapper;
            this._replaceClientSocket(connection, ref, socketWrapper);
            const secureTimer = setTimeout(() => {
              logger.error(() => `TLS connection timed out for device ${deviceIdHex}`);
              this._closeContext(context);
            }, normalizeTimerMs(this.handshakeTimeoutMs, 10000));
            tlsSocket.once('secureConnect', () => {
              clearTimeout(secureTimer);
              if (!clientSocket.destroyed) clientSocket.resume();
            });
            tlsSocket.once('close', () => {
              clearTimeout(secureTimer);
              if (!clientSocket.destroyed) {
                clientSocket.end();
              }
              // The local socket's close event cleans up after its buffered
              // plaintext has drained. Errors still destroy the context.
            });
            
          } catch (error) {
            logger.error(() => `Error setting up tls connection: ${error}`);
            if (tlsSocketWrapper && typeof tlsSocketWrapper.end === 'function') {
              tlsSocketWrapper.end();
            }
            await closeRemoteRef();
            clientSocket.destroy();
            return;
          }
        } else {
          // For TCP protocol, just use the raw socket
          clientSocket._diodeOwner = this;
          clientSocket._diodeContext = context;
          context.clientSocketWrapper = clientSocket;
          this._replaceClientSocket(connection, ref, clientSocket);
          
          // Raw TCP uses the same bounded send window as TLS. Keep inbound
          // routing on the client socket while pipe applies outbound pressure.
          const sendSocket = new DiodeSocket(ref, rpc, this.ioTimeoutMs);
          context.sendSocket = sendSocket;
          context.sockets.add(sendSocket);
          let finishPromise;
          context.finishWrites = () => {
            if (!finishPromise) {
              finishPromise = new Promise((resolve, reject) => {
                sendSocket.end((error) => error ? reject(error) : resolve());
              });
            }
            return finishPromise;
          };
          sendSocket.on('error', (error) => {
            logger.error(() => `Error sending data to device: ${error}`);
            this._closeContext(context);
          });
          clientSocket.pipe(sendSocket);
        }

        // Handle client socket closure (common for all protocols)
        clientSocket.once('end', () => {
          logger.info(() => 'Client disconnected');
          finishClientWrites();
        });
      });
      server._diodeClosed = false;

      server.listen(localPort, () => {
        logger.info(() => `Local server listening on port ${localPort} forwarding to device ${protocol} port ${targetPort}`);
        this.emit('listening', {
          localPort: Number(server.address().port),
          requestedLocalPort: Number(localPort),
          address: server.address(),
          targetPort: Number(targetPort),
          protocol,
        });
      });
      server.on('error', (err) => this._handleServerError(err, localPort, server));
      server.on('close', () => {
        server._diodeClosed = true;
        this._closeServerContexts(server);
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
