'use strict';

// API streams share a relay TCP socket. A slow local reader must eventually
// apply TCP pressure upstream instead of exhausting its bounded receive queue.
const pausedSockets = new WeakMap();
const PAUSE_BYTES = 256 * 1024;
const RESUME_BYTES = 128 * 1024;

function releaseRelayBackpressure(consumer) {
  if (!consumer) return;
  if (consumer._relayReadStallTimer) clearTimeout(consumer._relayReadStallTimer);
  consumer._relayReadStallTimer = null;
  const release = consumer && consumer._releaseRelayInput;
  if (release) {
    consumer._releaseRelayInput = null;
    release();
  }
}

function updateRelayBackpressure(connection, consumer, queuedBytes) {
  if (queuedBytes <= RESUME_BYTES) {
    releaseRelayBackpressure(consumer);
    return;
  }
  if (consumer._releaseRelayInput) {
    if (queuedBytes < consumer._relayReadLastBytes && consumer._relayReadStallTimer) {
      consumer._relayReadStallTimer.refresh();
    }
    consumer._relayReadLastBytes = queuedBytes;
    return;
  }
  if (queuedBytes < PAUSE_BYTES) return;
  const socket = connection && connection.socket;
  if (!socket || socket.destroyed || typeof socket.pause !== 'function' || typeof socket.resume !== 'function') return;
  let state = pausedSockets.get(socket);
  if (!state) {
    state = { consumers: new Set() };
    state.onClose = () => {
      pausedSockets.delete(socket);
      for (const owner of state.consumers) {
        owner._releaseRelayInput = null;
        releaseRelayBackpressure(owner);
      }
      state.consumers.clear();
    };
    pausedSockets.set(socket, state);
    if (typeof socket.once === 'function') socket.once('close', state.onClose);
    socket.pause();
  }
  state.consumers.add(consumer);
  consumer._relayReadLastBytes = queuedBytes;
  consumer._releaseRelayInput = () => {
    if (!state.consumers.delete(consumer) || state.consumers.size > 0) return;
    if (pausedSockets.get(socket) !== state) return;
    pausedSockets.delete(socket);
    if (typeof socket.off === 'function') socket.off('close', state.onClose);
    // An old tunnel must never resume a replacement relay connection.
    if (!socket.destroyed && connection.socket === socket) {
      if (typeof connection._scheduleUnsolicitedDrain === 'function') connection._scheduleUnsolicitedDrain();
      socket.resume();
    }
  };
  const timeoutMs = Math.min(Math.max(Math.floor(Number(consumer.relayReadTimeoutMs) || 10000), 1), 0x7fffffff);
  consumer._relayReadStallTimer = setTimeout(() => {
    try {
      if (connection.socket === socket && !socket.destroyed && typeof consumer.onRelayReadStall === 'function') {
        consumer.onRelayReadStall(new Error(`Diode local reader stalled for ${timeoutMs}ms`));
      }
    } finally {
      releaseRelayBackpressure(consumer);
    }
  }, timeoutMs);
  if (typeof consumer._relayReadStallTimer.unref === 'function') consumer._relayReadStallTimer.unref();
}

function isRelayInputPaused(connection) {
  return !!(connection && connection.socket && pausedSockets.has(connection.socket));
}

module.exports = { updateRelayBackpressure, releaseRelayBackpressure, isRelayInputPaused };
