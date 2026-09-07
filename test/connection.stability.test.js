const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { RLP } = require('@ethereumjs/rlp');

const DiodeConnection = require('../connection');
const DiodeRPC = require('../rpc');
const { updateRelayBackpressure, releaseRelayBackpressure } = require('../relayBackpressure');

function makeConnection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-connection-stability-'));
  const connection = new DiodeConnection('relay.example', 41046, path.join(tempDir, 'keys.json'));
  connection.autoReconnect = false;
  return connection;
}

function encodeFrame(requestId, message) {
  const payload = Buffer.from(RLP.encode([requestId, message]));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function makeWritableSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.writes = [];
  socket.write = (message, callback) => {
    socket.writes.push(message);
    if (callback) callback();
    return true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.writable = false;
  };
  return socket;
}

function prepareTransport(connection) {
  connection.socket = makeWritableSocket();
  connection._transportReady = true;
  connection._ready = true;
  return connection.socket;
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

test('decoded unsolicited batch stops at relay pressure and resumes in byte order', async () => {
  const connection = makeConnection();
  const socket = prepareTransport(connection);
  socket.pause = () => {};
  socket.resume = () => {};
  const consumer = {};
  const received = [];
  connection.on('unsolicited', (message) => {
    received.push(message);
    if (message === 1) updateRelayBackpressure(connection, consumer, 256 * 1024);
  });
  try {
    for (const message of [1, 2, 3]) connection._deferUnsolicited(message);
    assert.equal(connection._deferredUnsolicited.size, 1, 'one callback for the decoded batch');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [1]);
    assert.equal(connection._queuedUnsolicited.length, 2);
    assert.equal(connection._deferredUnsolicited.size, 0, 'paused dispatch must not spin');
    releaseRelayBackpressure(consumer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [1, 2, 3]);
    assert.equal(connection._queuedUnsolicited.length, 0);
    updateRelayBackpressure(connection, consumer, 256 * 1024);
    connection._deferUnsolicited(4);
    connection.close();
    releaseRelayBackpressure(consumer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [1, 2, 3], 'disconnect discards the old generation batch');
    assert.equal(connection._queuedUnsolicited.length, 0);
  } finally {
    releaseRelayBackpressure(consumer);
    connection.close();
  }
});

test('relay TLS disables multi-address racing and preserves an explicit IPv6 host', async () => {
  const originalConnect = tls.connect;
  const connection = makeConnection();
  connection.host = '2001:db8::1';
  const socket = makeWritableSocket();
  let connectOptions;
  tls.connect = (port, host, options) => {
    assert.equal(host, '2001:db8::1');
    assert.equal(port, 41046);
    connectOptions = options;
    return socket;
  };
  try {
    const connecting = connection.connect();
    const rejected = assert.rejects(connecting, { code: 'DIODE_DISCONNECTED' });
    assert.equal(connectOptions.autoSelectFamily, false);
    assert.equal(connectOptions.family, undefined, 'must not force IPv4 on IPv6 relays');
    connection.close();
    await rejected;
    assert.equal(socket.destroyed, true);
  } finally {
    connection.close();
    tls.connect = originalConnect;
  }
});

test('coalesced portopen response defers first portsend until ref registration completes', async () => {
  const connection = makeConnection();
  const ref = Buffer.from('01020304', 'hex');

  const opened = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['portopen'],
    });
  });
  // Match the real portOpen -> fallback -> bind async continuation chain.
  const registered = opened
    .then((response) => response[1])
    .then(async (openedRef) => openedRef)
    .then((openedRef) => connection.addClientSocket(openedRef, { ready: true }));

  const delivered = new Promise((resolve) => {
    connection.once('unsolicited', (message) => {
      const dataRef = Buffer.from(message[1][1]);
      resolve(Boolean(connection.getClientSocket(dataRef)));
    });
  });

  connection._handleData(Buffer.concat([
    encodeFrame(1, ['response', 'ok', ref]),
    encodeFrame(99, ['portsend', ref, Buffer.from('SSH-2.0-test\r\n')]),
  ]));

  await registered;
  assert.equal(await delivered, true);
  assert.equal(connection.receiveBuffer.length, 0);
  connection.close();
});

