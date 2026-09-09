'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BindPort = require('../bindPort');
const net = require('node:net');

test('unreachable allocated TCP port retries another relay and releases the failed lease', async () => {
  const original = net.connect;
  const sockets = [], closedPorts = [], allocations = [];
  const relay = name => ({ _managerHostKey: name, socket: { destroyed: false }, getServerRelayHost: () => name,
    RPC: { portOpen2: async () => { allocations.push(name); return 42001; },
      portClose2: async port => closedPorts.push([name, port]),
      portOpen: () => assert.fail('No API downgrade') } });
  const bad = relay('unreachable'), good = relay('reachable');
  const manager = Object.assign(new EventEmitter(), { getConnectionForDevice: async () => bad,
    getNearestConnection: () => good, getConnections: () => [bad, good] });
  const bind = new BindPort(manager, {});
  bind.portOpenTimeoutMs = 20;
  const context = bind._trackContext({}, 0, { sockets: new Set() });
  net.connect = options => {
    const socket = Object.assign(new EventEmitter(), { setNoDelay() {}, pause() { this.paused = true; },
      destroy() { this.destroyed = true; this.emit('close'); } });
    sockets.push(socket);
    if (options.host === 'reachable') queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  try {
    const opened = await bind._openNativePortWithRelayFallback(Buffer.alloc(20), '00'.repeat(20), 'tcp:42', 'rw', {
      cancelled: () => context.closed, prepare: value => bind._connectNativeTcpRelay(value, context),
    });
    assert.equal(opened.connection, good);
    assert.deepEqual(allocations, ['unreachable', 'reachable']);
    assert.deepEqual(closedPorts, [['unreachable', 42001]]);
    assert.equal(bad._diodeActiveNativeSessions, 0);
    assert.equal(good._diodeActiveNativeSessions, 1);
    assert.equal(sockets[0].destroyed, true);
    assert.equal(sockets[1].paused, true, 'data waits for authenticated handshake');
    assert.equal(context.sockets.size, 1);
  } finally { bind._closeContext(context); bind.dispose(); net.connect = original; }
  assert.equal(good._diodeActiveNativeSessions, 0);
  assert.deepEqual(closedPorts, [['unreachable', 42001], ['reachable', 42001]]);
});

test('cancellation during native allocation closes the late port without selecting another relay', async () => {
  let resolve, allocations = 0, closes = 0;
  const relay = { _managerHostKey: 'late', socket: { destroyed: false }, RPC: {
    portOpen2: () => { allocations++; return new Promise(r => { resolve = r; }); },
    portClose2: async () => { closes++; },
  } };
  const manager = Object.assign(new EventEmitter(), { getConnectionForDevice: async () => relay,
    getNearestConnection: () => relay, getConnections: () => [relay] });
  const bind = new BindPort(manager, {});
  const context = bind._trackContext({}, 0, { sockets: new Set() });
  try {
    const pending = bind._openNativePortWithRelayFallback(Buffer.alloc(20), '00'.repeat(20), 'tcp:42', 'rw', {
      cancelled: () => context.closed, prepare: value => bind._connectNativeTcpRelay(value, context),
    });
    while (!resolve) await new Promise(r => setImmediate(r));
    bind._closeContext(context); resolve(42001);
    await assert.rejects(pending, /closed during portopen2/);
    assert.equal(allocations, 1); assert.equal(closes, 1);
    assert.equal(relay._diodeActiveNativeSessions || 0, 0);
    assert.equal(context.sockets.size, 0);
  } finally { bind.dispose(); }
});

test('native portopen retries another relay without downgrading or sending application data', async () => {
  const calls = [];
  const relay = (name, result) => ({
    _managerHostKey: name,
    socket: { destroyed: false },
    RPC: {
      async portOpen2(_device, port, flags) {
        calls.push({ name, port, flags });
        if (result instanceof Error) throw result;
        return result;
      },
      portOpen() { assert.fail('Native application streams must not downgrade to API'); },
      portSend() { assert.fail('Opening a relay must not replay application data'); },
    },
  });
  for (const protocol of ['tcp', 'udp']) {
    calls.length = 0;
    const bad = relay('stale', new Error('portopen2 failed'));
    const good = relay('ready', 41001);
    const deviceHex = '31'.repeat(20);
    const manager = Object.assign(new EventEmitter(), {
      deviceRelayCache: new Map([[deviceHex, { hostKey: 'stale' }]]),
      getConnectionForDevice: async () => bad,
      getNearestConnection: () => good,
      getConnections: () => [bad, good],
    });
    const bind = new BindPort(manager, {});
    try {
      const opened = await bind._openNativePortWithRelayFallback(Buffer.from(deviceHex, 'hex'), deviceHex, `${protocol}:3389`, protocol === 'udp' ? 'rwu' : 'rw');
      assert.equal(opened.connection, good);
      assert.equal(opened.physicalPort, 41001);
      assert.deepEqual(calls.map((call) => call.name), ['stale', 'ready']);
      assert.equal(manager.deviceRelayCache.size, 0);
    } finally { bind.dispose(); }
  }
});
