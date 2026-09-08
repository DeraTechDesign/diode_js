const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const { PassThrough } = require('node:stream');

const PublishPort = require('../publishPort');
const nativeCrypto = require('../nativeCrypto');
const DiodeSocket = require('../diodeSocket');

class FakeStreamSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.writes = [];
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.pipeCalls = [];
  }

  setNoDelay() {}
  pause() {
    this.pauseCalls += 1;
  }
  resume() {
    this.resumeCalls += 1;
  }
  write(data) {
    this.writes.push(data);
  }
  end() {}
  destroy() {
    this.destroyed = true;
  }
  pipe(destination) {
    this.pipeCalls.push(destination);
    return destination;
  }
}

class FakeDatagramSocket extends EventEmitter {
  constructor() {
    super();
    this.connectCalls = [];
    this.sendCalls = [];
    this.closed = false;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
  }

  connect(port, host, callback) {
    this.connectCalls.push({ port, host });
    if (typeof callback === 'function') {
      callback();
    }
  }

  send(...args) {
    if (args.length >= 3 && typeof args[1] === 'number' && typeof args[2] === 'string') {
      this.sendCalls.push({ data: args[0], port: args[1], address: args[2] });
    } else {
      this.sendCalls.push({ data: args[0] });
    }
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) {
      callback(null);
    }
  }

  close() {
    this.closed = true;
  }

  setRecvBufferSize() {}
  setSendBufferSize() {}
}

class FakeTlsSocket extends EventEmitter {
  setNoDelay() {}
  pipe(destination) {
    return destination;
  }
}

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.sentResponses = [];
    this.sentErrors = [];
    this.portCloseCalls = [];
    this.portSendCalls = [];
    this.RPC = {
      sendResponse: async (...args) => {
        this.sentResponses.push(args);
      },
      sendError: async (...args) => {
        this.sentErrors.push(args);
      },
      portClose: async (...args) => {
        this.portCloseCalls.push(args);
      },
      portSend: async (...args) => {
        this.portSendCalls.push(args);
      },
    };
  }

  addConnection(ref, connectionInfo) {
    this.connections.set(ref.toString('hex'), connectionInfo);
  }

  getConnection(ref) {
    return this.connections.get(ref.toString('hex'));
  }

  deleteConnection(ref) {
    return this.connections.delete(ref.toString('hex'));
  }

  getClientSocket() {
    return null;
  }

  getServerRelayHost() {
    return 'relay.example';
  }

  getDeviceCertificate() {
    return 'fake-cert';
  }

  getEthereumAddress() {
    return '0x' + 'aa'.repeat(20);
  }

  getPrivateKey() {
    return Buffer.alloc(32, 1);
  }
}

function makeRef(value = '01') {
  return Buffer.from(value.padStart(2, '0'), 'hex');
}

function makeSessionId(value = '02') {
  return Buffer.from(value.padStart(2, '0'), 'hex');
}

function makeDeviceId(hexByte) {
  const byte = hexByte.length === 1 ? hexByte.repeat(2) : hexByte;
  return Buffer.from(byte.repeat(20), 'hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function malformedUnsolicitedFrames(sessionId, ref) {
  return [
    [sessionId, null],
    [sessionId, 7],
    [sessionId, []],
    [sessionId, ['portopen']],
    [sessionId, ['portopen', '8080', ref]],
    [sessionId, ['portopen', '8080', 7, Buffer.alloc(20)]],
    [sessionId, ['portsend']],
    [sessionId, ['portsend', ref]],
    [sessionId, ['portsend', ref, 7]],
    [sessionId, ['portclose']],
    [sessionId, ['portclose', 7]],
  ];
}

test('PublishPort array input defaults host to 127.0.0.1', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8080]);

  assert.deepEqual(publishPort.getPublishedPorts(), {
    8080: { mode: 'public', whitelist: [], host: '127.0.0.1' },
  });

  publishPort.stopListening();
});

test('PublishPort preserves explicit host in object config', () => {
  const connection = new FakeConnection();
  const address = `0x${'ab'.repeat(20)}`;
  const publishPort = new PublishPort(connection, {
    8080: { mode: 'private', whitelist: [address], host: ' backend.internal ' },
  });

  assert.deepEqual(publishPort.getPublishedPorts(), {
    8080: { mode: 'private', whitelist: [address], host: 'backend.internal' },
  });

  publishPort.stopListening();
});

test('PublishPort rejects invalid host values', () => {
  const connection = new FakeConnection();

  assert.throws(() => {
    new PublishPort(connection, { 8080: { mode: 'public', host: '   ' } });
  }, TypeError);

  assert.throws(() => {
    new PublishPort(connection, { 8080: { mode: 'public', host: 42 } });
  }, TypeError);
});

test('PublishPort normalizes private mode and case-insensitive EVM whitelist addresses', () => {
  const connection = new FakeConnection();
  const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7';
  const normalized = checksummed.toLowerCase();
  const publishPort = new PublishPort(connection, {
    3001: { mode: ' Private ', whitelist: [checksummed] },
  });
  const originalConnect = net.connect;
  let connectCalled = false;
  net.connect = () => {
    connectCalled = true;
    return new FakeStreamSocket();
  };

  try {
    assert.deepEqual(publishPort.getPublishedPorts()[3001], {
      mode: 'private',
      whitelist: [normalized],
      host: '127.0.0.1',
    });
    publishPort.handlePortOpen(
      makeSessionId('20'),
      ['portopen', '3001', makeRef('20'), Buffer.from(normalized.slice(2), 'hex')],
      connection
    );
    assert.equal(connectCalled, true);
    assert.equal(connection.sentErrors.length, 0);
  } finally {
    net.connect = originalConnect;
    publishPort.close();
  }
});

