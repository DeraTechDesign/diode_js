'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const DiodeSocket = require('../diodeSocket');
const { EventEmitter } = require('node:events');

function fixture(t) {
  const sends = [];
  const socket = new DiodeSocket(Buffer.from('0102', 'hex'), {
    portSend(ref, frame, options) {
      return new Promise((resolve, reject) => sends.push({ ref, frame, options, resolve, reject }));
    },
  });
  t.after(() => socket.destroy());
  return { socket, sends };
}

test('TLS sends a bounded window before ACKs, retaining byte order and buffers', async (t) => {
  const { socket, sends } = fixture(t);
  const expected = [];
  for (let index = 0; index < 32; index += 1) {
    const chunk = Buffer.alloc(16 * 1024, index);
    expected.push(Buffer.from(chunk));
    socket.write(chunk, () => chunk.fill(255));
  }
  const finished = once(socket, 'finish');
  socket.end();
  assert.equal(sends.length, 16, 'sixteen records in flight without waiting one RTT per record');
  assert.equal(socket._sendingBytes, 256 * 1024);
  // Responses may arrive in a different order; data must still be issued in order.
  for (const send of sends.slice().reverse()) send.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 32);
  assert.equal(socket._sendingBytes, 256 * 1024);
  assert.equal(socket.writableFinished, false, 'EOF waits for outstanding relay ACKs');
  for (const send of sends.slice(16)) send.resolve();
  await finished;
  assert.deepEqual(Buffer.concat(sends.map((send) => send.frame)), Buffer.concat(expected));
  assert.ok(sends.every((send) => send.options.timeoutMs === 10000));
});

test('large writes respect wire frame and in-flight byte limits', async (t) => {
  const { socket, sends } = fixture(t);
  const expected = Buffer.alloc(1024 * 1024, 42);
  const finished = once(socket, 'finish');
  socket.end(expected);
  let acknowledged = 0;
  while (!socket.writableFinished) {
    assert.ok(socket._sendingBytes <= 256 * 1024);
    assert.ok(socket._sending.size <= 16);
    const batch = sends.slice(acknowledged);
    acknowledged = sends.length;
    for (const send of batch) send.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await finished;
  assert.ok(sends.every((send) => send.frame.length <= 65000));
  assert.deepEqual(Buffer.concat(sends.map((send) => send.frame)), expected);
});

test('late send failure closes the stream and cancels pending RPCs without replay', async (t) => {
  const { socket, sends } = fixture(t);
  const errorEvent = once(socket, 'error');
  let writeError;
  socket.write(Buffer.alloc(1024 * 1024), (error) => { writeError = error; });
  const sentBeforeFailure = sends.length;
  sends[1].reject(new Error('relay disconnected'));
  const [error] = await errorEvent;
  assert.match(error.message, /relay disconnected/);
  assert.equal(socket.destroyed, true);
  assert.match(writeError.message, /relay disconnected/);
  assert.ok(sends.every((send) => send.options.signal.aborted));
  for (const send of sends) send.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, sentBeforeFailure);
  assert.equal(socket._sendingBytes, 0);
});

test('a synchronous RPC failure is reported through stream error', async (t) => {
  const socket = new DiodeSocket(Buffer.from('01', 'hex'), {
    portSend() { throw new Error('not writable'); },
  });
  t.after(() => socket.destroy());
  const errorEvent = once(socket, 'error');
  socket.write(Buffer.from('hello'));
  const [error] = await errorEvent;
  assert.match(error.message, /not writable/);
});

test('slow inbound readers retain ordered bytes within the existing queue bound', async (t) => {
  const { socket } = fixture(t);
  const chunks = Array.from({ length: 40 }, (_, index) => Buffer.alloc(16384, index));
  for (const chunk of chunks) socket.pushData(chunk);
  const received = [];
  let chunk;
  while ((chunk = socket.read()) !== null) received.push(chunk);
  assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks));
  assert.equal(socket._inboundBytes, 0);
});

test('a stalled TLS reader closes its stream and releases relay pressure', async (t) => {
  const relaySocket = new EventEmitter();
  relaySocket.destroyed = false;
  let resumed = 0;
  relaySocket.pause = () => {};
  relaySocket.resume = () => { resumed += 1; };
  const socket = new DiodeSocket(Buffer.from('01', 'hex'), { portSend: async () => {} }, 15, { socket: relaySocket });
  t.after(() => socket.destroy());
  const errorEvent = once(socket, 'error');
  // Keep the process alive while the production stall timer remains unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (let index = 0; index < 32; index += 1) socket.pushData(Buffer.alloc(16384));
    const [error] = await errorEvent;
    assert.match(error.message, /local reader stalled/);
    assert.equal(socket.destroyed, true);
    assert.equal(resumed, 1);
    assert.equal(socket._inboundBytes, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});
