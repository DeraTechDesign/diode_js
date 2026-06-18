const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const net = require('net');
const { once } = require('events');

const BindPort = require('../bindPort');

function makeRef(hex) {
  return Buffer.from(hex.padStart(8, '0'), 'hex');
}

function makeRelay(hostKey, result, calls) {
  const clientSockets = new Map();
  const portCloseCalls = [];
  return {
    _managerHostKey: hostKey,
    socket: { destroyed: false },
    clientSockets,
    portCloseCalls,
    RPC: {
      portOpen: async (_deviceId, port, flags) => {
        calls.push({ hostKey, port, flags });
        if (result instanceof Error) {
          throw result;
        }
        return typeof result === 'function' ? result() : result;
      },
      portClose: async (ref) => {
        portCloseCalls.push(ref);
      },
    },
    addClientSocket(ref, socket) {
      clientSockets.set(ref.toString('hex'), socket);
    },
    getClientSocket(ref) {
      return clientSockets.get(ref.toString('hex'));
    },
    deleteClientSocket(ref) {
      return clientSockets.delete(ref.toString('hex'));
    },
    hasClientSocket(ref) {
      return clientSockets.has(ref.toString('hex'));
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

class FakeManager extends EventEmitter {
  constructor({ relays, resolvedRelay, nearestRelay, resolveError = null }) {
    super();
    this.relays = relays;
    this.resolvedRelay = resolvedRelay;
    this.nearestRelay = nearestRelay;
    this.resolveError = resolveError;
    this.deviceRelayCache = new Map();
  }

  async getConnectionForDevice() {
    if (this.resolveError) {
      throw this.resolveError;
    }
    return this.resolvedRelay;
  }

  getNearestConnection() {
    return this.nearestRelay;
  }

  getConnections() {
    return this.relays.slice();
  }
}

test('API portopen falls back to another relay and clears stale device cache', async () => {
  const calls = [];
  const bad = makeRelay('bad.relay:41046', undefined, calls);
  const goodRef = makeRef('01020304');
  const good = makeRelay('good.relay:41046', goodRef, calls);
  const manager = new FakeManager({
    relays: [bad, good],
    resolvedRelay: bad,
    nearestRelay: bad,
  });
  manager.deviceRelayCache.set('8a72468957504d50247a260deb0218d504dd091b', {
    hostKey: 'bad.relay:41046',
  });

  const bind = new BindPort(manager, {});
  const result = await bind._openApiPortWithRelayFallback(
    Buffer.from('8a72468957504d50247a260deb0218d504dd091b', 'hex'),
    '8a72468957504d50247a260deb0218d504dd091b',
    'tls:8088',
    'rw'
  );

  assert.equal(result.connection, good);
  assert.equal(result.ref, goodRef);
  assert.deepEqual(calls.map((entry) => entry.hostKey), [
    'bad.relay:41046',
    'good.relay:41046',
  ]);
  assert.equal(manager.deviceRelayCache.has('8a72468957504d50247a260deb0218d504dd091b'), false);
});

test('API portopen tries connected relays when device relay lookup fails', async () => {
  const calls = [];
  const ref = makeRef('05060708');
  const fallback = makeRelay('fallback.relay:41046', ref, calls);
  const manager = new FakeManager({
    relays: [fallback],
    resolvedRelay: null,
    nearestRelay: null,
    resolveError: new Error('ticket lookup failed'),
  });

  const bind = new BindPort(manager, {});
  const result = await bind._openApiPortWithRelayFallback(
    Buffer.from('8a72468957504d50247a260deb0218d504dd091b', 'hex'),
    '8a72468957504d50247a260deb0218d504dd091b',
    'tls:8088',
    'rw'
  );

  assert.equal(result.connection, fallback);
  assert.equal(result.ref, ref);
  assert.deepEqual(calls, [{
    hostKey: 'fallback.relay:41046',
    port: 'tls:8088',
    flags: 'rw',
  }]);
});

test('multiple BindPort instances share one manager listener set', () => {
  const manager = new FakeManager({
    relays: [],
    resolvedRelay: null,
    nearestRelay: null,
  });

  new BindPort(manager, {});
  new BindPort(manager, {});

  assert.equal(manager.listenerCount('unsolicited'), 1);
  assert.equal(manager.listenerCount('end'), 1);
  assert.equal(manager.listenerCount('error'), 1);
});

test('API bind closes ref when local TCP client disconnects before portopen returns', async () => {
  const calls = [];
  const opened = deferred();
  const ref = makeRef('0a0b0c0d');
  const relay = makeRelay('relay.example:41046', () => opened.promise, calls);
  const manager = new FakeManager({
    relays: [relay],
    resolvedRelay: relay,
    nearestRelay: relay,
  });

  const bind = new BindPort(manager, {
    0: {
      targetPort: 8088,
      deviceIdHex: '8a72468957504d50247a260deb0218d504dd091b',
      protocol: 'tcp',
    }
  });
  bind.addPort(0, 8088, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const server = bind.servers.get(0);

  try {
    await once(server, 'listening');
    const client = net.connect(server.address().port, '127.0.0.1');
    await once(client, 'connect');
    client.destroy();
    await once(client, 'close');

    opened.resolve(ref);
    await waitFor(() => relay.portCloseCalls.length === 1);

    assert.equal(relay.portCloseCalls[0].toString('hex'), ref.toString('hex'));
    assert.equal(relay.hasClientSocket(ref), false);
  } finally {
    server.close();
  }
});

test('API bind closes ref when local TCP client disconnects after portopen returns', async () => {
  const calls = [];
  const ref = makeRef('0e0f1011');
  const relay = makeRelay('relay.example:41046', ref, calls);
  const manager = new FakeManager({
    relays: [relay],
    resolvedRelay: relay,
    nearestRelay: relay,
  });

  const bind = new BindPort(manager, {
    0: {
      targetPort: 8088,
      deviceIdHex: '8a72468957504d50247a260deb0218d504dd091b',
      protocol: 'tcp',
    }
  });
  bind.addPort(0, 8088, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const server = bind.servers.get(0);

  try {
    await once(server, 'listening');
    const client = net.connect(server.address().port, '127.0.0.1');
    await once(client, 'connect');
    await waitFor(() => relay.hasClientSocket(ref));

    client.end();
    await once(client, 'close');
    await waitFor(() => relay.portCloseCalls.length === 1);

    assert.equal(relay.portCloseCalls[0].toString('hex'), ref.toString('hex'));
    assert.equal(relay.hasClientSocket(ref), false);
  } finally {
    server.close();
  }
});
