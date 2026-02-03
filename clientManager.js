const EventEmitter = require('events');
const DiodeConnection = require('./connection');
const DiodeRPC = require('./rpc');
const logger = require('./logger');

const DEFAULT_DIODE_ADDRS = [
  'as1.prenet.diode.io:41046',
  'as2.prenet.diode.io:41046',
  'us1.prenet.diode.io:41046',
  'us2.prenet.diode.io:41046',
  'eu1.prenet.diode.io:41046',
  'eu2.prenet.diode.io:41046',
];

function splitHostPort(input, defaultPort) {
  if (!input || typeof input !== 'string') {
    return { host: '', port: defaultPort };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { host: '', port: defaultPort };
  }

  if (trimmed.startsWith('[')) {
    const idx = trimmed.indexOf(']');
    if (idx !== -1) {
      const host = trimmed.slice(1, idx);
      const rest = trimmed.slice(idx + 1);
      if (rest.startsWith(':')) {
        const port = parseInt(rest.slice(1), 10);
        return { host, port: Number.isFinite(port) && port > 0 ? port : defaultPort };
      }
      return { host, port: defaultPort };
    }
  }

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > -1 && trimmed.indexOf(':') === lastColon) {
    const host = trimmed.slice(0, lastColon);
    const portStr = trimmed.slice(lastColon + 1);
    if (/^\d+$/.test(portStr)) {
      const port = parseInt(portStr, 10);
      return { host, port: Number.isFinite(port) && port > 0 ? port : defaultPort };
    }
  }

  return { host: trimmed, port: defaultPort };
}