test('public ports ignore legacy whitelist data that has no authorization semantics', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8080: { mode: 'public', whitelist: ['legacy-short-address'] },
    8081: { mode: 'public', whitelist: 'legacy-non-array' },
  });

  assert.deepEqual(publishPort.getPublishedPorts(), {
    8080: { mode: 'public', whitelist: [], host: '127.0.0.1' },
    8081: { mode: 'public', whitelist: [], host: '127.0.0.1' },
  });
  publishPort.close();
});

test('PublishPort rejects malformed modes, ports, and whitelist addresses', () => {
  assert.throws(
    () => new PublishPort(new FakeConnection(), { 8080: { mode: 'privte' } }),
    /mode must be public or private/
  );

  for (const port of [0, 65536, 1.5, NaN, '', '8080junk', '1.5']) {
    assert.throws(
      () => new PublishPort(new FakeConnection(), [port]),
      /whole integer/
    );
  }

  for (const address of [
    '52908400098527886E0F7030069857D2E4169EE7',
    '0x1234',
    `0x${'gg'.repeat(20)}`,
    42,
  ]) {
    assert.throws(
      () => new PublishPort(new FakeConnection(), {
        8080: { mode: 'private', whitelist: [address] },
      }),
      /20-byte 0x EVM addresses/
    );
  }

  assert.throws(
    () => new PublishPort(new FakeConnection(), {
      8080: { mode: 'private', whitelist: 'not-an-array' },
    }),
    /whitelist must be an array/
  );
});

test('publisher unsolicited dispatcher contains malformed direct and manager relay frames', async (t) => {
  for (const kind of ['direct', 'manager']) {
    await t.test(kind, () => {
      const relay = new FakeConnection();
      const root = kind === 'direct' ? relay : new EventEmitter();
      if (kind === 'manager') root.getConnections = () => [relay];
      const publishPort = new PublishPort(root, [8080]);
      const frames = malformedUnsolicitedFrames(makeSessionId('21'), makeRef('21'));
      let applicationListenerCalls = 0;
      root.on('unsolicited', () => {
        applicationListenerCalls += 1;
      });

      try {
        for (const frame of frames) {
          assert.doesNotThrow(() => {
            if (kind === 'direct') root.emit('unsolicited', frame);
            else root.emit('unsolicited', frame, relay);
          });
        }
        assert.equal(applicationListenerCalls, frames.length);
        assert.equal(relay.connections.size, 0);
        assert.equal(publishPort._trackedConnectionInfos.size, 0);
        assert.equal(publishPort.nativeSessions.size, 0);
        assert.equal(relay.sentResponses.length, 0);
        assert.equal(relay.sentErrors.length, 0);
      } finally {
        publishPort.close();
      }
    });
  }
});

test('PublishPort clamps externally configured timers to safe Node.js bounds', () => {
  const names = [
    'DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS',
    'DIODE_BACKEND_CONNECT_TIMEOUT_MS',
    'DIODE_PORT_IO_TIMEOUT_MS',
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  process.env.DIODE_NATIVE_HANDSHAKE_TIMEOUT_MS = '999999999999';
  process.env.DIODE_BACKEND_CONNECT_TIMEOUT_MS = '-1';
  process.env.DIODE_PORT_IO_TIMEOUT_MS = 'Infinity';

  let publishPort;
  try {
    publishPort = new PublishPort(new FakeConnection(), []);
    assert.equal(publishPort.handshakeTimeoutMs, 0x7fffffff);
    assert.equal(publishPort.backendConnectTimeoutMs, 5000);
    assert.equal(publishPort.ioTimeoutMs, 10000);
  } finally {
    publishPort?.close();
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('TCP publish connects to configured host', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8080: { mode: 'public', host: '192.168.1.10' },
  });
  const originalConnect = net.connect;
  const connectCalls = [];

  net.connect = (options, callback) => {
    const socket = new FakeStreamSocket();
    connectCalls.push(options);
    process.nextTick(() => {
      if (typeof callback === 'function') {
        callback();
      }
    });
    return socket;
  };

  try {
    publishPort.handleTCPConnection(makeSessionId(), makeRef(), 8080, '0x' + '11'.repeat(20), publishPort.getPublishedPorts()[8080], connection);
  } finally {
    net.connect = originalConnect;
    publishPort.stopListening();
  }

  assert.equal(connectCalls.length, 1);
  assert.deepEqual(connectCalls[0], { port: 8080, host: '192.168.1.10', autoSelectFamily: false });
});

for (const payloadBytes of [128 * 1024, 1024 * 1024]) {
test(`TCP publish pipelines a bounded window and flushes ${payloadBytes} final backend bytes before closing`, async (t) => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8080]);
  const localSocket = new PassThrough();
  const send = deferred();
  connection.RPC.portSend = async (...args) => {
    connection.portSendCalls.push(args);
    return send.promise;
  };

  const ref = makeRef('04');
  const info = { socket: localSocket, protocol: 'tcp' };
  connection.addConnection(ref, info);
  publishPort.setupLocalSocketHandlers(localSocket, ref, 'tcp', connection.RPC, connection);
  t.after(() => {
    send.resolve();
    info.sendSocket.destroy();
    localSocket.destroy();
    publishPort.stopListening();
  });
  const payload = Buffer.alloc(payloadBytes);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  localSocket.end(payload);

  await waitFor(() => connection.portSendCalls.length > 1);
  if (payloadBytes > 256 * 1024) assert.equal(localSocket.isPaused(), true);
  else await waitFor(() => localSocket.readableEnded);
  assert.ok(connection.portSendCalls.length <= 16);
  assert.ok(info.sendSocket._sendingBytes <= 256 * 1024);
  assert.equal(connection.portCloseCalls.length, 0);

  send.resolve();
  await waitFor(() => connection.portCloseCalls.length === 1);
  assert.deepEqual(Buffer.concat(connection.portSendCalls.map(([, frame]) => frame)), payload);
  assert.equal(connection.getConnection(ref), undefined);
});
}

