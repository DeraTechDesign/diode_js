// connection.js
const tls = require('tls');
const fs = require('fs');
const { RLP } = require('@ethereumjs/rlp');
const EventEmitter = require('events');
const {
  makeReadable,
  parseRequestId,
  parseResponseType,
  parseReason,
  parseUInt,
  generateCert,
  ensureDirectoryExistence,
  loadOrGenerateKeyPair,
  toBufferView,
  DEFAULT_FLEET_CONTRACT,
  normalizeFleetContractAddress,
} = require('./utils');
const { Buffer } = require('buffer'); // Import Buffer
const asn1 = require('asn1.js');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');
const crypto = require('crypto');
const DiodeRPC = require('./rpc');
const abi = require('ethereumjs-abi');
const logger = require('./logger');
const path = require('path');
// Add dotenv for environment variables
require('dotenv').config();

const MAX_NODE_TIMER_MS = 0x7fffffff;

function normalizeTimerMs(value, fallback) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  const parsedFallback = typeof fallback === 'number' ? fallback : parseInt(fallback, 10);
  const safeFallback = Number.isFinite(parsedFallback) && parsedFallback > 0
    ? Math.max(1, Math.min(Math.floor(parsedFallback), MAX_NODE_TIMER_MS))
    : 1;
  if (!Number.isFinite(parsed) || parsed <= 0) return safeFallback;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_NODE_TIMER_MS));
}

function decodeUnsolicitedMessageType(raw) {
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) return null;
  if (raw.byteLength === 0) return null;
  return toBufferView(raw).toString('utf8');
}

// Try to use native keccak if available (optional perf boost)
let nativeKeccak = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  nativeKeccak = require('keccak');
} catch (_) {
  // optional dependency; fallback to ethereumjs-util.keccak256
}

class DiodeConnectionError extends Error {
  constructor(message, code = 'DIODE_CONNECTION_ERROR', options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.command !== undefined) this.command = options.command;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    this.retryable = options.retryable === true;
  }
}

class DiodeCommandTimeoutError extends DiodeConnectionError {
  constructor(command, timeoutMs, requestId = undefined) {
    const commandName = Array.isArray(command) && command.length > 0 ? String(command[0]) : 'command';
    super(`${commandName} timed out after ${timeoutMs}ms`, 'DIODE_COMMAND_TIMEOUT', {
      command: commandName,
      requestId,
      retryable: true,
    });
    this.timeoutMs = timeoutMs;
  }
}

class DiodeCommandAbortedError extends DiodeConnectionError {
  constructor(command, requestId = undefined, reason = undefined) {
    const commandName = Array.isArray(command) && command.length > 0 ? String(command[0]) : 'command';
    super(`${commandName} was aborted`, 'DIODE_COMMAND_ABORTED', {
      command: commandName,
      requestId,
      cause: reason instanceof Error ? reason : undefined,
      retryable: true,
    });
    if (reason !== undefined) this.reason = reason;
  }
}

class DiodeDisconnectedError extends DiodeConnectionError {
  constructor(message = 'Diode relay connection was lost', options = {}) {
    super(message, 'DIODE_DISCONNECTED', { ...options, retryable: true });
  }
}

class DiodeResponseError extends DiodeConnectionError {
  constructor(reason, requestId = undefined) {
    const message = reason instanceof Error ? reason.message : String(reason || 'Diode relay returned an error');
    super(message, 'DIODE_RESPONSE_ERROR', { cause: reason instanceof Error ? reason : undefined, requestId });
  }
}

class DiodeConnection extends EventEmitter {
  constructor(host, port, keyLocation = './db/keys.json') {
    super();
    this.host = host;
    this.port = port;
    this.keyLocation = keyLocation;
    this.socket = null;
    this.requestId = 0; // Initialize request ID counter
    this.pendingRequests = new Map(); // Map to store pending requests
    this.totalConnections = 0;
    this.totalBytes = 128000; // start with 128KB
    // Add buffer to handle partial data
    this.receiveBuffer = Buffer.alloc(0);
    this.RPC = new DiodeRPC(this);
    this.isReconnecting = false;
    this.connectPromise = null;
    this._connectAttempt = null;
    this._cancelConnectAttempt = null;
    this._resolveReconnectWaiter = null;
    this._rejectReconnectWaiter = null;
    this._ready = false;
    this._transportReady = false;
    this._closed = false;
    this._socketGeneration = 0;
    this._lastDisconnectedGeneration = -1;
    this._lifecycleGeneration = 0;
    this._deferredUnsolicited = new Set();
    
    // Add maps for storing client sockets and connections
    this.clientSockets = new Map(); // For BindPort
    this.connections = new Map(); // For PublishPort
    this.certPem = null;
    this._serverEthAddress = null; // cache after first read
    this.localAddressProvider = null;
    this.fleetContractHex = DEFAULT_FLEET_CONTRACT;
    this.fleetContract = Buffer.from(DEFAULT_FLEET_CONTRACT.slice(2), 'hex');
    // Load or generate keypair
    this.keyPair = loadOrGenerateKeyPair(this.keyLocation);
    
    // Load reconnection properties from environment variables with defaults
    const envMaxRetries = process.env.DIODE_MAX_RETRIES;
    this.maxRetries = envMaxRetries !== undefined ? 
                      (envMaxRetries.toLowerCase() === 'infinity' ? Infinity : parseInt(envMaxRetries, 10)) : 
                      Infinity;
    
    this.retryDelay = normalizeTimerMs(process.env.DIODE_RETRY_DELAY, 1000); // Default: 1 second
    this.maxRetryDelay = normalizeTimerMs(process.env.DIODE_MAX_RETRY_DELAY, 30000); // Default: 30 seconds
    
    // Parse boolean from string ('true'/'false')
    const envAutoReconnect = process.env.DIODE_AUTO_RECONNECT;
    this.autoReconnect = envAutoReconnect !== undefined ? 
                        (envAutoReconnect.toLowerCase() === 'true') : 
                        true;
    
    this.retryCount = 0;
    this.retryTimeoutId = null;
    const parsedCommandTimeout = parseInt(
      process.env.DIODE_COMMAND_TIMEOUT_MS || process.env.DIODE_COMMAND_TIMEOUT,
      10
    );
    this.commandTimeoutMs = normalizeTimerMs(parsedCommandTimeout, 15000);
    const parsedConnectTimeout = parseInt(
      process.env.DIODE_CONNECT_TIMEOUT_MS || process.env.DIODE_CONNECT_TIMEOUT,
      10
    );
    this.connectTimeoutMs = normalizeTimerMs(parsedConnectTimeout, 30000);
    
    // Log the reconnection settings
    logger.info(() => `Connection settings - Auto Reconnect: ${this.autoReconnect}, Max Retries: ${
      this.maxRetries === Infinity ? 'Infinity' : this.maxRetries
    }, Retry Delay: ${this.retryDelay}ms, Max Retry Delay: ${this.maxRetryDelay}ms`);

    // Add ticket batching configuration
    this.lastTicketUpdate = Date.now();
    this.accumulatedBytes = 0;
    this.ticketUpdateThreshold = parseInt(process.env.DIODE_TICKET_BYTES_THRESHOLD, 10) || 4 * 1024 * 1024; // 4MB default
    this.ticketUpdateInterval = normalizeTimerMs(process.env.DIODE_TICKET_UPDATE_INTERVAL, 30000); // 30 seconds default
    this.ticketUpdateTimer = null;
    this.ticketUpdateInFlight = false;
    this._ticketUpdateToken = null;
    this.pendingTicketUpdateForce = false;
    this.lastAcceptedTicketBytes = 0;
    this.lastRelayMeasuredBytes = 0;
    
    // Log the ticket batching settings
    logger.info(() => `Ticket batching settings - Bytes Threshold: ${this.ticketUpdateThreshold} bytes, Update Interval: ${this.ticketUpdateInterval}ms`);

    // Handle server ticket requests on the API socket
    this._onUnsolicited = (message) => {
      try {
        this._handleUnsolicitedMessage(message);
      } catch (error) {
        // Keep connection-owned dispatch failures inside the deferred library
        // boundary. Other listeners still run in normal EventEmitter order and
        // retain their usual error semantics.
        logger.error(() => `Connection unsolicited dispatcher failed: ${error}`);
      }
    };
    this.on('unsolicited', this._onUnsolicited);
  }

