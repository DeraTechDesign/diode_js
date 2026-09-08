'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const BindPort = require('../bindPort');

function fixture() {
  const connection = new EventEmitter();
  const clients = new Map();
  const closedPorts = [];
  connection.getDeviceCertificate = () => 'test certificate';
  connection.getClientSocket = (ref) => clients.get(ref.toString('hex'));
  connection.addClientSocket = (ref, socket) => clients.set(ref.toString('hex'), socket);
  connection.deleteClientSocket = (ref) => clients.delete(ref.toString('hex'));
  connection.RPC = { portSend: async () => {}, portClose2: async (port) => closedPorts.push(port) };
  const bind = new BindPort(connection, {});
  const context = bind._trackContext({}, 0, { connection, rpc: connection.RPC, physicalPort: 41000, sockets: new Set() });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.setNoDelay = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  return { connection, bind, context, socket, closedPorts };
}

test('late native handshake TLS errors retain a handler and release session ownership', async () => {
  const { connection, bind, context, socket, closedPorts } = fixture();
  const originalConnect = tls.connect;
  tls.connect = () => socket;
  const ref = Buffer.from('01', 'hex');
  try {
    const opening = bind._openTlsHandshakeChannel(connection, connection.RPC, ref, context);
    socket.emit('secureConnect');
    const { diodeSocket } = (await opening).socketWrapper;
    assert.equal(socket.listenerCount('error'), 1, 'permanent handler survives secureConnect cleanup');
    assert.doesNotThrow(() => socket.emit('error', new Error('late relay send failure')));
    assert.equal(context.closed, true);
    assert.equal(socket.destroyed, true);
    assert.equal(diodeSocket.destroyed, true);
    assert.equal(connection.getClientSocket(ref), undefined);
    assert.equal(connection._diodeActiveNativeSessions, 0);
    assert.deepEqual(closedPorts, [41000]);
  } finally {
    tls.connect = originalConnect;
    bind.dispose();
  }
});

test('native TLS setup errors still reject the handshake instead of being swallowed', async () => {
  const { connection, bind, context, socket } = fixture();
  const originalConnect = tls.connect;
  tls.connect = () => socket;
  try {
    const opening = bind._openTlsHandshakeChannel(connection, connection.RPC, Buffer.from('02', 'hex'), context);
    const rejected = assert.rejects(opening, /TLS negotiation failed/);
    socket.emit('error', new Error('TLS negotiation failed'));
    await rejected;
    assert.equal(context.closed, true);
    assert.equal(socket.destroyed, true);
  } finally {
    tls.connect = originalConnect;
    bind.dispose();
  }
});

test('a late handshake error cannot remove a replacement client ref', async () => {
  const { connection, bind, context, socket } = fixture();
  const originalConnect = tls.connect;
  tls.connect = () => socket;
  const ref = Buffer.from('03', 'hex');
  try {
    const opening = bind._openTlsHandshakeChannel(connection, connection.RPC, ref, context);
    socket.emit('secureConnect');
    await opening;
    const replacement = {};
    connection.addClientSocket(ref, replacement);
    socket.emit('error', new Error('old TLS channel failed'));
    assert.equal(connection.getClientSocket(ref), replacement);
    assert.equal(context.closed, true);
  } finally {
    tls.connect = originalConnect;
    bind.dispose();
  }
});