test('TLS publish backend socket connects to configured host', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8443: { mode: 'public', host: 'backend.internal' },
  });
  const originalConnect = net.connect;
  const originalTlsSocket = tls.TLSSocket;
  const connectCalls = [];

  net.connect = (options, callback) => {
    const socket = new FakeStreamSocket();
    connectCalls.push(options);
    process.nextTick(() => {
      if (typeof callback === 'function') {
        callback();
      }
    });
    return socket;
  };
  tls.TLSSocket = FakeTlsSocket;

  try {
    publishPort.handleTLSConnection(makeSessionId(), makeRef('03'), 8443, '0x' + '11'.repeat(20), publishPort.getPublishedPorts()[8443], connection);
  } finally {
    net.connect = originalConnect;
    tls.TLSSocket = originalTlsSocket;
    publishPort.stopListening();
  }

  assert.equal(connectCalls.length, 1);
  assert.deepEqual(connectCalls[0], { port: 8443, host: 'backend.internal', autoSelectFamily: false });
});

test('UDP publish stores and sends to configured host', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    5353: { mode: 'public', host: '192.168.1.20' },
  });
  const originalCreateSocket = dgram.createSocket;
  const sockets = [];

  dgram.createSocket = () => {
    const socket = new FakeDatagramSocket();
    sockets.push(socket);
    return socket;
  };

  try {
    const ref = makeRef('04');
    publishPort.handleUDPConnection(makeSessionId('05'), ref, 5353, '0x' + '11'.repeat(20), publishPort.getPublishedPorts()[5353], connection);
    publishPort.handlePortSend(makeSessionId('06'), ['portsend', ref, Buffer.from('hello')], connection);

    const connectionInfo = connection.getConnection(ref);
    assert.deepEqual(connectionInfo.remoteInfo, { port: 5353, address: '192.168.1.20' });
    assert.equal(sockets[0].sendCalls.length, 1);
    assert.equal(sockets[0].sendCalls[0].address, '192.168.1.20');
    assert.equal(sockets[0].sendCalls[0].port, 5353);
  } finally {
    dgram.createSocket = originalCreateSocket;
    publishPort.stopListening();
  }
});

test('native TCP publish connects local socket to configured host', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8089: { mode: 'public', host: '10.0.0.8' },
  });
  const originalConnect = net.connect;
  const connectCalls = [];

  net.connect = (options, callback) => {
    const socket = new FakeStreamSocket();
    connectCalls.push(options);
    process.nextTick(() => {
      if (typeof callback === 'function') {
        callback();
      }
      socket.emit('connect');
    });
    return socket;
  };

  try {
    publishPort.handleNativeTCPRelay(
      makeSessionId('07'),
      41000,
      { physicalPort: 41000, port: 8089, host: '10.0.0.8', deviceId: '0x' + '11'.repeat(20), ready: false, session: null },
      connection
    );
  } finally {
    net.connect = originalConnect;
    publishPort.stopListening();
  }

  assert.equal(connectCalls.length, 2);
  assert.deepEqual(connectCalls[0], { host: 'relay.example', port: 41000, allowHalfOpen: true, autoSelectFamily: false });
  assert.deepEqual(connectCalls[1], { port: 8089, host: '10.0.0.8', allowHalfOpen: true, autoSelectFamily: false });
});

test('native TCP publisher pauses both sockets until authenticated bridge setup', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8089: { mode: 'public', host: '10.0.0.8' },
  });
  const originalConnect = net.connect;
  const sockets = [];

  net.connect = (options, callback) => {
    const socket = new FakeStreamSocket();
    socket.options = options;
    sockets.push(socket);
    process.nextTick(() => {
      if (typeof callback === 'function') {
        callback();
      }
      socket.emit('connect');
    });
    return socket;
  };

  try {
    const session = {
      physicalPort: 41000,
      port: 8089,
      host: '10.0.0.8',
      protocol: 'tcp',
      deviceId: '0x' + '11'.repeat(20),
      ready: false,
      session: null,
      pendingRelayChunks: [],
    };
    publishPort.handleNativeTCPRelay(makeSessionId('07'), 41000, session, connection);

    const relaySocket = sockets[0];
    const localSocket = sockets[1];
    assert.equal(relaySocket.pauseCalls, 1);
    assert.equal(localSocket.pauseCalls, 1);
    assert.equal(relaySocket.listenerCount('data'), 0);
    assert.equal(localSocket.listenerCount('data'), 0);
    assert.equal(localSocket.writes.length, 0);

    session.ready = true;
    session.session = {};
    publishPort._flushNativeTCPRelayPending(session);

    assert.ok(session.bridge);
    assert.equal(relaySocket.pipeCalls.length, 1);
    assert.equal(localSocket.pipeCalls.length, 1);
    session.bridge.destroy();
  } finally {
    net.connect = originalConnect;
    publishPort.stopListening();
  }
});

