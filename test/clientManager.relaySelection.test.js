const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');

const DiodeClientManager = require('../clientManager');
const { fetchNetworkDirectory } = require('../networkDiscoveryClient');

const networkSnapshot = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dio-network-snapshot.json'), 'utf8')
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diode-relay-test-'));
}

function makeScoreCache(scoreCachePath, relays, options = {}) {
  fs.mkdirSync(path.dirname(scoreCachePath), { recursive: true });
  fs.writeFileSync(scoreCachePath, JSON.stringify({
    version: options.version || 1,
    updatedAt: Date.now(),
    discoveryState: options.discoveryState,
    relays,
  }, null, 2), 'utf8');
}

function extractHosts(candidates) {
  return candidates.map((candidate) => (typeof candidate === 'string' ? candidate : candidate.hostKey));
}

async function extractStartupHosts(manager) {
  return extractHosts(await manager._buildStartupCandidates());
}

class FakeConnection extends EventEmitter {
  constructor(hostKey, options = {}) {
    super();
    const parts = /^(.*):(\d+)$/.exec(hostKey);
    this.host = parts ? parts[1] : hostKey;
    this.port = parts ? Number(parts[2]) : 41046;
    this.socket = { destroyed: false };
    this.closeCount = 0;
    this.serverEthereumAddress = options.serverEthereumAddress || '0x' + Buffer.from(hostKey).toString('hex').slice(0, 40).padEnd(40, '0');
    this.RPC = {
      ping: async () => {
        await delay(options.pingDelayMs || 0);
        return options.pingResult !== false;
      },
      getObject: options.getObject || (async () => null),
      getNode: options.getNode || (async () => null),
    };
  }

  getServerEthereumAddress() {
    return this.serverEthereumAddress;
  }

  setLocalAddressProvider(provider) {
    this.localAddressProvider = provider;
  }

  close() {
    this.closeCount += 1;
    this.socket.destroyed = true;
  }

  async _ensureConnected() {
    this.socket.destroyed = false;
  }
}

class TestClientManager extends DiodeClientManager {
  constructor(options = {}, hostBehaviors = new Map(), networkNodes = null) {
    super(options);
    this.hostBehaviors = hostBehaviors;
    this.networkNodes = networkNodes;
    this.ensureCalls = [];
  }

  async _ensureConnection(hostEntry) {
    const hostKey = hostEntry;
    this.ensureCalls.push(hostKey);

    if (this.connectionByHost.has(hostKey)) {
      return this.connectionByHost.get(hostKey);
    }

    const behavior = this.hostBehaviors.get(hostKey) || {};
    if (behavior.connectDelayMs) {
      await delay(behavior.connectDelayMs);
    }
    if (behavior.connectError) {
      throw behavior.connectError;
    }

    const connection = behavior.connection || new FakeConnection(hostKey, behavior);
    if (!this.connectionByHost.has(hostKey)) {
      this._registerConnection(connection, hostKey);
    }
    connection._managerConnectedAt = connection._managerConnectedAt || Date.now();
    this._updateServerIdMapping(connection);
    return connection;
  }

  async _fetchNetworkDiscoveryNodes() {
    if (this.networkNodes !== null) {
      return this.networkNodes;
    }
    return super._fetchNetworkDiscoveryNodes();
  }
}

test('tested candidates rank by measured latency', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    'as1.prenet.diode.io:41046': {
      ewmaLatencyMs: 180,
      lastProbeLatencyMs: 180,
      successCount: 2,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'seed',
    },
    'eu1.prenet.diode.io:41046': {
      ewmaLatencyMs: 35,
      lastProbeLatencyMs: 35,
      successCount: 3,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'seed',
    },
  });

  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath, networkDiscovery: { enabled: false } } });
  const ranked = extractHosts(manager._rankRelayCandidates([
    'as1.prenet.diode.io:41046',
    'eu1.prenet.diode.io:41046',
  ]));

  assert.equal(ranked[0], 'eu1.prenet.diode.io:41046');
  manager.close();
});

test('unknown relays rank behind known-good relays and ahead of cooldown relays', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath: null } });

  manager.relayScores.set('known:41046', {
    hostKey: 'known:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('cooldown:41046', {
    hostKey: 'cooldown:41046',
    ewmaLatencyMs: 5,
    lastProbeLatencyMs: 5,
    successCount: 1,
    failureCount: 1,
    lastSuccessAt: Date.now(),
    lastFailureAt: Date.now(),
    cooldownUntil: Date.now() + 60000,
    discoveredFrom: 'seed',
  });

  const ranked = extractHosts(manager._rankRelayCandidates(['unknown:41046', 'cooldown:41046', 'known:41046']));
  assert.deepEqual(ranked, ['known:41046', 'unknown:41046', 'cooldown:41046']);
  manager.close();
});

