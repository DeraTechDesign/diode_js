const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

function loadWithFakeWebSocket({ autoOpen = true, emitErrorOnClose = false } = {}) {
  const wsPath = require.resolve('ws');
  const clientPath = require.resolve('../networkDiscoveryClient');
  const wsCacheEntry = require.cache[wsPath] || (() => {
    require('ws');
    return require.cache[wsPath];
  })();
  const originalExports = wsCacheEntry.exports;

  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor(endpoint, options) {
      super();
      this.endpoint = endpoint;
      this.options = options;
      this.closed = false;
      FakeWebSocket.instances.push(this);
      if (autoOpen) {
        queueMicrotask(() => this.emit('open'));
      }
    }

    send(raw) {
      const request = JSON.parse(String(raw));
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: [],
      })));
    }

    close() {
      this.closed = true;
      if (emitErrorOnClose) {
        queueMicrotask(() => {
          this.emit('error', new Error('WebSocket was closed before the connection was established'));
          this.emit('close');
        });
      }
    }
  }

  wsCacheEntry.exports = FakeWebSocket;
  delete require.cache[clientPath];
  try {
    return {
      ...require('../networkDiscoveryClient'),
      FakeWebSocket,
    };
  } finally {
    wsCacheEntry.exports = originalExports;
  }
}

test('network discovery clamps huge timeout and defaults invalid timer values', async () => {
  const { fetchNetworkDirectory, FakeWebSocket } = loadWithFakeWebSocket();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  global.setTimeout = (_callback, delayMs) => {
    delays.push(delayMs);
    return { fakeTimer: true };
  };
  global.clearTimeout = () => {};

  try {
    for (const timeoutMs of [Number.MAX_SAFE_INTEGER, -1, Number.POSITIVE_INFINITY, Number.NaN, 0.5]) {
      assert.deepEqual(await fetchNetworkDirectory({
        endpoint: 'ws://fake-relay.test',
        timeoutMs,
      }), []);
    }
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(delays, [0x7fffffff, 1500, 1500, 1500, 1]);
  assert.deepEqual(
    FakeWebSocket.instances.map((socket) => socket.options.handshakeTimeout),
    [0x7fffffff, 1500, 1500, 1500, 1]
  );
  assert.equal(FakeWebSocket.instances.every((socket) => socket.closed), true);
});

test('network discovery timeout safely closes a still-connecting WebSocket', async () => {
  const { fetchNetworkDirectory, FakeWebSocket } = loadWithFakeWebSocket({
    autoOpen: false,
    emitErrorOnClose: true,
  });

  await assert.rejects(
    fetchNetworkDirectory({
      endpoint: 'ws://hanging-relay.test',
      timeoutMs: 5,
    }),
    /timed out after 5ms/
  );

  // The fake matches ws by emitting its CONNECTING-close error later. If the
  // cleanup removed every error listener, this turn would fail as uncaught.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].closed, true);
  assert.equal(FakeWebSocket.instances[0].options.autoSelectFamily, false);
});

test('discovery avoids multi-address racing without forcing IPv4 for explicit IPv6 endpoints', async () => {
  const { fetchNetworkDirectory, FakeWebSocket } = loadWithFakeWebSocket();
  const endpoint = 'ws://[2001:db8::1]:8443/ws';
  assert.deepEqual(await fetchNetworkDirectory({ endpoint }), []);
  assert.equal(FakeWebSocket.instances[0].endpoint, endpoint);
  assert.equal(FakeWebSocket.instances[0].options.autoSelectFamily, false);
  assert.equal(FakeWebSocket.instances[0].options.family, undefined);
});