  isReady() {
    return Boolean(
      this._ready &&
      this._transportReady &&
      this.socket &&
      !this.socket.destroyed &&
      this.socket.writable !== false
    );
  }

  _assertCurrentTransport(expectedSocket, expectedGeneration, phase = 'Diode operation') {
    if (
      !expectedSocket ||
      expectedSocket !== this.socket ||
      expectedGeneration !== this._socketGeneration ||
      this._closed ||
      expectedSocket.destroyed ||
      expectedSocket.writable === false
    ) {
      throw new DiodeDisconnectedError(`${phase} belongs to a stale Diode connection`);
    }
    return expectedSocket;
  }

  connect() {
    if (this.isReady()) return Promise.resolve();
    if (this._connectAttempt) return this._connectAttempt;

    this._closed = false;
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
      // An explicit connect supersedes the scheduled reconnect. Do not leave
      // the reconnect guard latched after cancelling its timer.
      this.isReconnecting = false;
    }

    const generation = ++this._socketGeneration;
    const connectTimeoutMs = normalizeTimerMs(this.connectTimeoutMs, 30000);
    this.connectTimeoutMs = connectTimeoutMs;
    this._lastDisconnectedGeneration = Math.min(this._lastDisconnectedGeneration, generation - 1);
    this._ready = false;
    this._transportReady = false;
    this.receiveBuffer = Buffer.alloc(0);
    this._serverEthAddress = null;

