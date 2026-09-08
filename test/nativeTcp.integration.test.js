'use strict';

process.env.LOG = 'false';
process.env.DEBUG = 'false';

const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { KEYUTIL } = require('jsrsasign');
const { privateToAddress } = require('ethereumjs-util');
const { generateCert } = require('../utils');
const BindPort = require('../bindPort');
const PublishPort = require('../publishPort');

function makeIdentity() {
  const keys = KEYUTIL.generateKeypair('EC', 'secp256k1');
  const privateKey = Buffer.from(keys.prvKeyObj.prvKeyHex.padStart(64, '0'), 'hex');
  return {
    privateKey,
    address: `0x${privateToAddress(privateKey).toString('hex')}`,
    certificate: generateCert(keys.prvKeyObj, keys.pubKeyObj),
  };
}

const binderIdentity = makeIdentity();
const publisherIdentity = makeIdentity();

function makeConnection(identity) {
  const connection = new EventEmitter();
  connection.socket = new EventEmitter();
  Object.assign(connection.socket, { destroyed: false, writable: true, paused: false });
  connection.socket.pause = () => { connection.socket.paused = true; };
  connection.socket.resume = () => { connection.socket.paused = false; connection.socket.emit('resume'); };
  connection.clientSockets = new Map();
  connection.connections = new Map();
  connection.getDeviceCertificate = () => identity.certificate;
  connection.getPrivateKey = () => identity.privateKey;
  connection.getEthereumAddress = () => identity.address;
  connection.getServerRelayHost = () => '127.0.0.1';
  connection.isReady = () => true;
  for (const [kind, map] of [['ClientSocket', connection.clientSockets], ['Connection', connection.connections]]) {
    connection[`add${kind}`] = (ref, value) => map.set(ref.toString('hex'), value);
    connection[`get${kind}`] = (ref) => map.get(ref.toString('hex'));
    connection[`delete${kind}`] = (ref) => map.delete(ref.toString('hex'));
    connection[`has${kind}`] = (ref) => map.has(ref.toString('hex'));
  }
  return connection;
}

