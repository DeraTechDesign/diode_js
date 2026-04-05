const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');

const PublishPort = require('../publishPort');

class FakeStreamSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
  }

  setNoDelay() {}
  pause() {}
  write() {}
  end() {}
  destroy() {
    this.destroyed = true;
  }
  pipe(destination) {
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
  const publishPort = new PublishPort(connection, {
    8080: { mode: 'private', whitelist: ['0xabc'], host: ' backend.internal ' },
  });

  assert.deepEqual(publishPort.getPublishedPorts(), {
    8080: { mode: 'private', whitelist: ['0xabc'], host: 'backend.internal' },
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
  assert.deepEqual(connectCalls[0], { port: 8080, host: '192.168.1.10' });
});

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
  assert.deepEqual(connectCalls[0], { port: 8443, host: 'backend.internal' });
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
  assert.deepEqual(connectCalls[0], { host: 'relay.example', port: 41000 });
  assert.deepEqual(connectCalls[1], { port: 8089, host: '10.0.0.8' });
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

  assert.deepEqual(connectCalls[0], { port: 8081, host: '127.0.0.1' });
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
