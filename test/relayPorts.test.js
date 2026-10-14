'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connectRelayPorts } = require('../relayPorts');
const DiodeConnection = require('../connection');
const DiodeClientManager = require('../clientManager');

function sockets(t) {
  const attempts = [];
  t.mock.method(tls, 'connect', (port, host, options, secure) => {
    const socket = new EventEmitter();
    Object.assign(socket, { destroyed: false, writable: true, remotePort: port });
    socket.destroy = () => { socket.destroyed = true; socket.writable = false; };
    socket.setKeepAlive = socket.setNoDelay = () => {};
    attempts.push({ port, host, options, socket, secure });
    return socket;
  });
  return attempts;
}

function dial(t, options = {}) {
  const attempts = sockets(t);
  let resolve;
  let reject;
  const ready = new Promise((res, rej) => { resolve = res; reject = rej; });
  const cancel = connectRelayPorts({
    host: 'relay.example', port: 41046, tlsOptions: {}, fallbackDelayMs: 5,
    onSecure: (socket) => resolve(socket), onError: reject, ...options,
  });
  t.after(cancel);
  return { attempts, ready, cancel };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a black-holed default port falls back to TLS on 443 and closes the loser', async (t) => {
  const options = { minVersion: 'TLSv1.2', ecdhCurve: 'secp256k1', cert: 'same wallet' };
  const { attempts, ready } = dial(t, { tlsOptions: options });
  await delay(8);
  assert.deepEqual(attempts.map((a) => a.port), [41046, 443]);
  attempts[1].secure();
  assert.equal(await ready, attempts[1].socket);
  assert.equal(attempts[0].socket.destroyed, true);
  assert.equal(attempts[1].socket.destroyed, false);
  assert.equal(attempts[1].options, options);
  attempts[0].secure();
  assert.doesNotThrow(() => attempts[0].socket.emit('error', new Error('late cancellation')));
  await delay(15);
  assert.equal(attempts.length, 2);
});

test('a fast primary TLS handshake opens no alternate ports', async (t) => {
  const { attempts, ready } = dial(t);
  attempts[0].secure();
  assert.equal(await ready, attempts[0].socket);
  await delay(15);
  assert.equal(attempts.length, 1);
});

test('a reachable TCP listener with failed TLS does not prevent fallback to 993', async (t) => {
  const { attempts, ready } = dial(t);
  attempts[0].socket.emit('error', new Error('connection refused'));
  assert.equal(attempts[1].port, 443);
  attempts[1].socket.emit('error', new Error('incompatible HTTPS certificate'));
  assert.equal(attempts[2].port, 993);
  attempts[2].secure();
  assert.equal(await ready, attempts[2].socket);
  assert.ok(attempts.slice(0, 2).every((a) => a.socket.destroyed));
});

test('all refused ports fail once, without leaked sockets or delayed attempts', async (t) => {
  const { attempts, ready } = dial(t);
  const error = new Error('connection refused');
  const rejected = assert.rejects(ready, (e) => e === error);
  for (let i = 0; i < 5; i++) attempts[i].socket.emit('error', error);
  await rejected;
  assert.deepEqual(attempts.map((a) => a.port), [41046, 443, 993, 1723, 10000]);
  assert.ok(attempts.every((a) => a.socket.destroyed));
  await delay(15);
  assert.equal(attempts.length, 5);
});

test('synchronous TLS failures exhaust the bounded port list', (t) => {
  const error = new Error('TLS initialization failed');
  const attempts = [];
  t.mock.method(tls, 'connect', (port) => { attempts.push(port); throw error; });
  let failures = 0;
  const cancel = connectRelayPorts({ host: 'relay.example', port: 41046, tlsOptions: {},
    onSecure: () => assert.fail('cannot connect'),
    onError: (e) => { assert.equal(e, error); failures++; },
  });
  cancel();
  assert.equal(failures, 1);
  assert.deepEqual(attempts, [41046, 443, 993, 1723, 10000]);
});

test('cancellation destroys every pending socket and ignores late TLS completion', async (t) => {
  let completed = false;
  const { attempts, cancel } = dial(t, { onSecure: () => { completed = true; } });
  await delay(8);
  assert.equal(attempts.length, 2);
  cancel();
  attempts.forEach((a) => a.secure());
  await delay(15);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.socket.destroyed));
  assert.equal(completed, false);
});

