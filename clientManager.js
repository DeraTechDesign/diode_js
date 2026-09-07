const fs = require('fs');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const DiodeConnection = require('./connection');
const DiodeRPC = require('./rpc');
const { fetchNetworkDirectory } = require('./networkDiscoveryClient');
const logger = require('./logger');
const { DEFAULT_FLEET_CONTRACT, normalizeFleetContractAddress } = require('./utils');

const DEFAULT_DIODE_ADDRS = [
  'as1.prenet.diode.io:41046',
  'as2.prenet.diode.io:41046',
  'us1.prenet.diode.io:41046',
  'us2.prenet.diode.io:41046',
  'eu1.prenet.diode.io:41046',
  'eu2.prenet.diode.io:41046',
];

const RELAY_SCORE_CACHE_VERSION = 2;
const RELAY_SCORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RELAY_SCORE_FRESH_MS = 60 * 1000;
const RELAY_SCORE_FAILURE_COOLDOWN_MS = 30 * 1000;
const RELAY_SCORE_EWMA_WEIGHT = 0.3;
const RELAY_SCORE_FLUSH_DEBOUNCE_MS = 500;
const DEFAULT_NETWORK_DISCOVERY_ENDPOINT = 'wss://prenet.diode.io:8443/ws';
const DEFAULT_NETWORK_DISCOVERY_METHOD = 'dio_network';
const MAX_NODE_TIMER_MS = 0x7fffffff;

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

function normalizeHostKey(hostEntry, defaultPort) {
  const { host, port } = splitHostPort(hostEntry, defaultPort);
  return host ? joinHostPort(host, port) : '';
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
  if (!connection || connection._managerReady === false) return false;
  if (typeof connection.isReady === 'function') {
    return connection.isReady();
  }
  return !!(connection.socket && !connection.socket.destroyed && connection.socket.writable !== false);
}

function parseBoolean(value, defaultValue) {
  return typeof value === 'boolean' ? value : defaultValue;
}

function parsePositiveInteger(
  value,
  defaultValue,
  { allowZero = false, max = MAX_NODE_TIMER_MS } = {}
) {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  const normalized = Math.floor(value);
  const upperBound = Number.isFinite(max) && max >= 0
    ? Math.floor(max)
    : MAX_NODE_TIMER_MS;
  if (allowZero ? normalized >= 0 : normalized > 0) {
    return Math.min(normalized, upperBound);
  }
  return defaultValue;
}

async function runWithConcurrency(items, concurrency, worker) {
  const normalizedConcurrency = Math.max(1, Math.min(concurrency || 1, items.length || 1));
  const results = new Array(items.length);
  let index = 0;

  async function consume() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      try {
        const value = await worker(items[current], current);
        results[current] = { status: 'fulfilled', value };
      } catch (error) {
        results[current] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => consume()));
  return results;
}

class DiodeClientManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.keyLocation = options.keyLocation || './db/keys.json';
    this.defaultPort = Number.isFinite(options.port) && options.port > 0 ? options.port : 41046;
    this.deviceCacheTtlMs = Number.isFinite(options.deviceCacheTtlMs)
      ? options.deviceCacheTtlMs
      : 30000;

    this._hasExplicitHost = typeof options.host === 'string' && !!options.host.trim();
    this._hasExplicitHosts = !this._hasExplicitHost && (
      Array.isArray(options.hosts)
      || (typeof options.hosts === 'string' && !!options.hosts.trim())
    );

    this.relaySelection = this._buildRelaySelectionOptions(options.relaySelection);
    this.scoreCachePath = this._resolveRelayScoreCachePath(this.relaySelection.scoreCachePath);
    this.discoveryState = { networkCursor: 0 };

    this.connections = [];
    this.connectionByHost = new Map();
    this.serverIdToConnection = new Map();
    this.pendingConnections = new Map();
    this.pendingProbes = new Map();
    this.pendingDeviceResolutions = new Map();
    this.deviceRelayCache = new Map();
    this.relayScores = new Map();
    this._rpcByConnection = new Map();
    this._candidateMetadataByHost = new Map();
    this._rrIndex = 0;
    this._relayScoreFlushTimer = null;
    this._backgroundWarmupPromise = null;
    this._startupWorkPromise = null;
    this._startupWorkActive = false;
    this._startupReadyPromise = null;
    this._rejectStartupReady = null;
    this._lastProbeStartedAt = new Map();
    this._startupCoverageComplete = false;
    this._lastNetworkDiscoveryStats = null;
    this._lastDeviceResolutionTrace = null;
    this._closed = false;
    this._lifecycleGeneration = 0;
    this.fleetContract = DEFAULT_FLEET_CONTRACT;

    if (options.fleetContract !== undefined) {
      this.setFleetContract(options.fleetContract);
    }

    this.initialHosts = this._buildInitialHosts(options);
    this._loadRelayScores();
  }

  setFleetContract(address) {
    const normalizedFleetContract = normalizeFleetContractAddress(address);
    this.fleetContract = normalizedFleetContract;

    for (const connection of this.connections) {
      if (connection && typeof connection.setFleetContract === 'function') {
        connection.setFleetContract(normalizedFleetContract);
      }
    }

    return this;
  }

  _buildRelaySelectionOptions(options = {}) {
    const relaySelection = options && typeof options === 'object' ? options : {};
    const legacyWarmConnections = parsePositiveInteger(relaySelection.desiredWarmConnections, NaN);
    return {
      enabled: parseBoolean(relaySelection.enabled, true),
      startupConcurrency: parsePositiveInteger(relaySelection.startupConcurrency, 3),
      minReadyConnections: parsePositiveInteger(relaySelection.minReadyConnections, 2),
      probeTimeoutMs: parsePositiveInteger(relaySelection.probeTimeoutMs, 1200),
      connectionTimeoutMs: parsePositiveInteger(relaySelection.connectionTimeoutMs, 5000),
      targetConnectTimeoutMs: parsePositiveInteger(relaySelection.targetConnectTimeoutMs, 10000),
      deviceLookupTimeoutMs: parsePositiveInteger(relaySelection.deviceLookupTimeoutMs, 3000),
      warmConnectionBudget: parsePositiveInteger(
        relaySelection.warmConnectionBudget,
        Number.isFinite(legacyWarmConnections) ? legacyWarmConnections : 3,
      ),
      probeAllInitialCandidates: parseBoolean(relaySelection.probeAllInitialCandidates, true),
      continueProbingUntestedSeeds: parseBoolean(relaySelection.continueProbingUntestedSeeds, true),
      regionDiverseSeedOrdering: parseBoolean(relaySelection.regionDiverseSeedOrdering, true),
      discoveryProvider: typeof relaySelection.discoveryProvider === 'function'
        ? relaySelection.discoveryProvider
        : null,
      discoveryProviderTimeoutMs: parsePositiveInteger(relaySelection.discoveryProviderTimeoutMs, 1500),
      useProviderWithExplicitHost: parseBoolean(relaySelection.useProviderWithExplicitHost, false),
      useProviderWithExplicitHosts: parseBoolean(relaySelection.useProviderWithExplicitHosts, false),
      backgroundProbeIntervalMs: parsePositiveInteger(relaySelection.backgroundProbeIntervalMs, 300000),
      slowRelayThresholdMs: parsePositiveInteger(relaySelection.slowRelayThresholdMs, 250),
      slowDeviceRetryTtlMs: parsePositiveInteger(relaySelection.slowDeviceRetryTtlMs, 5000),
      deviceRelayReconciliation: this._buildDeviceRelayReconciliationOptions(
        relaySelection.deviceRelayReconciliation,
        parsePositiveInteger(relaySelection.probeTimeoutMs, 1200),
      ),
      networkDiscovery: this._buildNetworkDiscoveryOptions(relaySelection.networkDiscovery),
      scoreCachePath: Object.prototype.hasOwnProperty.call(relaySelection, 'scoreCachePath')
        ? relaySelection.scoreCachePath
        : undefined,
    };
  }

  _buildDeviceRelayReconciliationOptions(options = {}, probeTimeoutMs = 1200) {
    const reconciliation = options && typeof options === 'object' ? options : {};
    return {
      enabled: parseBoolean(reconciliation.enabled, true),
      maxControlRelays: parsePositiveInteger(reconciliation.maxControlRelays, 2, { allowZero: true }),
      timeoutMs: parsePositiveInteger(reconciliation.timeoutMs, probeTimeoutMs),
      minLatencyDeltaMs: parsePositiveInteger(reconciliation.minLatencyDeltaMs, 150, { allowZero: true }),
      slowdownFactor: Number.isFinite(reconciliation.slowdownFactor) && reconciliation.slowdownFactor > 0
        ? reconciliation.slowdownFactor
        : 4,
    };
  }

  _buildNetworkDiscoveryOptions(options = {}) {
    const networkDiscovery = options && typeof options === 'object' ? options : {};
    const enabledDefault = !this._hasExplicitHost && !this._hasExplicitHosts;
    return {
      enabled: parseBoolean(networkDiscovery.enabled, enabledDefault),
      endpoint: typeof networkDiscovery.endpoint === 'string' && networkDiscovery.endpoint.trim()
        ? networkDiscovery.endpoint.trim()
        : DEFAULT_NETWORK_DISCOVERY_ENDPOINT,
      method: typeof networkDiscovery.method === 'string' && networkDiscovery.method.trim()
        ? networkDiscovery.method.trim()
        : DEFAULT_NETWORK_DISCOVERY_METHOD,
      timeoutMs: parsePositiveInteger(networkDiscovery.timeoutMs, 1500),
      startupProbeCount: parsePositiveInteger(networkDiscovery.startupProbeCount, 2, { allowZero: true }),
      backgroundBatchSize: parsePositiveInteger(networkDiscovery.backgroundBatchSize, 12, { allowZero: true }),
      includePrivateAddresses: parseBoolean(networkDiscovery.includePrivateAddresses, false),
    };
  }

  _resolveRelayScoreCachePath(scoreCachePath) {
    if (scoreCachePath === null) {
      return null;
    }
    if (typeof scoreCachePath === 'string' && scoreCachePath.trim()) {
      return scoreCachePath;
    }
    const keyDir = path.dirname(this.keyLocation);
    return path.join(keyDir, 'relay-scores.json');
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
      const key = normalizeHostKey(entry, this.defaultPort);
      if (!key) continue;
      const lower = key.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        normalized.push(key);
      }
    }
    return normalized;
  }

  _loadRelayScores() {
    this.relayScores.clear();
    this.discoveryState = { networkCursor: 0 };
    if (!this.scoreCachePath) {
      return;
    }

    try {
      if (!fs.existsSync(this.scoreCachePath)) {
        return;
      }
      const raw = fs.readFileSync(this.scoreCachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || ![1, RELAY_SCORE_CACHE_VERSION].includes(parsed.version) || typeof parsed.relays !== 'object') {
        return;
      }

      this._loadDiscoveryState(parsed.discoveryState);

      const now = Date.now();
      for (const [hostEntry, record] of Object.entries(parsed.relays)) {
        const hostKey = normalizeHostKey(hostEntry, this.defaultPort);
        if (!hostKey || !record || typeof record !== 'object') {
          continue;
        }

        const lastTouched = Math.max(
          Number(record.lastSuccessAt) || 0,
          Number(record.lastFailureAt) || 0,
        );
        if (lastTouched && now - lastTouched > RELAY_SCORE_MAX_AGE_MS) {
          continue;
        }

        this.relayScores.set(hostKey, {
          hostKey,
          ewmaLatencyMs: Number.isFinite(record.ewmaLatencyMs) ? record.ewmaLatencyMs : null,
          lastProbeLatencyMs: Number.isFinite(record.lastProbeLatencyMs) ? record.lastProbeLatencyMs : null,
          successCount: parsePositiveInteger(record.successCount, 0, { allowZero: true }),
          failureCount: parsePositiveInteger(record.failureCount, 0, { allowZero: true }),
          lastSuccessAt: parsePositiveInteger(record.lastSuccessAt, 0, {
            allowZero: true,
            max: Number.MAX_SAFE_INTEGER,
          }),
          lastFailureAt: parsePositiveInteger(record.lastFailureAt, 0, {
            allowZero: true,
            max: Number.MAX_SAFE_INTEGER,
          }),
          cooldownUntil: parsePositiveInteger(record.cooldownUntil, 0, {
            allowZero: true,
            max: Number.MAX_SAFE_INTEGER,
          }),
          discoveredFrom: typeof record.discoveredFrom === 'string' ? record.discoveredFrom : 'seed',
        });
      }
    } catch (error) {
      logger.warn(() => `Failed to load relay scores from ${this.scoreCachePath}: ${error}`);
      this.relayScores.clear();
    }
  }

  _loadDiscoveryState(discoveryState) {
    const networkCursor = discoveryState && Number.isFinite(discoveryState.networkCursor)
      ? Math.max(0, Math.floor(discoveryState.networkCursor))
      : 0;
    this.discoveryState = { networkCursor };
  }

  _scheduleRelayScoreFlush() {
    if (this._closed || !this.scoreCachePath) {
      return;
    }
    if (this._relayScoreFlushTimer) {
      clearTimeout(this._relayScoreFlushTimer);
    }
    this._relayScoreFlushTimer = setTimeout(() => {
      this._relayScoreFlushTimer = null;
      this._flushRelayScores();
    }, RELAY_SCORE_FLUSH_DEBOUNCE_MS);
  }

  _flushRelayScores() {
    if (!this.scoreCachePath) {
      return;
    }

    const now = Date.now();
    const relays = {};
    for (const [hostKey, score] of this.relayScores.entries()) {
      const lastTouched = Math.max(score.lastSuccessAt || 0, score.lastFailureAt || 0);
      if (lastTouched && now - lastTouched > RELAY_SCORE_MAX_AGE_MS) {
        this.relayScores.delete(hostKey);
        continue;
      }
      relays[hostKey] = {
        ewmaLatencyMs: Number.isFinite(score.ewmaLatencyMs) ? score.ewmaLatencyMs : null,
        lastProbeLatencyMs: Number.isFinite(score.lastProbeLatencyMs) ? score.lastProbeLatencyMs : null,
        successCount: score.successCount || 0,
        failureCount: score.failureCount || 0,
        lastSuccessAt: score.lastSuccessAt || 0,
        lastFailureAt: score.lastFailureAt || 0,
        cooldownUntil: score.cooldownUntil || 0,
        discoveredFrom: score.discoveredFrom || 'seed',
      };
    }

    try {
      fs.mkdirSync(path.dirname(this.scoreCachePath), { recursive: true });
      fs.writeFileSync(this.scoreCachePath, JSON.stringify({
        version: RELAY_SCORE_CACHE_VERSION,
        updatedAt: now,
        discoveryState: this.discoveryState,
        relays,
      }, null, 2), 'utf8');
    } catch (error) {
      logger.warn(() => `Failed to write relay scores to ${this.scoreCachePath}: ${error}`);
    }
  }

  _getRegionKey(hostKey) {
    const host = splitHostPort(hostKey, this.defaultPort).host.toLowerCase();
    if (host.startsWith('as')) return 'as';
    if (host.startsWith('us')) return 'us';
    if (host.startsWith('eu')) return 'eu';
    return 'other';
  }

  _getCandidateRegion(hostKey) {
    const metadata = this._candidateMetadataByHost.get(hostKey);
    if (metadata && metadata.region) {
      return metadata.region;
    }
    return this._getRegionKey(hostKey);
  }

  _getCandidatePriority(hostKey) {
    const metadata = this._candidateMetadataByHost.get(hostKey);
    if (metadata && Number.isFinite(metadata.priority)) {
      return metadata.priority;
    }
    return 100;
  }

  _setCandidateMetadata(hostKey, options = {}) {
    const existing = this._candidateMetadataByHost.get(hostKey) || {};
    const next = { ...existing };
    if (Number.isFinite(options.priority)) {
      next.priority = options.priority;
    }
    if (typeof options.region === 'string' && options.region.trim()) {
      next.region = options.region.trim().toLowerCase();
    }
    if (options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)) {
      next.metadata = options.metadata;
    }
    ['nodeIdHex', 'lastSeenAt', 'retries', 'lastError', 'version', 'name', 'selectedPort', 'edgePort', 'serverPort', 'connected'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        next[key] = options[key];
      }
    });
    if (Object.keys(next).length > 0) {
      this._candidateMetadataByHost.set(hostKey, next);
    }
  }

  _createCandidate(hostKey, source, index, options = {}) {
    this._setCandidateMetadata(hostKey, options);
    const score = this.relayScores.get(hostKey);
    return {
      hostKey,
      source,
      index,
      hasBeenTested: !!(score && ((score.successCount || 0) > 0 || (score.failureCount || 0) > 0)),
      ewmaLatencyMs: score && Number.isFinite(score.ewmaLatencyMs) ? score.ewmaLatencyMs : null,
      inCooldown: !!(score && score.cooldownUntil && score.cooldownUntil > Date.now()),
      cooldownUntil: score && score.cooldownUntil ? score.cooldownUntil : 0,
      lastSuccessAt: score && score.lastSuccessAt ? score.lastSuccessAt : 0,
      discoveredFrom: score && score.discoveredFrom ? score.discoveredFrom : source,
      priority: Number.isFinite(options.priority) ? options.priority : this._getCandidatePriority(hostKey),
      region: options.region || this._getCandidateRegion(hostKey),
      metadata: options.metadata || (this._candidateMetadataByHost.get(hostKey)?.metadata || null),
      scoreFresh: this._isRelayScoreFresh(score),
      nodeIdHex: options.nodeIdHex || this._candidateMetadataByHost.get(hostKey)?.nodeIdHex || '',
      lastSeenAt: Number.isFinite(options.lastSeenAt) ? options.lastSeenAt : (this._candidateMetadataByHost.get(hostKey)?.lastSeenAt || 0),
      retries: Number.isFinite(options.retries) ? options.retries : (this._candidateMetadataByHost.get(hostKey)?.retries || 0),
      lastError: Object.prototype.hasOwnProperty.call(options, 'lastError')
        ? options.lastError
        : (this._candidateMetadataByHost.get(hostKey)?.lastError ?? null),
      version: options.version || this._candidateMetadataByHost.get(hostKey)?.version || '',
      name: options.name || this._candidateMetadataByHost.get(hostKey)?.name || '',
      selectedPort: Number.isFinite(options.selectedPort)
        ? options.selectedPort
        : (this._candidateMetadataByHost.get(hostKey)?.selectedPort || 0),
    };
  }

  _orderCandidatesByRegion(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
      const region = this._getRegionKey(candidate.hostKey);
      if (!groups.has(region)) {
        groups.set(region, []);
      }
      groups.get(region).push(candidate);
    }

    const priority = ['as', 'us', 'eu', 'other'];
    const ordered = [];
    let hasMore = true;
    while (hasMore) {
      hasMore = false;
      for (const region of priority) {
        const queue = groups.get(region);
        if (queue && queue.length > 0) {
          ordered.push(queue.shift());
          hasMore = true;
        }
      }
    }
    return ordered;
  }

  _getInitialCoverageCandidates(candidates) {
    const requiredCandidates = candidates.filter((candidate) => candidate.source === 'seed' || candidate.source === 'configured');
    if (!this.relaySelection.regionDiverseSeedOrdering || this._hasExplicitHost || this._hasExplicitHosts) {
      return requiredCandidates;
    }
    return this._orderCandidatesByRegion(requiredCandidates);
  }

  _getStartupSeedBootstrapCandidates(candidates) {
    const orderedRequiredCandidates = this._getInitialCoverageCandidates(candidates);
    if (this._hasExplicitHost || this._hasExplicitHosts || !this.relaySelection.networkDiscovery.enabled) {
      return orderedRequiredCandidates;
    }

    const selected = [];
    const seenRegions = new Set();
    for (const candidate of orderedRequiredCandidates) {
      const region = candidate.region || this._getRegionKey(candidate.hostKey) || 'other';
      if (seenRegions.has(region)) {
        continue;
      }
      seenRegions.add(region);
      selected.push(candidate);
    }

    return selected.length > 0 ? selected : orderedRequiredCandidates;
  }

  _getSourcePrecedence(source) {
    switch (source) {
      case 'configured': return 0;
      case 'seed': return 1;
      case 'provider': return 2;
      case 'network': return 3;
      case 'target': return 4;
      case 'cache': return 5;
      default: return 6;
    }
  }

  _parseHexInt(value) {
    if (Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      if (/^0x[0-9a-f]+$/i.test(value)) {
        return parseInt(value, 16);
      }
      if (/^\d+$/.test(value)) {
        return parseInt(value, 10);
      }
    }
    return 0;
  }

  _filterDiscoveryAddress(host) {
    if (typeof host !== 'string' || !host.trim()) {
      return false;
    }

    const normalized = host.trim().toLowerCase();
    if (normalized === 'localhost') {
      return false;
    }

    const ipVersion = net.isIP(normalized);
    if (!ipVersion) {
      return true;
    }
    if (this.relaySelection.networkDiscovery.includePrivateAddresses) {
      return true;
    }
    if (ipVersion === 6) {
      if (normalized === '::1') return false;
      if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
      if (normalized.startsWith('fe80:')) return false;
      return true;
    }

    const octets = normalized.split('.').map((part) => parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isFinite(part))) {
      return false;
    }
    if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) return false;
    if (octets[0] === 169 && octets[1] === 254) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] >= 224) return false;
    if (octets[0] === 255) return false;
    return true;
  }

  _getKnownRelayScoreSnapshot() {
    return Array.from(this.relayScores.values()).map((score) => ({
      hostKey: score.hostKey,
      ewmaLatencyMs: Number.isFinite(score.ewmaLatencyMs) ? score.ewmaLatencyMs : null,
      successCount: score.successCount || 0,
      failureCount: score.failureCount || 0,
      lastSuccessAt: score.lastSuccessAt || 0,
      discoveredFrom: score.discoveredFrom || 'seed',
    }));
  }

  async _callDiscoveryProviderWithTimeout() {
    const provider = this.relaySelection.discoveryProvider;
    if (typeof provider !== 'function') {
      return [];
    }
    const controller = new AbortController();
    const context = Object.freeze({
      defaultPort: this.defaultPort,
      keyLocation: this.keyLocation,
      explicitHost: this._hasExplicitHost,
      explicitHosts: this._hasExplicitHosts,
      initialHosts: this.initialHosts.slice(),
      knownRelayScores: this._getKnownRelayScoreSnapshot(),
      signal: controller.signal,
    });

    const timeoutMs = this.relaySelection.discoveryProviderTimeoutMs;
    return this._withTimeout(
      () => provider(context),
      timeoutMs,
      'Discovery provider',
      () => controller.abort()
    );
  }

  _normalizeDiscoveryCandidate(entry, index) {
    if (typeof entry === 'string') {
      const hostKey = normalizeHostKey(entry, this.defaultPort);
      if (!hostKey) return null;
      return this._createCandidate(hostKey, 'provider', index, {
        priority: 100,
        region: this._getRegionKey(hostKey),
        metadata: null,
      });
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    const hostKey = normalizeHostKey(
      entry.port !== undefined ? joinHostPort(entry.host, entry.port) : entry.host,
      this.defaultPort,
    );
    if (!hostKey) {
      return null;
    }

    return this._createCandidate(hostKey, 'provider', index, {
      priority: Number.isFinite(entry.priority) ? entry.priority : 100,
      region: typeof entry.region === 'string' ? entry.region : this._getRegionKey(hostKey),
      metadata: entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? entry.metadata
        : null,
    });
  }

  async _loadDiscoveryProviderCandidates() {
    if (!this.relaySelection.enabled) {
      return [];
    }
    if (this._hasExplicitHost && !this.relaySelection.useProviderWithExplicitHost) {
      return [];
    }
    if (this._hasExplicitHosts && !this.relaySelection.useProviderWithExplicitHosts) {
      return [];
    }
    if (typeof this.relaySelection.discoveryProvider !== 'function') {
      return [];
    }

    try {
      const provided = await this._callDiscoveryProviderWithTimeout();
      if (!Array.isArray(provided)) {
        logger.warn(() => 'Discovery provider returned a non-array result. Ignoring provider candidates.');
        return [];
      }

      let invalidCount = 0;
      const normalized = [];
      provided.forEach((entry, index) => {
        const candidate = this._normalizeDiscoveryCandidate(entry, index);
        if (!candidate) {
          invalidCount += 1;
          return;
        }
        normalized.push(candidate);
      });
      if (invalidCount > 0) {
        logger.warn(() => `Ignored ${invalidCount} invalid discovery provider candidates`);
      }
      return normalized;
    } catch (error) {
      logger.warn(() => `Discovery provider failed: ${error}`);
      return [];
    }
  }

  async _fetchNetworkDiscoveryNodes() {
    return fetchNetworkDirectory({
      endpoint: this.relaySelection.networkDiscovery.endpoint,
      method: this.relaySelection.networkDiscovery.method,
      timeoutMs: this.relaySelection.networkDiscovery.timeoutMs,
    });
  }

  _normalizeNetworkNode(entry, index) {
    if (!entry || typeof entry !== 'object' || !entry.connected) {
      return null;
    }
    if (!Array.isArray(entry.node) || entry.node[0] !== 'server') {
      return null;
    }

    const host = typeof entry.node[1] === 'string' ? entry.node[1].trim() : '';
    if (!this._filterDiscoveryAddress(host)) {
      return null;
    }

    const edgePort = this._parseHexInt(entry.node[2]);
    const serverPort = this._parseHexInt(entry.node[3]);
    const selectedPort = edgePort || serverPort;
    if (!selectedPort) {
      return null;
    }

    let name = '';
    const metadataEntries = Array.isArray(entry.node[5]) ? entry.node[5] : [];
    for (const metaEntry of metadataEntries) {
      if (Array.isArray(metaEntry) && metaEntry[0] === 'name') {
        name = typeof metaEntry[1] === 'string' ? metaEntry[1] : '';
        break;
      }
    }

    const hostKey = normalizeHostKey(joinHostPort(host, selectedPort), this.defaultPort);
    if (!hostKey) {
      return null;
    }

    return this._createCandidate(hostKey, 'network', index, {
      priority: 100,
      region: this._getRegionKey(hostKey),
      metadata: { name },
      nodeIdHex: normalizeServerIdHex(entry.node_id),
      lastSeenAt: this._parseHexInt(entry.last_seen),
      retries: this._parseHexInt(entry.retries),
      lastError: entry.last_error ?? null,
      version: typeof entry.node[4] === 'string' ? entry.node[4] : '',
      name,
      selectedPort,
      edgePort,
      serverPort,
      connected: !!entry.connected,
    });
  }

  async _loadNetworkDiscoveryCandidates() {
    if (!this.relaySelection.enabled || !this.relaySelection.networkDiscovery.enabled) {
      this._lastNetworkDiscoveryStats = {
        loadedCount: 0,
        usableCount: 0,
        filteredCount: 0,
        startupProbeCount: 0,
      };
      return [];
    }
    if (this._hasExplicitHost || this._hasExplicitHosts) {
      this._lastNetworkDiscoveryStats = {
        loadedCount: 0,
        usableCount: 0,
        filteredCount: 0,
        startupProbeCount: 0,
      };
      return [];
    }

    try {
      const discovered = await this._withTimeout(
        () => this._fetchNetworkDiscoveryNodes(),
        this.relaySelection.networkDiscovery.timeoutMs,
        'Network discovery'
      );
      if (!Array.isArray(discovered)) {
        logger.warn(() => 'Network discovery returned a non-array result. Ignoring discovered nodes.');
        return [];
      }

      let invalidCount = 0;
      const normalized = [];
      discovered.forEach((entry, index) => {
        const candidate = this._normalizeNetworkNode(entry, index);
        if (!candidate) {
          invalidCount += 1;
          return;
        }
        normalized.push(candidate);
      });
      if (invalidCount > 0) {
        logger.warn(() => `Ignored ${invalidCount} invalid network discovery nodes`);
      }
      this._lastNetworkDiscoveryStats = {
        loadedCount: discovered.length,
        usableCount: normalized.length,
        filteredCount: invalidCount,
        startupProbeCount: 0,
      };
      return normalized;
    } catch (error) {
      this._lastNetworkDiscoveryStats = {
        loadedCount: 0,
        usableCount: 0,
        filteredCount: 0,
        startupProbeCount: 0,
      };
      logger.warn(() => `Network discovery failed: ${error}`);
      return [];
    }
  }

  _mergeStartupCandidateLists(initialCandidates, providerCandidates, networkCandidates, cachedCandidates) {
    const merged = [];
    const byHost = new Map();
    const pushCandidate = (candidate) => {
      const lower = candidate.hostKey.toLowerCase();
      if (!byHost.has(lower)) {
        const normalized = { ...candidate, index: merged.length };
        byHost.set(lower, normalized);
        merged.push(normalized);
        return;
      }

      const existing = byHost.get(lower);
      if (this._getSourcePrecedence(candidate.source) < this._getSourcePrecedence(existing.source)) {
        const replacement = { ...candidate, index: existing.index };
        merged[existing.index] = replacement;
        byHost.set(lower, replacement);
      }
    };

    initialCandidates.forEach(pushCandidate);
    providerCandidates.forEach(pushCandidate);
    networkCandidates.forEach(pushCandidate);
    cachedCandidates.forEach(pushCandidate);
    return merged;
  }

  async _buildStartupCandidates() {
    const initialSource = this._hasExplicitHost || this._hasExplicitHosts ? 'configured' : 'seed';
    const initialCandidates = this.initialHosts.map((hostKey, index) => (
      this._createCandidate(hostKey, initialSource, index)
    ));

    const [providerCandidates, networkCandidates] = await Promise.all([
      this._loadDiscoveryProviderCandidates(),
      this._loadNetworkDiscoveryCandidates(),
    ]);
    const cachedCandidates = [];
    if (!this._hasExplicitHost && !this._hasExplicitHosts) {
      for (const [hostKey, score] of this.relayScores.entries()) {
        if ((score.successCount || 0) <= 0) {
          continue;
        }
        if (score.discoveredFrom === 'provider' || score.discoveredFrom === 'network') {
          continue;
        }
        const source = score.discoveredFrom === 'target' ? 'target' : 'cache';
        cachedCandidates.push(this._createCandidate(hostKey, source, cachedCandidates.length));
      }
    }

    return this._mergeStartupCandidateLists(initialCandidates, providerCandidates, networkCandidates, cachedCandidates);
  }

  _advanceNetworkCursor(totalCandidates, consumedCount) {
    if (!Number.isFinite(totalCandidates) || totalCandidates <= 0 || !Number.isFinite(consumedCount) || consumedCount <= 0) {
      return;
    }
    this.discoveryState.networkCursor = (this.discoveryState.networkCursor + consumedCount) % totalCandidates;
    this._scheduleRelayScoreFlush();
  }

  _selectStartupNetworkCandidates(candidates) {
    const startupProbeCount = this.relaySelection.networkDiscovery.startupProbeCount;
    if (!startupProbeCount) {
      return [];
    }

    const networkCandidates = candidates.filter((candidate) => candidate.source === 'network');
    if (networkCandidates.length === 0) {
      return [];
    }

    const freshScored = networkCandidates
      .filter((candidate) => candidate.hasBeenTested && !candidate.inCooldown && candidate.scoreFresh && candidate.ewmaLatencyMs !== null)
      .sort((left, right) => left.ewmaLatencyMs - right.ewmaLatencyMs);
    const staleScored = networkCandidates
      .filter((candidate) => candidate.hasBeenTested && !candidate.inCooldown && !candidate.scoreFresh && candidate.ewmaLatencyMs !== null)
      .sort((left, right) => left.ewmaLatencyMs - right.ewmaLatencyMs);
    const cooldown = networkCandidates
      .filter((candidate) => candidate.inCooldown)
      .sort((left, right) => (left.cooldownUntil || 0) - (right.cooldownUntil || 0));

    const compareUntestedNetwork = (left, right) => {
      if (left.retries !== right.retries) return left.retries - right.retries;
      const leftHasError = left.lastError !== null && left.lastError !== '0x00' && left.lastError !== 0;
      const rightHasError = right.lastError !== null && right.lastError !== '0x00' && right.lastError !== 0;
      if (leftHasError !== rightHasError) return leftHasError ? 1 : -1;
      if (left.lastSeenAt !== right.lastSeenAt) return right.lastSeenAt - left.lastSeenAt;
      return left.hostKey.localeCompare(right.hostKey);
    };

    const untested = networkCandidates
      .filter((candidate) => !candidate.hasBeenTested && !candidate.inCooldown)
      .sort(compareUntestedNetwork);

    const prioritizedUntested = untested.length > 0
      ? untested.slice(this.discoveryState.networkCursor % untested.length).concat(untested.slice(0, this.discoveryState.networkCursor % untested.length))
      : [];

    const selected = [];
    const seen = new Set();
    let consumedUntestedCount = 0;
    const pushCandidate = (candidate) => {
      if (!candidate || seen.has(candidate.hostKey) || selected.length >= startupProbeCount) {
        return;
      }
      seen.add(candidate.hostKey);
      selected.push(candidate);
      if (!candidate.hasBeenTested) {
        consumedUntestedCount += 1;
      }
    };

    freshScored.forEach(pushCandidate);
    prioritizedUntested.forEach(pushCandidate);
    staleScored.forEach(pushCandidate);
    cooldown.forEach(pushCandidate);

    if (this._lastNetworkDiscoveryStats) {
      this._lastNetworkDiscoveryStats.startupProbeCount = selected.length;
    }
    this._advanceNetworkCursor(untested.length, Math.min(consumedUntestedCount, untested.length));
    return selected;
  }

  _selectBackgroundNetworkCandidates(candidates) {
    const batchSize = this.relaySelection.networkDiscovery.backgroundBatchSize;
    if (!batchSize) {
      return [];
    }
    return candidates
      .filter((candidate) => candidate.source === 'network')
      .slice(0, batchSize);
  }

  _rankRelayCandidates(candidates) {
    const normalizedCandidates = candidates.map((candidate, index) => {
      if (typeof candidate === 'string') {
        return this._createCandidate(candidate, 'cache', index);
      }
      return {
        ...candidate,
        index,
      };
    });

    return normalizedCandidates
      .slice()
      .sort((left, right) => {
        const getGroup = (candidate) => {
          if (candidate.inCooldown) return 5;
          const requiredUntested = (candidate.source === 'seed' || candidate.source === 'configured') && !candidate.hasBeenTested;
          if (requiredUntested) return 0;
          if (candidate.hasBeenTested && candidate.ewmaLatencyMs !== null) return 1;
          if (candidate.source === 'network' && !candidate.hasBeenTested) return 2;
          if (candidate.source === 'provider' && !candidate.hasBeenTested) return 3;
          return 4;
        };

        const leftGroup = getGroup(left);
        const rightGroup = getGroup(right);
        if (leftGroup !== rightGroup) {
          return leftGroup - rightGroup;
        }

        if (leftGroup === 2) {
          if (left.retries !== right.retries) return left.retries - right.retries;
          const leftHasError = left.lastError !== null && left.lastError !== '0x00' && left.lastError !== 0;
          const rightHasError = right.lastError !== null && right.lastError !== '0x00' && right.lastError !== 0;
          if (leftHasError !== rightHasError) return leftHasError ? 1 : -1;
          if (left.lastSeenAt !== right.lastSeenAt) return right.lastSeenAt - left.lastSeenAt;
        }
        if (leftGroup === 3 && left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        if (leftGroup === 1 && left.ewmaLatencyMs !== right.ewmaLatencyMs) {
          return left.ewmaLatencyMs - right.ewmaLatencyMs;
        }
        if (left.lastSuccessAt !== right.lastSuccessAt) {
          return right.lastSuccessAt - left.lastSuccessAt;
        }
        if (left.source !== right.source) {
          return this._getSourcePrecedence(left.source) - this._getSourcePrecedence(right.source);
        }
        return left.index - right.index;
      })
      .map((entry) => entry);
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
      const serverId = normalizeServerIdHex(connection.getServerEthereumAddress(true));
      if (serverId) {
        connection._managerServerIdHex = serverId;
        const existing = this.serverIdToConnection.get(serverId);
        if (existing && existing !== connection && isConnected(existing)) {
          const preferred = this._rankConnectedConnections(
            [existing, connection].filter((candidate) => isConnected(candidate))
          )[0];
          this.serverIdToConnection.set(serverId, preferred || connection);
          return;
        }
        this.serverIdToConnection.set(serverId, connection);
      }
    } catch (error) {
      logger.debug(() => `Failed to map server ID for ${connection.host}:${connection.port}: ${error}`);
    }
  }

  _refreshServerIdMapping(serverIdHex) {
    if (!serverIdHex) {
      return;
    }

    const matches = this._connectedConnections().filter((connection) => {
      try {
        const mappedServerId = connection._managerServerIdHex
          || normalizeServerIdHex(connection.getServerEthereumAddress(true));
        if (mappedServerId) {
          connection._managerServerIdHex = mappedServerId;
        }
        return mappedServerId === serverIdHex;
      } catch (_) {
        return false;
      }
    });

    if (matches.length === 0) {
      this.serverIdToConnection.delete(serverIdHex);
      return;
    }

    this.serverIdToConnection.set(
      serverIdHex,
      this._rankConnectedConnections(matches)[0] || matches[0],
    );
  }

  _rankConnectedConnections(connected, options = {}) {
    const { queueRefresh = false } = options;
    return connected
      .map((connection, index) => {
        const hostKey = connection._managerHostKey || normalizeHostKey(joinHostPort(connection.host, connection.port), this.defaultPort);
        const score = this.relayScores.get(hostKey);
        const hasScore = !!(score && Number.isFinite(score.ewmaLatencyMs));
        const fresh = this._isRelayScoreFresh(score);
        if (queueRefresh && hasScore && !fresh) {
          this._queueBackgroundProbe(connection, hostKey);
        }
        return {
          connection,
          index,
          hasScore,
          fresh,
          latency: hasScore ? score.ewmaLatencyMs : Number.POSITIVE_INFINITY,
          connectedAt: connection._managerConnectedAt || Number.MAX_SAFE_INTEGER,
        };
      })
      .sort((left, right) => {
        const leftGroup = left.hasScore ? (left.fresh ? 0 : 1) : 2;
        const rightGroup = right.hasScore ? (right.fresh ? 0 : 1) : 2;
        if (leftGroup !== rightGroup) {
          return leftGroup - rightGroup;
        }
        if (left.latency !== right.latency) {
          return left.latency - right.latency;
        }
        if (left.connectedAt !== right.connectedAt) {
          return left.connectedAt - right.connectedAt;
        }
        return left.index - right.index;
      })
      .map((entry) => entry.connection);
  }

  _localAddressHintFor(connection) {
    const connected = this._rankConnectedConnections(this._connectedConnections());
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
    if (typeof connection.setFleetContract === 'function') {
      connection.setFleetContract(this.fleetContract);
    }
    if (typeof connection.setLocalAddressProvider === 'function') {
      connection.setLocalAddressProvider(() => this._localAddressHintFor(connection));
    }

    const handlers = {};
    handlers.unsolicited = (message) => {
      this.emit('unsolicited', message, connection);
    };
    handlers.reconnected = () => {
      connection._managerReady = true;
      this._updateServerIdMapping(connection);
      if (this.relaySelection.enabled) {
        this._queueBackgroundProbe(connection, hostKey);
      }
      this.emit('reconnected', connection);
    };
    handlers.reconnecting = (info) => {
      connection._managerReady = false;
      this.emit('reconnecting', connection, info);
    };
    handlers.reconnectFailed = () => {
      connection._managerReady = false;
      this.emit('reconnect_failed', connection);
    };
    handlers.disconnect = (payload) => {
      connection._managerReady = false;
      this.emit('disconnect', payload && payload.connection ? payload : { connection, error: payload || null });
    };
    connection.on('unsolicited', handlers.unsolicited);
    connection.on('reconnected', handlers.reconnected);
    connection.on('reconnecting', handlers.reconnecting);
    connection.on('reconnect_failed', handlers.reconnectFailed);
    connection.on('disconnect', handlers.disconnect);
    connection._managerEventHandlers = handlers;
  }

  _unregisterConnection(connection, hostKey) {
    if (!connection) return;
    const handlers = connection._managerEventHandlers;
    if (handlers && typeof connection.off === 'function') {
      connection.off('unsolicited', handlers.unsolicited);
      connection.off('reconnected', handlers.reconnected);
      connection.off('reconnecting', handlers.reconnecting);
      connection.off('reconnect_failed', handlers.reconnectFailed);
      connection.off('disconnect', handlers.disconnect);
      delete connection._managerEventHandlers;
    }
    if (hostKey) {
      if (this.connectionByHost.get(hostKey) === connection) {
        this.connectionByHost.delete(hostKey);
      }
    }
    this.connections = this.connections.filter((item) => item !== connection);
    const removedServerIds = new Set();
    for (const [serverId, conn] of this.serverIdToConnection.entries()) {
      if (conn === connection) {
        this.serverIdToConnection.delete(serverId);
        removedServerIds.add(serverId);
      }
    }
    if (connection._managerServerIdHex) {
      removedServerIds.add(connection._managerServerIdHex);
    }
    removedServerIds.forEach((serverId) => this._refreshServerIdMapping(serverId));
    this._rpcByConnection.delete(connection);
  }

  _closeManagedConnection(connection) {
    if (!connection) return;
    const hostKey = connection._managerHostKey || '';
    try {
      connection.close();
    } catch (_) {
      // Manager state must still be released when transport teardown throws.
    } finally {
      // Keep lifecycle forwarding attached until close() has synchronously
      // emitted disconnect so BindPort/PublishPort can release relay state.
      this._unregisterConnection(connection, hostKey);
    }
  }

  _isProtectedHost(hostKey) {
    if (!hostKey) {
      return false;
    }
    const score = this.relayScores.get(hostKey);
    if (score && score.discoveredFrom === 'target') {
      return true;
    }
    const connection = this.connectionByHost.get(hostKey);
    if (connection) {
      if (typeof connection.hasActiveTunnels === 'function' && connection.hasActiveTunnels()) {
        return true;
      }
      if ((connection.clientSockets && connection.clientSockets.size > 0)
        || (connection.connections && connection.connections.size > 0)
        || Number(connection._diodeActiveNativeSessions || 0) > 0) {
        return true;
      }
      // Opening a tunnel is already active use even before the relay returns
      // its ref and BindPort/PublishPort can register the socket.
      if (connection.pendingRequests) {
        for (const request of connection.pendingRequests.values()) {
          const command = request && request.commandArray && request.commandArray[0];
          if (command === 'portopen' || command === 'portopen2') return true;
        }
      }
    }
    for (const cached of this.deviceRelayCache.values()) {
      const ttlMs = Number.isFinite(cached.ttlMs) ? cached.ttlMs : this.deviceCacheTtlMs;
      if (ttlMs > 0 && Date.now() - cached.ts < ttlMs && cached.hostKey === hostKey) {
        return true;
      }
    }
    return false;
  }

  _pruneIdleConnections() {
    if (!this.relaySelection.enabled || !this._startupCoverageComplete) {
      return;
    }
    const warmBudget = Math.max(1, this.relaySelection.warmConnectionBudget);
    const ranked = this._rankConnectedConnections(this._connectedConnections());
    const keepHosts = new Set();

    if (this.relaySelection.regionDiverseSeedOrdering) {
      const seenRegions = new Set();
      for (const connection of ranked) {
        if (keepHosts.size >= warmBudget) break;
        const hostKey = connection._managerHostKey || '';
        const region = this._getCandidateRegion(hostKey);
        if (seenRegions.has(region)) continue;
        seenRegions.add(region);
        keepHosts.add(hostKey);
      }
    }

    for (const connection of ranked) {
      if (keepHosts.size >= warmBudget) break;
      keepHosts.add(connection._managerHostKey);
    }

    for (const connection of ranked) {
      const hostKey = connection._managerHostKey || '';
      if (!hostKey) continue;
      if (keepHosts.has(hostKey) || this._isProtectedHost(hostKey)) {
        continue;
      }
      this._closeManagedConnection(connection);
    }
  }

  async _ensureConnection(hostEntry) {
    if (this._closed) {
      throw new Error('Diode client manager is closed');
    }
    const hostKey = normalizeHostKey(hostEntry, this.defaultPort);
    const { host, port } = splitHostPort(hostKey, this.defaultPort);
    if (!host) {
      throw new Error(`Invalid host entry: ${hostEntry}`);
    }

    if (this.pendingConnections.has(hostKey)) {
      return this.pendingConnections.get(hostKey);
    }

    if (this.connectionByHost.has(hostKey)) {
      const existing = this.connectionByHost.get(hostKey);
      if (isConnected(existing)) {
        return existing;
      }
      if (existing && typeof existing._ensureConnected === 'function') {
        existing._managerReady = false;
        await existing._ensureConnected();
        existing._managerReady = typeof existing.isReady === 'function' ? existing.isReady() : true;
      }
      if (!isConnected(existing)) throw new Error(`Relay ${hostKey} is not ready`);
      return existing;
    }

    const connection = new DiodeConnection(host, port, this.keyLocation);
    connection._managerReady = false;
    this._registerConnection(connection, hostKey);
    const generation = this._lifecycleGeneration;

    const promise = connection.connect()
      .then(() => {
        if (this._closed || generation !== this._lifecycleGeneration || this.connectionByHost.get(hostKey) !== connection) {
          throw new Error('Diode client manager stopped relay connection while connecting');
        }
        connection._managerReady = typeof connection.isReady === 'function' ? connection.isReady() : true;
        if (!isConnected(connection)) {
          throw new Error(`Relay ${hostKey} did not become ready`);
        }
        connection._managerConnectedAt = connection._managerConnectedAt || Date.now();
        this._updateServerIdMapping(connection);
        this.emit('connected', connection);
        return connection;
      })
      .catch((error) => {
        try {
          connection.close();
        } catch (_) {
          // Preserve the original connection error.
        } finally {
          this._unregisterConnection(connection, hostKey);
        }
        throw error;
      })
      .finally(() => {
        if (this.pendingConnections.get(hostKey) === promise) {
          this.pendingConnections.delete(hostKey);
        }
      });

    this.pendingConnections.set(hostKey, promise);
    return promise;
  }

  async _probeConnection(connection, hostKey, discoveredFrom, startedAt = Date.now()) {
    const timeoutMs = this.relaySelection.probeTimeoutMs;
    const pingPromise = Promise.resolve()
      .then(() => this._getRpcFor(connection).ping({ timeoutMs }))
      .then((result) => {
        if (!result) {
          throw new Error(`Relay probe failed for ${hostKey}`);
        }
      });

    await this._withTimeout(
      () => pingPromise,
      timeoutMs,
      `Relay probe for ${hostKey}`
    );

    const latencyMs = Math.max(1, Date.now() - startedAt);
    this._recordRelayProbeSuccess(hostKey, latencyMs, discoveredFrom);
    return connection;
  }

  async _probeHost(hostEntry, discoveredFrom = 'seed') {
    if (this._closed) {
      throw new Error('Diode client manager is closed');
    }
    const hostKey = normalizeHostKey(hostEntry, this.defaultPort);
    if (!hostKey) {
      throw new Error(`Invalid host entry: ${hostEntry}`);
    }
    if (this.pendingProbes.has(hostKey)) {
      return this.pendingProbes.get(hostKey);
    }

    const startedAt = Date.now();
    this._lastProbeStartedAt.set(hostKey, startedAt);
    const probePromise = (async () => {
      try {
        const connection = await this._withTimeout(
          () => this._ensureConnection(hostKey),
          discoveredFrom === 'target'
            ? this.relaySelection.targetConnectTimeoutMs
            : this.relaySelection.connectionTimeoutMs,
          `Relay connection for ${hostKey}`,
          () => {
            const stalledConnection = this.connectionByHost.get(hostKey);
            if (stalledConnection) this._closeManagedConnection(stalledConnection);
            this.pendingConnections.delete(hostKey);
          }
        );
        // Rank network RTT rather than DNS/TLS/ticket setup time; a cold
        // connection to a nearby relay must not look slower than a warm one.
        const probedConnection = await this._probeConnection(connection, hostKey, discoveredFrom, Date.now());
        this._pruneIdleConnections();
        return probedConnection;
      } catch (error) {
        this._recordRelayProbeFailure(hostKey, error);
        throw error;
      } finally {
        this.pendingProbes.delete(hostKey);
      }
    })();

    this.pendingProbes.set(hostKey, probePromise);
    return probePromise;
  }

  _recordRelayProbeSuccess(hostKey, latencyMs, discoveredFrom) {
    if (this._closed) return;
    const now = Date.now();
    const previous = this.relayScores.get(hostKey) || {
      hostKey,
      ewmaLatencyMs: null,
      lastProbeLatencyMs: null,
      successCount: 0,
      failureCount: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: discoveredFrom || 'seed',
    };

    const previousLatency = Number.isFinite(previous.ewmaLatencyMs) ? previous.ewmaLatencyMs : null;
    const ewmaLatencyMs = previousLatency === null
      ? latencyMs
      : (RELAY_SCORE_EWMA_WEIGHT * latencyMs) + ((1 - RELAY_SCORE_EWMA_WEIGHT) * previousLatency);

    this.relayScores.set(hostKey, {
      hostKey,
      ewmaLatencyMs,
      lastProbeLatencyMs: latencyMs,
      successCount: (previous.successCount || 0) + 1,
      failureCount: previous.failureCount || 0,
      lastSuccessAt: now,
      lastFailureAt: previous.lastFailureAt || 0,
      cooldownUntil: 0,
      discoveredFrom: discoveredFrom || previous.discoveredFrom || 'seed',
    });
    this._scheduleRelayScoreFlush();
  }

  _recordRelayProbeFailure(hostKey, error) {
    if (this._closed) return;
    const now = Date.now();
    const previous = this.relayScores.get(hostKey) || {
      hostKey,
      ewmaLatencyMs: null,
      lastProbeLatencyMs: null,
      successCount: 0,
      failureCount: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'seed',
    };

    this.relayScores.set(hostKey, {
      hostKey,
      ewmaLatencyMs: Number.isFinite(previous.ewmaLatencyMs) ? previous.ewmaLatencyMs : null,
      lastProbeLatencyMs: previous.lastProbeLatencyMs || null,
      successCount: previous.successCount || 0,
      failureCount: (previous.failureCount || 0) + 1,
      lastSuccessAt: previous.lastSuccessAt || 0,
      lastFailureAt: now,
      cooldownUntil: now + RELAY_SCORE_FAILURE_COOLDOWN_MS,
      discoveredFrom: previous.discoveredFrom || 'seed',
    });
    this._scheduleRelayScoreFlush();

    if (error) {
      logger.debug(() => `Relay probe failed for ${hostKey}: ${error}`);
    }
  }

  _selectPreferredConnectedConnection() {
    const connected = this._connectedConnections();
    if (connected.length === 0) {
      return null;
    }
    return this._rankConnectedConnections(connected, { queueRefresh: true })[0] || null;
  }

  _isRelayScoreFresh(score) {
    return !!(score
      && Number.isFinite(score.ewmaLatencyMs)
      && score.lastSuccessAt
      && (Date.now() - score.lastSuccessAt) <= RELAY_SCORE_FRESH_MS);
  }

  _queueBackgroundProbe(connection, hostKey) {
    if (this._closed || !this.relaySelection.enabled || !connection || !hostKey || !isConnected(connection)) {
      return;
    }
    if (this.pendingProbes.has(hostKey)) {
      return;
    }
    const lastProbeStartedAt = this._lastProbeStartedAt.get(hostKey) || 0;
    if (Date.now() - lastProbeStartedAt < this.relaySelection.backgroundProbeIntervalMs) {
      return;
    }

    void this._probeHost(hostKey, this.relayScores.get(hostKey)?.discoveredFrom || 'seed')
      .catch((error) => {
        logger.debug(() => `Background relay probe failed for ${hostKey}: ${error}`);
      });
  }

  _getDeviceCacheEntry(deviceIdHex) {
    if (this.deviceCacheTtlMs <= 0) {
      return null;
    }
    const cached = this.deviceRelayCache.get(deviceIdHex);
    if (!cached) {
      return null;
    }
    const ttlMs = Number.isFinite(cached.ttlMs) ? cached.ttlMs : this.deviceCacheTtlMs;
    if (ttlMs <= 0 || Date.now() - cached.ts >= ttlMs) {
      this.deviceRelayCache.delete(deviceIdHex);
      return null;
    }
    return cached;
  }

  _setDeviceCacheEntry(deviceIdHex, entry) {
    if (this._closed || this.deviceCacheTtlMs <= 0 || !deviceIdHex || !entry) {
      return;
    }
    this.deviceRelayCache.set(deviceIdHex, {
      serverIdHex: entry.serverIdHex,
      hostKey: entry.hostKey,
      ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
      ttlMs: Number.isFinite(entry.ttlMs) ? entry.ttlMs : this.deviceCacheTtlMs,
    });
  }

  _getDeviceCacheTtlForHost(hostKey) {
    const score = this.relayScores.get(hostKey);
    if (score && Number.isFinite(score.ewmaLatencyMs) && score.ewmaLatencyMs >= this.relaySelection.slowRelayThresholdMs) {
      return this.relaySelection.slowDeviceRetryTtlMs;
    }
    return this.deviceCacheTtlMs;
  }

  _getRelayLatencyMs(hostKey) {
    const score = this.relayScores.get(hostKey);
    return score && Number.isFinite(score.ewmaLatencyMs) ? score.ewmaLatencyMs : Number.POSITIVE_INFINITY;
  }

  _connectedConnections() {
    return this.connections.filter((connection) => isConnected(connection));
  }

  getNearestConnection() {
    const connected = this._connectedConnections();
    if (connected.length === 0) {
      return null;
    }

    if (!this.relaySelection.enabled) {
      this._rrIndex = (this._rrIndex + 1) % connected.length;
      return connected[this._rrIndex];
    }

    return this._selectPreferredConnectedConnection();
  }

  async _resolveDeviceRelayCandidate(connection, deviceIdBuffer) {
    const rpc = this._getRpcFor(connection);
    const commandOptions = { timeoutMs: this.relaySelection.deviceLookupTimeoutMs };
    const ticket = await rpc.getObject(deviceIdBuffer, commandOptions);
    const serverIdHex = normalizeServerIdHex(ticket && (ticket.serverIdHex || ticket.serverId));
    if (!serverIdHex) {
      return null;
    }

    const existing = this.serverIdToConnection.get(serverIdHex);
    if (existing && isConnected(existing)) {
      return {
        serverIdHex,
        hostKey: existing._managerHostKey || '',
        relayConnection: existing,
        controlConnection: connection,
      };
    }

    const nodeId = Buffer.from(serverIdHex.slice(2), 'hex');
    const nodeInfo = await rpc.getNode(nodeId, commandOptions);
    if (!nodeInfo || !nodeInfo.host) {
      return null;
    }

    const relayPort = nodeInfo.edgePort || nodeInfo.serverPort;
    if (!relayPort) {
      return null;
    }

    return {
      serverIdHex,
      hostKey: joinHostPort(nodeInfo.host, relayPort),
      relayConnection: null,
      controlConnection: connection,
    };
  }

  async _ensureDeviceRelayCandidateConnection(candidate) {
    if (!candidate || !candidate.hostKey) {
      return null;
    }
    if (candidate.relayConnection && isConnected(candidate.relayConnection)) {
      return candidate.relayConnection;
    }
    candidate.relayConnection = this.relaySelection.enabled
      ? await this._probeHost(candidate.hostKey, 'target')
      : await this._ensureConnection(candidate.hostKey);
    return candidate.relayConnection;
  }

  _shouldReconcileDeviceRelay(controlHostKey, targetHostKey) {
    if (!this.relaySelection.enabled || !controlHostKey || !targetHostKey) {
      return false;
    }

    const reconciliation = this.relaySelection.deviceRelayReconciliation;
    if (!reconciliation.enabled || reconciliation.maxControlRelays <= 0) {
      return false;
    }

    const targetLatencyMs = this._getRelayLatencyMs(targetHostKey);
    if (!Number.isFinite(targetLatencyMs) || targetLatencyMs < this.relaySelection.slowRelayThresholdMs) {
      return false;
    }

    const controlLatencyMs = this._getRelayLatencyMs(controlHostKey);
    if (!Number.isFinite(controlLatencyMs)) {
      return true;
    }
    if (targetLatencyMs - controlLatencyMs < reconciliation.minLatencyDeltaMs) {
      return false;
    }
    return targetLatencyMs >= controlLatencyMs * reconciliation.slowdownFactor;
  }

  async _withTimeout(promiseFactory, timeoutMs, label, onTimeout = null) {
    const boundedTimeoutMs = parsePositiveInteger(timeoutMs, 1200);
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => promiseFactory()),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (typeof onTimeout === 'function') {
              try { onTimeout(); } catch (_) {}
            }
            reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`));
          }, boundedTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _reconcileDeviceRelayCandidate(primaryConnection, deviceIdBuffer, initialCandidate, trace = null) {
    if (!initialCandidate || !initialCandidate.hostKey) {
      return initialCandidate;
    }

    const primaryHostKey = primaryConnection && primaryConnection._managerHostKey
      ? primaryConnection._managerHostKey
      : '';
    const shouldReconcile = this._shouldReconcileDeviceRelay(primaryHostKey, initialCandidate.hostKey);
    if (trace) {
      trace.reconciliation = trace.reconciliation || {
        triggered: false,
        attempted: false,
        hadAlternateAnswer: false,
        choseAlternate: false,
        alternateResults: [],
      };
      trace.reconciliation.triggered = shouldReconcile;
    }
    if (!shouldReconcile) {
      return initialCandidate;
    }

    const reconciliation = this.relaySelection.deviceRelayReconciliation;
    const alternates = this._rankConnectedConnections(this._connectedConnections(), { queueRefresh: true })
      .filter((connection) => connection !== primaryConnection)
      .slice(0, reconciliation.maxControlRelays);
    if (trace) {
      trace.reconciliation.attempted = alternates.length > 0;
    }
    if (alternates.length === 0) {
      return initialCandidate;
    }

    const attempts = await Promise.allSettled(alternates.map(async (connection) => {
      const startedAt = Date.now();
      try {
        const candidate = await this._withTimeout(
          async () => this._resolveDeviceRelayCandidate(connection, deviceIdBuffer),
          reconciliation.timeoutMs,
          `Device relay reconciliation via ${connection._managerHostKey || 'unknown relay'}`
        );
        return {
          ok: true,
          controlHostKey: connection._managerHostKey || '',
          lookupMs: Date.now() - startedAt,
          candidate,
        };
      } catch (error) {
        return {
          ok: false,
          controlHostKey: connection._managerHostKey || '',
          lookupMs: Date.now() - startedAt,
          error: String(error && error.message ? error.message : error),
          candidate: null,
        };
      }
    }));

    let bestCandidate = initialCandidate;
    let bestLatencyMs = this._getRelayLatencyMs(initialCandidate.hostKey);
    for (const result of attempts) {
      if (result.status !== 'fulfilled' || !result.value) {
        continue;
      }
      const attempt = result.value;
      const candidate = attempt.candidate;
      const differentAnswer = !!(
        candidate
        && candidate.hostKey
        && (
          candidate.serverIdHex !== initialCandidate.serverIdHex
          || candidate.hostKey !== initialCandidate.hostKey
        )
      );
      if (trace) {
        trace.reconciliation.alternateResults.push({
          controlHostKey: attempt.controlHostKey,
          lookupMs: attempt.lookupMs,
          ok: attempt.ok,
          error: attempt.error || null,
          serverIdHex: candidate ? candidate.serverIdHex : null,
          hostKey: candidate ? candidate.hostKey : null,
          differentAnswer,
          chosen: false,
        });
        if (differentAnswer) {
          trace.reconciliation.hadAlternateAnswer = true;
        }
      }
      if (!attempt.ok || !candidate || !candidate.hostKey) {
        continue;
      }
      if (candidate.serverIdHex === bestCandidate.serverIdHex && candidate.hostKey === bestCandidate.hostKey) {
        continue;
      }
      try {
        await this._ensureDeviceRelayCandidateConnection(candidate);
      } catch (error) {
        logger.debug(() => `Device relay reconciliation candidate failed for ${candidate.hostKey}: ${error}`);
        continue;
      }
      const candidateLatencyMs = this._getRelayLatencyMs(candidate.hostKey);
      if (!Number.isFinite(candidateLatencyMs)) {
        continue;
      }
      if (!Number.isFinite(bestLatencyMs) || candidateLatencyMs < bestLatencyMs) {
        bestCandidate = candidate;
        bestLatencyMs = candidateLatencyMs;
      }
    }

    if (trace && trace.reconciliation && bestCandidate !== initialCandidate) {
      trace.reconciliation.choseAlternate = true;
      const chosen = trace.reconciliation.alternateResults.find((entry) => (
        entry.serverIdHex === bestCandidate.serverIdHex
        && entry.hostKey === bestCandidate.hostKey
      ));
      if (chosen) {
        chosen.chosen = true;
      }
    }

    return bestCandidate;
  }

  connect() {
    if (this._closed) return Promise.reject(new Error('Diode client manager is closed'));
    if (this._startupReadyPromise) return this._startupReadyPromise;
    if (this._connectedConnections().length > 0) return Promise.resolve(this);

    // One completed TLS/ticket handshake is enough to use the network. Keep
    // measuring the remaining relays in the background; pruning still waits
    // for startup coverage, preserving region diversity and active tunnels.
    let onConnected;
    const ready = new Promise((resolve, reject) => {
      this._rejectStartupReady = reject;
      onConnected = (connection) => {
        if (!this._closed && isConnected(connection)) resolve(this);
      };
      this.on('connected', onConnected);
      const work = this._startupWorkActive
        ? this._startupWorkPromise
        : this._connectAndWarmRelays();
      if (!this._startupWorkActive) {
        this._startupWorkPromise = work;
        this._startupWorkActive = true;
        const finishWork = () => { this._startupWorkActive = false; };
        work.then(finishWork, finishWork);
      }
      work.then(resolve, reject);
    });
    const result = ready.finally(() => {
      this.off('connected', onConnected);
      this._rejectStartupReady = null;
      if (this._startupReadyPromise === result) this._startupReadyPromise = null;
    });
    this._startupReadyPromise = result;
    return result;
  }

  async _connectAndWarmRelays() {
    if (this._closed) {
      throw new Error('Diode client manager is closed');
    }
    if (!this.initialHosts || this.initialHosts.length === 0) {
      throw new Error('No Diode hosts configured');
    }

    if (!this.relaySelection.enabled) {
      const results = await Promise.allSettled(
        this.initialHosts.map((host) => this._ensureConnection(host))
      );
      if (this._closed) throw new Error('Diode client manager closed during startup');

      const success = results.some((result) => result.status === 'fulfilled');
      if (!success) {
        const errorMessages = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));
        throw new Error(`Failed to connect to any Diode hosts. ${errorMessages.join('; ')}`);
      }

      return this;
    }

    const initialSource = this._hasExplicitHost || this._hasExplicitHosts ? 'configured' : 'seed';
    const initialCandidates = this.initialHosts.map((hostKey, index) => (
      this._createCandidate(hostKey, initialSource, index)
    ));

    if (!this.relaySelection.probeAllInitialCandidates) {
      const candidates = await this._buildStartupCandidates();
      const requiredCoverageCandidates = this._rankRelayCandidates(candidates).slice(0, this.relaySelection.minReadyConnections);
      const results = await runWithConcurrency(
        requiredCoverageCandidates,
        this.relaySelection.startupConcurrency,
        (candidate) => this._probeHost(candidate.hostKey, candidate.source)
      );

      const successes = results.filter((result) => result.status === 'fulfilled');
      if (this._closed) throw new Error('Diode client manager closed during startup');
      if (successes.length === 0 && this._connectedConnections().length === 0) {
        const errorMessages = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));
        throw new Error(`Failed to connect to any Diode hosts. ${errorMessages.join('; ')}`);
      }

      this._startupCoverageComplete = true;
      this._pruneIdleConnections();
      return this;
    }

    const allRequiredCoverageCandidates = this._getInitialCoverageCandidates(initialCandidates);
    const bootstrapSeedCandidates = this._getStartupSeedBootstrapCandidates(initialCandidates);
    const bootstrapCoveragePromise = runWithConcurrency(
      bootstrapSeedCandidates,
      this.relaySelection.startupConcurrency,
      (candidate) => this._probeHost(candidate.hostKey, candidate.source)
    );
    const candidatesPromise = this._buildStartupCandidates();
    const [bootstrapResults, candidates] = await Promise.all([bootstrapCoveragePromise, candidatesPromise]);
    if (this._closed) throw new Error('Diode client manager closed during startup');

    const startupNetworkCandidates = this._selectStartupNetworkCandidates(candidates);
    const useReducedSeedCoverage = (
      !this._hasExplicitHost
      && !this._hasExplicitHosts
      && this.relaySelection.networkDiscovery.enabled
      && startupNetworkCandidates.length > 0
    );
    const requiredCoverageCandidates = useReducedSeedCoverage
      ? bootstrapSeedCandidates
      : allRequiredCoverageCandidates;
    const bootstrapCoverageHostKeys = new Set(bootstrapSeedCandidates.map((candidate) => candidate.hostKey));
    const remainingRequiredCoverageCandidates = useReducedSeedCoverage
      ? []
      : allRequiredCoverageCandidates.filter((candidate) => !bootstrapCoverageHostKeys.has(candidate.hostKey));
    const initialCoverageCandidates = [];
    const coverageHostKeys = new Set();
    [...requiredCoverageCandidates, ...startupNetworkCandidates].forEach((candidate) => {
      if (!coverageHostKeys.has(candidate.hostKey)) {
        coverageHostKeys.add(candidate.hostKey);
        initialCoverageCandidates.push(candidate);
      }
    });

    const remainingCandidates = this._rankRelayCandidates(
      candidates.filter((candidate) => !coverageHostKeys.has(candidate.hostKey))
    );
    const backgroundNetworkCandidates = this._selectBackgroundNetworkCandidates(remainingCandidates);
    const backgroundCandidates = [
      ...backgroundNetworkCandidates,
      ...remainingCandidates.filter((candidate) => candidate.source !== 'network'),
    ];

    const additionalRequiredResults = remainingRequiredCoverageCandidates.length > 0
      ? await runWithConcurrency(
        remainingRequiredCoverageCandidates,
        this.relaySelection.startupConcurrency,
        (candidate) => this._probeHost(candidate.hostKey, candidate.source)
      )
      : [];
    const networkResults = startupNetworkCandidates.length > 0
      ? await runWithConcurrency(
        startupNetworkCandidates,
        this.relaySelection.startupConcurrency,
        (candidate) => this._probeHost(candidate.hostKey, candidate.source)
      )
      : [];
    const results = [...bootstrapResults, ...additionalRequiredResults, ...networkResults];

    const successes = results.filter((result) => result.status === 'fulfilled');
    if (this._closed) throw new Error('Diode client manager closed during startup');
    if (successes.length === 0 && this._connectedConnections().length === 0) {
      const errorMessages = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));
      throw new Error(`Failed to connect to any Diode hosts. ${errorMessages.join('; ')}`);
    }

    this._startupCoverageComplete = true;
    this._pruneIdleConnections();

    if (backgroundCandidates.length > 0 && this.relaySelection.continueProbingUntestedSeeds) {
      const generation = this._lifecycleGeneration;
      const warmupPromise = runWithConcurrency(
        backgroundCandidates,
        this.relaySelection.startupConcurrency,
        (candidate) => {
          if (this._closed || generation !== this._lifecycleGeneration) {
            throw new Error('Diode client manager closed during background warmup');
          }
          return this._probeHost(candidate.hostKey, candidate.source);
        }
      ).catch((error) => {
        logger.debug(() => `Background relay measurement failed: ${error}`);
      }).finally(() => {
        if (this._backgroundWarmupPromise === warmupPromise) {
          this._backgroundWarmupPromise = null;
        }
      });
      this._backgroundWarmupPromise = warmupPromise;
    }

    return this;
  }

  async getConnectionForDevice(deviceId) {
    if (this._closed) throw new Error('Diode client manager is closed');
    const deviceIdBuffer = normalizeAddress(deviceId);
    if (!deviceIdBuffer) throw new Error('Invalid device ID');
    const key = deviceIdBuffer.toString('hex');
    const existing = this.pendingDeviceResolutions.get(key);
    if (existing) return existing;

    // Applications often open several TCP sockets together. Share the device
    // ticket/node lookup and relay handshake while keeping their tunnels distinct.
    const resolution = this._getConnectionForDevice(deviceIdBuffer).finally(() => {
      if (this.pendingDeviceResolutions.get(key) === resolution) {
        this.pendingDeviceResolutions.delete(key);
      }
    });
    this.pendingDeviceResolutions.set(key, resolution);
    return resolution;
  }

  async _getConnectionForDevice(deviceId) {
    const deviceIdBuffer = normalizeAddress(deviceId);
    if (!deviceIdBuffer) {
      throw new Error('Invalid device ID');
    }
    const deviceIdHex = deviceIdBuffer.toString('hex');
    const trace = {
      deviceId: `0x${deviceIdHex}`,
      primaryControlHostKey: null,
      primaryLookupMs: null,
      controlPlaneSlowThresholdMs: Math.max(
        this.relaySelection.probeTimeoutMs,
        this.relaySelection.deviceRelayReconciliation.timeoutMs,
      ),
      controlPlaneSlow: false,
      initialServerIdHex: null,
      initialHostKey: null,
      initialConnectMs: null,
      finalServerIdHex: null,
      finalHostKey: null,
      reconciliation: {
        triggered: false,
        attempted: false,
        hadAlternateAnswer: false,
        choseAlternate: false,
        alternateResults: [],
      },
    };
    this._lastDeviceResolutionTrace = trace;

    const cached = this._getDeviceCacheEntry(deviceIdHex);
    if (cached) {
      const cachedConn = this.serverIdToConnection.get(cached.serverIdHex)
        || this.connectionByHost.get(cached.hostKey);
      if (cachedConn && isConnected(cachedConn)) {
        trace.cacheHit = true;
        trace.finalServerIdHex = cached.serverIdHex;
        trace.finalHostKey = cached.hostKey;
        return cachedConn;
      }
    }

    const primary = this.getNearestConnection();
    if (!primary) {
      throw new Error('No connected relay available');
    }
    trace.primaryControlHostKey = primary._managerHostKey || null;

    let candidate = null;
    try {
      const startedAt = Date.now();
      candidate = await this._resolveDeviceRelayCandidate(primary, deviceIdBuffer);
      trace.primaryLookupMs = Date.now() - startedAt;
      trace.controlPlaneSlow = trace.primaryLookupMs > trace.controlPlaneSlowThresholdMs;
    } catch (error) {
      logger.warn(() => `Failed to resolve device ticket: ${error}`);
      trace.error = String(error && error.message ? error.message : error);
      return primary;
    }
    if (!candidate || !candidate.serverIdHex) {
      return primary;
    }
    trace.initialServerIdHex = candidate.serverIdHex;
    trace.initialHostKey = candidate.hostKey || null;

    if (candidate.relayConnection && isConnected(candidate.relayConnection)) {
      const hostKey = candidate.hostKey || candidate.relayConnection._managerHostKey || '';
      this._setDeviceCacheEntry(deviceIdHex, {
        serverIdHex: candidate.serverIdHex,
        hostKey,
        ts: Date.now(),
        ttlMs: this._getDeviceCacheTtlForHost(hostKey),
      });
      trace.finalServerIdHex = candidate.serverIdHex;
      trace.finalHostKey = hostKey;
      return candidate.relayConnection;
    }

    try {
      const startedAt = Date.now();
      await this._ensureDeviceRelayCandidateConnection(candidate);
      trace.initialConnectMs = Date.now() - startedAt;
    } catch (error) {
      logger.warn(() => `Failed to connect to relay ${candidate.hostKey}: ${error}`);
      trace.error = String(error && error.message ? error.message : error);
      return primary;
    }

    candidate = await this._reconcileDeviceRelayCandidate(primary, deviceIdBuffer, candidate, trace);
    const hostKey = candidate.hostKey || '';
    const relayConnection = candidate.relayConnection || this.connectionByHost.get(hostKey) || primary;
    trace.finalServerIdHex = candidate.serverIdHex;
    trace.finalHostKey = hostKey;
    this._setDeviceCacheEntry(deviceIdHex, {
      serverIdHex: candidate.serverIdHex,
      hostKey,
      ts: Date.now(),
      ttlMs: this._getDeviceCacheTtlForHost(hostKey),
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

    let candidate = await this._resolveDeviceRelayCandidate(primary, deviceIdBuffer);
    if (!candidate || !candidate.serverIdHex || !candidate.hostKey) {
      throw new Error('Device ticket missing server ID');
    }

    try {
      await this._ensureDeviceRelayCandidateConnection(candidate);
    } catch (_) {}
    candidate = await this._reconcileDeviceRelayCandidate(primary, deviceIdBuffer, candidate);
    const { host, port } = splitHostPort(candidate.hostKey, this.defaultPort);

    return {
      serverId: candidate.serverIdHex,
      host,
      port,
    };
  }

  getConnections() {
    return this.connections.slice();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._lifecycleGeneration += 1;
    if (this._rejectStartupReady) {
      this._rejectStartupReady(new Error('Diode client manager closed during startup'));
      this._rejectStartupReady = null;
    }
    if (this._relayScoreFlushTimer) {
      clearTimeout(this._relayScoreFlushTimer);
      this._relayScoreFlushTimer = null;
    }
    this._flushRelayScores();
    for (const connection of this.connections.slice()) {
      this._closeManagedConnection(connection);
    }
    this.pendingConnections.clear();
    this.pendingProbes.clear();
    this.pendingDeviceResolutions.clear();
    this.deviceRelayCache.clear();
  }
}

module.exports = DiodeClientManager;
