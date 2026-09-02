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