for (const [name, options, port] of [
  ['custom port', { port: 18443 }, 18443],
  ['explicit 443', { port: 443 }, 443],
  ['disabled fallback', { fallback: false }, 41046],
]) {
  test(`${name} stays pinned when TLS fails`, async (t) => {
    const { attempts, ready } = dial(t, options);
    const rejected = assert.rejects(ready, /refused/);
    attempts[0].socket.emit('error', new Error('refused'));
    await rejected;
    await delay(10);
    assert.deepEqual(attempts.map((a) => a.port), [port]);
  });
}

test('the previous working port is tried first but can fall back after a network change', async (t) => {
  const { attempts, ready } = dial(t, { preferredPort: 443 });
  assert.equal(attempts[0].port, 443);
  attempts[0].socket.emit('close');
  assert.equal(attempts[1].port, 41046);
  attempts[1].secure();
  assert.equal(await ready, attempts[1].socket);
});

function connectionFixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-relay-ports-'));
  const connection = new DiodeConnection('relay.example', 41046, path.join(dir, 'keys.json'), options);
  connection.autoReconnect = false;
  t.after(() => { connection.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(connection, '_waitForServerEthereumAddress', async () => Buffer.alloc(20, 1));
  t.mock.method(connection, '_refreshTicketUsage', async () => 0);
  t.mock.method(connection, 'createTicketCommand', async () => ['ticketv2']);
  t.mock.method(connection, '_sendCommandTransportReady', async () => ['thanks!']);
  return connection;
}

test('fallback still waits for ticket acceptance and reconnects on the working port', async (t) => {
  const attempts = sockets(t);
  const connection = connectionFixture(t);
  let acceptTicket;
  t.mock.method(connection, '_sendCommandTransportReady', () => new Promise((resolve) => { acceptTicket = resolve; }));
  const identity = connection.getEthereumAddress();
  const connecting = connection.connect();
  assert.equal(connection.connect(), connecting, 'dialing remains single flight');
  attempts[0].socket.emit('error', new Error('blocked'));
  const handshake = attempts[1].secure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.isReady(), false);
  acceptTicket(['thanks!']);
  await Promise.all([connecting, handshake]);
  assert.equal(connection.isReady(), true);
  assert.equal(connection.socket.remotePort, 443);
  assert.equal(connection.port, 41046, 'configured endpoint stays stable for manager caches');
  assert.equal(connection.getEthereumAddress(), identity);
  attempts[0].socket.emit('close');
  assert.equal(connection.isReady(), true, 'losing socket cannot disconnect the winner');
  connection._handleDisconnect(connection.socket, connection._socketGeneration);
  const reconnecting = connection.connect();
  assert.equal(attempts[2].port, 443);
  const rejected = assert.rejects(reconnecting, { code: 'DIODE_DISCONNECTED' });
  connection.close();
  await rejected;
});

test('ticket rejection is surfaced without trying other ports to bypass it', async (t) => {
  const attempts = sockets(t);
  const connection = connectionFixture(t);
  t.mock.method(connection, '_sendCommandTransportReady', async () => ['denied']);
  const rejected = assert.rejects(connection.connect(), { code: 'DIODE_TICKET_REJECTED' });
  await attempts[0].secure();
  await rejected;
  assert.equal(connection.isReady(), false);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].socket.destroyed, true);
});

test('closing during fallback cancels every candidate and its timers', async (t) => {
  const attempts = sockets(t);
  const connection = connectionFixture(t);
  const rejected = assert.rejects(connection.connect(), { code: 'DIODE_DISCONNECTED' });
  await delay(275);
  assert.equal(attempts.length, 2);
  connection.close();
  await rejected;
  assert.ok(attempts.every((a) => a.socket.destroyed));
  attempts.forEach((a) => a.secure());
  await delay(275);
  assert.equal(attempts.length, 2);
  assert.equal(connection.socket, null);
  assert.equal(connection.isReady(), false);
});

test('the overall readiness timeout bounds all fallback ports', async (t) => {
  const attempts = sockets(t);
  const connection = connectionFixture(t);
  connection.connectTimeoutMs = 275;
  await assert.rejects(connection.connect(), { code: 'DIODE_CONNECT_TIMEOUT' });
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.socket.destroyed));
  assert.equal(connection.socket, null);
});

test('manager applies the fallback opt-out to target and startup connections', async (t) => {
  const attempts = sockets(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-manager-ports-'));
  const manager = new DiodeClientManager({ host: 'relay.example', relayPortFallback: false,
    keyLocation: path.join(dir, 'keys.json'), relaySelection: { scoreCachePath: null } });
  t.after(() => { manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const rejected = assert.rejects(manager._ensureConnection('relay.example:41046'), /blocked/);
  attempts[0].socket.emit('error', new Error('blocked'));
  await rejected;
  assert.equal(attempts.length, 1);
  assert.equal(manager.connections.length, 0);
});