test('connect probes all explicit hosts before resolving', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new TestClientManager({
    keyLocation,
    hosts: ['fast:41046', 'fail:41046', 'unused:41046'],
    relaySelection: {
      scoreCachePath: null,
      startupConcurrency: 2,
      minReadyConnections: 1,
      probeTimeoutMs: 200,
    },
  }, new Map([
    ['fast:41046', { connectDelayMs: 20, pingDelayMs: 40 }],
    ['fail:41046', { connectDelayMs: 5, pingDelayMs: 5, pingResult: false }],
    ['unused:41046', { connectDelayMs: 1, pingDelayMs: 1 }],
  ]));

  const startedAt = Date.now();
  await manager.connect();
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 50, `expected bounded startup probe wait, got ${elapsedMs}ms`);
  assert.deepEqual(manager.ensureCalls.sort(), ['fail:41046', 'fast:41046', 'unused:41046']);
  manager.close();
});

test('getNearestConnection returns the lowest-latency connected relay', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath: null } });

  const slow = new FakeConnection('slow:41046');
  const fast = new FakeConnection('fast:41046');
  const unknown = new FakeConnection('unknown:41046');
  manager._registerConnection(slow, 'slow:41046');
  manager._registerConnection(fast, 'fast:41046');
  manager._registerConnection(unknown, 'unknown:41046');
  slow._managerConnectedAt = 1;
  fast._managerConnectedAt = 2;
  unknown._managerConnectedAt = 0;

  manager.relayScores.set('slow:41046', {
    hostKey: 'slow:41046',
    ewmaLatencyMs: 90,
    lastProbeLatencyMs: 90,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('fast:41046', {
    hostKey: 'fast:41046',
    ewmaLatencyMs: 15,
    lastProbeLatencyMs: 15,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  assert.equal(manager.getNearestConnection(), fast);
  assert.equal(manager.getNearestConnection(), fast);
  manager.close();
});

test('failed probes place relays into cooldown', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath: null } });

  const startedAt = Date.now();
  manager._recordRelayProbeFailure('relay:41046', new Error('boom'));
  const score = manager.relayScores.get('relay:41046');

  assert.ok(score.cooldownUntil > startedAt);
  const ranked = extractHosts(manager._rankRelayCandidates(['relay:41046', 'unknown:41046']));
  assert.deepEqual(ranked, ['unknown:41046', 'relay:41046']);
  manager.close();
});

test('score cache load ignores corrupt files', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  fs.writeFileSync(scoreCachePath, '{not valid json', 'utf8');

  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath } });
  assert.equal(manager.relayScores.size, 0);
  manager.close();
});

test('score cache write persists relay metadata', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath } });

  manager._recordRelayProbeSuccess('persisted:41046', 42, 'target');
  manager._flushRelayScores();

  const written = JSON.parse(fs.readFileSync(scoreCachePath, 'utf8'));
  assert.equal(written.version, 2);
  assert.equal(written.relays['persisted:41046'].ewmaLatencyMs, 42);
  assert.equal(written.relays['persisted:41046'].discoveredFrom, 'target');
  manager.close();
});

test('on-demand target relay resolution records a new relay score', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const primary = new FakeConnection('primary:41046', {
    getObject: async () => ({ serverIdHex: '0xaabb' }),
    getNode: async () => ({ host: 'target', edgePort: 41046, serverPort: 41046 }),
  });
  const target = new FakeConnection('target:41046', { serverEthereumAddress: '0xaabb', pingDelayMs: 5 });
  const manager = new TestClientManager({ keyLocation, relaySelection: { scoreCachePath: null } }, new Map([
    ['target:41046', { connection: target, pingDelayMs: 5 }],
  ]));

  manager._registerConnection(primary, 'primary:41046');
  primary._managerConnectedAt = 1;
  manager.relayScores.set('primary:41046', {
    hostKey: 'primary:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  const connection = await manager.getConnectionForDevice('0x01');
  const score = manager.relayScores.get('target:41046');

  assert.equal(connection, target);
  assert.ok(score);
  assert.equal(score.discoveredFrom, 'target');
  assert.ok(score.successCount >= 1);
  manager.close();
});

test('slow target relay resolution stores shortened device cache ttl', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const primary = new FakeConnection('primary:41046', {
    getObject: async () => ({ serverIdHex: '0xccdd' }),
    getNode: async () => ({ host: 'slow-target', edgePort: 41046, serverPort: 41046 }),
  });
  const target = new FakeConnection('slow-target:41046', { serverEthereumAddress: '0xccdd', pingDelayMs: 30 });
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      slowRelayThresholdMs: 20,
      slowDeviceRetryTtlMs: 1234,
      probeTimeoutMs: 200,
    },
  }, new Map([
    ['slow-target:41046', { connection: target, pingDelayMs: 30 }],
  ]));

  manager._registerConnection(primary, 'primary:41046');
  primary._managerConnectedAt = 1;
  manager.relayScores.set('primary:41046', {
    hostKey: 'primary:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  await manager.getConnectionForDevice('0x02');
  const entry = manager.deviceRelayCache.get('02');

  assert.equal(entry.ttlMs, 1234);
  manager.close();
});