test('malformed deferred unsolicited frames cannot escape or block a later ticket request', async () => {
  const connection = makeConnection();
  const malformedFrames = [
    [Buffer.from([1]), [7]],
    null,
    [Buffer.from([2])],
  ];
  let applicationListenerCalls = 0;
  let ticketRequests = 0;
  connection.on('unsolicited', () => { applicationListenerCalls += 1; });
  connection._updateTicketIfNeeded = async (force) => {
    assert.equal(force, true);
    ticketRequests += 1;
  };

  for (const frame of malformedFrames) {
    assert.equal(connection._handleUnsolicitedMessage(frame), false);
    connection._deferUnsolicited(frame);
  }
  connection._deferUnsolicited([
    Buffer.from([3]),
    [Buffer.from('ticket_request'), Buffer.from([2, 0, 0])],
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applicationListenerCalls, malformedFrames.length + 1);
  assert.equal(ticketRequests, 1);
  connection.close();
});

test('too_low response does not leave processed frames to be replayed', async () => {
  const connection = makeConnection();
  let unsolicitedCount = 0;
  connection.on('unsolicited', () => { unsolicitedCount += 1; });

  const ticket = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 1,
    });
  });
  const tooLow = [
    'response', 'too_low', 1284, 1, 1, 128000, Buffer.alloc(0), Buffer.from([1]),
  ];
  connection._handleData(Buffer.concat([
    encodeFrame(1, tooLow),
    encodeFrame(2, ['portsend', Buffer.from('01', 'hex'), Buffer.from('data')]),
  ]));

  await ticket;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.receiveBuffer.length, 0);
  assert.equal(unsolicitedCount, 1);

  // Feeding another complete frame must not replay either processed frame.
  connection._handleData(encodeFrame(3, ['portsend', Buffer.from('02', 'hex'), Buffer.from('next')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsolicitedCount, 2);
  connection.close();
});

test('command deadline rejects and removes an unanswered RPC', async () => {
  const connection = makeConnection();
  prepareTransport(connection);

  await assert.rejects(
    connection.sendCommand(['ping'], { timeoutMs: 15 }),
    (error) => error.code === 'DIODE_COMMAND_TIMEOUT' && error.command === 'ping'
  );
  assert.equal(connection.pendingRequests.size, 0);
  connection.close();
});

