'use strict';

const { Duplex } = require('node:stream');
const { setMaxListeners } = require('node:events');
const { updateRelayBackpressure, releaseRelayBackpressure } = require('./relayBackpressure');

const MAX_FRAME_BYTES = 65000;
const SEND_WINDOW_BYTES = 256 * 1024;
const SEND_WINDOW_FRAMES = 16;
const MAX_INBOUND_BYTES = 1024 * 1024;

// A bounded, ordered API transport for TLS. Waiting for an acknowledgment in
// every _write limits TLS throughput to one record per relay round trip.
class DiodeSocket extends Duplex {
  constructor(ref, rpc, timeoutMs = 10000, connection = rpc.connection) {
    super({ readableHighWaterMark: SEND_WINDOW_BYTES, writableHighWaterMark: SEND_WINDOW_BYTES, allowHalfOpen: false });
    this.ref = ref;
    this.rpc = rpc;
    this.timeoutMs = timeoutMs;
    this.relayReadTimeoutMs = timeoutMs;
    this.onRelayReadStall = (error) => this.destroy(error);
    this.connection = connection;
    this._inboundQueue = [];
    this._inboundBytes = 0;
    this._inboundBlocked = false;
    this._inboundEnded = false;
    this._sending = new Set();
    this._sendingBytes = 0;
    this._pendingWrite = null;
    this._finishWrite = null;
    this._flushWaiters = [];
    this._sendFailure = null;
    this._pumping = false;
    this._sendAbort = new AbortController();
    setMaxListeners(SEND_WINDOW_FRAMES, this._sendAbort.signal);
  }

  _write(chunk, encoding, callback) {
    this._pendingWrite = { chunk, offset: 0, callback };
    this._pumpWrites();
  }

  _pumpWrites() {
    if (this._pumping || this.destroyed) return;
    this._pumping = true;
    try {
      while (this._pendingWrite && !this.destroyed) {
        const pending = this._pendingWrite;
        if (pending.offset === pending.chunk.length) {
          this._pendingWrite = null;
          pending.callback();
          continue;
        }
        const length = Math.min(MAX_FRAME_BYTES, pending.chunk.length - pending.offset);
        if (this._sending.size >= SEND_WINDOW_FRAMES || this._sendingBytes + length > SEND_WINDOW_BYTES) break;

        // Node/TLS may reuse its source buffer after the write callback. Keep
        // each in-flight frame alive independently until the relay answers.
        const frame = Buffer.from(pending.chunk.subarray(pending.offset, pending.offset + length));
        pending.offset += length;
        const send = { length };
        this._sending.add(send);
        this._sendingBytes += length;
        let result;
        try {
          // Invoke in byte order, without awaiting each individual response.
          // Never retry stream data: an ambiguous send cannot be replayed.
          result = this.rpc.portSend(this.ref, frame, {
            timeoutMs: this.timeoutMs,
            signal: this._sendAbort.signal,
          });
        } catch (error) {
          this.destroy(error);
          break;
        }
        Promise.resolve(result).then(() => {
          if (this.destroyed) return;
          this._sending.delete(send);
          this._sendingBytes -= send.length;
          this._pumpWrites();
        }, (error) => this.destroy(error));
      }
      if (!this.destroyed && !this._pendingWrite && this._sending.size === 0) {
        for (const waiter of this._flushWaiters.splice(0)) waiter.resolve();
        if (this._finishWrite) {
          const callback = this._finishWrite;
          this._finishWrite = null;
          callback();
        }
      }
    } finally {
      this._pumping = false;
    }
  }

  _final(callback) {
    // A graceful TLS close must flush every acknowledged frame before EOF.
    this._finishWrite = callback;
    this._pumpWrites();
  }

  flush() {
    if (this._sendFailure) return Promise.reject(this._sendFailure);
    if (!this._pendingWrite && this._sending.size === 0) return Promise.resolve();
    return new Promise((resolve, reject) => this._flushWaiters.push({ resolve, reject }));
  }

  async finishTlsWrites(tlsSocket) {
    // TLS can still hold plaintext after its application socket has ended.
    // Finish encryption before waiting for the final relay acknowledgments.
    if (!tlsSocket.writableFinished) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Diode TLS write shutdown timed out')), this.timeoutMs);
        const finish = (error) => {
          clearTimeout(timer);
          tlsSocket.removeListener('finish', onFinish);
          tlsSocket.removeListener('error', onError);
          tlsSocket.removeListener('close', onClose);
          if (error) reject(error);
          else resolve();
        };
        const onFinish = () => finish();
        const onError = (error) => finish(error);
        const onClose = () => finish(tlsSocket.writableFinished ? null : new Error('Diode TLS socket closed before flushing'));
        tlsSocket.once('finish', onFinish);
        tlsSocket.once('error', onError);
        tlsSocket.once('close', onClose);
        if (tlsSocket.destroyed) onClose();
        else tlsSocket.end();
      });
    }
    await this.flush();
  }

  _read() {
    this._inboundBlocked = false;
    while (!this._inboundBlocked && this._inboundQueue.length > 0 && !this.destroyed) {
      const chunk = this._inboundQueue.shift();
      this._inboundBytes -= chunk.length;
      this._inboundBlocked = this.push(chunk) === false;
    }
    updateRelayBackpressure(this.connection, this, this._inboundBytes);
    if (this._inboundEnded && this._inboundQueue.length === 0) this.push(null);
  }

  endReadable() {
    this._inboundEnded = true;
    if (this._inboundQueue.length === 0) this.push(null);
  }

  pushData(data) {
    if (this.destroyed || this._inboundEnded) return false;
    if (!this._inboundBlocked && this._inboundQueue.length === 0) {
      this._inboundBlocked = this.push(data) === false;
      return !this._inboundBlocked;
    }
    const copy = Buffer.from(data);
    this._inboundQueue.push(copy);
    this._inboundBytes += copy.length;
    updateRelayBackpressure(this.connection, this, this._inboundBytes);
    if (this._inboundBytes > MAX_INBOUND_BYTES) {
      this.destroy(new Error('Diode TLS inbound queue limit exceeded'));
    }
    return false;
  }

  _destroy(error, callback) {
    releaseRelayBackpressure(this);
    if (error || this._pendingWrite || this._sending.size > 0) {
      this._sendFailure = error || new Error('Diode transport closed before flushing');
    }
    this._sendAbort.abort();
    this._sending.clear();
    this._sendingBytes = 0;
    this._inboundQueue.length = 0;
    this._inboundBytes = 0;
    const pending = this._pendingWrite;
    const finish = this._finishWrite;
    this._pendingWrite = null;
    this._finishWrite = null;
    const closedError = error || new Error('Diode TLS transport closed');
    for (const waiter of this._flushWaiters.splice(0)) waiter.reject(this._sendFailure || closedError);
    if (pending) pending.callback(closedError);
    if (finish) finish(closedError);
    callback(error);
  }
}

module.exports = DiodeSocket;
