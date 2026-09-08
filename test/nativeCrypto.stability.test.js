const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const nativeCrypto = require('../nativeCrypto');

function makeUdpPair() {
  const key = Buffer.alloc(32, 7);
  const salt = Buffer.from([1, 2, 3, 4]);
  return {
    tx: { txKey: key, txSalt: salt, txCounter: 0n },
    rx: {
      rxKey: key,
      rxSalt: salt,
      rxCounter: 0n,
      rxBuffer: Buffer.alloc(0),
      rxUdpHighest: null,
      rxUdpSeen: 0n,
    },
  };
}

test('native UDP replay window accepts bounded reordering exactly once', () => {
  const { tx, rx } = makeUdpPair();
  const packets = [0, 1, 2].map((value) => nativeCrypto.createUdpPacket(tx, Buffer.from([value])));

  assert.equal(nativeCrypto.parseUdpPacket(rx, packets[2])[0], 2);
  assert.equal(nativeCrypto.parseUdpPacket(rx, packets[0])[0], 0);
  assert.equal(nativeCrypto.parseUdpPacket(rx, packets[0]), null);
  assert.equal(nativeCrypto.parseUdpPacket(rx, packets[1])[0], 1);
  assert.equal(nativeCrypto.parseUdpPacket(rx, packets[2]), null);
});

test('native frame readers reject declared oversized frames before buffering payloads', () => {
  const session = {
    rxKey: Buffer.alloc(32),
    rxSalt: Buffer.alloc(4),
    rxCounter: 0n,
    rxBuffer: Buffer.alloc(0),
  };
  const header = Buffer.alloc(12);
  header.writeUInt32BE((1024 * 1024) + 1, 0);

  assert.throws(
    () => nativeCrypto.consumeTcpFrames(session, header),
    /TCP frame exceeds/
  );
  assert.equal(session.rxBuffer.length, 0);
});

test('native frame writers enforce TCP and UDP packet limits', () => {
  const { tx } = makeUdpPair();
  const tcpSession = { ...tx, txCounter: 0n };

  assert.throws(
    () => nativeCrypto.createTcpFrame(tcpSession, Buffer.alloc((1024 * 1024) + 1)),
    /TCP frame exceeds/
  );
  const largestIpv4Payload = nativeCrypto.createUdpPacket(tx, Buffer.alloc(65479));
  assert.equal(largestIpv4Payload.length, 65507);
  assert.throws(
    () => nativeCrypto.createUdpPacket(tx, Buffer.alloc(65480)),
    /UDP packet exceeds/
  );
  assert.equal(nativeCrypto.parseUdpPacket(makeUdpPair().rx, Buffer.alloc(65508)), null);
});

test('native handshake reader rejects oversized declared payload immediately', async () => {
  const socket = new EventEmitter();
  const reading = nativeCrypto.readHandshakeMessage(socket, 1000);
  const header = Buffer.alloc(4);
  header.writeUInt32BE((64 * 1024) + 1, 0);
  socket.emit('data', header);

  await assert.rejects(reading, /Handshake message exceeds/);
  assert.equal(socket.listenerCount('data'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('native handshake writer waits for write completion and backpressure drain', async () => {
  const socket = new EventEmitter();
  let writeCallback;
  socket.destroyed = false;
  socket.write = (_frame, callback) => {
    writeCallback = callback;
    return false;
  };
  let settled = false;
  const writing = nativeCrypto.writeHandshakeMessage(socket, { v: 1 })
    .then(() => { settled = true; });

  assert.equal(settled, false);
  writeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'write callback alone must not bypass backpressure');

  socket.emit('drain');
  await writing;
  assert.equal(settled, true);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('drain'), 0);
});

test('native handshake writer rejects a socket error while write is pending', async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => true;
  const writing = nativeCrypto.writeHandshakeMessage(socket, { v: 1 });
  const error = new Error('delayed write failed');

  socket.emit('error', error);
  await assert.rejects(writing, (actual) => actual === error);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('native handshake verifier rejects malformed cryptographic fields', () => {
  assert.deepEqual(
    nativeCrypto.verifyHandshakeMessage({
      v: 1,
      role: 'bind',
      deviceId: `0x${'11'.repeat(20)}`,
      physicalPort: 41000,
      ephPub: '00',
      nonce: '00',
      sig: '00',
    }, { expectedRole: 'bind' }),
    { ok: false, reason: 'Invalid ephemeral key' }
  );
});

test('native TCP frames preserve wire bytes and bounded buffering across arbitrary fragmentation', () => {
  const payload = Buffer.alloc(8193);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  for (const fragmentBytes of [1, 4, 11, 12, 13, 257, 16384]) {
    const { tx, rx } = makeUdpPair();
    const frame = nativeCrypto.createTcpFrame(tx, payload);
    const messages = [];
    for (let offset = 0; offset < frame.length; offset += fragmentBytes) {
      const chunk = Buffer.from(frame.subarray(offset, offset + fragmentBytes));
      messages.push(...nativeCrypto.consumeTcpFrames(rx, chunk));
      chunk.fill(0); // Partial data must not retain a caller-owned mutable view.
      assert.ok(rx.rxBuffer.length <= payload.length + 28);
    }
    assert.deepEqual(messages, [payload]);
    assert.equal(rx.rxBuffer.length, 0);
    assert.equal(rx.rxCounter, 1n);
  }
});

test('native TCP accepts batches larger than one frame limit while bounding each frame', () => {
  const { tx, rx } = makeUdpPair();
  const payloads = [Buffer.alloc(1024 * 1024, 3), Buffer.alloc(1024 * 1024, 7), Buffer.alloc(0)];
  const batch = Buffer.concat(payloads.map((payload) => nativeCrypto.createTcpFrame(tx, payload)));
  assert.deepEqual(nativeCrypto.consumeTcpFrames(rx, batch), payloads);
  assert.equal(rx.rxBuffer.length, 0);
  assert.equal(rx.rxCounter, 3n);
});

test('native TCP rejects tampering without accepting plaintext or advancing receive state', () => {
  const { tx, rx } = makeUdpPair();
  const frame = nativeCrypto.createTcpFrame(tx, Buffer.from('authenticated payload'));
  frame[frame.length - 1] ^= 1;
  nativeCrypto.consumeTcpFrames(rx, frame.subarray(0, 14));
  assert.throws(() => nativeCrypto.consumeTcpFrames(rx, frame.subarray(14)), /TCP decrypt failed/);
  assert.equal(rx.rxBuffer.length, 0);
  assert.equal(rx.rxCounter, 0n);
});
