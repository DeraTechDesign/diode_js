const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const net = require('net');
const dgram = require('dgram');
const { once } = require('events');
const { Duplex } = require('node:stream');

const BindPort = require('../bindPort');
const nativeCrypto = require('../nativeCrypto');

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

function malformedUnsolicitedFrames(sessionId, ref) {
  return [
    [sessionId, null],
    [sessionId, 7],
    [sessionId, []],
    [sessionId, ['portopen']],
    [sessionId, ['portopen', '8080', ref]],
    [sessionId, ['portsend']],
    [sessionId, ['portsend', ref]],
    [sessionId, ['portsend', ref, 7]],
    [sessionId, ['portclose']],
    [sessionId, ['portclose', 7]],
  ];
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

class FakeStreamSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.connected = false;
    this.writes = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  setNoDelay() {}
  pause() { this.pauseCalls += 1; }
  resume() { this.resumeCalls += 1; }
  write(data) { this.writes.push(Buffer.from(data)); return true; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
  end() { this.destroy(); }
}

class FakeDatagramSocket extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.bindCalls = [];
    this.sendCalls = [];
  }

  bind(port) { this.bindCalls.push(port); }
  send(...args) { this.sendCalls.push(args); }
  close() { this.closed = true; }
}

function makeNativeRelay(portOpen2Impl = async () => 41000) {
  const portClose2Calls = [];
  return {
    _managerHostKey: 'native.relay:41046',
    socket: { destroyed: false },
    RPC: {
      portOpen2: portOpen2Impl,
      portClose2: async (physicalPort) => { portClose2Calls.push(physicalPort); },
    },
    portClose2Calls,
    getServerRelayHost: () => 'relay.example',
  };
}