test('native publisher keeps the handshake channel open until TLS write and relay ACKs complete', async () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8448]);
  const OriginalTlsSocket = tls.TLSSocket;
  const originals = {
    readHandshakeMessage: nativeCrypto.readHandshakeMessage,
    verifyHandshakeMessage: nativeCrypto.verifyHandshakeMessage,
    createHandshakeMessage: nativeCrypto.createHandshakeMessage,
    writeHandshakeMessage: nativeCrypto.writeHandshakeMessage,
    deriveSessionKeys: nativeCrypto.deriveSessionKeys,
  };
  const writeGate = deferred();
  const flushGate = deferred();
  const originalFlush = DiodeSocket.prototype.flush;
  const ref = makeRef('2a');
  const physicalPort = 41020;
  const remoteDeviceId = `0x${'11'.repeat(20)}`;
  const localSocket = new FakeStreamSocket();
  const relaySocket = new FakeStreamSocket();
  let tlsSocket;
  let writeStarted = false;
  let flushStarted = false;

  const session = {
    physicalPort,
    port: 8448,
    protocol: 'tcp',
    deviceId: remoteDeviceId,
    connection,
    localSocket,
    relaySocket,
    ready: false,
    session: null,
    timer: null,
    pendingRelayChunks: [],
    pendingRelayBytes: 0,
  };
  session.sessionKey = publishPort._nativeSessionKey(connection, physicalPort);
  publishPort.nativeSessions.set(session.sessionKey, session);

  tls.TLSSocket = class extends FakeStreamSocket {
    constructor() {
      super();
      tlsSocket = this;
      this.writableFinished = true;
    }
  };
  nativeCrypto.readHandshakeMessage = async () => ({ physicalPort });
  nativeCrypto.verifyHandshakeMessage = () => ({
    ok: true,
    deviceId: remoteDeviceId,
    ephPub: Buffer.alloc(33, 2),
    nonce: Buffer.alloc(16, 3),
  });
  nativeCrypto.createHandshakeMessage = () => ({
    message: { v: 1 },
    privKey: Buffer.alloc(32, 4),
    nonce: Buffer.alloc(16, 5),
  });
  nativeCrypto.writeHandshakeMessage = () => {
    writeStarted = true;
    return writeGate.promise;
  };
  nativeCrypto.deriveSessionKeys = () => ({});
  DiodeSocket.prototype.flush = () => {
    flushStarted = true;
    return flushGate.promise;
  };

  try {
    publishPort.handleTLSHandshake(
      makeSessionId('2a'),
      ref,
      8448,
      remoteDeviceId,
      connection
    );
    await waitFor(() => writeStarted);

    assert.equal(connection.getConnection(ref) !== undefined, true);
    assert.equal(publishPort._trackedConnectionInfos.size, 1);
    assert.equal(tlsSocket.destroyed, false);
    assert.equal(session.ready, false);
    assert.equal(localSocket.resumeCalls, 0);

    writeGate.resolve();
    await waitFor(() => flushStarted);
    assert.equal(tlsSocket.destroyed, false);
    assert.equal(session.ready, false, 'relay ACKs must finish before data socket activation');
    flushGate.resolve();
    await waitFor(() => connection.getConnection(ref) === undefined);

    assert.equal(session.ready, true);
    assert.ok(session.bridge);
    assert.equal(tlsSocket.destroyed, true);
    assert.equal(publishPort._trackedConnectionInfos.size, 0);
  } finally {
    tls.TLSSocket = OriginalTlsSocket;
    DiodeSocket.prototype.flush = originalFlush;
    writeGate.resolve();
    flushGate.resolve();
    Object.assign(nativeCrypto, originals);
    publishPort.close();
  }
});

test('native UDP publish connects local socket to configured host', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    8090: { mode: 'public', host: 'backend.internal' },
  });
  const originalCreateSocket = dgram.createSocket;
  const sockets = [];

  dgram.createSocket = () => {
    const socket = new FakeDatagramSocket();
    sockets.push(socket);
    return socket;
  };

  try {
    publishPort.handleNativeUDPRelay(
      makeSessionId('08'),
      41001,
      { physicalPort: 41001, port: 8090, host: 'backend.internal', deviceId: '0x' + '11'.repeat(20), ready: false, session: null },
      connection
    );
  } finally {
    dgram.createSocket = originalCreateSocket;
    publishPort.stopListening();
  }

  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[0].connectCalls[0], { port: 41001, host: 'relay.example' });
  assert.deepEqual(sockets[1].connectCalls[0], { port: 8090, host: 'backend.internal' });
});

test('native socket allocation failure or concurrent disposal releases partial resources', async (t) => {
  for (const protocol of ['tcp', 'udp']) {
    for (const mode of ['throw', 'close']) {
      await t.test(`${protocol} ${mode}`, () => {
        const connection = new FakeConnection();
        const publishPort = new PublishPort(connection, [8089]);
        const session = {
          physicalPort: 41000, port: 8089, host: '127.0.0.1', protocol,
          deviceId: `0x${'11'.repeat(20)}`, connection, ready: false,
          pendingRelayChunks: [Buffer.from('pending')], pendingRelayBytes: 7, nativeLease: true,
        };
        session.sessionKey = publishPort._nativeSessionKey(connection, session.physicalPort);
        publishPort.nativeSessions.set(session.sessionKey, session);
        connection._diodeActiveNativeSessions = 1;
        const original = protocol === 'tcp' ? net.connect : dgram.createSocket;
        const sockets = [];
        const allocate = () => {
          if (sockets.length === 1) {
            if (mode === 'throw') throw new Error('allocation failed');
            publishPort.close();
          }
          const socket = protocol === 'tcp' ? new FakeStreamSocket() : new FakeDatagramSocket();
          sockets.push(socket);
          return socket;
        };
        if (protocol === 'tcp') net.connect = allocate;
        else dgram.createSocket = allocate;
        try {
          const method = protocol === 'tcp' ? 'handleNativeTCPRelay' : 'handleNativeUDPRelay';
          assert.doesNotThrow(() => publishPort[method](makeSessionId('2e'), session.physicalPort, session, connection));
          assert.ok(sockets.every((socket) => socket.destroyed || socket.closed));
          assert.equal(connection._diodeActiveNativeSessions, 0);
          assert.equal(publishPort.nativeSessions.size, 0);
          assert.equal(session.pendingRelayBytes, 0);
          assert.equal(session.pendingRelayChunks.length, 0);
          assert.equal(connection.sentResponses.length, 0);
          if (mode === 'throw') assert.equal(connection.sentErrors.length, 1);
        } finally {
          if (protocol === 'tcp') net.connect = original;
          else dgram.createSocket = original;
          publishPort.close();
        }
      });
    }
  }
});

