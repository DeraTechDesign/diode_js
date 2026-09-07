'use strict';

process.env.LOG = 'false';
process.env.DEBUG = 'false';

const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { KEYUTIL } = require('jsrsasign');
const { generateCert } = require('../utils');
const BindPort = require('../bindPort');
const PublishPort = require('../publishPort');

// Only the relay RPC boundary is simulated. Both TCP endpoints and the TLS
// handshake/records inside BindPort and PublishPort use Node's real streams.
const keyPair = KEYUTIL.generateKeypair('EC', 'secp256k1');
const certificate = generateCert(keyPair.prvKeyObj, keyPair.pubKeyObj);
const deviceId = Buffer.alloc(20, 0x31);

function makeConnection() {
  const connection = new EventEmitter();
  connection.socket = new EventEmitter();
  Object.assign(connection.socket, { destroyed: false, writable: true, paused: false });
  connection.socket.pause = () => { connection.socket.paused = true; };
  connection.socket.resume = () => { connection.socket.paused = false; connection.socket.emit('resume'); };
  connection.clientSockets = new Map();
  connection.connections = new Map();
  connection.getDeviceCertificate = () => certificate;
  connection.isReady = () => true;
  for (const [kind, map] of [['ClientSocket', connection.clientSockets], ['Connection', connection.connections]]) {
    connection[`add${kind}`] = (ref, value) => map.set(ref.toString('hex'), value);
    connection[`get${kind}`] = (ref) => map.get(ref.toString('hex'));
    connection[`delete${kind}`] = (ref) => map.delete(ref.toString('hex'));
    connection[`has${kind}`] = (ref) => map.has(ref.toString('hex'));
  }
  return connection;
}

function makeRelay(ackRttMs = 0, protocol = 'tls') {
  const binder = makeConnection();
  const publisher = makeConnection();
  const pendingOpens = new Map();
  const timers = new Set();
  const stats = { frames: 0, inFlightFrames: 0, maxInFlightFrames: 0, maxFrameBytes: 0, closes: 0, readPauses: 0, maxDeliveryQueueFrames: 0 };
  let requestId = 0;
  let failureSource = null;
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const envelope = (content) => [Buffer.from([1]), content];
  const deliveryQueues = new Map();
  for (const destination of [binder, publisher]) {
    const queue = [];
    deliveryQueues.set(destination, queue);
    const drain = () => {
      while (!destination.socket.paused && queue.length > 0) queue.shift()();
    };
    destination.socket.pause = () => { destination.socket.paused = true; stats.readPauses += 1; };
    destination.socket.on('resume', drain);
  }
  const deliver = (destination, callback) => {
    const queue = deliveryQueues.get(destination);
    queue.push(callback);
    stats.maxDeliveryQueueFrames = Math.max(stats.maxDeliveryQueueFrames, queue.length);
    while (!destination.socket.paused && queue.length > 0) queue.shift()();
  };
  for (const [source, destination] of [[binder, publisher], [publisher, binder]]) {
    source.RPC = {
      async portSend(ref, data) {
        // Match DiodeRPC's ordered splitting for the old write-per-ACK baseline.
        if (data.length > 65000) {
          for (let offset = 0; offset < data.length; offset += 65000) {
            await source.RPC.portSend(ref, data.subarray(offset, offset + 65000));
          }
          return;
        }
        const frame = Buffer.from(data);
        stats.frames += 1;
        stats.maxFrameBytes = Math.max(stats.maxFrameBytes, frame.length);
        stats.inFlightFrames += 1;
        stats.maxInFlightFrames = Math.max(stats.maxInFlightFrames, stats.inFlightFrames);
        const fail = source === failureSource;
        if (fail) failureSource = null;
        return new Promise((resolve, reject) => {
          // Keep outstanding delivery bounded by the sender window. When the
          // receiver pauses its relay socket, pressure delays further ACKs too.
          schedule(() => deliver(destination, () => {
            if (!fail) destination.emit('unsolicited', envelope(['portsend', ref, frame]));
            schedule(() => {
              stats.inFlightFrames -= 1;
              if (fail) reject(new Error('Simulated relay send failure'));
              else resolve();
            }, ackRttMs / 2);
          }), ackRttMs / 2);
        });
      },
      async portClose(ref) {
        stats.closes += 1;
        schedule(() => deliver(destination, () => destination.emit('unsolicited', envelope(['portclose', ref]))), ackRttMs / 2);
      },
      async sendResponse(sessionId, ref) {
        const pending = pendingOpens.get(sessionId.toString('hex'));
        if (pending) {
          pendingOpens.delete(sessionId.toString('hex'));
          pending.resolve(ref);
        }
      },
      async sendError(sessionId, _ref, reason) {
        const pending = pendingOpens.get(sessionId.toString('hex'));
        if (pending) {
          pendingOpens.delete(sessionId.toString('hex'));
          pending.reject(new Error(reason));
        }
      },
    };
  }
  binder.RPC.portOpen = async (_deviceId, port) => {
    assert.ok(port.startsWith(`${protocol}:`), `integration traffic must use API/${protocol}`);
    const sessionId = Buffer.alloc(4);
    sessionId.writeUInt32BE(++requestId);
    const ref = Buffer.from(sessionId);
    return new Promise((resolve, reject) => {
      pendingOpens.set(sessionId.toString('hex'), { resolve, reject });
      publisher.emit('unsolicited', [sessionId, ['portopen', port, ref, deviceId]]);
    });
  };
  binder.RPC.portOpen2 = async () => assert.fail('integration traffic must never use portopen2');
  return {
    binder, publisher, stats,
    failNextSend(side) { failureSource = side === 'publisher' ? publisher : binder; },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const pending of pendingOpens.values()) pending.reject(new Error('Test relay closed'));
      pendingOpens.clear();
      for (const queue of deliveryQueues.values()) queue.length = 0;
    },
  };
}