test('AbortSignal cancels and removes an in-flight RPC immediately', async () => {
  const connection = makeConnection();
  prepareTransport(connection);
  const controller = new AbortController();
  const command = connection.sendCommand(['getobject', Buffer.alloc(20)], {
    timeoutMs: 1000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.pendingRequests.size, 1);

  controller.abort(new Error('probe stopped'));
  await assert.rejects(command, (error) => (
    error.code === 'DIODE_COMMAND_ABORTED' && error.retryable === true
  ));
  assert.equal(connection.pendingRequests.size, 0);
  connection.close();
});

test('disconnect rejects pending RPCs, drains buffers, and tears down sessions once', async () => {
  const connection = makeConnection();
  const socket = prepareTransport(connection);
  const client = { destroyed: false, destroy() { this.destroyed = true; } };
  const local = { destroyed: false, destroy() { this.destroyed = true; } };
  connection.addClientSocket(Buffer.from('01', 'hex'), client);
  connection.addConnection(Buffer.from('02', 'hex'), { localSocket: local });
  connection.receiveBuffer = Buffer.from([0, 10, 1]);

  let disconnects = 0;
  connection.on('disconnect', () => { disconnects += 1; });
  const pending = connection.sendCommand(['ping'], { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));

  const error = new DiodeConnection.Errors.DiodeDisconnectedError('test disconnect');
  connection._handleDisconnect(socket, connection._socketGeneration, error);
  connection._handleDisconnect(socket, connection._socketGeneration, error);

  await assert.rejects(pending, (actual) => actual === error);
  assert.equal(connection.pendingRequests.size, 0);
  assert.equal(connection.receiveBuffer.length, 0);
  assert.equal(connection.clientSockets.size, 0);
  assert.equal(connection.connections.size, 0);
  assert.equal(client.destroyed, true);
  assert.equal(local.destroyed, true);
  assert.equal(disconnects, 1);
});

test('an old ticket update cannot clear a new session ticket flight', async () => {
  const connection = makeConnection();
  const oldSocket = prepareTransport(connection);
  const first = deferred();
  const second = deferred();
  let syncCall = 0;
  connection._syncMeasuredBytesWithRelay = () => {
    syncCall += 1;
    return syncCall === 1 ? first.promise : second.promise;
  };
  connection.createTicketCommand = async () => ['ticketv2', 1284, 1, Buffer.alloc(20), 1, 1];
  connection.sendCommand = async () => ['thanks!'];
  connection._startTicketUpdateTimer = () => {};

  const oldUpdate = connection._updateTicketIfNeeded(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.ticketUpdateInFlight, true);

  connection._handleDisconnect(oldSocket, 0);
  connection._socketGeneration = 1;
  connection._lastDisconnectedGeneration = 0;
  prepareTransport(connection);
  const newUpdate = connection._updateTicketIfNeeded(true);
  await new Promise((resolve) => setImmediate(resolve));
  const newToken = connection._ticketUpdateToken;
  assert.equal(connection.ticketUpdateInFlight, true);

  first.resolve(0);
  await oldUpdate;
  assert.equal(connection._ticketUpdateToken, newToken);
  assert.equal(connection.ticketUpdateInFlight, true);

  second.resolve(0);
  await newUpdate;
  assert.equal(connection._ticketUpdateToken, null);
  assert.equal(connection.ticketUpdateInFlight, false);
  connection.close();
});

test('duplicate socket end/close handling schedules only one reconnect', () => {
  const connection = makeConnection();
  connection.autoReconnect = true;
  connection.retryDelay = 1000;
  const socket = prepareTransport(connection);

  connection._handleDisconnect(socket, connection._socketGeneration);
  const timer = connection.retryTimeoutId;
  connection._handleDisconnect(socket, connection._socketGeneration);

  assert.equal(connection.retryCount, 1);
  assert.equal(connection.retryTimeoutId, timer);
  connection.close();
});

test('failed reconnect attempts continue until max retries is reached', async () => {
  const connection = makeConnection();
  connection.autoReconnect = true;
  connection.retryDelay = 1;
  connection.maxRetryDelay = 1;
  connection.maxRetries = 2;
  let attempts = 0;
  connection.connect = async () => {
    attempts += 1;
    throw new Error('relay unavailable');
  };

  const failed = new Promise((resolve) => connection.once('reconnect_failed', resolve));
  connection._reconnect();
  const error = await failed;

  assert.equal(attempts, 2);
  assert.equal(error.code, 'DIODE_RECONNECT_FAILED');
  assert.equal(connection.isReconnecting, false);
  connection.close();
});

test('a reconnect promise cannot report success after its socket already disappeared', async () => {
  const connection = makeConnection();
  connection.autoReconnect = true;
  connection.retryDelay = 1;
  connection.maxRetryDelay = 1;
  connection.maxRetries = 2;
  let attempts = 0;
  let reconnected = 0;
  connection.connect = async () => { attempts += 1; };
  connection.on('reconnected', () => { reconnected += 1; });

  const failed = new Promise((resolve) => connection.once('reconnect_failed', resolve));
  connection._reconnect();
  await failed;

  assert.equal(attempts, 2);
  assert.equal(reconnected, 0);
  connection.close();
});

test('close cancels a scheduled reconnect without an orphan attempt', async () => {
  const connection = makeConnection();
  connection.autoReconnect = true;
  connection.retryDelay = 10;
  let attempts = 0;
  connection.connect = async () => { attempts += 1; };

  connection._reconnect();
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(attempts, 0);
  assert.equal(connection.retryTimeoutId, null);
});

test('connect has a real TLS/readiness timeout and does not report half-open sockets ready', async () => {
  const originalConnect = tls.connect;
  const fakeSocket = makeWritableSocket();
  tls.connect = () => fakeSocket;

  const connection = makeConnection();
  connection.connectTimeoutMs = 15;
  try {
    const connecting = connection.connect();
    assert.equal(connection.isReady(), false);
    await assert.rejects(connecting, (error) => error.code === 'DIODE_CONNECT_TIMEOUT');
    assert.equal(connection.isReady(), false);
    assert.equal(connection.socket, null);
  } finally {
    connection.close();
    tls.connect = originalConnect;
  }
});

test('connection becomes ready only after the secure ticket handshake succeeds', async () => {
  const originalConnect = tls.connect;
  const fakeSocket = makeWritableSocket();
  fakeSocket.remotePort = 41046;
  fakeSocket.setKeepAlive = () => {};
  fakeSocket.setNoDelay = () => {};
  let onSecure;
  tls.connect = (_port, _host, _options, callback) => {
    onSecure = callback;
    return fakeSocket;
  };

  const connection = makeConnection();
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection._syncMeasuredBytesWithRelay = async () => 0;
  connection.createTicketCommand = async () => ['ticketv2'];
  connection._sendCommandTransportReady = async () => ['thanks!'];
  try {
    const connecting = connection.connect();
    assert.equal(connection.isReady(), false);
    onSecure();
    await connecting;
    assert.equal(connection.isReady(), true);
  } finally {
    connection.close();
    tls.connect = originalConnect;
  }
});

test('a stale handshake cannot mutate or send through a newer ready generation', async () => {
  const originalConnect = tls.connect;
  const sockets = [];
  const secureCallbacks = [];
  tls.connect = (_port, _host, _options, callback) => {
    const socket = makeWritableSocket();
    socket.remotePort = 41046;
    socket.setKeepAlive = () => {};
    socket.setNoDelay = () => {};
    sockets.push(socket);
    secureCallbacks.push(callback);
    return socket;
  };

  const connection = makeConnection();
  const firstLookup = deferred();
  const firstServerAddress = Buffer.alloc(20, 1);
  const secondServerAddress = Buffer.alloc(20, 2);
  const syncGenerations = [];
  const createdTickets = [];
  const submittedTickets = [];
  let lookupCalls = 0;
  connection._waitForServerEthereumAddress = async () => {
    lookupCalls += 1;
    return lookupCalls === 1 ? firstLookup.promise : secondServerAddress;
  };
  connection._syncMeasuredBytesWithRelay = async () => {
    syncGenerations.push(connection._socketGeneration);
    return 0;
  };
  connection.createTicketCommand = async () => {
    const generation = connection._socketGeneration;
    createdTickets.push(generation);
    return ['ticketv2', generation];
  };
  connection._sendCommandTransportReady = async (command) => {
    submittedTickets.push(command[1]);
    return ['thanks!'];
  };
  connection._startTicketUpdateTimer = () => {};
  const localIdentity = connection.getEthereumAddress();

  try {
    const firstConnecting = connection.connect();
    const firstHandshake = secureCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lookupCalls, 1);

    const firstDisconnect = new DiodeConnection.Errors.DiodeDisconnectedError('replace generation one');
    connection._handleDisconnect(sockets[0], 1, firstDisconnect);
    await assert.rejects(firstConnecting, (error) => error === firstDisconnect);
    await new Promise((resolve) => setImmediate(resolve));

    const secondConnecting = connection.connect();
    const secondHandshake = secureCallbacks[1]();
    await Promise.all([secondConnecting, secondHandshake]);
    assert.equal(connection.isReady(), true);
    assert.equal(connection.socket, sockets[1]);
    assert.deepEqual(connection._serverEthAddress, secondServerAddress);

    firstLookup.resolve(firstServerAddress);
    await firstHandshake;

    assert.equal(connection.isReady(), true);
    assert.equal(connection.socket, sockets[1]);
    assert.deepEqual(connection._serverEthAddress, secondServerAddress);
    assert.deepEqual(syncGenerations, [2]);
    assert.deepEqual(createdTickets, [2]);
    assert.deepEqual(submittedTickets, [2]);
    assert.equal(connection.getEthereumAddress(), localIdentity);
  } finally {
    connection.close();
    tls.connect = originalConnect;
  }
});