test('native handshake cannot rekey, destroy an unowned session, or revive a closed one', async (t) => {
  for (const mode of ['ready', 'in-progress', 'invalid-signature', 'closed-during-flush']) {
    await t.test(mode, async () => {
      const connection = new FakeConnection();
      const publishPort = new PublishPort(connection, [8448]);
      const originalTls = tls.TLSSocket;
      const originalFlush = DiodeSocket.prototype.flush;
      const originals = Object.fromEntries(['readHandshakeMessage', 'verifyHandshakeMessage', 'createHandshakeMessage', 'writeHandshakeMessage', 'deriveSessionKeys'].map((name) => [name, nativeCrypto[name]]));
      const session = {
        physicalPort: 41020, port: 8448, protocol: 'tcp', connection,
        deviceId: `0x${'11'.repeat(20)}`, ready: mode === 'ready',
        handshakeInProgress: mode === 'in-progress',
        localSocket: new FakeStreamSocket(), relaySocket: new FakeStreamSocket(),
        session: null,
      };
      session.sessionKey = publishPort._nativeSessionKey(connection, session.physicalPort);
      publishPort.nativeSessions.set(session.sessionKey, session);
      let derivations = 0;
      tls.TLSSocket = class extends FakeStreamSocket {};
      nativeCrypto.readHandshakeMessage = async () => ({ physicalPort: session.physicalPort });
      nativeCrypto.verifyHandshakeMessage = () => ({ ok: mode !== 'invalid-signature', reason: 'invalid signature', deviceId: session.deviceId, ephPub: Buffer.alloc(33), nonce: Buffer.alloc(16) });
      nativeCrypto.createHandshakeMessage = () => ({ message: {}, privKey: Buffer.alloc(32), nonce: Buffer.alloc(16) });
      nativeCrypto.writeHandshakeMessage = async () => {};
      nativeCrypto.deriveSessionKeys = () => { derivations += 1; return {}; };
      DiodeSocket.prototype.flush = async () => { publishPort._cleanupNativeSession(session); };
      try {
        const ref = makeRef('2f');
        publishPort.handleTLSHandshake(makeSessionId('2f'), ref, session.port, session.deviceId, connection);
        await waitFor(() => !connection.getConnection(ref));
        assert.equal(derivations, 0);
        assert.equal(session.bridge, undefined);
        if (mode === 'closed-during-flush') {
          assert.equal(session.ready, false);
          assert.equal(session._cleaned, true);
          assert.equal(publishPort.nativeSessions.size, 0);
        } else {
          assert.equal(publishPort.nativeSessions.get(session.sessionKey), session);
          assert.equal(session._cleaned, undefined);
          assert.equal(session.localSocket.destroyed, false);
          assert.equal(session.ready, mode === 'ready');
        }
      } finally {
        tls.TLSSocket = originalTls;
        DiodeSocket.prototype.flush = originalFlush;
        Object.assign(nativeCrypto, originals);
        publishPort.close();
      }
    });
  }
});

test('handlePortOpen preserves localhost default when host is omitted', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8081]);
  const originalConnect = net.connect;
  const connectCalls = [];

  net.connect = (options, callback) => {
    const socket = new FakeStreamSocket();
    connectCalls.push(options);
    process.nextTick(() => {
      if (typeof callback === 'function') {
        callback();
      }
    });
    return socket;
  };

  try {
    publishPort.handlePortOpen(
      makeSessionId('09'),
      ['portopen', '8081', makeRef('0a'), makeDeviceId('1')],
      connection
    );
  } finally {
    net.connect = originalConnect;
    publishPort.stopListening();
  }

  assert.deepEqual(connectCalls[0], { port: 8081, host: '127.0.0.1', autoSelectFamily: false });
});

test('handlePortOpen rejects non-whitelisted devices before connecting', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, {
    3000: { mode: 'private', whitelist: ['0x' + '22'.repeat(20)], host: '192.168.1.30' },
  });
  const originalConnect = net.connect;
  let connectCalled = false;

  net.connect = () => {
    connectCalled = true;
    return new FakeStreamSocket();
  };

  try {
    publishPort.handlePortOpen(
      makeSessionId('0b'),
      ['portopen', '3000', makeRef('0c'), makeDeviceId('1')],
      connection
    );
  } finally {
    net.connect = originalConnect;
    publishPort.stopListening();
  }

  assert.equal(connectCalled, false);
  assert.equal(connection.sentErrors.length, 1);
  assert.equal(connection.sentErrors[0][2], 'Device not whitelisted');
});

test('TCP publish rejects a portopen when the local backend refuses connection', async () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8082]);
  const originalConnect = net.connect;
  let socket;

  net.connect = () => {
    socket = new FakeStreamSocket();
    process.nextTick(() => socket.emit('error', new Error('ECONNREFUSED')));
    return socket;
  };

  try {
    const ref = makeRef('0d');
    publishPort.handleTCPConnection(
      makeSessionId('0e'),
      ref,
      8082,
      `0x${'11'.repeat(20)}`,
      publishPort.getPublishedPorts()[8082],
      connection
    );
    await waitFor(() => connection.sentErrors.length === 1);

    assert.equal(connection.sentErrors[0][2], 'Local service connection failed');
    assert.equal(connection.getConnection(ref), undefined);
    assert.equal(socket.destroyed, true);
  } finally {
    net.connect = originalConnect;
    publishPort.close();
  }
});

