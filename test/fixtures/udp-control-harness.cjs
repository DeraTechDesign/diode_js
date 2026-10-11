'use strict';
const { EventEmitter, once } = require('node:events');
const dgram = require('node:dgram');
const { performance } = require('node:perf_hooks');
const BindPort = require('../../bindPort');
const nativeCrypto = require('../../nativeCrypto');

// Real UDP sockets and native authenticated encryption; only relay allocation
// and the handshake wait are simulated. Never represents a physical robot.
async function createHarness({ transport = 'api', policy, openingMs = 200, sendMs = 0 } = {}) {
  const packets = [], errors = [];
  let opens = 0;
  const backend = dgram.createSocket('udp4');
  backend.bind(0, '127.0.0.1'); await once(backend, 'listening');
  const tx = { txCounter: 0n, txKey: Buffer.alloc(32, 0x37), txSalt: Buffer.alloc(4, 0x21) };
  const rx = { rxUdpHighest: null, rxUdpSeen: 0n, rxKey: tx.txKey, rxSalt: tx.txSalt };
  const record = data => packets.push({ data: Buffer.from(data), receivedAt: performance.now() });
  backend.on('message', data => { const plaintext = nativeCrypto.parseUdpPacket(rx, data); if (plaintext) record(plaintext); });
  const connection = Object.assign(new EventEmitter(), {
    socket: { destroyed: false, writable: true }, clientSockets: new Map(),
    getServerRelayHost: () => '127.0.0.1',
    addClientSocket(ref, info) { this.clientSockets.set(ref.toString('hex'), info); },
    getClientSocket(ref) { return this.clientSockets.get(ref.toString('hex')); },
    deleteClientSocket(ref) { this.clientSockets.delete(ref.toString('hex')); },
  });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  connection.RPC = {
    portOpen: async () => { opens++; await pause(openingMs); return Buffer.from([1]); },
    portOpen2: async () => { opens++; return backend.address().port; },
    portClose: async () => {}, portClose2: async () => {},
    portSend: async (_ref, data) => { record(data); if (sendMs) await pause(sendMs); },
  };
  const bind = new BindPort(connection, { 0: {
    targetPort: backend.address().port, deviceIdHex: '11'.repeat(20), protocol: 'udp', transport,
    listenHost: '127.0.0.1', ...(policy ? { udpSendPolicy: policy } : {}),
  } });
  bind._performNativeHandshake = async () => { await pause(openingMs); return tx; };
  bind.on('bindError', error => errors.push(error.message));
  bind.bindSinglePort(0); const server = bind.servers.get(0); await once(server, 'listening');
  const client = dgram.createSocket('udp4');
  client.bind(0, '127.0.0.1'); await once(client, 'listening');
  return {
    bind, server, client, packets, errors, connection, get opens() { return opens; },
    send(data) { return new Promise((resolve, reject) => client.send(data, server.address().port, '127.0.0.1', error => error ? reject(error) : resolve())); },
    async close() { bind.dispose(); client.close(); await new Promise(resolve => backend.close(resolve)); },
  };
}
module.exports = { createHarness };
