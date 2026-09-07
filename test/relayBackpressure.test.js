'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { updateRelayBackpressure, releaseRelayBackpressure, isRelayInputPaused } = require('../relayBackpressure');

function fixture() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.pauses = 0;
  socket.resumes = 0;
  socket.pause = () => { socket.pauses += 1; };
  socket.resume = () => { socket.resumes += 1; };
  return { socket };
}

test('relay resumes only after every slow consumer drains, with hysteresis', () => {
  const connection = fixture();
  const first = {};
  const second = {};
  updateRelayBackpressure(connection, first, 256 * 1024);
  updateRelayBackpressure(connection, second, 300 * 1024);
  assert.equal(connection.socket.pauses, 1);
  assert.equal(isRelayInputPaused(connection), true);
  updateRelayBackpressure(connection, first, 200 * 1024);
  assert.equal(connection.socket.resumes, 0);
  updateRelayBackpressure(connection, first, 128 * 1024);
  assert.equal(connection.socket.resumes, 0, 'second consumer still holds pressure');
  releaseRelayBackpressure(second);
  assert.equal(connection.socket.resumes, 1);
  assert.equal(isRelayInputPaused(connection), false);
  releaseRelayBackpressure(second);
  assert.equal(connection.socket.resumes, 1, 'cleanup is idempotent');
  assert.equal(connection.socket.listenerCount('close'), 0);
});

test('closing a paused relay clears consumers without resuming it', () => {
  const connection = fixture();
  const consumer = {};
  updateRelayBackpressure(connection, consumer, 256 * 1024);
  connection.socket.destroyed = true;
  connection.socket.emit('close');
  releaseRelayBackpressure(consumer);
  assert.equal(isRelayInputPaused(connection), false);
  assert.equal(connection.socket.resumes, 0);
  assert.equal(consumer._releaseRelayInput, null);
});

test('an old consumer cannot resume a replacement relay socket', () => {
  const connection = fixture();
  const oldSocket = connection.socket;
  const consumer = {};
  updateRelayBackpressure(connection, consumer, 256 * 1024);
  connection.socket = fixture().socket;
  releaseRelayBackpressure(consumer);
  assert.equal(oldSocket.resumes, 0);
  assert.equal(connection.socket.resumes, 0);
  assert.equal(oldSocket.listenerCount('close'), 0);
});

test('a stalled consumer times out and releases shared relay input', async () => {
  const connection = fixture();
  let failure;
  const consumer = { relayReadTimeoutMs: 15, onRelayReadStall: (error) => { failure = error; } };
  updateRelayBackpressure(connection, consumer, 256 * 1024);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.match(failure.message, /local reader stalled/);
  assert.equal(isRelayInputPaused(connection), false);
  assert.equal(connection.socket.resumes, 1);
  assert.equal(consumer._relayReadStallTimer, null);
});

test('decreasing queue occupancy keeps a slow reader alive beyond one stall interval', async () => {
  const connection = fixture();
  let failures = 0;
  const consumer = { relayReadTimeoutMs: 80, onRelayReadStall: () => { failures += 1; } };
  try {
    updateRelayBackpressure(connection, consumer, 512 * 1024);
    for (const remaining of [450, 400, 350, 300]) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      updateRelayBackpressure(connection, consumer, remaining * 1024);
    }
    assert.equal(failures, 0);
    assert.equal(isRelayInputPaused(connection), true);
  } finally {
    releaseRelayBackpressure(consumer);
  }
});

test('an old stall timer cannot close a consumer on a replacement relay', async () => {
  const connection = fixture();
  const oldSocket = connection.socket;
  let failures = 0;
  const consumer = { relayReadTimeoutMs: 15, onRelayReadStall: () => { failures += 1; } };
  updateRelayBackpressure(connection, consumer, 256 * 1024);
  connection.socket = fixture().socket;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(failures, 0);
  assert.equal(oldSocket.resumes, 0);
  assert.equal(connection.socket.resumes, 0);
  assert.equal(consumer._relayReadStallTimer, null);
});