    const attempt = new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer = null;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (error) reject(error);
        else resolve();
      };
      this._cancelConnectAttempt = (error) => settle(
        error instanceof Error ? error : new DiodeDisconnectedError()
      );

      // Generate a temporary certificate valid for 1 month.
      this.certPem = generateCert(this.keyPair.prvKeyObj, this.keyPair.pubKeyObj);
      const options = {
        cert: this.certPem,
        key: this.certPem,
        rejectUnauthorized: false,
        ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
        ecdhCurve: 'secp256k1',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      };

      let socket;
      try {
        socket = tls.connect(this.port, this.host, options, async () => {
          if (generation !== this._socketGeneration || socket !== this.socket || this._closed) return;
          this._transportReady = true;
          const relayHost = this.getServerRelayHost(socket);
          const relayPort = socket.remotePort || this.port;
          logger.info(() => `Connected to Diode relay ${relayHost}:${relayPort}`);
          socket.setKeepAlive(true, 1500);
          socket.setNoDelay(true);

          try {
            const handshakeOptions = {
              allowTransportReady: true,
              expectedSocket: socket,
              expectedGeneration: generation,
            };
            this._assertCurrentTransport(socket, generation, 'Diode handshake');
            const cachedServerAddress = await this._waitForServerEthereumAddress(handshakeOptions);
            this._assertCurrentTransport(socket, generation, 'Diode server identity lookup');
            if (cachedServerAddress) this._serverEthAddress = cachedServerAddress;
            this._assertCurrentTransport(socket, generation, 'Diode measured-byte synchronization');
            await this._syncMeasuredBytesWithRelay(handshakeOptions);
            this._assertCurrentTransport(socket, generation, 'Diode measured-byte synchronization');
            const ticketCommand = await this.createTicketCommand(handshakeOptions);
            this._assertCurrentTransport(socket, generation, 'Diode ticket creation');
            const ticketResponse = await this._sendCommandTransportReady(ticketCommand, handshakeOptions);
            this._assertCurrentTransport(socket, generation, 'Diode ticket submission');
            const ticketStatus = ticketResponse && ticketResponse[0] !== undefined
              ? parseResponseType(ticketResponse[0])
              : '';
            if (ticketStatus !== 'thanks!') {
              throw new DiodeConnectionError(
                `Diode relay rejected the connection ticket (${ticketStatus || 'empty response'})`,
                'DIODE_TICKET_REJECTED'
              );
            }

            this._assertCurrentTransport(socket, generation, 'Diode handshake completion');
            this._ready = true;
            this.isReconnecting = false;
            this.retryCount = 0;
            this._startTicketUpdateTimer();
            if (this._resolveReconnectWaiter) this._resolveReconnectWaiter();
            settle();
          } catch (error) {
            logger.error(() => `Error completing Diode handshake: ${error}`);
            settle(error instanceof Error ? error : new DiodeConnectionError(String(error)));
            if (!socket.destroyed) socket.destroy();
          }
        });
      } catch (error) {
        settle(error instanceof Error ? error : new DiodeConnectionError(String(error)));
        return;
      }

      this.socket = socket;
      socket._diodeGeneration = generation;

      socket.on('data', (data) => {
        if (generation !== this._socketGeneration || socket !== this.socket) return;
        this._recordTrafficBytes(data.length);
        try {
          this._handleData(data, generation);
        } catch (error) {
          logger.error(() => `Error handling data: ${error}`);
        }
      });

      socket.on('error', (err) => {
        if (generation !== this._socketGeneration) return;
        logger.error(() => `Connection error: ${err}`);
        settle(err instanceof Error ? err : new DiodeConnectionError(String(err)));
        this._handleDisconnect(socket, generation, err);
      });

      socket.on('end', () => {
        logger.info(() => 'Disconnected from server');
        const error = new DiodeDisconnectedError('Diode relay ended the connection');
        settle(error);
        this._handleDisconnect(socket, generation, error);
      });

      socket.on('close', (hadError) => {
        logger.info(() => `Connection closed${hadError ? ' due to error' : ''}`);
        const error = new DiodeDisconnectedError(
          hadError ? 'Diode relay connection closed due to an error' : 'Diode relay connection closed'
        );
        settle(error);
        this._handleDisconnect(socket, generation, error);
      });

      socket.on('timeout', () => {
        const error = new DiodeConnectionError(
          'Diode relay socket timed out',
          'DIODE_SOCKET_TIMEOUT',
          { retryable: true }
        );
        logger.warn(() => error.message);
        settle(error);
        this._handleDisconnect(socket, generation, error);
      });

      connectTimer = setTimeout(() => {
        if (settled) return;
        const error = new DiodeConnectionError(
          `Diode relay connection handshake timed out after ${connectTimeoutMs}ms`,
          'DIODE_CONNECT_TIMEOUT',
          { retryable: true }
        );
        settle(error);
        this._handleDisconnect(socket, generation, error);
      }, connectTimeoutMs);
    });

    this._connectAttempt = attempt;
    attempt.then(
      () => {
        if (this._connectAttempt === attempt) {
          this._connectAttempt = null;
          this._cancelConnectAttempt = null;
        }
      },
      () => {
        if (this._connectAttempt === attempt) {
          this._connectAttempt = null;
          this._cancelConnectAttempt = null;
        }
      }
    );
    return attempt;
  }

  // Schedule one reconnect attempt at a time. A failed attempt schedules the
  // next backoff rather than depending on socket event ordering.
  _reconnect() {
    if (!this.autoReconnect || this._closed || this.isReady()) return;
    if (this.isReconnecting || this.retryTimeoutId) return;

    this.retryCount++;
    if (this.maxRetries !== Infinity && this.retryCount > this.maxRetries) {
      const error = new DiodeConnectionError(
        `Maximum reconnection attempts (${this.maxRetries}) reached`,
        'DIODE_RECONNECT_FAILED',
        { retryable: true }
      );
      logger.error(() => error.message);
      this.isReconnecting = false;
      this.emit('reconnect_failed', error);
      return;
    }

    this.retryDelay = normalizeTimerMs(this.retryDelay, 1000);
    this.maxRetryDelay = normalizeTimerMs(this.maxRetryDelay, 30000);
    const delay = Math.min(this.retryDelay * Math.pow(1.5, this.retryCount - 1), this.maxRetryDelay);
    const lifecycleGeneration = this._lifecycleGeneration;
    this.isReconnecting = true;
    logger.info(() => `Reconnecting in ${delay}ms... (Attempt ${this.retryCount})`);
    this.emit('reconnecting', { attempt: this.retryCount, delay });

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null;
      if (
        lifecycleGeneration !== this._lifecycleGeneration ||
        !this.autoReconnect ||
        this._closed
      ) {
        this.isReconnecting = false;
        return;
      }

      this.connect()
        .then(() => {
          if (lifecycleGeneration !== this._lifecycleGeneration || this._closed) return;
          this.isReconnecting = false;
          if (!this.isReady()) {
            logger.warn(() => 'Diode relay disconnected before reconnect completion was observed');
            this._reconnect();
            return;
          }
          this.emit('reconnected', this);
          logger.info(() => 'Successfully reconnected to Diode.io server');
        })
        .catch((err) => {
          if (lifecycleGeneration !== this._lifecycleGeneration || this._closed) return;
          this.isReconnecting = false;
          logger.error(() => `Reconnection attempt failed: ${err}`);
          this._reconnect();
        });
    }, delay);
  }

  _rejectPendingRequests(error) {
    const rejection = error instanceof Error
      ? error
      : new DiodeDisconnectedError(String(error || 'Diode relay connection was lost'));
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const request of pending) {
      if (request && request.timeoutId) clearTimeout(request.timeoutId);
      try { request.reject(rejection); } catch (_) {}
    }
  }

  _closeSessionResource(resource) {
    if (!resource) return;
    for (const key of ['tlsSocket', 'diodeSocket', 'localSocket', 'relaySocket', 'socket']) {
      if (resource[key] && resource[key] !== resource) this._closeSessionResource(resource[key]);
    }
    try {
      if (typeof resource.destroy === 'function' && !resource.destroyed) resource.destroy();
      else if (typeof resource.close === 'function') resource.close();
      else if (typeof resource.end === 'function') resource.end();
      else if (typeof resource._destroy === 'function') resource._destroy(null, () => {});
    } catch (_) {}
  }

  _resetSessionState(error) {
    this.receiveBuffer = Buffer.alloc(0);
    for (const immediate of this._deferredUnsolicited) clearImmediate(immediate);
    this._deferredUnsolicited.clear();
    this._rejectPendingRequests(error);

    const clientSockets = Array.from(this.clientSockets.values());
    const connections = Array.from(this.connections.values());
    this.clientSockets.clear();
    this.connections.clear();
    for (const resource of clientSockets) this._closeSessionResource(resource);
    for (const resource of connections) this._closeSessionResource(resource);

    if (this.ticketUpdateTimer) {
      clearTimeout(this.ticketUpdateTimer);
      this.ticketUpdateTimer = null;
    }
    this._ticketUpdateToken = null;
    this.ticketUpdateInFlight = false;
    this.pendingTicketUpdateForce = false;
  }

  // Handle end/close exactly once for a socket generation. Stale events from
  // an older socket cannot tear down a newer relay connection.
  _handleDisconnect(socket = this.socket, generation = this._socketGeneration, error = null) {
    if (generation === this._lastDisconnectedGeneration) return;
    if (generation !== this._socketGeneration) return;
    this._lastDisconnectedGeneration = generation;

    const disconnectError = error instanceof Error
      ? error
      : new DiodeDisconnectedError();
    if (this._cancelConnectAttempt) this._cancelConnectAttempt(disconnectError);
    this._ready = false;
    this._transportReady = false;
    if (socket === this.socket) this.socket = null;
    this._resetSessionState(disconnectError);

    if (socket && !socket.destroyed) {
      try { socket.destroy(); } catch (_) {}
    }

    const info = { connection: this, error: disconnectError, generation };
    this.emit('disconnect', info);
    if (this.autoReconnect && !this._closed && !this.isReconnecting) this._reconnect();
  }

  _waitForReconnect() {
    if (this.connectPromise) return this.connectPromise;
    const connectTimeoutMs = normalizeTimerMs(this.connectTimeoutMs, 30000);
    const maxRetryDelay = normalizeTimerMs(this.maxRetryDelay, 30000);
    const timeoutMs = normalizeTimerMs(
      Math.max(connectTimeoutMs, maxRetryDelay + connectTimeoutMs),
      MAX_NODE_TIMER_MS
    );
    let timer;
    let onReconnected;
    let onFailed;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      this.off('reconnected', onReconnected);
      this.off('reconnect_failed', onFailed);
    };
    const promise = new Promise((resolve, reject) => {
      this._resolveReconnectWaiter = resolve;
      this._rejectReconnectWaiter = reject;
      onReconnected = () => resolve();
      onFailed = (error) => reject(error || new DiodeConnectionError('Reconnection failed'));
      this.once('reconnected', onReconnected);
      this.once('reconnect_failed', onFailed);
      timer = setTimeout(() => {
        reject(new DiodeConnectionError(
          `Reconnection timed out after ${timeoutMs}ms`,
          'DIODE_RECONNECT_TIMEOUT',
          { retryable: true }
        ));
      }, timeoutMs);
    });
    this.connectPromise = promise;
    promise.then(
      () => {
        cleanup();
        if (this.connectPromise === promise) {
          this.connectPromise = null;
          this._resolveReconnectWaiter = null;
          this._rejectReconnectWaiter = null;
        }
      },
      () => {
        cleanup();
        if (this.connectPromise === promise) {
          this.connectPromise = null;
          this._resolveReconnectWaiter = null;
          this._rejectReconnectWaiter = null;
        }
      }
    );
    return promise;
  }

  _ensureConnected({
    allowTransportReady = false,
    expectedSocket = undefined,
    expectedGeneration = undefined,
  } = {}) {
    const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
    if (hasExpectedTransport) {
      try {
        this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode command');
      } catch (error) {
        return Promise.reject(error);
      }
      if (this.isReady() || (allowTransportReady && this._transportReady)) {
        return Promise.resolve();
      }
      return Promise.reject(new DiodeDisconnectedError('Expected Diode transport is not ready'));
    }
    if (this.isReady()) {
      return Promise.resolve();
    }
    if (
      allowTransportReady &&
      this._transportReady &&
      this.socket &&
      !this.socket.destroyed &&
      this.socket.writable !== false
    ) {
      return Promise.resolve();
    }
    if (this._closed) {
      return Promise.reject(new DiodeDisconnectedError('Diode connection is closed'));
    }
    if (this._connectAttempt) return this._connectAttempt;
    if (!this.autoReconnect) return this.connect();
    const waiting = this._waitForReconnect();
    this._reconnect();
    return waiting;
  }

  // Method to set reconnection options
  setReconnectOptions(options = {}) {
    if (typeof options.maxRetries === 'number') {
      this.maxRetries = options.maxRetries;
    }
    if (typeof options.retryDelay === 'number') {
      this.retryDelay = normalizeTimerMs(options.retryDelay, this.retryDelay);
    }
    if (typeof options.maxRetryDelay === 'number') {
      this.maxRetryDelay = normalizeTimerMs(options.maxRetryDelay, this.maxRetryDelay);
    }
    if (typeof options.autoReconnect === 'boolean') {
      this.autoReconnect = options.autoReconnect;
    }
    return this;
  }

  setCommandOptions(options = {}) {
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      this.commandTimeoutMs = normalizeTimerMs(options.timeoutMs, this.commandTimeoutMs);
    }
    if (Number.isFinite(options.connectTimeoutMs) && options.connectTimeoutMs > 0) {
      this.connectTimeoutMs = normalizeTimerMs(options.connectTimeoutMs, this.connectTimeoutMs);
    }
    return this;
  }

  // Optional provider for LocalAddr ticket hint (Buffer or string)
  setLocalAddressProvider(provider) {
    this.localAddressProvider = typeof provider === 'function' ? provider : null;
    return this;
  }

  setFleetContract(fleetContract) {
    const normalizedFleetContract = normalizeFleetContractAddress(fleetContract);
    this.fleetContractHex = normalizedFleetContract;
    this.fleetContract = Buffer.from(normalizedFleetContract.slice(2), 'hex');
    return this;
  }

  close() {
    this.autoReconnect = false;
    this._closed = true;
    this._lifecycleGeneration++;
    this.isReconnecting = false;
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
    if (this._rejectReconnectWaiter) {
      this._rejectReconnectWaiter(new DiodeDisconnectedError('Diode connection was closed intentionally'));
    }
    const socket = this.socket;
    const generation = this._socketGeneration;
    this._handleDisconnect(
      socket,
      generation,
      new DiodeDisconnectedError('Diode connection was closed intentionally')
    );
  }

  _deferUnsolicited(message, generation = this._socketGeneration) {
    // A relay may coalesce a portopen response and the first portsend into one
    // TLS data event. Promise continuations need to finish registering the new
    // ref before the unsolicited payload is delivered.
    const immediate = setImmediate(() => {
      this._deferredUnsolicited.delete(immediate);
      if (
        generation !== this._socketGeneration ||
        generation === this._lastDisconnectedGeneration
      ) return;
      this.emit('unsolicited', message);
    });
    this._deferredUnsolicited.add(immediate);
  }

  _handleResponse(requestId, responseArray) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    try {
      if (!Array.isArray(responseArray) || responseArray.length === 0) {
        throw new DiodeResponseError('Malformed Diode relay response', requestId);
      }
      const [responseTypeRaw, ...responseData] = responseArray;
      const responseRaw = responseData[0];
      const responseType = parseResponseType(responseTypeRaw);

      logger.debug(() => `Received response for requestId: ${requestId}`);
      logger.debug(() => `Response Type: '${responseType}'`);

      if (responseType === 'response') {
        if (!Array.isArray(responseRaw) && makeReadable(responseRaw) === 'too_low') {
          const originalCommand = pending.commandArray;
          const retryCount = pending.ticketRetryCount || 0;
          const isTicketCommand = this._isTicketCommand(originalCommand);

          if (isTicketCommand && retryCount < 1) {
            this.fixResponse(responseData);
            const allowTransportReady = pending.allowTransportReady === true;
            const expectedSocket = pending.expectedSocket;
            const expectedGeneration = pending.expectedGeneration;
            const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
            const retryContext = { allowTransportReady, expectedSocket, expectedGeneration };
            this._syncMeasuredBytesWithRelay(retryContext)
              .catch((error) => {
                if (hasExpectedTransport) throw error;
                logger.debug(() => `Unable to sync relay measured bytes after too_low: ${error}`);
              })
              .then(() => this.createTicketCommand(retryContext))
              .then((ticketCommand) => {
                const retryOptions = {
                  ticketRetryCount: retryCount + 1,
                  timeoutMs: pending.timeoutMs,
                  signal: pending.signal,
                  expectedSocket,
                  expectedGeneration,
                };
                return allowTransportReady
                  ? this._sendCommandTransportReady(ticketCommand, retryOptions)
                  : this.sendCommand(ticketCommand, retryOptions);
              })
              .then(pending.resolve)
              .catch(pending.reject);
            return true;
          }
          this._recordTicketResponse(originalCommand, responseData);
          pending.resolve(responseData);
          return true;
        }
        this._recordTicketResponse(pending.commandArray, responseData);
        pending.resolve(responseData);
      } else if (responseType === 'error') {
        const reasonRaw = responseData.length > 1 ? responseData[1] : responseData[0];
        pending.reject(new DiodeResponseError(parseReason(reasonRaw), requestId));
      } else {
        pending.resolve(responseData);
      }
    } catch (error) {
      const rejection = error instanceof Error
        ? error
        : new DiodeResponseError(error, requestId);
      logger.error(() => `Error handling response: ${rejection}`);
      pending.reject(rejection);
    }
    return true;
  }

  _handleData(data, generation = this._socketGeneration) {
    // Append new data to the receive buffer
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    // logger.debug(() => `Received data: ${data.toString('hex')}`);
  
    let offset = 0;
    while (offset + 2 <= this.receiveBuffer.length) {
      // Read the length of the message (2 bytes)
      const lengthBuffer = this.receiveBuffer.slice(offset, offset + 2);
      const length = lengthBuffer.readUInt16BE(0);
  
      if (offset + 2 + length > this.receiveBuffer.length) {
        // Not enough data received yet, wait for more
        break;
      }
  
      const messageBuffer = this.receiveBuffer.slice(offset + 2, offset + 2 + length);
      offset += 2 + length;
  
      try {
        // Avoid copying: pass Buffer directly to RLP.decode
        const decodedMessage = RLP.decode(messageBuffer);
        // logger.debug(() => `Decoded message: ${makeReadable(decodedMessage)}`);
    
        if (Array.isArray(decodedMessage) && decodedMessage.length > 1) {
          const requestIdRaw = decodedMessage[0];
          const responseArray = decodedMessage[1];
    
          // Parse requestId
          const requestId = parseRequestId(requestIdRaw);
    
          // Debug statements
          logger.debug(() => `requestIdRaw: ${requestIdRaw}`);
          logger.debug(() => `Parsed requestId: ${requestId}`);
    
          if (requestId !== null && this._handleResponse(requestId, responseArray)) {
            // Response handled synchronously; continue parsing any coalesced
            // frames before trimming receiveBuffer below.
          } else {
            // This is an unsolicited message
            logger.debug(() => `Received unsolicited message`);
            this._deferUnsolicited(decodedMessage, generation);
          }
        } else {
          // Invalid message format
          logger.error(() => `Invalid message format: ${makeReadable(decodedMessage)}`);
        }
      } catch (error) {
        logger.error(() => `Error decoding message: ${error}`);
      }
    }
    
  
    // Remove processed data from the buffer
    this.receiveBuffer = this.receiveBuffer.slice(offset);
  }

  _handleUnsolicitedMessage(message) {
    if (!Array.isArray(message) || message.length < 2) {
      logger.warn(() => 'Ignoring malformed unsolicited connection frame: invalid envelope');
      return false;
    }
    const messageContent = message[1];
    if (!Array.isArray(messageContent) || messageContent.length < 1) {
      logger.warn(() => 'Ignoring malformed unsolicited connection frame: invalid message content');
      return false;
    }

    const messageTypeRaw = messageContent[0];
    const messageType = decodeUnsolicitedMessageType(messageTypeRaw);
    if (!messageType) {
      logger.warn(() => 'Ignoring malformed unsolicited connection frame: invalid message type');
      return false;
    }

    if (messageType === 'ticket_request') {
      const deviceUsageRaw = messageContent[1];
      const deviceUsage = parseUInt(deviceUsageRaw);
      if (typeof deviceUsage === 'number' && deviceUsage > this.totalBytes) {
        this.totalBytes = deviceUsage;
      }

      // Use the same single-flight ticket path as periodic updates.
      this._updateTicketIfNeeded(true).catch((error) => {
        logger.error(() => `Error handling ticket_request: ${error}`);
      });
    }
    return true;
  }

  fixResponse(response) {
    /*
      ticketv2 too_low responses are:
      [
        'too_low',
        chain_id,
        epoch,
        last_total_connections,
        last_total_bytes,
        local_address,
        device_signature
      ]
      The byte value is the relay's last accepted paid floor. The live
      unpaid measurement still comes from the relay "bytes" command.
    */
    const lastTicket = this._parseTooLowTicketSummary(response);
    if (Number.isFinite(lastTicket.totalConnections)) {
      this.totalConnections = Math.max(this.totalConnections, lastTicket.totalConnections);
    }
    if (Number.isFinite(lastTicket.totalBytes)) {
      this.lastAcceptedTicketBytes = Math.max(this.lastAcceptedTicketBytes, lastTicket.totalBytes);
      const relayMeasuredBytes = Number.isFinite(this.lastRelayMeasuredBytes) ? this.lastRelayMeasuredBytes : 0;
      const pendingBytes = Math.max(this.accumulatedBytes, relayMeasuredBytes, 0);
      this.totalBytes = Math.max(this.totalBytes, lastTicket.totalBytes + pendingBytes + 1024);
      this.accumulatedBytes = Math.max(this.accumulatedBytes, this.totalBytes - lastTicket.totalBytes);
    }
  }

  _parseTooLowTicketSummary(response) {
    if (!Array.isArray(response)) {
      return { totalConnections: null, totalBytes: null };
    }

    const firstItem = response[0];
    const firstItemType = typeof firstItem === 'string' || Buffer.isBuffer(firstItem) || firstItem instanceof Uint8Array
      ? parseResponseType(firstItem)
      : '';
    let normalized = response;
    if (firstItemType === 'response') {
      const secondItem = response[1];
      const secondItemType = typeof secondItem === 'string' || Buffer.isBuffer(secondItem) || secondItem instanceof Uint8Array
        ? parseResponseType(secondItem)
        : '';
      normalized = secondItemType === 'too_low' ? response.slice(2) : response;
    } else if (firstItemType === 'too_low') {
      normalized = response.slice(1);
    }

    if (normalized.length >= 6) {
      return {
        version: 2,
        chainId: parseUInt(normalized[0]),
        epoch: parseUInt(normalized[1]),
        totalConnections: parseUInt(normalized[2]),
        totalBytes: parseUInt(normalized[3]),
        localAddress: normalized[4],
        deviceSignature: normalized[5],
      };
    }

    if (normalized.length >= 5) {
      return {
        version: 1,
        blockHash: normalized[0],
        totalConnections: parseUInt(normalized[1]),
        totalBytes: parseUInt(normalized[2]),
        localAddress: normalized[3],
        deviceSignature: normalized[4],
      };
    }

    return { totalConnections: null, totalBytes: null };
  }

  _isTicketCommand(commandArray) {
    return Array.isArray(commandArray) &&
      (commandArray[0] === 'ticket' || commandArray[0] === 'ticketv2');
  }

  _ticketTotalBytes(commandArray) {
    if (!this._isTicketCommand(commandArray)) return null;
    const index = commandArray[0] === 'ticketv2' ? 5 : 4;
    return parseUInt(commandArray[index]);
  }

  _recordTicketResponse(commandArray, responseData) {
    if (!this._isTicketCommand(commandArray) || !Array.isArray(responseData)) return;
    const status = responseData[0] !== undefined ? parseResponseType(responseData[0]) : '';
    if (status !== 'thanks!') return;
    const ticketTotalBytes = this._ticketTotalBytes(commandArray);
    if (!Number.isFinite(ticketTotalBytes)) return;
    this.lastAcceptedTicketBytes = Math.max(this.lastAcceptedTicketBytes, ticketTotalBytes);
    this.accumulatedBytes = Math.max(0, this.totalBytes - ticketTotalBytes);
    this.lastTicketUpdate = Date.now();
  }

  _recordTrafficBytes(bytesCount) {
    if (!Number.isFinite(bytesCount) || bytesCount <= 0) return;
    this.totalBytes += bytesCount;
    this.accumulatedBytes += bytesCount;

    if (this.accumulatedBytes >= this.ticketUpdateThreshold) {
      this._updateTicketIfNeeded();
    }
  }

  _parseRelaySignedInt(valueRaw) {
    const encoded = parseUInt(valueRaw);
    if (!Number.isFinite(encoded)) return null;
    if (encoded % 2 === 0) return encoded / 2;
    return -((encoded - 1) / 2);
  }

  async _syncMeasuredBytesWithRelay({
    allowTransportReady = false,
    expectedSocket = undefined,
    expectedGeneration = undefined,
  } = {}) {
    const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
    const socket = hasExpectedTransport
      ? this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode byte synchronization')
      : this.socket;
    if (!socket || socket.destroyed) return null;
    const commandOptions = hasExpectedTransport ? { expectedSocket, expectedGeneration } : {};
    const responseData = allowTransportReady
      ? await this._sendCommandTransportReady(['bytes'], commandOptions)
      : await this.sendCommand(['bytes'], commandOptions);
    if (hasExpectedTransport) {
      this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode byte synchronization');
    }
    const measuredBytes = responseData && responseData[0] !== undefined
      ? this._parseRelaySignedInt(responseData[0])
      : null;
    if (!Number.isFinite(measuredBytes) || measuredBytes <= 0) {
      return measuredBytes;
    }

    this.lastRelayMeasuredBytes = measuredBytes;
    const baseBytes = Number.isFinite(this.lastAcceptedTicketBytes) && this.lastAcceptedTicketBytes > 0
      ? this.lastAcceptedTicketBytes
      : 128000;
    const targetTotalBytes = baseBytes + measuredBytes + 1024;
    if (targetTotalBytes > this.totalBytes) {
      this.totalBytes = targetTotalBytes;
      this.accumulatedBytes = Math.max(this.accumulatedBytes, this.totalBytes - baseBytes);
    }
    return measuredBytes;
  }

  sendCommand(commandArray, options = {}) {
    return this._sendCommand(commandArray, options, false);
  }

  _sendCommandTransportReady(commandArray, options = {}) {
    return this._sendCommand(commandArray, options, true);
  }

  _sendCommand(commandArray, options = {}, allowTransportReady = false) {
    return new Promise((resolve, reject) => {
      this.commandTimeoutMs = normalizeTimerMs(this.commandTimeoutMs, 15000);
      const timeoutMs = normalizeTimerMs(options.timeoutMs, this.commandTimeoutMs);
      let requestId;
      let settled = false;
      let timeoutId;
      const signal = options.signal;
      const expectedSocket = options.expectedSocket;
      const expectedGeneration = options.expectedGeneration;
      const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
      let onAbort;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (requestId !== undefined) {
          const pending = this.pendingRequests.get(requestId);
          if (pending && pending.resolve === safeResolve) this.pendingRequests.delete(requestId);
        }
        if (error) reject(error);
        else resolve(value);
      };
      const safeResolve = (value) => finish(null, value);
      const safeReject = (error) => finish(
        error instanceof Error ? error : new DiodeConnectionError(String(error))
      );

      onAbort = () => {
        safeReject(new DiodeCommandAbortedError(commandArray, requestId, signal && signal.reason));
      };
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      timeoutId = setTimeout(() => {
        safeReject(new DiodeCommandTimeoutError(commandArray, timeoutMs, requestId));
      }, timeoutMs);

      this._ensureConnected({ allowTransportReady, expectedSocket, expectedGeneration }).then(() => {
        if (settled) return;
        const socket = hasExpectedTransport
          ? this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode command write')
          : this.socket;
        if (!socket || socket.destroyed || socket.writable === false) {
          throw new DiodeDisconnectedError('Diode relay is not writable');
        }

        requestId = this._getNextRequestId();
        const commandWithId = [requestId, commandArray];
        const commandBuffer = RLP.encode(commandWithId);
        const byteLength = commandBuffer.length;
        if (byteLength > 0xffff) {
          throw new DiodeConnectionError(
            `Encoded Diode command exceeds the 65535-byte frame limit (${byteLength} bytes)`,
            'DIODE_COMMAND_TOO_LARGE',
            { command: Array.isArray(commandArray) ? commandArray[0] : undefined, requestId }
          );
        }

        const lengthBuffer = Buffer.alloc(2);
        lengthBuffer.writeUInt16BE(byteLength, 0);
        const message = Buffer.concat([lengthBuffer, Buffer.from(commandBuffer)]);

        this.pendingRequests.set(requestId, {
          resolve: safeResolve,
          reject: safeReject,
          commandArray,
          ticketRetryCount: options.ticketRetryCount || 0,
          timeoutId,
          timeoutMs,
          signal,
          allowTransportReady,
          expectedSocket,
          expectedGeneration,
          generation: hasExpectedTransport ? expectedGeneration : this._socketGeneration,
        });

        logger.debug(() => `Sending command with requestId ${requestId}: ${commandArray}`);
        socket.write(message, (error) => {
          if (error) safeReject(error);
        });
        this._recordTrafficBytes(message.length);
      }).catch(safeReject);
    });
  }

  sendCommandWithSessionId(commandArray, sessionId, options = {}) {
    return new Promise((resolve, reject) => {
      this.commandTimeoutMs = normalizeTimerMs(this.commandTimeoutMs, 15000);
      const timeoutMs = normalizeTimerMs(options.timeoutMs, this.commandTimeoutMs);
      let settled = false;
      let timer;
      const signal = options.signal;
      const onDisconnect = (info) => {
        finish(info && info.error ? info.error : new DiodeDisconnectedError());
      };
      const onAbort = () => {
        finish(new DiodeCommandAbortedError(commandArray, sessionId, signal && signal.reason));
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.off('disconnect', onDisconnect);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error instanceof Error ? error : new DiodeConnectionError(String(error)));
        else resolve();
      };

      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        finish(new DiodeCommandTimeoutError(commandArray, timeoutMs, sessionId));
      }, timeoutMs);
      this.once('disconnect', onDisconnect);

      this._ensureConnected().then(() => {
        if (settled) return;
        const requestId = sessionId;
        const commandWithId = [requestId, commandArray];
        const commandBuffer = RLP.encode(commandWithId);
        const byteLength = commandBuffer.length;
        if (byteLength > 0xffff) {
          throw new DiodeConnectionError(
            `Encoded Diode command exceeds the 65535-byte frame limit (${byteLength} bytes)`,
            'DIODE_COMMAND_TOO_LARGE'
          );
        }
        const lengthBuffer = Buffer.alloc(2);
        lengthBuffer.writeUInt16BE(byteLength, 0);
        const message = Buffer.concat([lengthBuffer, Buffer.from(commandBuffer)]);

        logger.debug(() => `Sending command with requestId ${requestId}: ${commandArray}`);
        const socket = this.socket;
        if (!socket || socket.destroyed || socket.writable === false) {
          throw new DiodeDisconnectedError('Diode relay is not writable');
        }
        socket.write(message, (error) => finish(error || null));
        this._recordTrafficBytes(message.length);
      }).catch(finish);
    });
  }

  getEthereumAddress() {
    try {
      // Use the stored keyPair.pubKeyObj to derive Ethereum address
      const publicKeyDer = this.keyPair.prvKeyObj.generatePublicKeyHex();
      const publicKeyBuffer = Buffer.from(publicKeyDer, 'hex');
      
      // Derive the Ethereum address
      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');

      return address;
    } catch (error) {
      logger.error(() => `Error extracting Ethereum address: ${error}`);
      throw error;
    }
  }
  
  getServerEthereumAddress(quiet = false, options = {}) {
    try {
      const socket = options.socket || this.socket;
      const isCurrentSocket = socket === this.socket;
      const shouldCache = options.cache !== false && isCurrentSocket;
      // `cache: false` prevents a generation-bound caller from mutating state
      // before its post-read generation check. It must not disable reading the
      // identity already committed for the asserted current socket.
      if (isCurrentSocket && this._serverEthAddress) {
        return this._serverEthAddress;
      }
      if (!socket) throw new Error('Diode relay socket is unavailable');

      let publicKeyBuffer;
      if (typeof socket.getPeerX509Certificate === 'function') {
        // The X509Certificate API avoids legacy certificate-to-object parsing
        // and gives us a typed KeyObject. This also avoids a Node/OpenSSL crash
        // observed in getPeerCertificate(true) for the relay's EC certificate.
        const serverCertificate = socket.getPeerX509Certificate();
        if (!serverCertificate || !serverCertificate.publicKey) {
          throw new Error('Failed to get server certificate public key');
        }
        const jwk = serverCertificate.publicKey.export({ format: 'jwk' });
        if (
          !jwk ||
          jwk.kty !== 'EC' ||
          jwk.crv !== 'secp256k1' ||
          typeof jwk.x !== 'string' ||
          typeof jwk.y !== 'string'
        ) {
          throw new Error('Diode relay certificate must use a secp256k1 public key');
        }
        const x = Buffer.from(jwk.x, 'base64url');
        const y = Buffer.from(jwk.y, 'base64url');
        if (x.length !== 32 || y.length !== 32) {
          throw new Error('Diode relay certificate has an invalid secp256k1 public key');
        }
        publicKeyBuffer = Buffer.concat([Buffer.from([0x04]), x, y]);
        if (!secp256k1.publicKeyVerify(publicKeyBuffer)) {
          throw new Error('Diode relay certificate contains an invalid secp256k1 point');
        }
      } else {
        // Node 18+ exposes getPeerX509Certificate. Retain this branch for
        // compatible socket fakes and embedders that only implement the
        // historical API.
        const serverCertificate = socket.getPeerCertificate(true);
        if (!serverCertificate || !serverCertificate.raw || !serverCertificate.pubkey) {
          throw new Error('Failed to get server certificate');
        }
        publicKeyBuffer = Buffer.isBuffer(serverCertificate.pubkey)
          ? serverCertificate.pubkey
          : Buffer.from(serverCertificate.pubkey);
      }

      logger.debug(() => `Public key Server: ${publicKeyBuffer.toString('hex')}`);

      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');
      if (shouldCache) this._serverEthAddress = address;
      return address;
    } catch (error) {
      if (!quiet) {
        logger.error(() => `Error extracting server Ethereum address: ${error}`);
        throw error;
      }
      return null;
    }
  }

  getServerRelayHost(socket = this.socket) {
    if (socket && socket.remoteAddress) {
      const address = socket.remoteAddress;
      if (address.startsWith('::ffff:')) {
        return address.slice(7);
      }
      if (address.includes(':')) {
        return this.host;
      }
      return address;
    }
    return this.host;
  }

  async _waitForServerEthereumAddress(options = {}) {
    const timeoutMs = normalizeTimerMs(options.timeoutMs, 2000);
    const intervalMs = normalizeTimerMs(options.intervalMs, 50);
    const expectedSocket = options.expectedSocket;
    const expectedGeneration = options.expectedGeneration;
    const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
    const readAddress = () => {
      if (hasExpectedTransport) {
        this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode server identity lookup');
      }
      const address = this.getServerEthereumAddress(true, hasExpectedTransport
        ? { socket: expectedSocket, cache: false }
        : {});
      if (hasExpectedTransport) {
        this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode server identity lookup');
      }
      return address;
    };
    const start = Date.now();
    let address = readAddress();
    if (address) return address;
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      address = readAddress();
      if (address) return address;
    }
    return null;
  }

  // Method to extract private key bytes from keyPair
  getPrivateKey() {
    try {
      // Extract private key bytes from the keyPair.prvKeyObj
      const privateKeyHex = this.keyPair.prvKeyObj.prvKeyHex;
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      return privateKeyBytes;
    } catch (error) {
      logger.error(() => `Error extracting private key: ${error}`);
      throw error;
    }
  }

  async createTicketSignature(serverIdBuffer, totalConnections, totalBytes, localAddress, epoch) { 
    const chainId = 1284;
    const fleetContractBuffer = this.fleetContract;
  
    const localAddressBytes = Buffer.isBuffer(localAddress) || localAddress instanceof Uint8Array
      ? toBufferView(localAddress)
      : Buffer.from(localAddress || '', 'utf8');
    const localAddressHash = crypto.createHash('sha256').update(localAddressBytes).digest();
  
    // Data to sign
    const dataToSign = [
      ethUtil.setLengthLeft(ethUtil.toBuffer(chainId), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(epoch), 32),
      ethUtil.setLengthLeft(fleetContractBuffer, 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(serverIdBuffer), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(totalConnections), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(totalBytes), 32),
      ethUtil.setLengthLeft(localAddressHash, 32),
    ];

    // Elements are already bytes32; concatenate directly to avoid ABI overhead
    const encodedData = Buffer.concat(dataToSign);

    logger.debug(() => `Encoded data: ${encodedData.toString('hex')}`);

    logger.debug(() => `Data to sign: ${makeReadable(dataToSign)}`);
  
  
    // Sign the data
    const privateKey = this.getPrivateKey();
    const msgHash = nativeKeccak
      ? nativeKeccak('keccak256').update(encodedData).digest()
      : ethUtil.keccak256(encodedData);
    logger.debug(() => `Message hash: ${msgHash.toString('hex')}`);
    const signature = secp256k1.ecdsaSign(msgHash, privateKey);
    logger.debug(() => `Signature: ${signature.signature.toString('hex')}`);
    
    const signatureBuffer = Buffer.concat([
      Buffer.from([signature.recid]),
      signature.signature
    ]);

    return signatureBuffer;
  }

  async createTicketCommand({
    allowTransportReady = false,
    expectedSocket = undefined,
    expectedGeneration = undefined,
  } = {}) {
    const hasExpectedTransport = expectedSocket !== undefined || expectedGeneration !== undefined;
    if (hasExpectedTransport) {
      this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode ticket creation');
    }
    const chainId = 1284;
    const fleetContract = this.fleetContract;
    let localAddress = '';
    if (typeof this.localAddressProvider === 'function') {
      try {
        localAddress = this.localAddressProvider();
      } catch (error) {
        logger.warn(() => `Failed to get local address hint: ${error}`);
        localAddress = '';
      }
    }
    if (localAddress === null || localAddress === undefined) {
      localAddress = '';
    }
  
    // A generation-bound handshake commits this counter only after all awaited
    // work still belongs to the same socket. Ordinary ticket creation preserves
    // the existing eager increment behavior.
    const totalConnections = this.totalConnections + 1;
    if (!hasExpectedTransport) this.totalConnections = totalConnections;
  
    // Assume totalBytes is managed elsewhere
    const totalBytes = this.totalBytes;
  
    // Get server Ethereum address as Buffer
    const serverIdBuffer = await this._waitForServerEthereumAddress({
      expectedSocket,
      expectedGeneration,
    });
    if (hasExpectedTransport) {
      this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode ticket server identity');
    }
    if (!serverIdBuffer) {
      throw new Error('Failed to get server certificate.');
    }

    // Get epoch
    const epoch = allowTransportReady
      ? await this.RPC._getEpochWithSender((command) => this._sendCommandTransportReady(command, {
        expectedSocket,
        expectedGeneration,
      }))
      : await this.RPC.getEpoch();
    if (hasExpectedTransport) {
      this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode ticket epoch');
    }
    const signature = await this.createTicketSignature(
      serverIdBuffer,
      totalConnections,
      totalBytes,
      localAddress,
      epoch
    );
    if (hasExpectedTransport) {
      this._assertCurrentTransport(expectedSocket, expectedGeneration, 'Diode ticket signature');
      this.totalConnections = totalConnections;
    }
    logger.debug(() => `Signature hex: ${signature.toString('hex')}`);

  
    // Construct the ticket command
    const ticketCommand = [
      'ticketv2',
      chainId,
      epoch,
      fleetContract,
      totalConnections,
      totalBytes,
      localAddress,
      signature
    ];
  
    return ticketCommand;
  }

  getDeviceCertificate() {
    return this.certPem;
  }

    

  _getNextRequestId() {
    // Avoid reusing an id that is still in flight after the counter wraps.
    do {
      this.requestId = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
    } while (this.pendingRequests.has(this.requestId));
    return this.requestId;
  }

  // Client sockets management methods (for BindPort)
  addClientSocket(ref, socket) {
    this.clientSockets.set(ref.toString('hex'), socket);
  }

  getClientSocket(ref) {
    return this.clientSockets.get(ref.toString('hex'));
  }

  deleteClientSocket(ref) {
    return this.clientSockets.delete(ref.toString('hex'));
  }

  hasClientSocket(ref) {
    return this.clientSockets.has(ref.toString('hex'));
  }

  // Connections management methods (for PublishPort)
  addConnection(ref, connectionInfo) {
    this.connections.set(ref.toString('hex'), connectionInfo);
  }

  getConnection(ref) {
    return this.connections.get(ref.toString('hex'));
  }

  deleteConnection(ref) {
    return this.connections.delete(ref.toString('hex'));
  }

  hasConnection(ref) {
    return this.connections.has(ref.toString('hex'));
  }

  // Start timer for periodic ticket updates
  _startTicketUpdateTimer() {
    if (this.ticketUpdateTimer) {
      clearTimeout(this.ticketUpdateTimer);
    }
    if (!this.isReady()) {
      this.ticketUpdateTimer = null;
      return;
    }
    this.ticketUpdateInterval = normalizeTimerMs(this.ticketUpdateInterval, 30000);
    const generation = this._socketGeneration;
    this.ticketUpdateTimer = setTimeout(() => {
      this.ticketUpdateTimer = null;
      if (generation !== this._socketGeneration || !this.isReady()) return;
      this._updateTicketIfNeeded();
    }, this.ticketUpdateInterval);
    if (typeof this.ticketUpdateTimer.unref === 'function') this.ticketUpdateTimer.unref();
  }

  // Method to check if ticket update is needed and perform it
  async _updateTicketIfNeeded(force = false) {
    // If socket is not connected, don't try to update
    if (!this.socket || this.socket.destroyed || this.socket.writable === false) {
      return;
    }

    if (this.ticketUpdateInFlight) {
      this.pendingTicketUpdateForce = this.pendingTicketUpdateForce || force;
      return;
    }
    
    const timeSinceLastUpdate = Date.now() - this.lastTicketUpdate;
    
    if (force || 
      (this.accumulatedBytes > 0 && 
      (this.accumulatedBytes >= this.ticketUpdateThreshold || 
      timeSinceLastUpdate >= this.ticketUpdateInterval))) {
      
      const generation = this._socketGeneration;
      const updateToken = Symbol('ticket-update');
      this._ticketUpdateToken = updateToken;
      this.ticketUpdateInFlight = true;
      let accepted = false;
      try {
        if (this.accumulatedBytes > 0 || force) {
          logger.debug(() => `Updating ticket: accumulated ${this.accumulatedBytes} bytes, ${timeSinceLastUpdate}ms since last update`);
          await this._syncMeasuredBytesWithRelay().catch((error) => {
            logger.debug(() => `Unable to sync relay measured bytes before ticket update: ${error}`);
          });
          if (generation !== this._socketGeneration || this._ticketUpdateToken !== updateToken) return;
          const ticketCommand = await this.createTicketCommand();
          if (generation !== this._socketGeneration || this._ticketUpdateToken !== updateToken) return;
          const ticketTotalBytes = parseUInt(ticketCommand[5]);
          const responseData = await this.sendCommand(ticketCommand);
          if (generation !== this._socketGeneration || this._ticketUpdateToken !== updateToken) return;
          const status = responseData && responseData[0] !== undefined ? parseResponseType(responseData[0]) : '';
          if (status === 'thanks!') {
            accepted = true;
            if (Number.isFinite(ticketTotalBytes)) {
              this.accumulatedBytes = Math.max(0, this.totalBytes - ticketTotalBytes);
            }
            this.lastTicketUpdate = Date.now();
          }
        }
      } catch (error) {
        logger.error(() => `Error updating ticket: ${error}`);
      } finally {
        if (this._ticketUpdateToken === updateToken) {
          this._ticketUpdateToken = null;
          this.ticketUpdateInFlight = false;
        }
      }

      if (generation !== this._socketGeneration || this._ticketUpdateToken !== null) return;
      if (accepted && (this.pendingTicketUpdateForce || this.accumulatedBytes >= this.ticketUpdateThreshold)) {
        const pendingForce = this.pendingTicketUpdateForce;
        this.pendingTicketUpdateForce = false;
        setImmediate(() => {
          if (generation === this._socketGeneration) this._updateTicketIfNeeded(pendingForce);
        });
      } else {
        this.pendingTicketUpdateForce = false;
      }
    }
    
    // Restart the timer
    if (this.isReady()) this._startTicketUpdateTimer();
  }

  // Add method to track bytes without immediate ticket update
  addBytes(bytesCount) {
    this._recordTrafficBytes(bytesCount);
  }

  // Method to set ticket batching options
  setTicketBatchingOptions(options = {}) {
    if (typeof options.threshold === 'number') {
      this.ticketUpdateThreshold = options.threshold;
    }
    if (typeof options.interval === 'number') {
      this.ticketUpdateInterval = normalizeTimerMs(options.interval, this.ticketUpdateInterval);
    }
    
    logger.info(() => `Updated ticket batching settings - Bytes Threshold: ${this.ticketUpdateThreshold} bytes, Update Interval: ${this.ticketUpdateInterval}ms`);
    
    // Reset the timer with new interval
    if (this.isReady()) {
      this._startTicketUpdateTimer();
    }
    
    return this;
  }
}


module.exports = DiodeConnection;
DiodeConnection.Errors = {
  DiodeConnectionError,
  DiodeCommandTimeoutError,
  DiodeCommandAbortedError,
  DiodeDisconnectedError,
  DiodeResponseError,
};
