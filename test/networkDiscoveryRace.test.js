const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const tls = require('node:tls');
const { KEYUTIL } = require('jsrsasign');
const { generateCert } = require('../utils');
const { fetchNetworkDirectory } = require('../networkDiscoveryClient');
const DiodeClientManager = require('../clientManager');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('manager shutdown cancels an in-flight directory request immediately', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-discovery-close-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const manager = new DiodeClientManager({ keyLocation: path.join(temp, 'key.json'), relaySelection: {
    scoreCachePath: null, networkDiscovery: { endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 2000 },
  } });
  t.after(async () => {
    manager.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const connected = once(server, 'connection');
  const outcome = manager._fetchNetworkDiscoveryNodes().then(() => 'resolved', error => error.message);
  const [socket] = await connected;
  const closed = once(socket, 'close').then(() => 'closed');
  manager.close();
  const deadline = new Promise(resolve => setTimeout(() => resolve('still open'), 100));
  assert.equal(await Promise.race([closed, deadline]), 'closed');
  assert.match(await outcome, /aborted/);
});

test('directory address racing retains hostname SNI and rejects an untrusted certificate', async t => {
  const keys = KEYUTIL.generateKeypair('EC', 'secp256r1');
  const pem = generateCert(keys.prvKeyObj, keys.pubKeyObj);
  const context = tls.createSecureContext({ key: pem, cert: pem });
  let servername;
  const server = tls.createServer({ key: pem, cert: pem,
    SNICallback: (name, callback) => { servername = name; callback(null, context); },
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(fetchNetworkDirectory({ endpoint: `wss://directory.test:${server.address().port}`, timeoutMs: 2000,
    lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  }), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(servername, 'directory.test');
});

test('discovery races directory responses across DNS addresses and closes the stalled loser', async t => {
  const slow = new WebSocketServer({ host: '127.0.0.2', port: 0 });
  await once(slow, 'listening');
  const fast = new WebSocketServer({ host: '127.0.0.1', port: slow.address().port });
  await once(fast, 'listening');
  t.after(async () => {
    for (const server of [slow, fast]) {
      for (const client of server.clients) client.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  });
  let slowOpened = false, slowClosed = false;
  slow.on('connection', socket => { slowOpened = true; socket.on('close', () => { slowClosed = true; }); });
  fast.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ id: 1, result: [{ connected: true }] }))));
  const result = await fetchNetworkDirectory({
    endpoint: `ws://directory.test:${slow.address().port}/ws`, timeoutMs: 1000,
    lookup: (_host, _options, callback) => callback(null, [
      { address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]),
  });
  assert.deepEqual(result, [{ connected: true }]);
  assert.equal(slowOpened, true);
  for (let i = 0; i < 20 && !slowClosed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(slowClosed, true);
});

test('a directory deadline includes DNS and ignores a resolver callback after expiry', async () => {
  let callback;
  const pending = fetchNetworkDirectory({ endpoint: 'ws://directory.test', timeoutMs: 15,
    lookup: (_host, _options, done) => { callback = done; } });
  await assert.rejects(pending, /timed out/);
  assert.equal(typeof callback, 'function');
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
});

test('directory cancellation works before and during DNS resolution', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    let callback;
    if (before) controller.abort();
    const pending = fetchNetworkDirectory({ endpoint: 'ws://directory.test', signal: controller.signal,
      lookup: (_host, _options, done) => { callback = done; } });
    if (!before) controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(typeof callback, before ? 'undefined' : 'function');
    callback?.(null, [{ address: '127.0.0.1', family: 4 }]);
    await new Promise(resolve => setImmediate(resolve));
  }
});

for (const reply of ['invalid JSON', JSON.stringify({ id: 1, error: { message: 'Unavailable' } }), JSON.stringify({ id: 1, result: {} })]) {
  test(`a failed directory response does not hide a valid alternate: ${reply}`, async t => {
    const bad = new WebSocketServer({ host: '127.0.0.2', port: 0 });
    await once(bad, 'listening');
    const good = new WebSocketServer({ host: '127.0.0.1', port: bad.address().port });
    await once(good, 'listening');
    t.after(async () => {
      for (const server of [bad, good]) {
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
      }
    });
    bad.on('connection', socket => socket.on('message', () => socket.send(reply)));
    good.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ id: 1, result: [] }))));
    assert.deepEqual(await fetchNetworkDirectory({ endpoint: `ws://directory.test:${bad.address().port}`, timeoutMs: 1000,
      lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }]),
    }), []);
  });
}

test('all failed directory responses report failure rather than an empty directory', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  server.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ id: 1, result: {} }))));
  await assert.rejects(fetchNetworkDirectory({ endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000 }), /non-array result/);
});