// Simulate only the relay's RPC routing and portopen2 socket pairing. The
// library performs its actual TLS handshake, signed identity verification,
// session-key derivation, TCP encryption and stream shutdown on both sides.
async function makeRelay(targetPort) {
  const binder = makeConnection(binderIdentity);
  const publisher = makeConnection(publisherIdentity);
  const pending = new Map();
  const sockets = [];
  const jobs = new Set();
  const stats = { nativeOpens: 0, handshakeOpens: 0, apiBytes: 0, nativeBytes: 0, nativeCloses: 0 };
  let requestId = 0;
  let closed = false;
  const schedule = (callback) => {
    const job = setImmediate(() => { jobs.delete(job); if (!closed) callback(); });
    jobs.add(job);
  };
  const envelope = (message) => [Buffer.from([1]), message];
  const deliveries = new Map();
  for (const connection of [binder, publisher]) {
    const queue = [];
    deliveries.set(connection, queue);
    connection.socket.on('resume', () => {
      while (!connection.socket.paused && queue.length) queue.shift()();
    });
  }
  const deliver = (destination, callback) => {
    const queue = deliveries.get(destination);
    queue.push(callback);
    while (!destination.socket.paused && queue.length) queue.shift()();
  };
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setNoDelay(true);
    socket.pause();
    socket.on('error', () => {});
    sockets.push(socket);
    assert.ok(sockets.length <= 2, 'one native session has exactly two relay peers');
    socket.on('data', (chunk) => { stats.nativeBytes += chunk.length; });
    if (sockets.length === 2) {
      sockets[0].pipe(sockets[1]);
      sockets[1].pipe(sockets[0]);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const physicalPort = server.address().port;
  const open = (message) => {
    const sessionId = Buffer.alloc(4);
    sessionId.writeUInt32BE(++requestId);
    return new Promise((resolve, reject) => {
      pending.set(sessionId.toString('hex'), { resolve, reject });
      schedule(() => publisher.emit('unsolicited', [sessionId, message(sessionId)]));
    });
  };
  for (const [source, destination] of [[binder, publisher], [publisher, binder]]) {
    source.RPC = {
      async portSend(ref, data) {
        assert.ok(data.length <= 65000, 'TLS handshake must respect relay API frame limits');
        const frame = Buffer.from(data);
        stats.apiBytes += frame.length;
        return new Promise((resolve) => schedule(() => deliver(destination, () => {
          destination.emit('unsolicited', envelope(['portsend', ref, frame]));
          resolve();
        })));
      },
      async portClose(ref) {
        schedule(() => deliver(destination, () => destination.emit('unsolicited', envelope(['portclose', ref]))));
      },
      async portClose2(port) {
        assert.equal(Number(port), physicalPort);
        stats.nativeCloses += 1;
        schedule(() => {
          destination.emit('unsolicited', envelope(['portclose2', physicalPort]));
          for (const socket of sockets) socket.destroy();
        });
      },
      async sendResponse(sessionId, ref) {
        const operation = pending.get(sessionId.toString('hex'));
        if (operation) {
          pending.delete(sessionId.toString('hex'));
          operation.resolve(ref);
        }
      },
      async sendError(sessionId, _ref, reason) {
        const operation = pending.get(sessionId.toString('hex'));
        if (operation) {
          pending.delete(sessionId.toString('hex'));
          operation.reject(new Error(String(reason)));
        }
      },
    };
  }
  binder.RPC.portOpen2 = async (deviceId, portName, flags) => {
    assert.equal(deviceId.toString('hex'), publisherIdentity.address.slice(2));
    assert.equal(portName, `tcp:${targetPort}`);
    assert.equal(flags, 'rw');
    stats.nativeOpens += 1;
    return open(() => ['portopen2', portName, physicalPort, Buffer.from(binderIdentity.address.slice(2), 'hex'), flags]);
  };
  binder.RPC.portOpen = async (deviceId, portName, flags) => {
    assert.equal(deviceId.toString('hex'), publisherIdentity.address.slice(2));
    assert.equal(portName, `tls:${targetPort}#hs`, 'API transport is used only for the authenticated native handshake');
    assert.equal(flags, 'rw');
    stats.handshakeOpens += 1;
    return open((ref) => ['portopen', portName, ref, Buffer.from(binderIdentity.address.slice(2), 'hex')]);
  };
  return {
    binder, publisher, stats,
    async close() {
      closed = true;
      for (const job of jobs) clearImmediate(job);
      for (const operation of pending.values()) operation.reject(new Error('Local test relay closed'));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function binaryPayload(bytes, prefix) {
  const value = Buffer.alloc(bytes);
  for (let offset = 0; offset < bytes; offset += 1) value[offset] = offset % 251;
  Buffer.from(prefix, 'hex').copy(value);
  return value;
}

async function runNativeTunnel({ requestBytes = 4096, responseBytes = 4096, serverFirst = false, slowBackend = false, slowClient = false } = {}) {
  const request = binaryPayload(requestBytes, '030000130ee0000000000100080003000000');
  const response = Buffer.concat([binaryPayload(responseBytes, '1201003400000100'), Buffer.from('\x00FINAL-RESPONSE-TAIL\xff', 'latin1')]);
  const banner = serverFirst ? Buffer.from('SSH-2.0-loopback-native-test\r\n') : Buffer.alloc(0);
  const expectedResponse = Buffer.concat([banner, response]);
  const backendSockets = new Set();
  const timers = new Set();
  const backendChunks = [];
  const clientChunks = [];
  let backendBytes = 0;
  let clientBytes = 0;
  let backendEnded = false;
  let sentRequest = false;
  let relay;
  let publish;
  let bind;
  let client;
  let finish = () => {};
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const backend = net.createServer({ allowHalfOpen: true }, (socket) => {
    backendSockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => backendSockets.delete(socket));
    socket.on('data', (chunk) => {
      backendChunks.push(Buffer.from(chunk));
      backendBytes += chunk.length;
      if (slowBackend) {
        socket.pause();
        later(() => socket.resume(), 20);
      }
    });
    socket.on('end', () => {
      backendEnded = true;
      // A client FIN must not close the response direction. Waiting until EOF
      // also proves the entire upload drained before publisher shutdown.
      later(() => socket.end(response), 40);
    });
    if (serverFirst) socket.write(banner);
  });
  try {
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    relay = await makeRelay(backend.address().port);
    publish = new PublishPort(relay.publisher, { [backend.address().port]: { host: '127.0.0.1', mode: 'private', whitelist: [binderIdentity.address] } });
    bind = new BindPort(relay.binder, { 0: { targetPort: backend.address().port, deviceIdHex: publisherIdentity.address.slice(2), protocol: 'tcp', transport: 'native' } });
    const listening = once(bind, 'listening');
    bind.bindSinglePort(0);
    const [address] = await listening;
    client = net.connect({ host: '127.0.0.1', port: address.localPort, allowHalfOpen: true });
    client.setNoDelay(true);
    await new Promise((resolve, reject) => {
      let settled = false;
      const deadline = setTimeout(() => finish(new Error(`Native TCP timed out (${backendBytes}/${request.length} request bytes, ${clientBytes}/${expectedResponse.length} response bytes, backend EOF=${backendEnded})`)), 15000);
      finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      const sendRequest = () => {
        if (sentRequest) return;
        sentRequest = true;
        client.end(request);
      };
      client.on('connect', () => { if (!serverFirst) sendRequest(); });
      client.on('data', (chunk) => {
        clientChunks.push(Buffer.from(chunk));
        clientBytes += chunk.length;
        if (serverFirst && clientBytes >= banner.length) sendRequest();
        if (slowClient) {
          client.pause();
          later(() => client.resume(), 20);
        }
      });
      client.on('error', finish);
      client.on('close', () => finish(clientBytes === expectedResponse.length && backendEnded
        ? null
        : new Error(`Native TCP closed early (${backendBytes}/${request.length} request bytes, ${clientBytes}/${expectedResponse.length} response bytes, backend EOF=${backendEnded})`)));
    });
    assert.deepEqual(Buffer.concat(backendChunks), request, 'backend receives every binary request byte before EOF');
    assert.deepEqual(Buffer.concat(clientChunks), expectedResponse, 'client receives the banner and complete delayed response after half-close');
    assert.equal(relay.stats.nativeOpens, 1);
    assert.equal(relay.stats.handshakeOpens, 1);
    assert.ok(relay.stats.apiBytes > 0 && relay.stats.apiBytes < 16000, 'API traffic contains only the TLS/native handshake');
    assert.ok(relay.stats.nativeBytes > request.length + response.length, 'application bytes pass through the encrypted native relay');
    const cleanupDeadline = Date.now() + 1000;
    while (publish.nativeSessions.size > 0 || relay.binder._diodeActiveNativeSessions > 0) {
      assert.ok(Date.now() < cleanupDeadline, 'graceful native EOF releases both relay leases');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(relay.binder._diodeActiveNativeSessions, 0);
    assert.equal(relay.publisher._diodeActiveNativeSessions, 0);
    assert.equal(relay.binder.clientSockets.size, 0, 'binder handshake API ref is released');
    assert.equal(relay.publisher.connections.size, 0, 'publisher handshake API ref is released');
    return relay.stats;
  } finally {
    finish = () => {};
    for (const timer of timers) clearTimeout(timer);
    if (client) client.destroy();
    if (bind) bind.dispose();
    if (publish) publish.close();
    for (const socket of backendSockets) socket.destroy();
    await new Promise((resolve) => backend.close(resolve));
    if (relay) await relay.close();
  }
}

test('real native TCP carries client-first binary data and a delayed response after client half-close', { timeout: 20000 }, async () => {
  await runNativeTunnel();
});

test('real native TCP preserves a server-first banner sent before the authenticated handshake finishes', { timeout: 20000 }, async () => {
  await runNativeTunnel({ serverFirst: true });
});

test('real native TCP drains an 8 MiB upload to a slow backend before EOF and its delayed response', { timeout: 20000 }, async () => {
  await runNativeTunnel({ requestBytes: 8 * 1024 * 1024, responseBytes: 128, slowBackend: true });
});

test('real native TCP drains an 8 MiB final response to a slow client after request EOF', { timeout: 20000 }, async () => {
  await runNativeTunnel({ responseBytes: 8 * 1024 * 1024, slowClient: true });
});