function joinHostPort(host, port) {
  if (!host) return '';
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

function normalizeAddress(address) {
  if (!address) return null;
  if (Buffer.isBuffer(address)) return address;
  if (address instanceof Uint8Array) return Buffer.from(address);
  if (typeof address === 'string') {
    const hex = address.toLowerCase().startsWith('0x') ? address.slice(2) : address;
    if (!hex) return Buffer.alloc(0);
    return Buffer.from(hex, 'hex');
  }
  return null;
}

function normalizeServerIdHex(serverId) {
  if (!serverId) return '';
  if (Buffer.isBuffer(serverId) || serverId instanceof Uint8Array) {
    return `0x${Buffer.from(serverId).toString('hex')}`.toLowerCase();
  }
  if (typeof serverId === 'string') {
    return (serverId.startsWith('0x') ? serverId : `0x${serverId}`).toLowerCase();
  }
  return '';
}

function isConnected(connection) {
  return connection && connection.socket && !connection.socket.destroyed;
}

class DiodeClientManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.keyLocation = options.keyLocation || './db/keys.json';
    this.defaultPort = Number.isFinite(options.port) && options.port > 0 ? options.port : 41046;
    this.deviceCacheTtlMs = Number.isFinite(options.deviceCacheTtlMs)
      ? options.deviceCacheTtlMs
      : 30000;

    this.connections = [];
    this.connectionByHost = new Map();
    this.serverIdToConnection = new Map();
    this.pendingConnections = new Map();
    this.deviceRelayCache = new Map();
    this._rpcByConnection = new Map();
    this._rrIndex = 0;

    this.initialHosts = this._buildInitialHosts(options);
  }

  _buildInitialHosts(options) {
    if (typeof options.host === 'string' && options.host.trim()) {
      const { host, port } = splitHostPort(options.host, this.defaultPort);
      return host ? [joinHostPort(host, port)] : [];
    }

    let hosts = [];
    if (Array.isArray(options.hosts)) {
      hosts = options.hosts;
    } else if (typeof options.hosts === 'string') {
      hosts = options.hosts.split(',').map((entry) => entry.trim());
    }

    if (hosts.length === 0) {
      hosts = DEFAULT_DIODE_ADDRS.slice();
    }

    const seen = new Set();
    const normalized = [];
    for (const entry of hosts) {
      if (!entry) continue;
      const { host, port } = splitHostPort(entry, this.defaultPort);
      if (!host) continue;
      const key = joinHostPort(host, port);
      const lower = key.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        normalized.push(key);
      }
    }
    return normalized;
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

  _updateServerIdMapping(connection) {
    if (!connection) return;
    try {
      const serverId = connection.getServerEthereumAddress(true);
      if (serverId) {
        this.serverIdToConnection.set(serverId.toLowerCase(), connection);
      }
    } catch (error) {
      logger.debug(() => `Failed to map server ID for ${connection.host}:${connection.port}: ${error}`);
    }
  }

  _localAddressHintFor(connection) {
    const connected = this._connectedConnections();
    if (connected.length === 0) {
      return Buffer.alloc(0);
    }
    const primary = connected[0];
    const secondary = connected.length > 1 ? connected[1] : null;

    let primaryId = '';
    try {
      primaryId = normalizeServerIdHex(primary.getServerEthereumAddress(true));
    } catch (_) {
      primaryId = '';
    }
    if (!primaryId) {
      return Buffer.alloc(0);
    }

    if (primary === connection) {
      if (!secondary) return Buffer.alloc(0);
      let secondaryId = '';
      try {
        secondaryId = normalizeServerIdHex(secondary.getServerEthereumAddress(true));
      } catch (_) {
        secondaryId = '';
      }
      if (!secondaryId) return Buffer.alloc(0);
      return Buffer.concat([
        Buffer.from([1]),
        Buffer.from(secondaryId.slice(2), 'hex'),
      ]);
    }

    return Buffer.concat([
      Buffer.from([0]),
      Buffer.from(primaryId.slice(2), 'hex'),
    ]);
  }

  _registerConnection(connection, hostKey) {
    connection._managerHostKey = hostKey;
    this.connections.push(connection);
    this.connectionByHost.set(hostKey, connection);
    if (typeof connection.setLocalAddressProvider === 'function') {
      connection.setLocalAddressProvider(() => this._localAddressHintFor(connection));
    }

    connection.on('unsolicited', (message) => {
      this.emit('unsolicited', message, connection);
    });
    connection.on('reconnected', () => {
      this._updateServerIdMapping(connection);
      this.emit('reconnected', connection);
    });
    connection.on('reconnecting', (info) => {
      this.emit('reconnecting', connection, info);
    });
    connection.on('reconnect_failed', () => {
      this.emit('reconnect_failed', connection);
    });
  }

  _unregisterConnection(connection, hostKey) {
    if (!connection) return;
    if (hostKey) {
      this.connectionByHost.delete(hostKey);
    }
    this.connections = this.connections.filter((item) => item !== connection);
    for (const [serverId, conn] of this.serverIdToConnection.entries()) {
      if (conn === connection) {
        this.serverIdToConnection.delete(serverId);
      }
    }
    this._rpcByConnection.delete(connection);
  }

  async _ensureConnection(hostEntry) {
    const { host, port } = splitHostPort(hostEntry, this.defaultPort);
    const hostKey = joinHostPort(host, port);
    if (!host) {
      throw new Error(`Invalid host entry: ${hostEntry}`);
    }

    if (this.connectionByHost.has(hostKey)) {
      return this.connectionByHost.get(hostKey);
    }

    if (this.pendingConnections.has(hostKey)) {
      return this.pendingConnections.get(hostKey);
    }

    const connection = new DiodeConnection(host, port, this.keyLocation);
    this._registerConnection(connection, hostKey);

    const promise = connection.connect()
      .then(() => {
        this._updateServerIdMapping(connection);
        this.emit('connected', connection);
        return connection;
      })
      .catch((error) => {
        this._unregisterConnection(connection, hostKey);
        throw error;
      })
      .finally(() => {
        this.pendingConnections.delete(hostKey);
      });

    this.pendingConnections.set(hostKey, promise);
    return promise;
  }

  _connectedConnections() {
    return this.connections.filter((connection) => isConnected(connection));
  }

  getNearestConnection() {
    const connected = this._connectedConnections();
    if (connected.length === 0) {
      return null;
    }
    this._rrIndex = (this._rrIndex + 1) % connected.length;
    return connected[this._rrIndex];
  }

  async connect() {
    if (!this.initialHosts || this.initialHosts.length === 0) {
      throw new Error('No Diode hosts configured');
    }

    const results = await Promise.allSettled(
      this.initialHosts.map((host) => this._ensureConnection(host))
    );

    const success = results.some((result) => result.status === 'fulfilled');
    if (!success) {
      const errorMessages = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));
      throw new Error(`Failed to connect to any Diode hosts. ${errorMessages.join('; ')}`);
    }

    return this;
  }

  async getConnectionForDevice(deviceId) {
    const deviceIdBuffer = normalizeAddress(deviceId);
    if (!deviceIdBuffer) {
      throw new Error('Invalid device ID');
    }
    const deviceIdHex = deviceIdBuffer.toString('hex');

    if (this.deviceCacheTtlMs > 0) {
      const cached = this.deviceRelayCache.get(deviceIdHex);
      if (cached && Date.now() - cached.ts < this.deviceCacheTtlMs) {
        const cachedConn = this.serverIdToConnection.get(cached.serverIdHex) ||
          this.connectionByHost.get(cached.hostKey);
        if (cachedConn && isConnected(cachedConn)) {
          return cachedConn;
        }
      }
    }

    const primary = this.getNearestConnection();
    if (!primary) {
      throw new Error('No connected relay available');
    }

    let ticket = null;
    try {
      ticket = await this._getRpcFor(primary).getObject(deviceIdBuffer);
    } catch (error) {
      logger.warn(() => `Failed to resolve device ticket: ${error}`);
      return primary;
    }

    const serverIdHex = normalizeServerIdHex(ticket && (ticket.serverIdHex || ticket.serverId));
    if (!serverIdHex) {
      return primary;
    }

    const existing = this.serverIdToConnection.get(serverIdHex);
    if (existing && isConnected(existing)) {
      this.deviceRelayCache.set(deviceIdHex, {
        serverIdHex,
        hostKey: existing._managerHostKey || '',
        ts: Date.now(),
      });
      return existing;
    }

    let nodeInfo = null;
    try {
      const nodeId = Buffer.from(serverIdHex.slice(2), 'hex');
      nodeInfo = await this._getRpcFor(primary).getNode(nodeId);
    } catch (error) {
      logger.warn(() => `Failed to resolve relay node for ${serverIdHex}: ${error}`);
      return primary;
    }

    if (!nodeInfo || !nodeInfo.host) {
      return primary;
    }

    const relayPort = nodeInfo.edgePort || nodeInfo.serverPort;
    if (!relayPort) {
      return primary;
    }

    const hostKey = joinHostPort(nodeInfo.host, relayPort);
    let relayConnection;
    try {
      relayConnection = await this._ensureConnection(hostKey);
    } catch (error) {
      logger.warn(() => `Failed to connect to relay ${hostKey}: ${error}`);
      return primary;
    }

    this.deviceRelayCache.set(deviceIdHex, {
      serverIdHex,
      hostKey,
      ts: Date.now(),
    });

    return relayConnection || primary;
  }

  async resolveRelayForDevice(deviceId) {
    const deviceIdBuffer = normalizeAddress(deviceId);
    if (!deviceIdBuffer) {
      throw new Error('Invalid device ID');
    }

    const primary = this.getNearestConnection();
    if (!primary) {
      throw new Error('No connected relay available');
    }

    const ticket = await this._getRpcFor(primary).getObject(deviceIdBuffer);
    const serverIdHex = normalizeServerIdHex(ticket && (ticket.serverIdHex || ticket.serverId));
    if (!serverIdHex) {
      throw new Error('Device ticket missing server ID');
    }

    const nodeId = Buffer.from(serverIdHex.slice(2), 'hex');
    const nodeInfo = await this._getRpcFor(primary).getNode(nodeId);
    if (!nodeInfo || !nodeInfo.host) {
      throw new Error('Relay node info missing host');
    }
    const relayPort = nodeInfo.edgePort || nodeInfo.serverPort;
    if (!relayPort) {
      throw new Error('Relay node info missing port');
    }

    return {
      serverId: serverIdHex,
      host: nodeInfo.host,
      port: relayPort,
    };
  }

  getConnections() {
    return this.connections.slice();
  }

  close() {
    for (const connection of this.connections) {
      try {
        connection.close();
      } catch (_) {}
    }
  }
}

module.exports = DiodeClientManager;
