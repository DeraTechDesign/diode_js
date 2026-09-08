'use strict';

// Compare the 0.5.2 receive algorithm with the current one using identical
// authenticated frames. This isolates copying/decryption, not network speed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const nativeCrypto = require('../nativeCrypto');
const key = Buffer.alloc(32, 7);
const salt = Buffer.alloc(4, 3);
const bytes = 8 * 1024 * 1024;
const frameBytes = 64 * 1024;

function previousConsume(session, data) {
  let buffer = Buffer.concat([session.rxBuffer, data]);
  const messages = [];
  while (buffer.length >= 12) {
    const length = buffer.readUInt32BE(0);
    if (length > 1024 * 1024) throw new Error('oversized frame');
    const size = length + 28;
    if (buffer.length < size) break;
    const counter = buffer.readBigUInt64BE(4);
    if (counter >= session.rxCounter) {
      const nonce = Buffer.alloc(12);
      salt.copy(nonce);
      nonce.writeBigUInt64BE(counter, 4);
      const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      decipher.setAAD(buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12 + length, size));
      messages.push(Buffer.concat([decipher.update(buffer.subarray(12, 12 + length)), decipher.final()]));
      session.rxCounter = counter + 1n;
    }
    buffer = buffer.subarray(size);
  }
  session.rxBuffer = buffer;
  return messages;
}

const tx = { txKey: key, txSalt: salt, txCounter: 0n };
const frames = Array.from({ length: bytes / frameBytes }, () => nativeCrypto.createTcpFrame(tx, Buffer.alloc(frameBytes, 5)));
function measure(consume, fragmentBytes) {
  const session = { rxKey: key, rxSalt: salt, rxCounter: 0n, rxBuffer: Buffer.alloc(0) };
  let received = 0;
  const started = performance.now();
  for (const frame of frames) {
    for (let offset = 0; offset < frame.length; offset += fragmentBytes) {
      for (const message of consume(session, frame.subarray(offset, offset + fragmentBytes))) received += message.length;
    }
  }
  const elapsed = performance.now() - started;
  assert.equal(received, bytes);
  assert.equal(session.rxBuffer.length, 0);
  return elapsed;
}

for (const fragmentBytes of [256, 16384, frameBytes + 28]) {
  measure(previousConsume, fragmentBytes);
  measure(nativeCrypto.consumeTcpFrames, fragmentBytes);
  const previous = [];
  const current = [];
  for (let sample = 0; sample < 5; sample++) {
    previous.push(measure(previousConsume, fragmentBytes));
    current.push(measure(nativeCrypto.consumeTcpFrames, fragmentBytes));
  }
  const median = (values) => values.sort((a, b) => a - b)[2];
  const before = median(previous);
  const after = median(current);
  console.log(JSON.stringify({ bytes, fragmentBytes, previousMs: +before.toFixed(2), currentMs: +after.toFixed(2), speedup: +(before / after).toFixed(2) }));
}
