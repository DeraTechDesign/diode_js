'use strict';
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LatestUdpSender, normalizeUdpSendPolicy } = require('../udpLatestSender');
const { createHarness } = require('./fixtures/udp-control-harness.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const transport of ['api', 'native']) {
  test(`${transport} latest UDP coalesces a real socket burst while opening, preserves legacy delivery`, async () => {
    for (const latest of [false, true]) {
      const harness = await createHarness({ transport, openingMs: 100, policy: latest ? { mode: 'latest', maxAgeMs: 1000 } : undefined });
      try {
        await Promise.all(Array.from({ length: 24 }, (_, index) => harness.send(Buffer.from([index]))));
        await sleep(250);
        assert.equal(harness.opens, 1);
        assert.deepEqual(harness.packets.map(p => p.data[0]), latest ? [23] : Array.from({ length: 24 }, (_, i) => i));
        if (latest) { assert.equal(harness.bind.getUdpSendStats(0).superseded, 23); assert.equal(harness.bind.getUdpSendStats(0).pendingDatagrams, 0); }
      } finally { await harness.close(); }
    }
  });
  test(`${transport} expires data during setup and accepts the next fresh datagram`, async () => {
    const harness = await createHarness({ transport, openingMs: 150, policy: { mode: 'latest', maxAgeMs: 40 } });
    try {
      await harness.send(Buffer.from('stale')); await sleep(240);
      assert.equal(harness.packets.length, 0); assert.equal(harness.bind.getUdpSendStats(0).expired, 1);
      await harness.send(Buffer.from('fresh')); await sleep(40);
      assert.deepEqual(harness.packets.map(p => p.data.toString()), ['fresh']);
    } finally { await harness.close(); }
  });
  test(`${transport} disposal while opening cannot release a queued command`, async () => {
    const harness = await createHarness({ transport, openingMs: 100, policy: { mode: 'latest', maxAgeMs: 1000 } });
    try {
      await harness.send(Buffer.from('cancelled')); await sleep(20);
      const sender = harness.server._diodeUdpSender;
      harness.bind.dispose(); await sleep(150);
      assert.equal(harness.packets.length, 0); assert.equal(sender.snapshot().pendingDatagrams, 0);
    } finally { await harness.close(); }
  });
}

test('bounded source workers never retain an unbounded payload backlog', async () => {
  const open = gate(), sent = [];
  const sender = new LatestUdpSender({ maxAgeMs: 50, maxPendingClients: 2 }, async (key, _peer, take) => {
    await open.promise; const item = take(); if (item) sent.push([key, item.data[0]]);
  }, () => {}, () => 0);
  for (let i = 0; i < 10000; i++) sender.offer('a', Buffer.from([i % 256]), {});
  sender.offer('b', Buffer.from([7]), {}); sender.offer('c', Buffer.from([8]), {});
  assert.equal(sender.snapshot().pendingDatagrams, 2); assert.equal(sender.snapshot().overloaded, 1);
  open.resolve(); await sleep(0);
  assert.deepEqual(sent, [['a', 9999 % 256], ['b', 7]]); assert.equal(sender.snapshot().pendingClients, 0);
});

test('an in-flight send retains only the newest following datagram and failures do not replay it', async () => {
  const sending = gate(), sent = [], errors = [];
  const sender = new LatestUdpSender({ maxAgeMs: 50, maxPendingClients: 1 }, async (_key, _peer, take) => {
    sent.push(take().data[0]); await sending.promise;
  }, error => errors.push(error), () => 0);
  sender.offer('a', Buffer.from([1]), {});
  sender.offer('a', Buffer.from([2]), {}); sender.offer('a', Buffer.from([3]), {});
  assert.equal(sender.snapshot().pendingDatagrams, 1);
  sending.reject(new Error('ambiguous send')); await sleep(0);
  assert.deepEqual(sent, [1]); assert.equal(errors.length, 1); assert.equal(sender.snapshot().cancelled, 1);
});

test('expiry uses elapsed monotonic time at submission, including a local scheduler stall', async () => {
  let now = 0; const open = gate(); let sent = 0;
  const sender = new LatestUdpSender({ maxAgeMs: 50, maxPendingClients: 1 }, async (_key, _peer, take) => {
    await open.promise; if (take()) sent++;
  }, () => {}, () => now);
  sender.offer('a', Buffer.alloc(1), {}); now = 50;
  open.resolve(); await sleep(0);
  assert.equal(sent, 0); assert.equal(sender.snapshot().expired, 1);
});

test('a successful slow send expires its queued successor and still permits a new fresh value', async () => {
  let now = 0; const ack = gate(), sent = [];
  const sender = new LatestUdpSender({ maxAgeMs: 50, maxPendingClients: 1 }, async (_key, _peer, take) => {
    const item = take(); if (!item) return;
    sent.push(item.data[0]); if (sent.length === 1) await ack.promise;
  }, error => assert.fail(error), () => now);
  sender.offer('a', Buffer.from([1]), {});
  now = 10; sender.offer('a', Buffer.from([2]), {});
  now = 20; sender.offer('a', Buffer.from([3]), {});
  now = 100; ack.resolve(); await sleep(0);
  assert.deepEqual(sent, [1]); assert.equal(sender.snapshot().expired, 1);
  assert.equal(sender.snapshot().superseded, 1); assert.equal(sender.snapshot().pendingClients, 0);
  now = 101; sender.offer('a', Buffer.from([4]), {}); await sleep(0);
  assert.deepEqual(sent, [1, 4]); assert.equal(sender.snapshot().errors, 0);
});

test('freshness configuration rejects invalid values and use on streams', () => {
  assert.equal(normalizeUdpSendPolicy(undefined, 'tcp'), null);
  for (const policy of [null, {}, { mode: 'latest', maxAgeMs: 0 }, { mode: 'latest', maxAgeMs: Infinity }, { mode: 'latest', maxAgeMs: 50, maxPendingClients: 0 }]) {
    assert.throws(() => normalizeUdpSendPolicy(policy, 'udp'), TypeError);
  }
  assert.throws(() => normalizeUdpSendPolicy({ mode: 'latest', maxAgeMs: 50 }, 'tcp'), /only supported for UDP/);
});
