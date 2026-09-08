'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BindPort = require('../bindPort');

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
