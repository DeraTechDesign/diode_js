'use strict';
const { performance } = require('node:perf_hooks');

function normalizeUdpSendPolicy(value, protocol) {
  if (value === undefined) return null;
  if (protocol !== 'udp') throw new TypeError('udpSendPolicy is only supported for UDP');
  if (!value || value.mode !== 'latest' || !Number.isFinite(value.maxAgeMs) || value.maxAgeMs <= 0 || value.maxAgeMs > 0x7fffffff) {
    throw new TypeError('udpSendPolicy requires mode: latest and maxAgeMs > 0 (at most 2147483647)');
  }
  const maxPendingClients = value.maxPendingClients === undefined ? 64 : value.maxPendingClients;
  if (!Number.isInteger(maxPendingClients) || maxPendingClients < 1 || maxPendingClients > 4096) {
    throw new TypeError('udpSendPolicy.maxPendingClients must be an integer from 1 to 4096');
  }
  return { mode: 'latest', maxAgeMs: value.maxAgeMs, maxPendingClients };
}

// An opt-in policy for replaceable datagrams. One worker and one pending
// payload per source; the payload is selected AFTER asynchronous setup.
class LatestUdpSender {
  constructor(policy, send, onError, now = () => performance.now()) {
    this.policy = policy; this.send = send; this.onError = onError; this.now = now;
    this.clients = new Map(); this.closed = false;
    this.stats = { received: 0, submitted: 0, superseded: 0, expired: 0, overloaded: 0, cancelled: 0, errors: 0, peakPendingClients: 0 };
  }

  offer(key, data, peer) {
    this.stats.received++;
    if (this.closed) { this.stats.cancelled++; return; }
    let state = this.clients.get(key);
    if (!state) {
      if (this.clients.size >= this.policy.maxPendingClients) { this.stats.overloaded++; return; }
      state = { key, peer, pending: null, running: false };
      this.clients.set(key, state);
      this.stats.peakPendingClients = Math.max(this.stats.peakPendingClients, this.clients.size);
    }
    if (state.pending) this.stats.superseded++;
    state.pending = { data, receivedAt: this.now() };
    if (!state.running) { state.running = true; void this._drain(state); }
  }

  async _drain(state) {
    try {
      while (!this.closed && state.pending) {
        let taken = false;
        await this.send(state.key, state.peer, () => {
          if (taken) return null;
          taken = true;
          const item = state.pending; state.pending = null;
          if (this.closed || !item) return null;
          const remainingMs = this.policy.maxAgeMs - (this.now() - item.receivedAt);
          if (remainingMs <= 0) { this.stats.expired++; return null; }
          this.stats.submitted++;
          return { data: item.data, remainingMs };
        });
        // Setup failure/cancellation may return without selecting a packet.
        // Discard that generation's pending data; never retry it on a new path.
        if (!taken) break;
      }
    } catch (error) {
      this.stats.errors++;
      try { this.onError(error); } catch (_) {}
    } finally {
      if (state.pending) { this.stats.cancelled++; state.pending = null; }
      if (this.clients.get(state.key) === state) this.clients.delete(state.key);
    }
  }

  close() {
    this.closed = true;
    for (const state of this.clients.values()) {
      if (state.pending) { this.stats.cancelled++; state.pending = null; }
    }
    this.clients.clear();
  }

  snapshot() {
    return { ...this.stats, pendingClients: this.clients.size,
      pendingDatagrams: [...this.clients.values()].filter(state => state.pending).length };
  }
}
module.exports = { LatestUdpSender, normalizeUdpSendPolicy };
