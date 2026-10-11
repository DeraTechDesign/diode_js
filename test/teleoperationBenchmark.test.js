'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleRate, deadlineCounts, freshnessTimeline, robotReceiver, checkWatchdog, controlPathSockets, packet, frames, distribution } = require('../scripts/benchmark-teleoperation');

test('fixed-rate generator counts missed deadlines without waiting for echo or replaying a catch-up burst', async () => {
  let clock = 0, skipped = 0; const tasks = [], sent = [];
  const complete = scheduleRate({ hz: 100, seconds: .1, started: 0, clock: () => clock,
    schedule: callback => tasks.push(callback), skip: n => { skipped += n; },
    send: (seq, due) => { sent.push([seq, due]); return new Promise(() => {}); },
  });
  assert.deepEqual(sent, [[0, 0]]);
  clock = 45; tasks.shift()();
  assert.deepEqual(sent, [[0, 0], [4, 40]]);
  clock = 100; tasks.shift()(); await complete;
  assert.equal(skipped, 8); assert.equal(sent.length + skipped, 10);
});

test('control stream framing handles fragmented and coalesced commands without timestamp changes', () => {
  const expected = [packet(1, 42, 100), packet(2, 42, 110)]; const output = [];
  const receive = frames(data => output.push(data)); const input = Buffer.concat(expected);
  receive(input.subarray(0, 1)); receive(input.subarray(1, 135)); receive(input.subarray(135));
  assert.deepEqual(output, expected);
  assert.equal(distribution([1, 2, 1000]).max, 1000);
});

test('deadline accounting includes unsent slots, deduplicates receipts, and separates startup and reverse-path loss', () => {
  const received = deadlineCounts(10, 10, .2, [2, 2, 3, 4, 5, 6, 7, 8, 9, 999]);
  const echoed = deadlineCounts(10, 10, .2, [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(received.onTime, 8); assert.equal(received.deadlineMissPct, 20);
  assert.equal(received.longestMissBurstMs, 200); assert.equal(received.steadyState.deadlineMissPct, 0);
  assert.equal(echoed.steadyState.deadlineMissPct, 12.5);
});

test('receiver rejects stale, reordered, wrong-session and invalid-time packets without refreshing its watchdog', () => {
  let clock = 100; const state = new BigInt64Array(new SharedArrayBuffer(32)), replies = [];
  const receiver = robotReceiver({ epoch: 42, hz: 100, seconds: 10, deadlineMs: 50 }, state, () => clock);
  const send = data => receiver.receive(data, reply => replies.push(reply.readUInt32BE(12)));
  send(packet(2, 42, 90)); assert.equal(state[0], 100000000n);
  clock = 120;
  send(packet(1, 42, 110)); send(packet(3, 42, 1)); send(packet(4, 999, 110));
  send(packet(5, 42, NaN)); send(packet(6, 42, 121));
  assert.equal(state[0], 100000000n);
  assert.deepEqual(replies, [0, 2, 1, 1, 1]);
  assert.deepEqual(receiver.report().counts, { received: 5, accepted: 1, expired: 3, reordered: 1, invalid: 1, stopped: 0 });
});

test('watchdog expires accepted commands and recovered traffic cannot overwrite the latched stop', () => {
  let clock = 100; const state = new BigInt64Array(new SharedArrayBuffer(32));
  const receiver = robotReceiver({ epoch: 42, hz: 100, seconds: 10, deadlineMs: 50 }, state, () => clock);
  assert.equal(checkWatchdog(state, 100000000n, 100000000n), false);
  receiver.receive(packet(1, 42, 100), () => {});
  assert.equal(checkWatchdog(state, 100000000n, 199999999n), false);
  assert.equal(checkWatchdog(state, 100000000n, 200000000n), true);
  clock = 201; receiver.receive(packet(2, 42, 201), response => assert.equal(response.readUInt32BE(12), 3));
  assert.equal(state[0], -1n); assert.equal(state[1], 1n);
  assert.equal(receiver.report().counts.accepted, 1); assert.equal(receiver.report().counts.stopped, 1);
  assert.equal(checkWatchdog(state, 100000000n, 999000000n), false);
});

test('disconnect faults target the control bind active relay or Native data socket', () => {
  const activeRelay = {}, nativeData = { remotePort: 4444 }, localClient = { remotePort: 5555 }, unrelated = {};
  const active = { connection: { socket: activeRelay }, physicalPort: 4444, sockets: new Set([nativeData, localClient]) };
  const bind = { _activeContexts: new Set([active, { closed: true, connection: { socket: unrelated } }]) };
  assert.deepEqual(controlPathSockets(bind), [activeRelay]); assert.deepEqual(controlPathSockets(bind, true), [nativeData]);
  active.closed = true; assert.deepEqual(controlPathSockets(bind), []);
});

test('receiver detects corrupted stream record payloads before accepting a command', () => {
  const state = new BigInt64Array(new SharedArrayBuffer(32));
  const receiver = robotReceiver({ epoch: 42, hz: 100, seconds: 10, deadlineMs: 50 }, state, () => 100);
  const data = packet(1, 42, 100); data[80] ^= 1;
  receiver.receive(data, () => assert.fail('corrupt command must not be acknowledged'));
  assert.equal(receiver.report().counts.invalid, 1); assert.equal(receiver.report().counts.accepted, 0); assert.equal(state[0], 0n);
});

test('fault timeline distinguishes an unusable initial path from failed recovery', () => {
  const arrivals = [5, 6, 7, 8, 9].map(sequence => ({ sequence, receivedAtMonoMs: 1000 + sequence * 100 + 20 }));
  const report = freshnessTimeline(10, 10, 1000, 1500, arrivals);
  assert.equal(report.firstFreshCommandAtRunMs, 520);
  assert.equal(report.beforeInjection.deadlineMissPct, 100);
  assert.equal(report.afterInjection.deadlineMissPct, 0);
  assert.equal(report.firstFreshPostInjectionMs, 20);
  const failed = freshnessTimeline(10, 10, 1000, 1500, [{ sequence: 4, receivedAtMonoMs: 1520 }]);
  assert.equal(failed.afterInjection.deadlineMissPct, 100);
  assert.equal(failed.firstFreshPostInjectionMs, null, 'a late pre-fault command is not post-fault recovery');
  assert.equal(freshnessTimeline(10, 10, 1000, undefined, []).firstFreshCommandAtRunMs, null);
});