async function runTunnel({ bytes = 1024 * 1024, ackRttMs = 0, backendEnds = false, failSend = false, slowReader = false, protocol = 'tls', clientEnds = false, slowBackend = false, readDelayMs = 10 } = {}) {
  // TPKT/X.224-like prefix is a binary client-first request, not an HTTP probe.
  const request = Buffer.alloc(bytes);
  for (let index = 0; index < request.length; index += 1) request[index] = index % 251;
  Buffer.from('030000130ee0000000000100080003000000', 'hex').copy(request);
  const response = backendEnds ? Buffer.concat([request, Buffer.from('\x00FINAL-RESPONSE-TAIL\xff', 'latin1')]) : request;
  const backendSockets = new Set();
  const receivedByBackend = [];
  let backendBytes = 0;
  let relay;
  let publish;
  let bind;
  let client;
  let resumeTimer;
  const backendResumeTimers = new Set();
  let backendEnded = false;
  let finishBackendRead = () => {};
  const backend = net.createServer((socket) => {
    backendSockets.add(socket);
    socket.on('close', () => {
      backendSockets.delete(socket);
      if (clientEnds && !backendEnded) finishBackendRead(new Error(`Backend closed before EOF (${backendBytes}/${request.length} request bytes)`));
    });
    socket.on('error', (error) => { if (clientEnds) finishBackendRead(error); });
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      receivedByBackend.push(Buffer.from(chunk));
      backendBytes += chunk.length;
      if (slowBackend) {
        socket.pause();
        const timer = setTimeout(() => { backendResumeTimers.delete(timer); socket.resume(); }, readDelayMs);
        backendResumeTimers.add(timer);
      }
      if (backendEnds && backendBytes === request.length) socket.end(response);
    });
    socket.on('end', () => {
      backendEnded = true;
      if (clientEnds) finishBackendRead(backendBytes === request.length ? null : new Error(`Backend reached EOF early (${backendBytes}/${request.length} request bytes)`));
    });
    if (!backendEnds && !clientEnds) socket.pipe(socket);
  });
  try {
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    relay = makeRelay(ackRttMs, protocol);
    publish = new PublishPort(relay.publisher, { [backend.address().port]: { host: '127.0.0.1' } });
    bind = new BindPort(relay.binder, { 0: { targetPort: backend.address().port, deviceIdHex: deviceId.toString('hex'), protocol, transport: 'api' } });
    const listening = once(bind, 'listening');
    bind.bindSinglePort(0);
    const [address] = await listening;
    client = net.connect({ host: '127.0.0.1', port: address.localPort });
    client.setNoDelay(true);
    const chunks = [];
    let receivedBytes = 0;
    let backendFinishedAt = null;
    const startedAt = performance.now();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`API/${protocol} test timed out (${backendBytes}/${request.length} request bytes; ${receivedBytes}/${response.length} response bytes)`)), 15000);
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ elapsedMs: performance.now() - startedAt, receivedBytes });
      };
      finishBackendRead = finish;
      client.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
        receivedBytes += chunk.length;
        if (slowReader) {
          client.pause();
          resumeTimer = setTimeout(() => client.resume(), readDelayMs);
        }
        if (receivedBytes >= response.length && !backendEnds) finish();
      });
      client.on('error', (error) => { if (!failSend) finish(error); });
      client.on('close', () => {
        backendFinishedAt = performance.now();
        if (clientEnds) return; // The remote backend must drain the upload to EOF.
        else if (failSend) finish();
        else if (receivedBytes === response.length) finish();
        else finish(new Error(`API/${protocol} closed early (${receivedBytes}/${response.length} response bytes)`));
      });
      client.on('connect', () => {
        void (async () => {
          if (failSend) {
            // Establish the encrypted session first; fail an application-data send.
            const deadline = Date.now() + 5000;
            while (!Array.from(relay.binder.clientSockets.values()).some((entry) => protocol === 'tcp' || (entry.tlsSocket && entry.tlsSocket._secureEstablished))) {
              if (client.destroyed || Date.now() >= deadline) throw new Error('Test API session did not become ready');
              await new Promise((resolveWait) => setTimeout(resolveWait, 5));
            }
            relay.failNextSend(failSend);
          }
          if (clientEnds) client.end(request);
          else client.write(request);
        })().catch(finish);
      });
    });
    if (!failSend) {
      assert.deepEqual(Buffer.concat(receivedByBackend), request, 'backend must receive all binary bytes in order');
      if (clientEnds) assert.ok(backendEnded, 'client EOF must reach backend after the full upload drains');
      else assert.deepEqual(Buffer.concat(chunks), response, 'client must receive the entire response including its final tail');
      assert.ok(relay.stats.maxFrameBytes <= 65000, 'relay payloads must remain within the API frame limit');
      if (backendEnds) assert.ok(backendFinishedAt !== null, 'backend EOF must reach the local client');
    } else {
      assert.ok(relay.stats.closes > 0, 'async send failure must clean up its remote ref');
    }
    return { ...result, ...relay.stats };
  } finally {
    finishBackendRead = () => {};
    for (const timer of backendResumeTimers) clearTimeout(timer);
    if (resumeTimer) clearTimeout(resumeTimer);
    if (client) client.destroy();
    if (bind) bind.dispose();
    if (publish) publish.close();
    for (const socket of backendSockets) socket.destroy();
    await new Promise((resolve) => backend.close(resolve));
    if (relay) relay.close();
  }
}