test('TLS publish backend failure sends an error and destroys both sides', async () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8444]);
  const originalConnect = net.connect;
  const originalTlsSocket = tls.TLSSocket;
  let localSocket;
  let tlsSocket;

  net.connect = () => {
    localSocket = new FakeStreamSocket();
    process.nextTick(() => localSocket.emit('error', new Error('ECONNREFUSED')));
    return localSocket;
  };
  tls.TLSSocket = class extends FakeTlsSocket {
    constructor(...args) {
      super(...args);
      tlsSocket = this;
      this.destroyed = false;
    }
    destroy() { this.destroyed = true; }
  };

  try {
    const ref = makeRef('0f');
    publishPort.handleTLSConnection(
      makeSessionId('10'),
      ref,
      8444,
      `0x${'11'.repeat(20)}`,
      publishPort.getPublishedPorts()[8444],
      connection
    );
    await waitFor(() => connection.sentErrors.length === 1);

    assert.equal(connection.sentErrors[0][2], 'Local service connection failed');
    assert.equal(connection.getConnection(ref), undefined);
    assert.equal(localSocket.destroyed, true);
    assert.equal(tlsSocket.destroyed, true);
  } finally {
    net.connect = originalConnect;
    tls.TLSSocket = originalTlsSocket;
    publishPort.close();
  }
});

test('portopen ACK rejection cleans native and API publisher resources', async (t) => {
  await t.test('native TCP session and lease', async () => {
    const connection = new FakeConnection();
    let ackCalls = 0;
    connection.RPC.sendResponse = async () => {
      ackCalls += 1;
      throw new Error('ACK write failed');
    };
    const publishPort = new PublishPort(connection, [8082]);
    const originalConnect = net.connect;
    const sockets = [];
    net.connect = () => {
      const socket = new FakeStreamSocket();
      sockets.push(socket);
      return socket;
    };

    try {
      const session = {
        physicalPort: 41010,
        port: 8082,
        host: '127.0.0.1',
        protocol: 'tcp',
        deviceId: `0x${'11'.repeat(20)}`,
        connection,
        ready: false,
        session: null,
        pendingRelayChunks: [],
        nativeLease: true,
      };
      session.sessionKey = publishPort._nativeSessionKey(connection, session.physicalPort);
      connection._diodeActiveNativeSessions = 1;
      publishPort.nativeSessions.set(session.sessionKey, session);

      publishPort.handleNativeTCPRelay(makeSessionId('1a'), session.physicalPort, session, connection);
      sockets[0].emit('connect');
      sockets[1].emit('connect');

      await waitFor(() => !publishPort.nativeSessions.has(session.sessionKey));
      assert.equal(ackCalls, 1);
      assert.equal(connection._diodeActiveNativeSessions, 0);
      assert.equal(session.nativeLease, false);
      assert.equal(sockets[0].destroyed, true);
      assert.equal(sockets[1].destroyed, true);
    } finally {
      net.connect = originalConnect;
      publishPort.close();
    }
  });

  await t.test('native UDP session and lease', async () => {
    const connection = new FakeConnection();
    let ackCalls = 0;
    connection.RPC.sendResponse = async () => {
      ackCalls += 1;
      throw new Error('ACK write failed');
    };
    const publishPort = new PublishPort(connection, [5356]);
    const originalCreateSocket = dgram.createSocket;
    const sockets = [];
    dgram.createSocket = () => {
      const socket = new FakeDatagramSocket();
      sockets.push(socket);
      return socket;
    };

    try {
      const session = {
        physicalPort: 41011,
        port: 5356,
        host: '127.0.0.1',
        protocol: 'udp',
        deviceId: `0x${'11'.repeat(20)}`,
        connection,
        ready: false,
        session: null,
        nativeLease: true,
      };
      session.sessionKey = publishPort._nativeSessionKey(connection, session.physicalPort);
      connection._diodeActiveNativeSessions = 1;
      publishPort.nativeSessions.set(session.sessionKey, session);

      publishPort.handleNativeUDPRelay(makeSessionId('1b'), session.physicalPort, session, connection);

      await waitFor(() => !publishPort.nativeSessions.has(session.sessionKey));
      assert.equal(ackCalls, 1);
      assert.equal(connection._diodeActiveNativeSessions, 0);
      assert.equal(session.nativeLease, false);
      assert.equal(sockets[0].closed, true);
      assert.equal(sockets[1].closed, true);
    } finally {
      dgram.createSocket = originalCreateSocket;
      publishPort.close();
    }
  });

  await t.test('API TCP connection', async () => {
    const connection = new FakeConnection();
    let ackCalls = 0;
    connection.RPC.sendResponse = async () => {
      ackCalls += 1;
      throw new Error('ACK write failed');
    };
    const publishPort = new PublishPort(connection, [8083]);
    const originalConnect = net.connect;
    let localSocket;
    let onConnect;
    net.connect = (_options, callback) => {
      localSocket = new FakeStreamSocket();
      onConnect = callback;
      return localSocket;
    };

    try {
      const ref = makeRef('1c');
      publishPort.handleTCPConnection(
        makeSessionId('1c'),
        ref,
        8083,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[8083],
        connection
      );
      onConnect();

      await waitFor(() => connection.getConnection(ref) === undefined);
      assert.equal(ackCalls, 1);
      assert.equal(localSocket.destroyed, true);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.portCloseCalls.length, 0);
    } finally {
      net.connect = originalConnect;
      publishPort.close();
    }
  });

  await t.test('API TLS connection', async () => {
    const connection = new FakeConnection();
    let ackCalls = 0;
    connection.RPC.sendResponse = async () => {
      ackCalls += 1;
      throw new Error('ACK write failed');
    };
    const publishPort = new PublishPort(connection, [8449]);
    const originalConnect = net.connect;
    const OriginalTlsSocket = tls.TLSSocket;
    let localSocket;
    let tlsSocket;
    let diodeSocket;
    let onConnect;
    tls.TLSSocket = class extends FakeStreamSocket {
      constructor(socket) {
        super();
        diodeSocket = socket;
        tlsSocket = this;
      }
    };
    net.connect = (_options, callback) => {
      localSocket = new FakeStreamSocket();
      onConnect = callback;
      return localSocket;
    };

    try {
      const ref = makeRef('1d');
      publishPort.handleTLSConnection(
        makeSessionId('1d'),
        ref,
        8449,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[8449],
        connection
      );
      onConnect();

      await waitFor(() => connection.getConnection(ref) === undefined);
      assert.equal(ackCalls, 1);
      assert.equal(localSocket.destroyed, true);
      assert.equal(tlsSocket.destroyed, true);
      assert.equal(diodeSocket.destroyed, true);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.portCloseCalls.length, 0);
    } finally {
      net.connect = originalConnect;
      tls.TLSSocket = OriginalTlsSocket;
      publishPort.close();
    }
  });
});