test('device relay reconciliation switches to a better target relay from an alternate control relay', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const primary = new FakeConnection('primary:41046', {
    getObject: async () => ({ serverIdHex: '0xaaaa' }),
    getNode: async () => ({ host: 'slow-target', edgePort: 41046, serverPort: 41046 }),
  });
  const alternate = new FakeConnection('alternate:41046', {
    getObject: async () => ({ serverIdHex: '0xbbbb' }),
    getNode: async () => ({ host: 'fast-target', edgePort: 41046, serverPort: 41046 }),
  });
  const fastTarget = new FakeConnection('fast-target:41046', { serverEthereumAddress: '0xbbbb', pingDelayMs: 20 });
  const slowTarget = new FakeConnection('slow-target:41046', { serverEthereumAddress: '0xaaaa', pingDelayMs: 250 });
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      probeTimeoutMs: 1000,
      slowRelayThresholdMs: 100,
      deviceRelayReconciliation: {
        enabled: true,
        maxControlRelays: 1,
        timeoutMs: 200,
        minLatencyDeltaMs: 50,
        slowdownFactor: 2,
      },
    },
  }, new Map([
    ['slow-target:41046', { connection: slowTarget, pingDelayMs: 250 }],
    ['fast-target:41046', { connection: fastTarget, pingDelayMs: 20 }],
  ]));

  manager._registerConnection(primary, 'primary:41046');
  manager._registerConnection(alternate, 'alternate:41046');
  primary._managerConnectedAt = 1;
  alternate._managerConnectedAt = 2;
  manager.relayScores.set('primary:41046', {
    hostKey: 'primary:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('alternate:41046', {
    hostKey: 'alternate:41046',
    ewmaLatencyMs: 12,
    lastProbeLatencyMs: 12,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  const connection = await manager.getConnectionForDevice('0x03');
  const cacheEntry = manager.deviceRelayCache.get('03');

  assert.equal(connection, fastTarget);
  assert.equal(cacheEntry.serverIdHex, '0xbbbb');
  assert.equal(cacheEntry.hostKey, 'fast-target:41046');
  assert.ok(manager.ensureCalls.includes('slow-target:41046'));
  assert.ok(manager.ensureCalls.includes('fast-target:41046'));
  manager.close();
});

test('device relay reconciliation does not query alternate control relays when target relay is not suspiciously slow', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  let alternateGetObjectCalls = 0;
  const primary = new FakeConnection('primary:41046', {
    getObject: async () => ({ serverIdHex: '0xaaaa' }),
    getNode: async () => ({ host: 'acceptable-target', edgePort: 41046, serverPort: 41046 }),
  });
  const alternate = new FakeConnection('alternate:41046', {
    getObject: async () => {
      alternateGetObjectCalls += 1;
      return { serverIdHex: '0xbbbb' };
    },
    getNode: async () => ({ host: 'fast-target', edgePort: 41046, serverPort: 41046 }),
  });
  const acceptableTarget = new FakeConnection('acceptable-target:41046', { serverEthereumAddress: '0xaaaa', pingDelayMs: 40 });
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      probeTimeoutMs: 500,
      slowRelayThresholdMs: 100,
      deviceRelayReconciliation: {
        enabled: true,
        maxControlRelays: 1,
        timeoutMs: 200,
        minLatencyDeltaMs: 50,
        slowdownFactor: 2,
      },
    },
  }, new Map([
    ['acceptable-target:41046', { connection: acceptableTarget, pingDelayMs: 40 }],
  ]));

  manager._registerConnection(primary, 'primary:41046');
  manager._registerConnection(alternate, 'alternate:41046');
  primary._managerConnectedAt = 1;
  alternate._managerConnectedAt = 2;
  manager.relayScores.set('primary:41046', {
    hostKey: 'primary:41046',
    ewmaLatencyMs: 15,
    lastProbeLatencyMs: 15,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('alternate:41046', {
    hostKey: 'alternate:41046',
    ewmaLatencyMs: 20,
    lastProbeLatencyMs: 20,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  const connection = await manager.getConnectionForDevice('0x04');
  const cacheEntry = manager.deviceRelayCache.get('04');

  assert.equal(connection, acceptableTarget);
  assert.equal(cacheEntry.serverIdHex, '0xaaaa');
  assert.equal(alternateGetObjectCalls, 0);
  manager.close();
});

test('explicit host mode does not add cached relays to startup candidates', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    'cached:41046': {
      ewmaLatencyMs: 10,
      lastProbeLatencyMs: 10,
      successCount: 1,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'target',
    },
  });

  const manager = new DiodeClientManager({
    keyLocation,
    host: 'explicit:41046',
    relaySelection: { scoreCachePath },
  });

  assert.deepEqual(await extractStartupHosts(manager), ['explicit:41046']);
  manager.close();
});