if (require.main === module) {
  const test = require('node:test');
  for (const protocol of ['tls', 'tcp']) {
    const label = `real API/${protocol.toUpperCase()}`;
    test(`${label} tunnel echoes 1 MiB of client-first binary data`, { timeout: 20000 }, async () => {
      const result = await runTunnel({ ackRttMs: 10, protocol });
      assert.ok(result.maxInFlightFrames > 2, 'bulk data should use the bounded send pipeline');
    });
    test(`${label} tunnel preserves 1 MiB final response when backend ends`, { timeout: 20000 }, async () => {
      await runTunnel({ ackRttMs: 10, backendEnds: true, slowReader: true, protocol });
    });
    test(`${label} tunnel drains 1 MiB request to a slow backend before client EOF`, { timeout: 20000 }, async () => {
      await runTunnel({ ackRttMs: 10, clientEnds: true, slowBackend: true, protocol });
    });
    test(`${label} async relay send failure closes the session safely`, { timeout: 20000 }, async () => {
      await runTunnel({ bytes: 4096, ackRttMs: 10, failSend: true, protocol });
    });
    test(`${label} publisher send failure closes the session safely`, { timeout: 20000 }, async () => {
      await runTunnel({ bytes: 4096, ackRttMs: 10, failSend: 'publisher', protocol });
    });
    for (const direction of ['download', 'upload']) {
      test(`${label} preserves 8 MiB with sustained slow ${direction} consumption`, { timeout: 20000 }, async () => {
        const result = await runTunnel({
          bytes: 8 * 1024 * 1024, ackRttMs: 10, protocol, readDelayMs: 20,
          backendEnds: direction === 'download', slowReader: direction === 'download',
          clientEnds: direction === 'upload', slowBackend: direction === 'upload',
        });
        assert.ok(result.readPauses > 0, 'slow readers must apply relay backpressure before exhausting the receive bound');
        assert.ok(result.maxDeliveryQueueFrames <= 16, 'paused relay delivery remains bounded by the send window');
      });
    }
  }
}

module.exports = { runTunnel };
