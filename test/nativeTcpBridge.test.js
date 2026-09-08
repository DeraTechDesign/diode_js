'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { bridgeNativeTcp } = require('../nativeTcpBridge');
const nativeCrypto = require('../nativeCrypto');

class Endpoint extends Duplex {
  constructor() {
    super({ allowHalfOpen: true });
    this.writes = [];
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
}

function sessions() {
  const forwardKey = Buffer.alloc(32, 1);
  const reverseKey = Buffer.alloc(32, 2);
  const forwardSalt = Buffer.alloc(4, 3);
  const reverseSalt = Buffer.alloc(4, 4);
  const state = (txKey, rxKey, txSalt, rxSalt) => ({ txKey, rxKey, txSalt, rxSalt, txCounter: 0n, rxCounter: 0n, rxBuffer: Buffer.alloc(0) });
  return {
    local: state(forwardKey, reverseKey, forwardSalt, reverseSalt),
    remote: state(reverseKey, forwardKey, reverseSalt, forwardSalt),
  };
}

test('native bridge preserves a delayed response after request half-close', async (t) => {
  const localSocket = new Endpoint();
  const relaySocket = new Endpoint();
  const keys = sessions();
  const errors = [];
  const bridge = bridgeNativeTcp({ localSocket, relaySocket, session: keys.local, onError: (error) => errors.push(error) });
  t.after(() => bridge.destroy());
  localSocket.push(Buffer.from('binary request'));
  localSocket.push(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relaySocket.writableFinished, true, 'request FIN follows all encrypted writes');
  assert.equal(localSocket.destroyed, false, 'response direction remains usable after request EOF');
  assert.deepEqual(Buffer.concat(nativeCrypto.consumeTcpFrames(keys.remote, Buffer.concat(relaySocket.writes))), Buffer.from('binary request'));
  relaySocket.push(nativeCrypto.createTcpFrame(keys.remote, Buffer.from('delayed final response')));
  relaySocket.push(null);
  await bridge.closed;
  assert.deepEqual(Buffer.concat(localSocket.writes), Buffer.from('delayed final response'));
  assert.deepEqual(errors, []);
});

test('native bridge rejects truncated encrypted EOF and releases both endpoints', async () => {
  const localSocket = new Endpoint();
  const relaySocket = new Endpoint();
  const keys = sessions();
  const errors = [];
  let closes = 0;
  const bridge = bridgeNativeTcp({ localSocket, relaySocket, session: keys.local, onError: (error) => errors.push(error), onClose: () => { closes += 1; } });
  const frame = nativeCrypto.createTcpFrame(keys.remote, Buffer.from('incomplete request'));
  relaySocket.push(frame.subarray(0, frame.length - 1));
  relaySocket.push(null);
  await bridge.closed;
  assert.match(errors[0].message, /incomplete encrypted frame/);
  assert.equal(localSocket.destroyed, true);
  assert.equal(relaySocket.destroyed, true);
  assert.equal(localSocket.writes.length, 0);
  bridge.destroy();
  assert.equal(closes, 1);
});

test('native bridge reports an authentication failure without forwarding plaintext', async () => {
  const localSocket = new Endpoint();
  const relaySocket = new Endpoint();
  const keys = sessions();
  const errors = [];
  const bridge = bridgeNativeTcp({ localSocket, relaySocket, session: keys.local, onError: (error) => errors.push(error) });
  const frame = nativeCrypto.createTcpFrame(keys.remote, Buffer.from('request'));
  frame[frame.length - 1] ^= 1;
  relaySocket.push(frame);
  await bridge.closed;
  assert.match(errors[0].message, /decrypt failed/);
  assert.equal(localSocket.writes.length, 0);
  assert.equal(relaySocket.destroyed, true);
});