test('explicit hosts mode only keeps configured relays in startup coverage', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    'cached:41046': {
      ewmaLatencyMs: 10,
      lastProbeLatencyMs: 10,
      successCount: 1,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'target',
    },
  });

  const manager = new DiodeClientManager({
    keyLocation,
    hosts: ['b:41046', 'a:41046'],
    relaySelection: { scoreCachePath },
  });
  manager.relayScores.set('a:41046', {
    hostKey: 'a:41046',
    ewmaLatencyMs: 20,
    lastProbeLatencyMs: 20,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'configured',
  });

  const startupCandidates = await manager._buildStartupCandidates();
  assert.deepEqual(extractHosts(startupCandidates), ['b:41046', 'a:41046']);
  assert.deepEqual(extractHosts(manager._getInitialCoverageCandidates(startupCandidates)), ['b:41046', 'a:41046']);
  manager.close();
});

test('default mode probes all default seeds before final pruning', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      startupConcurrency: 3,
      warmConnectionBudget: 3,
      networkDiscovery: { enabled: false },
    },
  }, new Map([
    ['as1.prenet.diode.io:41046', { pingDelayMs: 60 }],
    ['as2.prenet.diode.io:41046', { pingDelayMs: 55 }],
    ['us1.prenet.diode.io:41046', { pingDelayMs: 40 }],
    ['us2.prenet.diode.io:41046', { pingDelayMs: 35 }],
    ['eu1.prenet.diode.io:41046', { pingDelayMs: 5 }],
    ['eu2.prenet.diode.io:41046', { pingDelayMs: 25 }],
  ]));

  await manager.connect();

  assert.deepEqual(new Set(manager.ensureCalls), new Set([
    'as1.prenet.diode.io:41046',
    'as2.prenet.diode.io:41046',
    'us1.prenet.diode.io:41046',
    'us2.prenet.diode.io:41046',
    'eu1.prenet.diode.io:41046',
    'eu2.prenet.diode.io:41046',
  ]));
  assert.equal(manager.getNearestConnection()._managerHostKey, 'eu1.prenet.diode.io:41046');
  assert.equal(manager.getConnections().length, 3);
  assert.deepEqual(new Set(manager.getConnections().map((connection) => manager._getRegionKey(connection._managerHostKey))), new Set([
    'as',
    'us',
    'eu',
  ]));
  manager.close();
});

test('region-diverse ordering interleaves default seeds', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath: null, networkDiscovery: { enabled: false } } });

  const ordered = extractHosts(manager._getInitialCoverageCandidates(await manager._buildStartupCandidates()));
  assert.deepEqual(ordered, [
    'as1.prenet.diode.io:41046',
    'us1.prenet.diode.io:41046',
    'eu1.prenet.diode.io:41046',
    'as2.prenet.diode.io:41046',
    'us2.prenet.diode.io:41046',
    'eu2.prenet.diode.io:41046',
  ]);
  manager.close();
});

test('cached strong relays do not suppress first-pass sampling of default seeds', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    'cached:41046': {
      ewmaLatencyMs: 5,
      lastProbeLatencyMs: 5,
      successCount: 4,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'target',
    },
  });

  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath, networkDiscovery: { enabled: false } } });
  const ordered = extractHosts(manager._getInitialCoverageCandidates(await manager._buildStartupCandidates()));

  assert.ok(!ordered.includes('cached:41046'));
  assert.equal(ordered.length, 6);
  manager.close();
});