function makeFakeUdpServer() {
  const server = new EventEmitter();
  server._diodeClosed = false;
  server.sendCalls = [];
  server.send = (...args) => server.sendCalls.push(args);
  return server;
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

test('bind unsolicited dispatcher contains malformed direct and manager relay frames', async (t) => {
  for (const kind of ['direct', 'manager']) {
    await t.test(kind, () => {
      const relayData = makeRelay(`${kind}.relay:41046`, makeRef('99'), []);
      const relay = Object.assign(new EventEmitter(), relayData);
      const root = kind === 'direct'
        ? relay
        : new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
      const bind = new BindPort(root, {});
      const ref = makeRef('22');
      const clientSocket = new FakeStreamSocket();
      relay.addClientSocket(ref, clientSocket);
      const frames = malformedUnsolicitedFrames(makeRef('23'), ref);
      let applicationListenerCalls = 0;
      root.on('unsolicited', () => {
        applicationListenerCalls += 1;
      });

      try {
        for (const frame of frames) {
          assert.doesNotThrow(() => {
            if (kind === 'direct') root.emit('unsolicited', frame);
            else root.emit('unsolicited', frame, relay);
          });
        }
        assert.equal(applicationListenerCalls, frames.length);
        assert.equal(relay.clientSockets.size, 1);
        assert.equal(relay.getClientSocket(ref), clientSocket);
        assert.equal(clientSocket.destroyed, false);
        assert.equal(clientSocket.writes.length, 0);
        assert.equal(relay.portCloseCalls.length, 0);
        assert.equal(bind._activeContexts.size, 0);
      } finally {
        bind.dispose();
      }
    });
  }
});

test('reused bind ref closes the old context without letting a late close remove the new wrapper', () => {
  const relayData = makeRelay('reused.relay:41046', makeRef('98'), []);
  const relay = Object.assign(new EventEmitter(), relayData);
  const bind = new BindPort(relay, {});
  const server = { _diodeContexts: new Set() };
  const ref = makeRef('25');
  const oldSocket = new FakeStreamSocket();
  const oldContext = bind._trackContext(server, 0, {
    connection: relay,
    rpc: relay.RPC,
    ref,
    sockets: new Set([oldSocket]),
  });
  oldSocket._diodeOwner = bind;
  oldSocket._diodeContext = oldContext;
  oldContext.clientSocketWrapper = oldSocket;
  bind._replaceClientSocket(relay, ref, oldSocket);

  const newSocket = new FakeStreamSocket();
  const newContext = bind._trackContext(server, 0, {
    connection: relay,
    rpc: relay.RPC,
    ref,
    sockets: new Set([newSocket]),
  });
  newSocket._diodeOwner = bind;
  newSocket._diodeContext = newContext;
  newContext.clientSocketWrapper = newSocket;
  bind._replaceClientSocket(relay, ref, newSocket);

  assert.equal(oldContext.closed, true);
  assert.equal(oldSocket.destroyed, true);
  assert.equal(relay.getClientSocket(ref), newSocket);
  assert.equal(relay.portCloseCalls.length, 0);

  bind._closeContext(oldContext, { notifyRemote: true });

  assert.equal(relay.getClientSocket(ref), newSocket);
  assert.equal(newSocket.destroyed, false);
  assert.equal(relay.portCloseCalls.length, 0);

  bind._closeContext(newContext, { notifyRemote: true });
  assert.equal(relay.getClientSocket(ref), undefined);
  assert.equal(relay.portCloseCalls.length, 1);
  bind.dispose();
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

for (const payloadBytes of [128 * 1024, 1024 * 1024]) {
test(`API TCP bind pipelines a bounded send window and flushes ${payloadBytes} final bytes before closing`, async () => {
  const calls = [];
  const send = deferred();
  const ref = makeRef('12131415');
  const relay = makeRelay('relay.example:41046', ref, calls);
  const portSendCalls = [];
  relay.RPC.portSend = async (...args) => {
    portSendCalls.push(args);
    return send.promise;
  };
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

    const payload = Buffer.alloc(payloadBytes);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    client.end(payload);
    await waitFor(() => portSendCalls.length > 1);

    const acceptedSocket = relay.getClientSocket(ref);
    if (payloadBytes > 256 * 1024) {
      await waitFor(() => acceptedSocket.isPaused());
      assert.equal(acceptedSocket.isPaused(), true);
    } else {
      await waitFor(() => acceptedSocket.readableEnded);
    }
    assert.ok(portSendCalls.length <= 16);
    assert.ok(portSendCalls.reduce((bytes, [, frame]) => bytes + frame.length, 0) <= 256 * 1024);
    assert.equal(relay.portCloseCalls.length, 0, 'outstanding frames keep the ref alive');

    send.resolve();
    await waitFor(() => relay.portCloseCalls.length === 1);
    assert.deepEqual(Buffer.concat(portSendCalls.map(([, frame]) => frame)), payload);
    assert.equal(relay.hasClientSocket(ref), false);

    client.destroy();
  } finally {
    send.resolve();
    bind.closeAllServers();
    server.close();
  }
});
}

// Native pipes need real readable buffering and writable backpressure. Keep
// the lightweight EventEmitter fake above for tests that never attach pipes.
class NativeStreamSocket extends Duplex {
  constructor(input = null) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 });
    this.connected = false;
    this.writes = [];
    this.input = input;
    this.inputOffset = 0;
    this.holdWrites = false;
    this.pendingWrite = null;
  }

  setNoDelay() {}
  _read() {
    if (!this.input || this.inputOffset >= this.input.length) return;
    const end = Math.min(this.inputOffset + 64 * 1024, this.input.length);
    const chunk = this.input.subarray(this.inputOffset, end);
    this.inputOffset = end;
    this.push(chunk);
  }
  _write(data, _encoding, callback) {
    this.writes.push(Buffer.from(data));
    if (this.holdWrites) this.pendingWrite = callback;
    else callback();
  }
  releaseWrites() {
    this.holdWrites = false;
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    if (callback) callback();
  }
}

