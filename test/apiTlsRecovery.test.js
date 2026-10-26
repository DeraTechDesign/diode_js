const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const BindPort = require('../bindPort');
const PublishPort = require('../publishPort');
const { makeRelay } = require('./apiTls.integration.test');

for (const failAfterHandshake of [false, true]) {
  test(failAfterHandshake ? 'application sends are never replayed on another relay' : 'private HTTP survives a relay that accepts portopen but fails TLS', { timeout: 10000 }, async t => {
    const sockets = new Set();
    let requests = 0, goodOpens = 0;
    const backend = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      socket.once('data', data => {
        requests++;
        assert.match(data.toString(), /^POST \/one-time-operation HTTP\/1.1/);
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
      });
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const bad = makeRelay(), good = makeRelay();
    bad.binder._managerHostKey = 'bad-relay'; good.binder._managerHostKey = 'good-relay';
    const originalOpen = good.binder.RPC.portOpen;
    good.binder.RPC.portOpen = (...args) => { goodOpens++; return originalOpen(...args); };
    const manager = Object.assign(new EventEmitter(), {
      getConnectionForDevice: async () => bad.binder,
      getNearestConnection: () => good.binder,
      getConnections: () => [bad.binder, good.binder], deviceRelayCache: new Map(),
    });
    for (const relay of [bad, good]) relay.binder.on('unsolicited', message => manager.emit('unsolicited', message, relay.binder));
    const publishes = [bad, good].map(relay => new PublishPort(relay.publisher, {
      [backend.address().port]: { host: '127.0.0.1', mode: 'private', whitelist: ['0x' + '31'.repeat(20)] },
    }));
    const bind = new BindPort(manager, { 0: { targetPort: backend.address().port, deviceIdHex: '31'.repeat(20), protocol: 'tls', transport: 'api', listenHost: '127.0.0.1' } });
    let client;
    t.after(async () => {
      client?.destroy(); bind.dispose(); publishes.forEach(p => p.close());
      for (const socket of sockets) socket.destroy();
      bad.close(); good.close(); await new Promise(resolve => backend.close(resolve));
    });
    if (!failAfterHandshake) bad.failNextSend('binder');
    const listening = once(bind, 'listening'); bind.bindSinglePort(0);
    const [address] = await listening;
    client = net.connect(address.localPort, '127.0.0.1'); client.on('error', () => {});
    const response = []; client.on('data', data => response.push(data));
    const closed = new Promise(resolve => client.once('close', resolve));
    await once(client, 'connect');
    if (failAfterHandshake) {
      const deadline = Date.now() + 3000;
      while (bind.getBindDiagnostics(0)?.phase !== 'tls-ready') {
        assert.ok(Date.now() < deadline, 'handshake should complete');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      bad.failNextSend('binder');
    }
    client.write('POST /one-time-operation HTTP/1.1\r\nHost: fixture\r\nContent-Length: 0\r\n\r\n');
    await closed;
    assert.equal(requests, failAfterHandshake ? 0 : 1);
    assert.equal(goodOpens, failAfterHandshake ? 0 : 1);
    if (!failAfterHandshake) assert.match(Buffer.concat(response).toString(), /^HTTP\/1.1 200 OK/);
    assert.equal(bad.binder.clientSockets.size, 0, 'failed relay references are released');
  });
}