test('network discovery client fetches dio_network over websocket', async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const server = new WebSocketServer({ port });
  server.on('connection', (socket) => {
    socket.on('message', (message) => {
      const parsed = JSON.parse(message.toString('utf8'));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: networkSnapshot.slice(0, 2),
      }));
    });
  });

  try {
    const result = await fetchNetworkDirectory({
      endpoint: `ws://127.0.0.1:${port}`,
      method: 'dio_network',
      timeoutMs: 500,
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].node_id, networkSnapshot[0].node_id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('network discovery normalizes public server entries from snapshot fixtures', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true },
    },
  }, new Map(), networkSnapshot);

  const candidates = await manager._loadNetworkDiscoveryCandidates();
  assert.deepEqual(extractHosts(candidates), ['144.126.157.138:41046', '194.233.80.251:41046']);
  assert.equal(candidates[0].nodeIdHex, networkSnapshot[0].node_id);
  assert.equal(candidates[0].name, 'pause_chalk@diode-us2b');
  manager.close();
});

test('network discovery can include private addresses when enabled', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true, includePrivateAddresses: true },
    },
  }, new Map(), networkSnapshot);

  const candidates = await manager._loadNetworkDiscoveryCandidates();
  assert.ok(candidates.some((candidate) => candidate.hostKey === '192.168.100.4:41046'));
  manager.close();
});

test('network discovery timeout falls back to seed candidates only', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true, timeoutMs: 10 },
    },
  });
  manager._fetchNetworkDiscoveryNodes = async () => {
    await delay(50);
    return networkSnapshot;
  };

  const candidates = await manager._loadNetworkDiscoveryCandidates();
  assert.deepEqual(candidates, []);
  manager.close();
});

test('startup candidate assembly includes network candidates in default mode', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true },
    },
  }, new Map(), networkSnapshot);

  const startupHosts = await extractStartupHosts(manager);
  assert.ok(startupHosts.includes('144.126.157.138:41046'));
  assert.ok(startupHosts.includes('194.233.80.251:41046'));
  manager.close();
});

test('explicit host skips built-in network discovery', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    host: 'explicit:41046',
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true },
    },
  }, new Map(), networkSnapshot);

  assert.deepEqual(await manager._loadNetworkDiscoveryCandidates(), []);
  manager.close();
});

test('explicit hosts skip built-in network discovery', async () => {
  const tempDir = makeTempDir();
  const manager = new TestClientManager({
    keyLocation: path.join(tempDir, 'keys.json'),
    hosts: ['explicit-a:41046'],
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: true },
    },
  }, new Map(), networkSnapshot);

  assert.deepEqual(await manager._loadNetworkDiscoveryCandidates(), []);
  manager.close();
});

test('startup waits for required seeds plus bounded network sample', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      startupConcurrency: 4,
      networkDiscovery: { enabled: true, startupProbeCount: 1, backgroundBatchSize: 0 },
    },
  }, new Map([
    ['as1.prenet.diode.io:41046', { pingDelayMs: 40 }],
    ['as2.prenet.diode.io:41046', { pingDelayMs: 35 }],
    ['us1.prenet.diode.io:41046', { pingDelayMs: 30 }],
    ['us2.prenet.diode.io:41046', { pingDelayMs: 25 }],
    ['eu1.prenet.diode.io:41046', { pingDelayMs: 10 }],
    ['eu2.prenet.diode.io:41046', { pingDelayMs: 15 }],
    ['144.126.157.138:41046', { pingDelayMs: 5 }],
  ]), networkSnapshot);

  await manager.connect();

  assert.ok(manager.ensureCalls.includes('144.126.157.138:41046'));
  assert.equal(manager._lastNetworkDiscoveryStats.startupProbeCount, 1);
  manager.close();
});

test('live network discovery reduces startup seed coverage to one seed per region', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      startupConcurrency: 6,
      continueProbingUntestedSeeds: false,
      networkDiscovery: { enabled: true, startupProbeCount: 1, backgroundBatchSize: 0 },
    },
  }, new Map([
    ['as1.prenet.diode.io:41046', { pingDelayMs: 40 }],
    ['us1.prenet.diode.io:41046', { pingDelayMs: 30 }],
    ['eu1.prenet.diode.io:41046', { pingDelayMs: 10 }],
    ['144.126.157.138:41046', { pingDelayMs: 5 }],
  ]), networkSnapshot);

  await manager.connect();

  assert.deepEqual(new Set(manager.ensureCalls), new Set([
    'as1.prenet.diode.io:41046',
    'us1.prenet.diode.io:41046',
    'eu1.prenet.diode.io:41046',
    '144.126.157.138:41046',
  ]));
  manager.close();
});

