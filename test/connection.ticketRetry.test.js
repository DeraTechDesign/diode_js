const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RLP } = require('@ethereumjs/rlp');

const DiodeConnection = require('../connection');

function makeConnection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-ticket-retry-test-'));
  return new DiodeConnection('relay.example', 41046, path.join(tempDir, 'keys.json'));
}

function encodeResponse(requestId, response) {
  const payload = RLP.encode([requestId, response]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length, 0);
  return Buffer.concat([length, Buffer.from(payload)]);
}

function tooLowResponse(overrides = {}) {
  const totalConnections = overrides.totalConnections === undefined ? 11 : overrides.totalConnections;
  const totalBytes = overrides.totalBytes === undefined ? 135591 : overrides.totalBytes;

  return [
    'response',
    'too_low',
    1284,
    687,
    totalConnections,
    totalBytes,
    Buffer.from([0]),
    Buffer.from([1]),
  ];
}

test('ticket too_low response retries once with repaired ticket', async () => {
  const connection = makeConnection();
  let retryCount = 0;

  connection.fixResponse = () => {};
  connection.createTicketCommand = async () => ['ticketv2'];
  connection.sendCommand = async (command, options) => {
    retryCount += 1;
    assert.deepEqual(command, ['ticketv2']);
    assert.equal(options.ticketRetryCount, 1);
    return ['thanks!', 1];
  };

  const resultPromise = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 0,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  const result = await resultPromise;

  assert.deepEqual(result, ['thanks!', 1]);
  assert.equal(retryCount, 1);
});

test('ticket too_low during initial handshake keeps the transport-ready retry path', async () => {
  const connection = makeConnection();
  let syncAllowed = false;
  let createAllowed = false;
  let internalRetries = 0;

  connection.fixResponse = () => {};
  connection._syncMeasuredBytesWithRelay = async (options) => {
    syncAllowed = options.allowTransportReady === true;
  };
  connection.createTicketCommand = async (options) => {
    createAllowed = options.allowTransportReady === true;
    return ['ticketv2'];
  };
  connection._sendCommandTransportReady = async (command, options) => {
    internalRetries += 1;
    assert.deepEqual(command, ['ticketv2']);
    assert.equal(options.ticketRetryCount, 1);
    return ['thanks!'];
  };
  connection.sendCommand = async () => {
    throw new Error('public command path would wait for readiness');
  };

  const resultPromise = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 0,
      allowTransportReady: true,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  assert.deepEqual(await resultPromise, ['thanks!']);
  assert.equal(syncAllowed, true);
  assert.equal(createAllowed, true);
  assert.equal(internalRetries, 1);
});

test('ticket too_low response does not retry recursively', async () => {
  const connection = makeConnection();
  let retryCount = 0;

  connection.fixResponse = () => {};
  connection.createTicketCommand = async () => {
    retryCount += 1;
    return ['ticketv2'];
  };

  const resultPromise = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 1,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  const result = await resultPromise;

  assert.equal(retryCount, 0);
  assert.equal(Buffer.from(result[0]).toString('utf8'), 'too_low');
});

test('session responses do not swallow later unsolicited messages on the same session', async () => {
  const connection = makeConnection();
  const writes = [];

  connection._ensureConnected = async () => {};
  connection.socket = {
    write(message, callback) {
      writes.push(message);
      callback();
    },
  };

  await connection.sendCommandWithSessionId(['response', Buffer.from([1]), 'ok'], 7);

  assert.equal(connection.pendingRequests.has(7), false);
  assert.equal(writes.length, 1);

  const unsolicited = new Promise((resolve) => {
    connection.once('unsolicited', resolve);
  });
  connection._handleData(encodeResponse(7, ['portsend', Buffer.from([1]), Buffer.from('hello')]));

  const message = await unsolicited;
  assert.equal(Buffer.from(message[0]).readUIntBE(0, Buffer.from(message[0]).length), 7);
  assert.equal(Buffer.from(message[1][0]).toString('utf8'), 'portsend');
});

test('too_low repair does not reduce local byte counters', () => {
  const connection = makeConnection();
  connection.totalConnections = 40;
  connection.totalBytes = 1304576;

  connection.fixResponse(tooLowResponse());

  assert.equal(connection.totalConnections, 40);
  assert.equal(connection.totalBytes, 1304576);
});

test('too_low repair uses node-reported paid byte floor', () => {
  const connection = makeConnection();
  connection.totalConnections = 4;
  connection.totalBytes = 128000;
  connection.accumulatedBytes = 2048;
  connection.lastRelayMeasuredBytes = 4096;

  connection.fixResponse(tooLowResponse({
    totalConnections: 7,
    totalBytes: 135591,
  }));

  assert.equal(connection.totalConnections, 7);
  assert.equal(connection.lastAcceptedTicketBytes, 135591);
  assert.equal(connection.totalBytes, 140711);
  assert.equal(connection.accumulatedBytes, 5120);
});

test('ticket update keeps accumulated bytes when ticket is rejected', async () => {
  const connection = makeConnection();
  connection.socket = { destroyed: false };
  connection.accumulatedBytes = 1000;
  connection.lastTicketUpdate = 123;
  connection.createTicketCommand = async () => ['ticketv2'];
  connection.sendCommand = async () => ['too_low'];
  connection._startTicketUpdateTimer = () => {};

  await connection._updateTicketIfNeeded(true);

  assert.equal(connection.accumulatedBytes, 1000);
  assert.equal(connection.lastTicketUpdate, 123);
});