test('reused API ref replaces the old mapping and ignores its late socket error', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8084]);
  const originalConnect = net.connect;
  const sockets = [];
  const callbacks = [];
  net.connect = (_options, callback) => {
    const socket = new FakeStreamSocket();
    sockets.push(socket);
    callbacks.push(callback);
    return socket;
  };

  try {
    const ref = makeRef('24');
    const args = [
      makeSessionId('24'),
      ref,
      8084,
      `0x${'11'.repeat(20)}`,
      publishPort.getPublishedPorts()[8084],
      connection,
    ];
    publishPort.handleTCPConnection(...args);
    callbacks[0]();
    const oldInfo = connection.getConnection(ref);

    publishPort.handleTCPConnection(...args);
    const newInfo = connection.getConnection(ref);

    assert.notEqual(newInfo, oldInfo);
    assert.equal(sockets[0].destroyed, true);
    assert.equal(sockets[1].destroyed, false);
    assert.equal(publishPort._trackedConnectionInfos.size, 1);
    assert.equal(connection.portCloseCalls.length, 0);

    sockets[0].emit('error', new Error('late old backend error'));

    assert.equal(connection.getConnection(ref), newInfo);
    assert.equal(sockets[1].destroyed, false);
    assert.equal(publishPort._trackedConnectionInfos.size, 1);
    assert.equal(connection.portCloseCalls.length, 0);
  } finally {
    net.connect = originalConnect;
    publishPort.close();
  }
});

test('close during backend socket allocation cannot leave late TCP or TLS sockets', async (t) => {
  await t.test('TCP', () => {
    const connection = new FakeConnection();
    const publishPort = new PublishPort(connection, [8086]);
    const originalConnect = net.connect;
    let localSocket;

    net.connect = () => {
      localSocket = new FakeStreamSocket();
      publishPort.close();
      return localSocket;
    };

    try {
      publishPort.handleTCPConnection(
        makeSessionId('14'),
        makeRef('14'),
        8086,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[8086],
        connection
      );

      assert.equal(localSocket.destroyed, true);
      assert.equal(connection.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.sentResponses.length, 0);
      assert.equal(connection.portCloseCalls.length, 1);
    } finally {
      net.connect = originalConnect;
      publishPort.close();
    }
  });

  await t.test('TLS', () => {
    const connection = new FakeConnection();
    const publishPort = new PublishPort(connection, [8446]);
    const originalConnect = net.connect;
    const OriginalTlsSocket = tls.TLSSocket;
    let localSocket;
    let tlsSocket;
    let diodeSocket;

    tls.TLSSocket = class extends FakeStreamSocket {
      constructor(socket) {
        super();
        diodeSocket = socket;
        tlsSocket = this;
      }
    };
    net.connect = () => {
      localSocket = new FakeStreamSocket();
      publishPort.close();
      return localSocket;
    };

    try {
      publishPort.handleTLSConnection(
        makeSessionId('15'),
        makeRef('15'),
        8446,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[8446],
        connection
      );

      assert.equal(localSocket.destroyed, true);
      assert.equal(tlsSocket.destroyed, true);
      assert.equal(diodeSocket.destroyed, true);
      assert.equal(connection.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.sentResponses.length, 0);
      assert.equal(connection.portCloseCalls.length, 1);
    } finally {
      net.connect = originalConnect;
      tls.TLSSocket = OriginalTlsSocket;
      publishPort.close();
    }
  });
});