test('untested network candidates outrank cache-only candidates', () => {
  const tempDir = makeTempDir();
  const manager = new DiodeClientManager({ keyLocation: path.join(tempDir, 'keys.json'), relaySelection: { scoreCachePath: null } });

  const ranked = extractHosts(manager._rankRelayCandidates([
    manager._createCandidate('network-a:41046', 'network', 0, { retries: 0, lastSeenAt: 10 }),
    manager._createCandidate('cache-a:41046', 'cache', 1),
  ]));

  assert.deepEqual(ranked, ['network-a:41046', 'cache-a:41046']);
  manager.close();
});

test('network membership is not reused if the next discovery response omits it', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    '144.126.157.138:41046': {
      ewmaLatencyMs: 10,
      lastProbeLatencyMs: 10,
      successCount: 2,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'network',
    },
  }, { version: 2, discoveryState: { networkCursor: 1 } });

  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath,
      networkDiscovery: { enabled: true },
    },
  }, new Map(), [networkSnapshot[2]]);

  const hosts = await extractStartupHosts(manager);
  assert.ok(!hosts.includes('144.126.157.138:41046'));
  assert.ok(hosts.includes('194.233.80.251:41046'));
  manager.close();
});

test('scored network candidates are reused when rediscovered', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    '144.126.157.138:41046': {
      ewmaLatencyMs: 11,
      lastProbeLatencyMs: 11,
      successCount: 2,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'network',
    },
  }, { version: 2 });

  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath,
      networkDiscovery: { enabled: true, startupProbeCount: 1 },
    },
  }, new Map(), [networkSnapshot[0], networkSnapshot[2]]);

  const candidates = await manager._buildStartupCandidates();
  const selected = manager._selectStartupNetworkCandidates(candidates);
  assert.equal(selected[0].hostKey, '144.126.157.138:41046');
  manager.close();
});

test('network cursor rotates startup network samples across runs', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {}, { version: 2, discoveryState: { networkCursor: 1 } });
  const rotatingSnapshot = [
    { ...networkSnapshot[0], node_id: '0xaaa1', node: ['server', '10.10.10.10', '0xa056', '0xc76f', '1.9.3', [['name', 'skip-private']]], connected: true },
    networkSnapshot[0],
    networkSnapshot[2],
  ];
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath,
      networkDiscovery: { enabled: true, startupProbeCount: 1, includePrivateAddresses: false },
    },
  }, new Map(), rotatingSnapshot);

  const candidates = await manager._buildStartupCandidates();
  const selected = manager._selectStartupNetworkCandidates(candidates);
  assert.equal(selected[0].hostKey, '194.233.80.251:41046');
  manager.close();
});

test('successful network probes are persisted with discoveredFrom network', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath } });

  manager._recordRelayProbeSuccess('144.126.157.138:41046', 20, 'network');
  manager._flushRelayScores();

  const written = JSON.parse(fs.readFileSync(scoreCachePath, 'utf8'));
  assert.equal(written.relays['144.126.157.138:41046'].discoveredFrom, 'network');
  manager.close();
});

test('target-discovered relays are preserved during pruning', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const primary = new FakeConnection('primary:41046', {
    getObject: async () => ({ serverIdHex: '0xffee' }),
    getNode: async () => ({ host: 'target-relay', edgePort: 41046, serverPort: 41046 }),
  });
  const target = new FakeConnection('target-relay:41046', { serverEthereumAddress: '0xffee', pingDelayMs: 5 });
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: { scoreCachePath: null, warmConnectionBudget: 1 },
  }, new Map([
    ['target-relay:41046', { connection: target, pingDelayMs: 5 }],
  ]));

  manager._registerConnection(primary, 'primary:41046');
  primary._managerConnectedAt = 1;
  manager.relayScores.set('primary:41046', {
    hostKey: 'primary:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager._startupCoverageComplete = true;

  await manager.getConnectionForDevice('0x03');
  manager._pruneIdleConnections();

  assert.ok(manager.connectionByHost.has('target-relay:41046'));
  manager.close();
});

