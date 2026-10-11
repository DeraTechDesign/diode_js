'use strict';
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const PublishPort = require('../publishPort');
const BindPort = require('../bindPort');
const { makeRelay } = require('./apiTls.integration.test');

const { parserConnection, frame } = require('./fixtures/stream-parser.cjs');

test('API stream parser preserves fragmented headers, payloads and coalesced frames', async () => {
  for (const fragment of [1, 31, 1024, 16384, 1000000]) {
    const connection = parserConnection(), received = [];
    connection.on('unsolicited', message => received.push(Buffer.from(message[1][2])));
    const payloads = [Buffer.alloc(65000, 1), Buffer.alloc(128, 2), Buffer.alloc(65000, 3)];
    const wire = Buffer.concat(payloads.map((value, i) => frame(i + 1, value)));
    for (let offset = 0; offset < wire.length; offset += fragment) connection._handleData(wire.subarray(offset, offset + fragment), 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, payloads); assert.equal(connection.receiveBuffer.length, 0);
  }
});

test('a large decoded TCP batch yields to other event-loop work without reordering', async () => {
  const connection = parserConnection(), received = [];
  connection.on('unsolicited', value => received.push(value));
  for (let i = 0; i < 10000; i++) connection._deferUnsolicited(i, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.length > 0 && received.length < 10000, 'bulk dispatch must yield before monopolizing the event loop');
  while (received.length < 10000) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, Array.from({ length: 10000 }, (_, i) => i));
  assert.equal(connection._deferredUnsolicited.size, 0);
});

test('TLS publisher releases a backend when the peer never completes TLS', { timeout: 5000 }, async () => {
  const sockets = new Set();
  const backend = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const relay = makeRelay(0, 'tls');
  const publish = new PublishPort(relay.publisher, { [backend.address().port]: { host: '127.0.0.1' } });
  publish.handshakeTimeoutMs = 40;
  try {
    const ref = await relay.binder.RPC.portOpen(Buffer.alloc(20, 1), `tls:${backend.address().port}`);
    assert.ok(relay.publisher.getConnection(ref));
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(Boolean(relay.publisher.getConnection(ref)), false, 'unfinished TLS must release the published ref');
    assert.equal(sockets.size, 0); assert.ok(relay.stats.closes > 0);
  } finally {
    publish.close(); relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => backend.close(resolve));
  }
});

test('completed TLS stays usable beyond its handshake deadline while idle', { timeout: 5000 }, async () => {
  const sockets = new Set();
  const backend = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const relay = makeRelay(0, 'tls');
  const publish = new PublishPort(relay.publisher, { [backend.address().port]: { host: '127.0.0.1' } });
  publish.handshakeTimeoutMs = 500;
  const bind = new BindPort(relay.binder, { 0: { protocol: 'tls', targetPort: backend.address().port, deviceIdHex: '31'.repeat(20), listenHost: '127.0.0.1' } });
  let client;
  try {
    const listening = once(bind, 'listening'); bind.bindSinglePort(0); const [address] = await listening;
    client = net.connect(address.localPort, '127.0.0.1'); client.on('error', () => {});
    let response = once(client, 'data'); client.write(Buffer.from('ready')); assert.equal((await response)[0].toString(), 'ready');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(client.destroyed, false); assert.equal(relay.publisher.connections.size, 1);
    response = once(client, 'data'); client.write(Buffer.from('after idle')); assert.equal((await response)[0].toString(), 'after idle');
  } finally {
    client?.destroy(); bind.dispose(); publish.close(); relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => backend.close(resolve));
  }
});

test('old-generation fragmented input cannot contaminate a replacement connection', async () => {
  const connection = parserConnection(), received = [];
  const old = frame(1, Buffer.from('old')), fresh = frame(2, Buffer.from('fresh'));
  connection.on('unsolicited', message => received.push(Buffer.from(message[1][2]).toString()));
  connection._handleData(old.subarray(0, 3), 1);
  connection._socketGeneration = 2; connection._lastDisconnectedGeneration = 1;
  connection.receiveBuffer = Buffer.alloc(0); connection._receiveFrameStorage = null;
  connection._handleData(old.subarray(3), 1); connection._handleData(fresh, 2);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(received, ['fresh']);
  assert.equal(connection.receiveBuffer.length, 0);
});

module.exports = { parserConnection, frame };