test('publisher tracking closes TLS-handshake and UDP sockets after manager relay removal', async (t) => {
  await t.test('TLS handshake', () => {
    const relay = new FakeConnection();
    let managerConnections = [relay];
    const manager = new EventEmitter();
    manager.getConnections = () => managerConnections;
    const publishPort = new PublishPort(manager, [8447]);
    const OriginalTlsSocket = tls.TLSSocket;
    let tlsSocket;
    let diodeSocket;

    tls.TLSSocket = class extends FakeStreamSocket {
      constructor(socket) {
        super();
        diodeSocket = socket;
        tlsSocket = this;
      }

      destroy(error) {
        if (this.destroyed) return;
        super.destroy(error);
        this.emit('close');
      }
    };

    try {
      const ref = makeRef('16');
      publishPort.handleTLSHandshake(
        makeSessionId('16'),
        ref,
        8447,
        `0x${'11'.repeat(20)}`,
        relay
      );
      assert.equal(relay.getConnection(ref) !== undefined, true);
      assert.equal(publishPort._trackedConnectionInfos.size, 1);

      managerConnections = [];
      publishPort.close();

      assert.equal(tlsSocket.destroyed, true);
      assert.equal(diodeSocket.destroyed, true);
      assert.equal(relay.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(relay.portCloseCalls.length, 1);
    } finally {
      tls.TLSSocket = OriginalTlsSocket;
      publishPort.close();
    }
  });

  await t.test('UDP', () => {
    const relay = new FakeConnection();
    let managerConnections = [relay];
    const manager = new EventEmitter();
    manager.getConnections = () => managerConnections;
    const publishPort = new PublishPort(manager, {
      5354: { mode: 'public', host: '127.0.0.1' },
    });
    const originalCreateSocket = dgram.createSocket;
    let localSocket;

    dgram.createSocket = () => {
      localSocket = new FakeDatagramSocket();
      return localSocket;
    };

    try {
      const ref = makeRef('17');
      publishPort.handleUDPConnection(
        makeSessionId('17'),
        ref,
        5354,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[5354],
        relay
      );
      assert.equal(relay.getConnection(ref) !== undefined, true);
      assert.equal(publishPort._trackedConnectionInfos.size, 1);

      managerConnections = [];
      publishPort.close();

      assert.equal(localSocket.closed, true);
      assert.equal(relay.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(relay.portCloseCalls.length, 1);
    } finally {
      dgram.createSocket = originalCreateSocket;
      publishPort.close();
    }
  });
});

test('close during TLS-handshake or UDP socket allocation destroys late resources', async (t) => {
  await t.test('TLS handshake', () => {
    const connection = new FakeConnection();
    const publishPort = new PublishPort(connection, [8448]);
    const OriginalTlsSocket = tls.TLSSocket;
    let tlsSocket;
    let diodeSocket;

    tls.TLSSocket = class extends FakeStreamSocket {
      constructor(socket) {
        super();
        diodeSocket = socket;
        tlsSocket = this;
        publishPort.close();
      }
    };

    try {
      publishPort.handleTLSHandshake(
        makeSessionId('18'),
        makeRef('18'),
        8448,
        `0x${'11'.repeat(20)}`,
        connection
      );

      assert.equal(tlsSocket.destroyed, true);
      assert.equal(diodeSocket.destroyed, true);
      assert.equal(connection.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.sentResponses.length, 0);
      assert.equal(connection.portCloseCalls.length, 1);
    } finally {
      tls.TLSSocket = OriginalTlsSocket;
      publishPort.close();
    }
  });

  await t.test('UDP', () => {
    const connection = new FakeConnection();
    const publishPort = new PublishPort(connection, [5355]);
    const originalCreateSocket = dgram.createSocket;
    let localSocket;

    dgram.createSocket = () => {
      localSocket = new FakeDatagramSocket();
      publishPort.close();
      return localSocket;
    };

    try {
      publishPort.handleUDPConnection(
        makeSessionId('19'),
        makeRef('19'),
        5355,
        `0x${'11'.repeat(20)}`,
        publishPort.getPublishedPorts()[5355],
        connection
      );

      assert.equal(localSocket.closed, true);
      assert.equal(connection.connections.size, 0);
      assert.equal(publishPort._trackedConnectionInfos.size, 0);
      assert.equal(connection.sentResponses.length, 0);
      assert.equal(connection.portCloseCalls.length, 1);
    } finally {
      dgram.createSocket = originalCreateSocket;
      publishPort.close();
    }
  });
});

test('startListening cannot reopen a closed publisher', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, []);
  assert.equal(connection.listenerCount('unsolicited'), 1);

  publishPort.close();
  publishPort.startListening();

  assert.equal(connection.listenerCount('unsolicited'), 0);
  assert.equal(publishPort._listening, false);
});

test('portclose for TLS destroys the separately stored localSocket', () => {
  const connection = new FakeConnection();
  const publishPort = new PublishPort(connection, [8445]);
  const ref = makeRef('11');
  const localSocket = new FakeStreamSocket();
  const tlsSocket = new FakeStreamSocket();
  const diodeSocket = new FakeStreamSocket();
  connection.addConnection(ref, {
    localSocket,
    tlsSocket,
    diodeSocket,
    protocol: 'tls',
    port: 8445,
  });

  publishPort.handlePortClose(makeSessionId('12'), ['portclose', ref], connection);

  assert.equal(localSocket.destroyed, true);
  assert.equal(tlsSocket.destroyed, true);
  assert.equal(diodeSocket.destroyed, true);
  assert.equal(connection.getConnection(ref), undefined);
  publishPort.close();
});

test('portclose2 is scoped to the relay connection as well as physical port', () => {
  const manager = new EventEmitter();
  manager.getConnections = () => [];
  const publishPort = new PublishPort(manager, {});
  const relayA = new FakeConnection();
  const relayB = new FakeConnection();
  const physicalPort = 41000;
  const sessionA = {
    sessionKey: publishPort._nativeSessionKey(relayA, physicalPort),
    connection: relayA,
    physicalPort,
    port: 8080,
    relaySocket: new FakeStreamSocket(),
    localSocket: new FakeStreamSocket(),
    nativeLease: true,
  };
  const sessionB = {
    sessionKey: publishPort._nativeSessionKey(relayB, physicalPort),
    connection: relayB,
    physicalPort,
    port: 8080,
    relaySocket: new FakeStreamSocket(),
    localSocket: new FakeStreamSocket(),
    nativeLease: true,
  };
  relayA._diodeActiveNativeSessions = 1;
  relayB._diodeActiveNativeSessions = 1;
  publishPort.nativeSessions.set(sessionA.sessionKey, sessionA);
  publishPort.nativeSessions.set(sessionB.sessionKey, sessionB);

  publishPort.handlePortClose2(makeSessionId('13'), ['portclose2', physicalPort], relayA);

  assert.equal(publishPort.nativeSessions.has(sessionA.sessionKey), false);
  assert.equal(publishPort.nativeSessions.has(sessionB.sessionKey), true);
  assert.equal(sessionA.localSocket.destroyed, true);
  assert.equal(sessionB.localSocket.destroyed, false);
  publishPort.close();
});