test('API portopen deadline advances to the next relay when one hangs', async () => {
  const calls = [];
  const never = deferred();
  const bad = makeRelay('hung.relay:41046', () => never.promise, calls);
  const ref = makeRef('16171819');
  const good = makeRelay('good.relay:41046', ref, calls);
  const manager = new FakeManager({
    relays: [bad, good],
    resolvedRelay: bad,
    nearestRelay: bad,
  });
  const bind = new BindPort(manager, {});
  bind.portOpenTimeoutMs = 20;

  const startedAt = Date.now();
  const opened = await bind._openApiPortWithRelayFallback(
    Buffer.from('8a72468957504d50247a260deb0218d504dd091b', 'hex'),
    '8a72468957504d50247a260deb0218d504dd091b',
    'tcp:22',
    'rw'
  );

  assert.equal(opened.connection, good);
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(calls.map((call) => call.hostKey), ['hung.relay:41046', 'good.relay:41046']);
  bind.dispose();
});

test('closing a bind destroys accepted clients and closes their remote refs', async () => {
  const calls = [];
  const ref = makeRef('1a1b1c1d');
  const relay = makeRelay('relay.example:41046', ref, calls);
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  bind.addPort(0, 22, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const server = bind.servers.get(0);
  await once(server, 'listening');
  const client = net.connect(server.address().port, '127.0.0.1');
  await once(client, 'connect');
  await waitFor(() => relay.hasClientSocket(ref));

  bind.closeAllServers();
  await once(client, 'close');
  await waitFor(() => relay.portCloseCalls.length === 1);

  assert.equal(relay.hasClientSocket(ref), false);
  assert.equal(bind._activeContexts.size, 0);
  bind.dispose();
});

test('relay disconnect payload tears down only clients using that relay', async () => {
  const calls = [];
  const ref = makeRef('1e1f2021');
  const relay = makeRelay('relay.example:41046', ref, calls);
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  bind.addPort(0, 22, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const server = bind.servers.get(0);
  await once(server, 'listening');
  const client = net.connect(server.address().port, '127.0.0.1');
  await once(client, 'connect');
  await waitFor(() => relay.hasClientSocket(ref));
  const closed = once(client, 'close');

  manager.emit('disconnect', { connection: relay, error: new Error('relay lost') });
  await closed;

  assert.equal(bind._activeContexts.size, 0);
  assert.equal(relay.portCloseCalls.length, 0);
  bind.dispose();
});

test('TCP listener errors are surfaced without an uncaught error event', async () => {
  const manager = new FakeManager({ relays: [], resolvedRelay: null, nearestRelay: null });
  const first = new BindPort(manager, {});
  first.addPort(0, 22, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const firstServer = first.servers.get(0);
  await once(firstServer, 'listening');
  const occupiedPort = firstServer.address().port;

  const second = new BindPort(manager, {});
  const bindError = once(second, 'bindError');
  second.addPort(occupiedPort, 22, '8a72468957504d50247a260deb0218d504dd091b', 'tcp');
  const [error, details] = await bindError;

  assert.equal(error.code, 'EADDRINUSE');
  assert.equal(details.localPort, occupiedPort);
  assert.equal(second.servers.has(occupiedPort), false);

  const firstClosed = once(firstServer, 'close');
  first.dispose();
  await firstClosed;
  const listening = once(second, 'listening');
  assert.equal(
    second.addPort(occupiedPort, 22, '8a72468957504d50247a260deb0218d504dd091b', 'tcp'),
    true
  );
  const [listeningInfo] = await listening;
  assert.equal(listeningInfo.localPort, occupiedPort);
  second.dispose();
});

test('native TCP connects relay before handshake and preserves immediate banner bytes', async () => {
  const relay = makeNativeRelay();
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {
    0: {
      targetPort: 22,
      deviceIdHex: '8a72468957504d50247a260deb0218d504dd091b',
      protocol: 'tcp',
      transport: 'native',
    },
  });
  bind.bindSinglePort(0);
  const server = bind.servers.get(0);
  await once(server, 'listening');
  const handler = server.listeners('connection')[0];
  const clientSocket = new NativeStreamSocket();
  const relaySocket = new NativeStreamSocket();
  const originalConnect = net.connect;
  const originalConsume = nativeCrypto.consumeTcpFrames;

  net.connect = (options) => {
    assert.equal(options.allowHalfOpen, true);
    queueMicrotask(() => {
      relaySocket.connected = true;
      relaySocket.emit('connect');
    });
    return relaySocket;
  };
  nativeCrypto.consumeTcpFrames = (_session, encrypted) => [Buffer.from(encrypted)];
  bind._performNativeHandshake = async () => {
    assert.equal(relaySocket.connected, true);
    assert.equal(relaySocket.isPaused(), true, 'relay bytes wait for authentication');
    relaySocket.push(Buffer.from('SSH-2.0-immediate\r\n'));
    assert.equal(clientSocket.writes.length, 0, 'paused relay preserves the banner until the bridge is ready');
    return {};
  };

  try {
    await handler(clientSocket);
    await waitFor(() => clientSocket.writes.length === 1);
    assert.equal(clientSocket.writes.length, 1);
    assert.equal(clientSocket.writes[0].toString(), 'SSH-2.0-immediate\r\n');
    assert.equal(clientSocket.isPaused(), false);
  } finally {
    net.connect = originalConnect;
    nativeCrypto.consumeTcpFrames = originalConsume;
    bind.dispose();
  }
});

test('native TCP bounds queued data while a relay write is blocked and resumes after drain', async () => {
  const relay = makeNativeRelay();
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {
    0: {
      targetPort: 22,
      deviceIdHex: '8a72468957504d50247a260deb0218d504dd091b',
      protocol: 'tcp',
      transport: 'native',
    },
  });
  bind.bindSinglePort(0);
  const server = bind.servers.get(0);
  await once(server, 'listening');
  const handler = server.listeners('connection')[0];
  const payload = Buffer.alloc(8 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const clientSocket = new NativeStreamSocket(payload);
  const relaySocket = new NativeStreamSocket();
  relaySocket.holdWrites = true;
  const originalConnect = net.connect;
  const originalCreateTcpFrame = nativeCrypto.createTcpFrame;

  net.connect = () => {
    queueMicrotask(() => {
      relaySocket.connected = true;
      relaySocket.emit('connect');
    });
    return relaySocket;
  };
  bind._performNativeHandshake = async () => ({});
  nativeCrypto.createTcpFrame = (_session, data) => Buffer.from(data);

  try {
    await handler(clientSocket);
    await waitFor(() => clientSocket.isPaused() && relaySocket.pendingWrite !== null);
    const acceptedBytes = clientSocket.inputOffset;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clientSocket.inputOffset, acceptedBytes, 'blocked downstream stops reading the client');
    assert.ok(acceptedBytes <= 1024 * 1024, 'the pipeline buffers a bounded part of the 8 MiB source');
    assert.ok(relaySocket.writableLength <= 128 * 1024, 'relay socket writes remain bounded');
    assert.equal(relaySocket.writes.length, 1);

    relaySocket.releaseWrites();
    await waitFor(() => relaySocket.writes.reduce((bytes, chunk) => bytes + chunk.length, 0) === payload.length);
    assert.deepEqual(Buffer.concat(relaySocket.writes), payload, 'draining resumes the full ordered upload');
    assert.equal(clientSocket.isPaused(), false);
  } finally {
    nativeCrypto.createTcpFrame = originalCreateTcpFrame;
    net.connect = originalConnect;
    bind.dispose();
  }
});

test('closing native TCP client during handshake cannot create a post-close relay leak', async () => {
  const relay = makeNativeRelay();
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {
    0: {
      targetPort: 22,
      deviceIdHex: '8a72468957504d50247a260deb0218d504dd091b',
      protocol: 'tcp',
      transport: 'native',
    },
  });
  bind.bindSinglePort(0);
  const server = bind.servers.get(0);
  await once(server, 'listening');
  const handler = server.listeners('connection')[0];
  const clientSocket = new FakeStreamSocket();
  const relaySocket = new FakeStreamSocket();
  const handshake = deferred();
  let handshakeStarted = false;
  const originalConnect = net.connect;

  net.connect = () => {
    queueMicrotask(() => {
      relaySocket.connected = true;
      relaySocket.emit('connect');
    });
    return relaySocket;
  };
  bind._performNativeHandshake = async () => {
    handshakeStarted = true;
    return handshake.promise;
  };

  try {
    const handling = handler(clientSocket);
    await waitFor(() => handshakeStarted);
    const closed = once(clientSocket, 'close');
    clientSocket.destroy();
    await closed;
    handshake.resolve({});
    await handling;

    assert.equal(bind._activeContexts.size, 0);
    assert.equal(relaySocket.destroyed, true);
    assert.equal(clientSocket.resumeCalls, 0);
    assert.deepEqual(relay.portClose2Calls, [41000]);
  } finally {
    net.connect = originalConnect;
    bind.dispose();
  }
});