test('provider candidates are loaded and normalized from string entries', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => ['provider-relay.example:41046'],
    },
  });

  const candidates = await manager._buildStartupCandidates();
  const providerCandidate = candidates.find((candidate) => candidate.hostKey === 'provider-relay.example:41046');

  assert.ok(providerCandidate);
  assert.equal(providerCandidate.source, 'provider');
  assert.equal(providerCandidate.priority, 100);
  manager.close();
});

test('provider candidates are loaded and normalized from object entries', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => [{ host: '1.2.3.4', port: 41046, priority: 5, region: 'eu', metadata: { tag: 'x' } }],
    },
  });

  const candidates = await manager._buildStartupCandidates();
  const providerCandidate = candidates.find((candidate) => candidate.hostKey === '1.2.3.4:41046');

  assert.ok(providerCandidate);
  assert.equal(providerCandidate.priority, 5);
  assert.equal(providerCandidate.region, 'eu');
  assert.deepEqual(providerCandidate.metadata, { tag: 'x' });
  manager.close();
});

test('invalid provider entries are ignored without breaking startup', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => [null, 123, {}, 'valid-provider:41046'],
    },
  });

  const candidates = await manager._buildStartupCandidates();
  assert.ok(candidates.some((candidate) => candidate.hostKey === 'valid-provider:41046'));
  manager.close();
});

test('provider timeout falls back to seed candidates only', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProviderTimeoutMs: 10,
      discoveryProvider: async () => {
        await delay(50);
        return ['too-late:41046'];
      },
    },
  });

  const candidates = await manager._buildStartupCandidates();
  assert.ok(!candidates.some((candidate) => candidate.hostKey === 'too-late:41046'));
  manager.close();
});

test('provider error falls back cleanly', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => {
        throw new Error('provider failed');
      },
    },
  });

  const candidates = await manager._buildStartupCandidates();
  assert.equal(candidates.length, 6);
  manager.close();
});

test('provider candidates are deduplicated against seed candidates', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => [
        'eu1.prenet.diode.io:41046',
        { host: 'provider-only', port: 41046, priority: 1 },
      ],
    },
  });

  const candidates = await manager._buildStartupCandidates();
  assert.equal(candidates.filter((candidate) => candidate.hostKey === 'eu1.prenet.diode.io:41046').length, 1);
  assert.ok(candidates.some((candidate) => candidate.hostKey === 'provider-only:41046'));
  manager.close();
});

test('provider candidates outrank cache-only candidates when untested', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath: null, networkDiscovery: { enabled: false } } });

  const ranked = extractHosts(manager._rankRelayCandidates([
    manager._createCandidate('provider-a:41046', 'provider', 0, { priority: 10 }),
    manager._createCandidate('cache-a:41046', 'cache', 1),
  ]));

  assert.deepEqual(ranked, ['provider-a:41046', 'cache-a:41046']);
  manager.close();
});

test('explicit host ignores provider by default', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    host: 'explicit:41046',
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => ['provider-relay:41046'],
    },
  });

  assert.deepEqual(await extractStartupHosts(manager), ['explicit:41046']);
  manager.close();
});

test('opt-in allows provider with explicit host', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    host: 'explicit:41046',
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      useProviderWithExplicitHost: true,
      discoveryProvider: async () => ['provider-relay:41046'],
    },
  });

  assert.deepEqual(await extractStartupHosts(manager), ['explicit:41046', 'provider-relay:41046']);
  manager.close();
});

test('explicit hosts ignore provider by default', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    hosts: ['explicit-a:41046'],
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => ['provider-relay:41046'],
    },
  });

  assert.deepEqual(await extractStartupHosts(manager), ['explicit-a:41046']);
  manager.close();
});

test('opt-in allows provider with explicit hosts', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    hosts: ['explicit-a:41046'],
    relaySelection: {
      scoreCachePath: null,
      networkDiscovery: { enabled: false },
      useProviderWithExplicitHosts: true,
      discoveryProvider: async () => ['provider-relay:41046'],
    },
  });

  assert.deepEqual(await extractStartupHosts(manager), ['explicit-a:41046', 'provider-relay:41046']);
  manager.close();
});