test('explicit connect resolves a backoff waiter and a later disconnect can reconnect', async () => {
  const originalConnect = tls.connect;
  const fakeSocket = makeWritableSocket();
  fakeSocket.remotePort = 41046;
  fakeSocket.setKeepAlive = () => {};
  fakeSocket.setNoDelay = () => {};
  let onSecure;
  tls.connect = (_port, _host, _options, callback) => {
    onSecure = callback;
    return fakeSocket;
  };

  const connection = makeConnection();
  connection.autoReconnect = true;
  connection.retryDelay = 1000;
  connection.maxRetryDelay = 1000;
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection._syncMeasuredBytesWithRelay = async () => 0;
  connection.createTicketCommand = async () => ['ticketv2'];
  connection._sendCommandTransportReady = async () => ['thanks!'];
  try {
    const command = connection.sendCommand(['ping'], { timeoutMs: 5000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(connection.retryTimeoutId, null);
    assert.equal(connection.isReconnecting, true);
    assert.notEqual(connection.connectPromise, null);

    const connecting = connection.connect();
    assert.equal(connection.retryTimeoutId, null);
    assert.equal(connection.isReconnecting, false);
    onSecure();
    await connecting;
    assert.equal(connection.isReady(), true);
    assert.equal(connection.isReconnecting, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.connectPromise, null);
    assert.equal(fakeSocket.writes.length, 1, 'waiting command should resume after explicit connect');

    const [requestId] = Array.from(connection.pendingRequests.keys());
    connection._handleData(encodeFrame(requestId, ['response', 'pong']));
    const response = await command;
    assert.equal(Buffer.from(response[0]).toString('utf8'), 'pong');

    connection._handleDisconnect(
      fakeSocket,
      connection._socketGeneration,
      new DiodeConnection.Errors.DiodeDisconnectedError('relay dropped again')
    );
    assert.notEqual(connection.retryTimeoutId, null);
    assert.equal(connection.isReconnecting, true);
  } finally {
    connection.close();
    tls.connect = originalConnect;
  }
});

test('public commands wait for ticket readiness while handshake commands may use the TLS transport', async () => {
  const connection = makeConnection();
  const socket = makeWritableSocket();
  const handshake = deferred();
  connection.socket = socket;
  connection._transportReady = true;
  connection._ready = false;
  connection._connectAttempt = handshake.promise;

  const publicCommand = connection.sendCommand(['portopen'], { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 0, 'public command must wait for the ticket handshake');

  const transportCommand = connection._sendCommandTransportReady(['bytes'], { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 1, 'internal handshake command should use the secured transport');
  const transportRequestId = Array.from(connection.pendingRequests.keys())[0];
  connection._handleData(encodeFrame(transportRequestId, ['response', 0]));
  await transportCommand;

  connection._ready = true;
  handshake.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 2);
  const publicRequestId = Array.from(connection.pendingRequests.keys())[0];
  connection._handleData(encodeFrame(publicRequestId, ['response', 'ok']));
  const publicResponse = await publicCommand;
  assert.equal(Buffer.from(publicResponse[0]).toString('utf8'), 'ok');
  connection.close();
});

test('connection timer configuration rejects non-positive values and clamps Node overflow values', () => {
  const previous = {
    retryDelay: process.env.DIODE_RETRY_DELAY,
    maxRetryDelay: process.env.DIODE_MAX_RETRY_DELAY,
    commandTimeout: process.env.DIODE_COMMAND_TIMEOUT_MS,
    connectTimeout: process.env.DIODE_CONNECT_TIMEOUT_MS,
    ticketInterval: process.env.DIODE_TICKET_UPDATE_INTERVAL,
  };
  process.env.DIODE_RETRY_DELAY = '-1';
  process.env.DIODE_MAX_RETRY_DELAY = String(Number.MAX_SAFE_INTEGER);
  process.env.DIODE_COMMAND_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
  process.env.DIODE_CONNECT_TIMEOUT_MS = '0';
  process.env.DIODE_TICKET_UPDATE_INTERVAL = String(Number.MAX_SAFE_INTEGER);

  let connection;
  try {
    connection = makeConnection();
    assert.equal(connection.retryDelay, 1000);
    assert.equal(connection.maxRetryDelay, 0x7fffffff);
    assert.equal(connection.commandTimeoutMs, 0x7fffffff);
    assert.equal(connection.connectTimeoutMs, 30000);
    assert.equal(connection.ticketUpdateInterval, 0x7fffffff);

    connection.setReconnectOptions({ retryDelay: -10, maxRetryDelay: Number.MAX_SAFE_INTEGER });
    connection.setCommandOptions({ timeoutMs: Number.MAX_SAFE_INTEGER, connectTimeoutMs: Number.MAX_SAFE_INTEGER });
    connection.setTicketBatchingOptions({ interval: Number.MAX_SAFE_INTEGER });
    assert.equal(connection.retryDelay, 1000);
    assert.equal(connection.maxRetryDelay, 0x7fffffff);
    assert.equal(connection.commandTimeoutMs, 0x7fffffff);
    assert.equal(connection.connectTimeoutMs, 0x7fffffff);
    assert.equal(connection.ticketUpdateInterval, 0x7fffffff);
  } finally {
    if (connection) connection.close();
    for (const [key, value] of Object.entries({
      DIODE_RETRY_DELAY: previous.retryDelay,
      DIODE_MAX_RETRY_DELAY: previous.maxRetryDelay,
      DIODE_COMMAND_TIMEOUT_MS: previous.commandTimeout,
      DIODE_CONNECT_TIMEOUT_MS: previous.connectTimeout,
      DIODE_TICKET_UPDATE_INTERVAL: previous.ticketInterval,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('server address polling clamps huge intervals and defaults invalid timer values', async () => {
  const connection = makeConnection();
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (callback, delayMs) => {
    delays.push(delayMs);
    queueMicrotask(callback);
    return { fakeTimer: true };
  };

  const lookup = async (options) => {
    let reads = 0;
    connection.getServerEthereumAddress = () => {
      reads += 1;
      return reads > 1 ? Buffer.alloc(20, reads) : null;
    };
    const address = await connection._waitForServerEthereumAddress(options);
    assert.equal(Buffer.isBuffer(address), true);
    assert.equal(reads, 2);
  };

  try {
    await lookup({ timeoutMs: Number.MAX_SAFE_INTEGER, intervalMs: Number.MAX_SAFE_INTEGER });
    await lookup({ timeoutMs: Number.POSITIVE_INFINITY, intervalMs: -1 });
    await lookup({ timeoutMs: Number.NaN, intervalMs: Number.NaN });
    await lookup({ timeoutMs: 0.5, intervalMs: 0.5 });
  } finally {
    global.setTimeout = originalSetTimeout;
    connection.close();
  }

  assert.deepEqual(delays, [0x7fffffff, 50, 50, 1]);
});

test('relay identity uses the typed X509 public key without legacy certificate parsing', () => {
  const connection = makeConnection();
  const publicKey = Buffer.from(connection.keyPair.prvKeyObj.generatePublicKeyHex(), 'hex');
  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33, 65);
  let legacyCalls = 0;
  let x509Calls = 0;
  connection.socket = {
    getPeerX509Certificate: () => {
      x509Calls += 1;
      return {
        publicKey: {
          export: (options) => {
            assert.deepEqual(options, { format: 'jwk' });
            return {
              kty: 'EC',
              crv: 'secp256k1',
              x: x.toString('base64url'),
              y: y.toString('base64url'),
            };
          },
        },
      };
    },
    getPeerCertificate: () => {
      legacyCalls += 1;
      throw new Error('legacy certificate path must not run');
    },
  };

  const expected = `0x${require('ethereumjs-util').pubToAddress(
    publicKey,
    true
  ).toString('hex')}`;
  assert.equal(connection.getServerEthereumAddress(), expected);
  assert.equal(
    connection.getServerEthereumAddress(true, { socket: connection.socket, cache: false }),
    expected,
    'the asserted current socket may read, but not rewrite, its committed identity cache'
  );
  assert.equal(x509Calls, 1);
  assert.equal(legacyCalls, 0);
  connection.close();
});

test('reconnect waiter is single-flight and cleared after settling', async () => {
  const connection = makeConnection();
  const first = connection._waitForReconnect();
  const second = connection._waitForReconnect();
  assert.equal(first, second);

  connection.emit('reconnected', connection);
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.connectPromise, null);
  connection.close();
});

test('port RPC failures propagate instead of becoming undefined successes', async () => {
  const timeout = new DiodeConnection.Errors.DiodeCommandTimeoutError(['portopen'], 10, 1);
  const rpc = new DiodeRPC({ sendCommand: async () => { throw timeout; } });
  await assert.rejects(rpc.portOpen(Buffer.alloc(20), 22), (error) => error === timeout);

  const rejected = new DiodeRPC({ sendCommand: async () => ['error', Buffer.from('denied')] });
  await assert.rejects(
    rejected.portOpen(Buffer.alloc(20), 22),
    (error) => error.code === 'DIODE_RPC_ERROR' && error.operation === 'portopen'
  );
  await assert.rejects(
    rejected.portOpen2(Buffer.alloc(20), 22),
    (error) => error.code === 'DIODE_RPC_ERROR' && error.operation === 'portopen2'
  );
  await assert.rejects(
    rejected.portClose(Buffer.from('01', 'hex')),
    (error) => error.code === 'DIODE_RPC_ERROR' && error.operation === 'portclose'
  );
  await assert.rejects(
    rejected.portClose2(41000),
    (error) => error.code === 'DIODE_RPC_ERROR' && error.operation === 'portclose2'
  );
});

test('publisher response helpers propagate transport write failures', async () => {
  const failure = new Error('response write failed');
  const rpc = new DiodeRPC({
    sendCommandWithSessionId: async () => { throw failure; },
  });

  await assert.rejects(
    rpc.sendResponse(Buffer.from('01', 'hex'), Buffer.from('02', 'hex'), 'ok'),
    (error) => error === failure
  );
  await assert.rejects(
    rpc.sendError(Buffer.from('01', 'hex'), Buffer.from('02', 'hex'), 'denied'),
    (error) => error === failure
  );
});

test('ping and lookup RPCs forward per-call cancellation options', async () => {
  const calls = [];
  const controller = new AbortController();
  const options = { timeoutMs: 321, signal: controller.signal };
  const rpc = new DiodeRPC({
    sendCommand: async (command, actualOptions) => {
      calls.push({ command, actualOptions });
      if (command[0] === 'ping') return ['pong'];
      return [[Buffer.from('unknown')]];
    },
  });

  assert.equal(await rpc.ping(options), true);
  await rpc.getObject(Buffer.alloc(20), options);
  await rpc.getNode(Buffer.alloc(20), options);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.actualOptions, options);
});