test('concurrent API UDP datagrams share one portopen', async () => {
  const calls = [];
  const ref = makeRef('22232425');
  const relay = makeRelay('udp.relay:41046', ref, calls);
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  const server = makeFakeUdpServer();
  const opened = deferred();
  let openCalls = 0;
  bind._openApiPortWithRelayFallback = async () => {
    openCalls += 1;
    return opened.promise;
  };
  const options = {
    deviceId: Buffer.alloc(20),
    deviceIdHex: '00'.repeat(20),
    formattedTargetPort: 'udp:5000',
    localPort: 5001,
    rinfo: { address: '127.0.0.1', port: 40000 },
  };

  const first = bind._getOrOpenApiUdpEntry(server, '127.0.0.1:40000', options);
  const second = bind._getOrOpenApiUdpEntry(server, '127.0.0.1:40000', options);
  assert.equal(openCalls, 1);
  opened.resolve({ ref, connection: relay, rpc: relay.RPC });
  const [firstEntry, secondEntry] = await Promise.all([first, second]);

  assert.equal(firstEntry, secondEntry);
  assert.equal(openCalls, 1);
  assert.equal(relay.clientSockets.size, 1);
  bind._closeContext(firstEntry.context);
  bind.dispose();
});

test('closing API UDP bind during portopen closes a late ref without resurrecting state', async () => {
  const calls = [];
  const ref = makeRef('26272829');
  const relay = makeRelay('udp.relay:41046', ref, calls);
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  const server = makeFakeUdpServer();
  const opened = deferred();
  bind._openApiPortWithRelayFallback = async () => opened.promise;
  const opening = bind._getOrOpenApiUdpEntry(server, '127.0.0.1:40001', {
    deviceId: Buffer.alloc(20),
    deviceIdHex: '00'.repeat(20),
    formattedTargetPort: 'udp:5000',
    localPort: 5001,
    rinfo: { address: '127.0.0.1', port: 40001 },
  });

  server._diodeClosed = true;
  server.clientRefs = null;
  opened.resolve({ ref, connection: relay, rpc: relay.RPC });

  await assert.rejects(opening, /closed during portopen/);
  await waitFor(() => relay.portCloseCalls.length === 1);
  assert.equal(server.clientRefs, null);
  assert.equal(bind._activeContexts.size, 0);
  bind.dispose();
});