test('provider-sourced relays participate in region-diverse warm retention', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: { scoreCachePath: null, warmConnectionBudget: 3, networkDiscovery: { enabled: false } },
  });

  const eu = new FakeConnection('eu-fast:41046');
  const us = new FakeConnection('provider-us:41046');
  const as = new FakeConnection('as-mid:41046');
  const extra = new FakeConnection('eu-extra:41046');

  manager._registerConnection(eu, 'eu-fast:41046');
  manager._registerConnection(us, 'provider-us:41046');
  manager._registerConnection(as, 'as-mid:41046');
  manager._registerConnection(extra, 'eu-extra:41046');
  manager._startupCoverageComplete = true;
  manager._setCandidateMetadata('provider-us:41046', { region: 'us', priority: 1 });

  manager.relayScores.set('eu-fast:41046', {
    hostKey: 'eu-fast:41046',
    ewmaLatencyMs: 10,
    lastProbeLatencyMs: 10,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('provider-us:41046', {
    hostKey: 'provider-us:41046',
    ewmaLatencyMs: 12,
    lastProbeLatencyMs: 12,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'provider',
  });
  manager.relayScores.set('as-mid:41046', {
    hostKey: 'as-mid:41046',
    ewmaLatencyMs: 20,
    lastProbeLatencyMs: 20,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('eu-extra:41046', {
    hostKey: 'eu-extra:41046',
    ewmaLatencyMs: 15,
    lastProbeLatencyMs: 15,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });

  manager._pruneIdleConnections();

  const retained = new Set(manager.getConnections().map((connection) => connection._managerHostKey));
  assert.deepEqual(retained, new Set(['eu-fast:41046', 'provider-us:41046', 'as-mid:41046']));
  assert.equal(extra.closeCount, 1);
  manager.close();
});

test('provider-sourced successful probes are persisted with discoveredFrom provider', () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  const manager = new DiodeClientManager({ keyLocation, relaySelection: { scoreCachePath } });

  manager._recordRelayProbeSuccess('provider-persisted:41046', 20, 'provider');
  manager._flushRelayScores();

  const written = JSON.parse(fs.readFileSync(scoreCachePath, 'utf8'));
  assert.equal(written.relays['provider-persisted:41046'].discoveredFrom, 'provider');
  manager.close();
});

test('provider membership is not reused if provider omits prior relay on next startup', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const scoreCachePath = path.join(tempDir, 'relay-scores.json');
  makeScoreCache(scoreCachePath, {
    'provider-old:41046': {
      ewmaLatencyMs: 10,
      lastProbeLatencyMs: 10,
      successCount: 2,
      failureCount: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: 0,
      cooldownUntil: 0,
      discoveredFrom: 'provider',
    },
  });

  const manager = new DiodeClientManager({
    keyLocation,
    relaySelection: {
      scoreCachePath,
      networkDiscovery: { enabled: false },
      discoveryProvider: async () => ['provider-new:41046'],
    },
  });

  const hosts = await extractStartupHosts(manager);
  assert.ok(!hosts.includes('provider-old:41046'));
  assert.ok(hosts.includes('provider-new:41046'));
  manager.close();
});

test('closing a duplicate relay alias remaps serverId to the surviving connection', async () => {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const manager = new TestClientManager({
    keyLocation,
    relaySelection: { scoreCachePath: null, warmConnectionBudget: 1 },
  });

  const serverId = '0x1111222233334444555566667777888899990000';
  const hostnameConnection = new FakeConnection('us2.prenet.diode.io:41046', {
    serverEthereumAddress: serverId,
    getObject: async () => ({ serverIdHex: serverId }),
  });
  const providerConnection = new FakeConnection('144.126.157.138:41046', {
    serverEthereumAddress: serverId,
  });

  manager._registerConnection(hostnameConnection, 'us2.prenet.diode.io:41046');
  manager._registerConnection(providerConnection, '144.126.157.138:41046');
  hostnameConnection._managerConnectedAt = 1;
  providerConnection._managerConnectedAt = 2;
  manager._updateServerIdMapping(hostnameConnection);
  manager._updateServerIdMapping(providerConnection);
  manager._startupCoverageComplete = true;

  manager.relayScores.set('us2.prenet.diode.io:41046', {
    hostKey: 'us2.prenet.diode.io:41046',
    ewmaLatencyMs: 15,
    lastProbeLatencyMs: 15,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'seed',
  });
  manager.relayScores.set('144.126.157.138:41046', {
    hostKey: '144.126.157.138:41046',
    ewmaLatencyMs: 50,
    lastProbeLatencyMs: 50,
    successCount: 1,
    failureCount: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: 0,
    cooldownUntil: 0,
    discoveredFrom: 'provider',
  });

  manager._pruneIdleConnections();

  assert.equal(manager.serverIdToConnection.get(serverId), hostnameConnection);
  const resolved = await manager.getConnectionForDevice('0x01');
  assert.equal(resolved, hostnameConnection);
  manager.close();
});