test('concurrent native UDP datagrams share one portopen2 and relay socket', async () => {
  const port = deferred();
  let openCalls = 0;
  const relay = makeNativeRelay(async () => {
    openCalls += 1;
    return port.promise;
  });
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  const server = makeFakeUdpServer();
  const originalCreateSocket = dgram.createSocket;
  const sockets = [];
  dgram.createSocket = () => {
    const socket = new FakeDatagramSocket();
    sockets.push(socket);
    return socket;
  };
  const options = {
    deviceId: Buffer.alloc(20),
    deviceIdHex: '00'.repeat(20),
    formattedTargetPort: 'udp:5000',
    config: {},
    localPort: 5001,
    targetPort: 5000,
    rinfo: { address: '127.0.0.1', port: 40002 },
  };

  try {
    const first = bind._getOrOpenNativeUdpRelay(server, '127.0.0.1:40002', options);
    const second = bind._getOrOpenNativeUdpRelay(server, '127.0.0.1:40002', options);
    await waitFor(() => openCalls === 1);
    port.resolve(41000);
    const [firstRelay, secondRelay] = await Promise.all([first, second]);

    assert.equal(firstRelay, secondRelay);
    assert.equal(openCalls, 1);
    assert.equal(sockets.length, 1);
    bind._closeContext(firstRelay.context);
  } finally {
    dgram.createSocket = originalCreateSocket;
    bind.dispose();
  }
});

test('closing native UDP bind during portopen2 closes the late physical port', async () => {
  const port = deferred();
  let openCalls = 0;
  const relay = makeNativeRelay(() => {
    openCalls += 1;
    return port.promise;
  });
  const manager = new FakeManager({ relays: [relay], resolvedRelay: relay, nearestRelay: relay });
  const bind = new BindPort(manager, {});
  const server = makeFakeUdpServer();
  const originalCreateSocket = dgram.createSocket;
  let socketCreations = 0;
  dgram.createSocket = () => {
    socketCreations += 1;
    return new FakeDatagramSocket();
  };

  try {
    const opening = bind._getOrOpenNativeUdpRelay(server, '127.0.0.1:40003', {
      deviceId: Buffer.alloc(20),
      deviceIdHex: '00'.repeat(20),
      formattedTargetPort: 'udp:5000',
      config: {},
      localPort: 5001,
      targetPort: 5000,
      rinfo: { address: '127.0.0.1', port: 40003 },
    });
    await waitFor(() => openCalls === 1);
    server._diodeClosed = true;
    server.nativeRelays = null;
    port.resolve(41001);

    await assert.rejects(opening, /closed during portopen2/);
    await waitFor(() => relay.portClose2Calls.length === 1);
    assert.deepEqual(relay.portClose2Calls, [41001]);
    assert.equal(socketCreations, 0);
    assert.equal(bind._activeContexts.size, 0);
  } finally {
    dgram.createSocket = originalCreateSocket;
    bind.dispose();
  }
});

test('BindPort clamps timer environment values to safe finite ranges', () => {
  const keys = [
    'DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS',
    'DIODE_PORTOPEN_TIMEOUT_MS',
    'DIODE_PORT_IO_TIMEOUT_MS',
    'DIODE_RELAY_RESOLVE_TIMEOUT_MS',
    'DIODE_UDP_SESSION_IDLE_TIMEOUT_MS',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS = '-1';
  process.env.DIODE_PORTOPEN_TIMEOUT_MS = '999999999999999999';
  process.env.DIODE_PORT_IO_TIMEOUT_MS = 'Infinity';
  process.env.DIODE_RELAY_RESOLVE_TIMEOUT_MS = '0';
  process.env.DIODE_UDP_SESSION_IDLE_TIMEOUT_MS = '2147483648';
  const manager = new FakeManager({ relays: [], resolvedRelay: null, nearestRelay: null });

  try {
    const bind = new BindPort(manager, {});
    assert.equal(bind.handshakeTimeoutMs, 10000);
    assert.equal(bind.portOpenTimeoutMs, 2147483647);
    assert.equal(bind.ioTimeoutMs, 10000);
    assert.equal(bind.relayResolveTimeoutMs, 2147483647);
    assert.equal(bind.udpSessionIdleTimeoutMs, 2147483647);
    bind.dispose();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
