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
  const epoch = overrides.epoch === undefined ? 687 : overrides.epoch;
  const totalConnections = overrides.totalConnections === undefined ? 11 : overrides.totalConnections;
  const totalBytes = overrides.totalBytes === undefined ? 135591 : overrides.totalBytes;

  return [
    'response',
    'too_low',
    1284,
    epoch,
    totalConnections,
    totalBytes,
    Buffer.from([0]),
    Buffer.from([1]),
  ];
}

function stubTicketSigning(connection, epoch = 687) {
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection.RPC.getEpoch = async () => epoch;
  connection.createTicketSignature = async () => Buffer.alloc(65, 1);
}

function reportRelayUsage(connection, usage) {
  connection._handleData(encodeResponse(99, ['ticket_request', usage]));
}

function stubHelloUsage(connection, usage, { beforeResponse = false } = {}) {
  const commands = [];
  connection.sendCommand = async (command) => {
    commands.push(command[0]);
    assert.deepEqual(command, ['hello', 1001]);
    reportRelayUsage(connection, usage);
    if (beforeResponse) await new Promise(setImmediate);
    return ['ok'];
  };
  return commands;
}

test('ticket too_low response retries once with repaired ticket', async () => {
  const connection = makeConnection();
  let retryCount = 0;

  connection.fixResponse = () => {};
  connection._refreshTicketUsage = async () => {};
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
  connection._refreshTicketUsage = async (options) => {
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

test('ticket too_low response stops after the bounded retries', async () => {
  const connection = makeConnection();
  let retryCount = 0;
  connection._supportsRelayUsage = true;
  connection._ticketHeadroomBytes = 1024 * 1024;

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
      ticketRetryCount: 3,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  const result = await resultPromise;

  assert.equal(retryCount, 0);
  assert.equal(Buffer.from(result[0]).toString('utf8'), 'too_low');
  assert.equal(connection._ticketHeadroomBytes, 1024);
});

test('legacy relay stops after one too_low retry', async () => {
  const connection = makeConnection();
  connection._supportsRelayUsage = false;
  let refreshes = 0;
  connection._refreshTicketUsage = async () => { refreshes += 1; };
  const result = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 1,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  assert.equal(Buffer.from((await result)[0]).toString('utf8'), 'too_low');
  assert.equal(refreshes, 0);
});

test('failed ticket retry clears the temporary headroom', async () => {
  const connection = makeConnection();
  connection._refreshTicketUsage = async () => {};
  connection.createTicketCommand = async () => ['ticketv2'];
  connection.sendCommand = async () => { throw new Error('retry failed'); };
  const result = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 0,
    });
  });

  connection._handleData(encodeResponse(1, tooLowResponse()));
  await assert.rejects(result, /retry failed/);
  assert.equal(connection._ticketHeadroomBytes, 1024);
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

test('too_low repair discards an unverified local byte target', () => {
  const connection = makeConnection();
  connection.totalConnections = 40;
  connection.totalBytes = 1304576;

  connection.fixResponse(tooLowResponse());

  assert.equal(connection.totalConnections, 40);
  assert.equal(connection.totalBytes, 135591);
});

test('too_low repair uses only the node-reported paid byte floor', () => {
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
  assert.equal(connection.totalBytes, 135591);
  assert.equal(connection.accumulatedBytes, 0);
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

test('large byte totals are paid in bounded tickets without losing the unpaid target', async () => {
  const connection = makeConnection();
  connection.totalBytes = 190_000_000;
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection.RPC.getEpoch = async () => 687;
  const signedBytes = [];
  connection.createTicketSignature = async (_server, _connections, bytes) => {
    signedBytes.push(bytes);
    return Buffer.alloc(65, 1);
  };

  const first = await connection.createTicketCommand();
  assert.equal(first[5], 64_000_000);
  connection._recordTicketResponse(first, ['thanks!']);
  assert.equal(connection.totalBytes, 190_000_000);
  assert.equal(connection.accumulatedBytes, 126_000_000);

  const second = await connection.createTicketCommand();
  assert.equal(second[5], 128_000_000);
  connection._recordTicketResponse(second, ['thanks!']);

  const third = await connection.createTicketCommand();
  assert.equal(third[5], 190_000_000);
  assert.deepEqual(signedBytes, [first[5], second[5], third[5]]);
});

test('too_low repair reconciles against authoritative relay usage without adding local pending bytes', async () => {
  const connection = makeConnection();
  connection.totalBytes = 190_000_000;
  connection.accumulatedBytes = 120_000_000;
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection.RPC.getEpoch = async () => 687;
  connection.createTicketSignature = async () => Buffer.alloc(65, 1);

  connection.fixResponse(tooLowResponse({ totalConnections: 9, totalBytes: 700_000_000 }));

  assert.equal(connection.lastAcceptedTicketBytes, 700_000_000);
  assert.equal(connection.totalBytes, 700_000_000);
  connection._supportsRelayUsage = true;
  connection._relayUsageGeneration = connection._socketGeneration;
  connection._relayUsage = 820_000_000;
  connection._ticketUsageEpoch = 687;
  connection._ticketUsageSequence = connection._relayUsageSequence;
  const ticket = await connection.createTicketCommand();
  assert.equal(ticket[5], 820_001_024);
  assert.equal(connection.totalBytes, 820_001_024);
});

test('ticket updates drain a large backlog without exceeding the relay jump limit', async () => {
  const connection = makeConnection();
  connection.socket = { destroyed: false, writable: true };
  connection._ready = true;
  connection._transportReady = true;
  connection.totalBytes = 190_000_000;
  connection.accumulatedBytes = 190_000_000;
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection.RPC.getEpoch = async () => 687;
  connection.createTicketSignature = async () => Buffer.alloc(65, 1);
  connection._syncMeasuredBytesWithRelay = async () => 0;
  connection._refreshTicketUsage = async () => {};
  connection._startTicketUpdateTimer = () => {};

  let relayFloor = 0;
  const acceptedTotals = [];
  connection.sendCommand = async (command) => {
    const ticketBytes = command[5];
    assert.ok(ticketBytes - relayFloor <= 100_000_000);
    assert.ok(ticketBytes > relayFloor);
    relayFloor = ticketBytes;
    acceptedTotals.push(ticketBytes);
    connection._recordTicketResponse(command, ['thanks!']);
    return ['thanks!'];
  };

  await connection._updateTicketIfNeeded(true);
  for (let index = 0; index < 10 && relayFloor < connection.totalBytes; index += 1) {
    await new Promise(setImmediate);
  }

  assert.deepEqual(acceptedTotals, [64_000_000, 128_000_000, 190_000_000]);
  assert.equal(connection.accumulatedBytes, 0);
});

test('epoch rollover does not reuse the previous epoch ticket floor', async () => {
  const connection = makeConnection();
  connection.lastAcceptedTicketEpoch = 687;
  connection.lastAcceptedTicketBytes = 700_000_000;
  connection.totalBytes = 900_000_000;
  connection._waitForServerEthereumAddress = async () => Buffer.alloc(20, 1);
  connection.RPC.getEpoch = async () => 688;
  connection.createTicketSignature = async () => Buffer.alloc(65, 1);

  const first = await connection.createTicketCommand();
  assert.equal(first[2], 688);
  assert.equal(first[5], 64_000_000);
  assert.equal(connection.lastAcceptedTicketEpoch, 688);
  assert.equal(connection.lastAcceptedTicketBytes, 0);

  connection.fixResponse(tooLowResponse({ epoch: 688, totalBytes: 20_000_000 }));
  const retry = await connection.createTicketCommand();
  assert.equal(retry[5], 20_000_000);

  // Late responses from an older epoch cannot restore its higher floor.
  connection._recordTicketResponse(['ticketv2', 1284, 687, null, 1, 700_000_000], ['thanks!']);
  connection.fixResponse(tooLowResponse({ epoch: 687, totalBytes: 700_000_000 }));
  assert.equal(connection.lastAcceptedTicketEpoch, 688);
  assert.equal(connection.lastAcceptedTicketBytes, 20_000_000);
});

for (const beforeResponse of [false, true]) {
  test(`hello waits for absolute usage ${beforeResponse ? 'before' : 'after'} its response`, async () => {
    const connection = makeConnection();
    stubTicketSigning(connection);
    const commands = stubHelloUsage(connection, 10_000_000, { beforeResponse });
    connection.totalBytes = 110_000_000;
    connection.accumulatedBytes = 109_000_000;

    assert.equal(await connection._refreshTicketUsage(), 10_000_000);
    assert.deepEqual(commands, ['hello']);
    assert.equal(connection.totalBytes, 10_001_024);
    assert.equal((await connection.createTicketCommand())[5], 10_001_024);
  });
}

test('hello selects the fresh usage report after an older queued request', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.sendCommand = async (command) => {
    assert.deepEqual(command, ['hello', 1001]);
    reportRelayUsage(connection, 700_000_000); // previous epoch, still queued
    reportRelayUsage(connection, 20_000_000); // response to this hello
    return ['ok'];
  };

  assert.equal(await connection._refreshTicketUsage(), 20_000_000);
  assert.equal((await connection.createTicketCommand())[5], 20_001_024);
});

test('two idle reconnects keep the same signed byte total and clear stale local bytes', async () => {
  let paidBytes = 0;
  for (let reconnect = 0; reconnect < 2; reconnect += 1) {
    const connection = makeConnection();
    stubTicketSigning(connection);
    stubHelloUsage(connection, 10_000_000);
    connection.totalBytes = 500_000_000;
    connection.accumulatedBytes = 500_000_000;
    await connection._refreshTicketUsage();
    const ticket = await connection.createTicketCommand();
    if (reconnect === 0) paidBytes = ticket[5];
    assert.equal(ticket[5], paidBytes);
    connection._recordTicketResponse(ticket, ['thanks!']);
    assert.equal(connection.accumulatedBytes, 0);
    await connection._refreshTicketUsage();
    assert.equal((await connection.createTicketCommand())[5], paidBytes);
    assert.equal(connection.accumulatedBytes, 0);
  }
  assert.equal(paidBytes, 10_001_024);
});

test('too_low from a parallel connection does not add local pending bytes to its paid floor', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.totalBytes = 40_000_000;
  connection.accumulatedBytes = 100_000;
  connection.fixResponse(tooLowResponse({ totalBytes: 10_101_024 }));
  stubHelloUsage(connection, 10_101_024);

  await connection._refreshTicketUsage();
  const ticket = await connection.createTicketCommand();
  assert.equal(ticket[5], 10_101_024);
  assert.equal(connection.accumulatedBytes, 0);
});

test('too_low with over 64 MB unpaid uses absolute usage rather than doubling the ticket', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.totalBytes = 220_000_000;
  connection.accumulatedBytes = 110_000_000;
  connection.fixResponse(tooLowResponse({ totalBytes: 10_000_000 }));
  stubHelloUsage(connection, 120_000_000);

  await connection._refreshTicketUsage();
  const ticket = await connection.createTicketCommand();
  assert.equal(ticket[5], 120_001_024);
  assert.equal(ticket[5] - 120_000_000, 1024);
});

test('active stream too_low retries use fresh usage and bounded temporary margin', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  const reports = [120_100_000, 120_300_000, 120_700_000];
  let refreshes = 0;
  let submissions = 0;
  connection._refreshTicketUsage = async () => {
    connection._supportsRelayUsage = true;
    connection._relayUsageGeneration = connection._socketGeneration;
    connection._relayUsage = reports[refreshes];
    connection._ticketUsageEpoch = 687;
    connection._ticketUsageSequence = connection._relayUsageSequence;
    refreshes += 1;
  };
  connection.sendCommand = (command, options) => {
    assert.equal(command[0], 'ticketv2');
    const retryNumber = options.ticketRetryCount;
    const currentUsage = [120_300_000, 120_700_000, 121_000_000][submissions];
    assert.equal(retryNumber, submissions + 1);
    assert.ok(command[5] - reports[submissions] <= 1024 * 1024);
    submissions += 1;
    return new Promise((resolve, reject) => {
      const requestId = submissions + 1;
      connection.pendingRequests.set(requestId, {
        resolve,
        reject,
        commandArray: command,
        ticketRetryCount: retryNumber,
      });
      const response = submissions < 3
        ? tooLowResponse({ totalBytes: 10_000_000 })
        : ['response', 'thanks!'];
      if (submissions < 3) assert.ok(command[5] < currentUsage);
      else assert.ok(command[5] >= currentUsage);
      setImmediate(() => connection._handleData(encodeResponse(requestId, response)));
    });
  };

  const result = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: ['ticketv2'],
      ticketRetryCount: 0,
    });
  });
  connection._handleData(encodeResponse(1, tooLowResponse({ totalBytes: 10_000_000 })));
  assert.equal(Buffer.from((await result)[0]).toString('utf8'), 'thanks!');
  assert.equal(refreshes, 3);
  assert.equal(submissions, 3);
  assert.equal(connection.lastAcceptedTicketBytes, 121_748_576);
  assert.equal(connection._ticketHeadroomBytes, 1024, 'successful ticket resets retry margin');
  connection._relayUsage = 121_000_000;
  assert.equal((await connection.createTicketCommand())[5], 121_748_576);
});

test('new epoch usage replaces the previous epoch paid floor', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection, 688);
  connection.lastAcceptedTicketEpoch = 687;
  connection.lastAcceptedTicketBytes = 700_000_000;
  connection.totalBytes = 900_000_000;
  stubHelloUsage(connection, 20_000_000);

  await connection._refreshTicketUsage();
  const ticket = await connection.createTicketCommand();
  assert.equal(ticket[2], 688);
  assert.equal(ticket[5], 20_001_024);
  assert.equal(connection.lastAcceptedTicketBytes, 0);
});

test('ticket creation refuses a usage report from the previous epoch', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  let epoch = 687;
  connection.RPC.getEpoch = async () => epoch;
  stubHelloUsage(connection, 500_000_000);

  await connection._refreshTicketUsage();
  epoch = 688; // Epoch rolls over after hello but before ticket signing.

  await assert.rejects(connection.createTicketCommand(), (error) =>
    error.code === 'DIODE_USAGE_EPOCH_CHANGED');
  assert.equal(connection.lastAcceptedTicketEpoch, 687);
  assert.equal(connection.lastAcceptedTicketBytes, 0);

  stubHelloUsage(connection, 20_000_000);
  await connection._refreshTicketUsage();
  const retry = await connection.createTicketCommand();
  assert.equal(retry[2], 688);
  assert.equal(retry[5], 20_001_024);
});

test('hello refuses usage when the epoch changes while the report is in flight', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  const epochs = [687, 688];
  connection.RPC.getEpoch = async () => epochs.shift() ?? 688;
  stubHelloUsage(connection, 500_000_000);

  await assert.rejects(connection._refreshTicketUsage(), (error) =>
    error.code === 'DIODE_USAGE_EPOCH_CHANGED');
  assert.equal(connection._ticketUsageEpoch, null);
  await assert.rejects(connection.createTicketCommand(), (error) =>
    error.code === 'DIODE_USAGE_EPOCH_CHANGED');
});

test('too_low retry after rollover signs fresh-epoch usage', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  let epoch = 687;
  connection.RPC.getEpoch = async () => epoch;
  stubHelloUsage(connection, 500_000_000);
  await connection._refreshTicketUsage();
  const previousEpochTicket = await connection.createTicketCommand();
  assert.equal(previousEpochTicket[5], 500_001_024);
  epoch = 688;

  let retryTicket;
  connection.sendCommand = async (command) => {
    if (command[0] === 'hello') {
      reportRelayUsage(connection, 20_000_000);
      return ['ok'];
    }
    retryTicket = command;
    return ['thanks!'];
  };
  const response = new Promise((resolve, reject) => {
    connection.pendingRequests.set(1, {
      resolve,
      reject,
      commandArray: previousEpochTicket,
      ticketRetryCount: 0,
    });
  });
  connection._handleData(encodeResponse(1, tooLowResponse({ epoch: 688, totalBytes: 0 })));

  assert.deepEqual(await response, ['thanks!']);
  assert.equal(retryTicket[2], 688);
  assert.equal(retryTicket[5], 20_000_000 + 64 * 1024);
});

test('an extra usage request during epoch validation retries with a fresh report', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  let reads = 0;
  connection.RPC.getEpoch = async () => {
    reads += 1;
    if (reads === 2) {
      reportRelayUsage(connection, 10_000_100);
      await new Promise(setImmediate);
    }
    return 687;
  };
  stubHelloUsage(connection, 10_000_000);
  await assert.rejects(connection._refreshTicketUsage(), (error) =>
    error.code === 'DIODE_USAGE_STALE');

  stubHelloUsage(connection, 10_000_100);
  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 10_001_124);
});

test('unsupported hello wire error probes the paid floor without ambiguous pre-ticket bytes', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.totalBytes = 110_000_000;
  connection.accumulatedBytes = 110_000_000;
  const commands = [];
  connection.sendCommand = async (command) => {
    commands.push(command[0]);
    const response = new Promise((resolve, reject) => {
      connection.pendingRequests.set(1, { resolve, reject, commandArray: command });
    });
    connection._handleData(encodeResponse(1, ['error', Buffer.from('version not supported')]));
    return response;
  };

  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 128000);
  connection.fixResponse(tooLowResponse({ totalBytes: 10_000_000 }));
  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 10_000_000);
  assert.deepEqual(commands, ['hello']);
});

test('legacy bytes measurement is used only after an accepted ticket selects the fleet', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.socket = { destroyed: false };
  connection.lastAcceptedTicketEpoch = 687;
  connection.lastAcceptedTicketBytes = 10_000_000;
  connection._supportsRelayUsage = false;
  connection._ticketAcceptedOnTransport = true;
  const commands = [];
  let signedUnpaidBytes = 200; // zigzag encoding for +100
  connection.sendCommand = async (command) => {
    commands.push(command[0]);
    assert.deepEqual(command, ['bytes']);
    return [signedUnpaidBytes];
  };

  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 10_000_100);
  signedUnpaidBytes = 3; // zigzag encoding for -1
  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 10_000_000);
  assert.equal(connection.accumulatedBytes, 0);
  assert.deepEqual(commands, ['bytes', 'bytes']);
});

test('hello response without absolute usage fails closed', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.relayUsageWaitMs = 10;
  connection.sendCommand = async (command) => {
    assert.deepEqual(command, ['hello', 1001]);
    return ['ok'];
  };

  await assert.rejects(connection._refreshTicketUsage(), (error) => error.code === 'DIODE_USAGE_TIMEOUT');
  assert.equal(connection._supportsRelayUsage, null);
  assert.equal(connection.listenerCount('relay_usage'), 0);
  assert.equal(connection.listenerCount('disconnect'), 0);
});

test('disconnect cancels the absolute usage waiter and removes its listeners', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.sendCommand = async () => ['ok'];
  const refresh = connection._refreshTicketUsage();
  for (let turn = 0; turn < 3 && connection.listenerCount('relay_usage') === 0; turn += 1) {
    await new Promise(setImmediate);
  }
  assert.equal(connection.listenerCount('relay_usage'), 1);
  connection.emit('disconnect', { generation: connection._socketGeneration });
  await assert.rejects(refresh, (error) => error.code === 'DIODE_DISCONNECTED');
  assert.equal(connection.listenerCount('relay_usage'), 0);
  assert.equal(connection.listenerCount('disconnect'), 0);
});

test('hello command timeout fails closed without a legacy fallback', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.sendCommand = async () => {
    const error = new Error('hello timed out');
    error.code = 'DIODE_COMMAND_TIMEOUT';
    throw error;
  };

  await assert.rejects(connection._refreshTicketUsage(), (error) => error.code === 'DIODE_COMMAND_TIMEOUT');
  assert.equal(connection._supportsRelayUsage, null);
});

test('failed write bytes are removed by the next absolute relay usage report', async () => {
  const connection = makeConnection();
  stubTicketSigning(connection);
  connection.ticketUpdateThreshold = Number.MAX_SAFE_INTEGER;
  connection._ensureConnected = async () => {};
  connection.socket = {
    destroyed: false,
    writable: true,
    write(_message, callback) { callback(new Error('send failed')); },
  };

  await assert.rejects(connection.sendCommand(['ping', Buffer.alloc(2048)]), /send failed/);
  assert.ok(connection.totalBytes > 128000);
  assert.equal(connection.pendingRequests.size, 0);
  stubHelloUsage(connection, 0);
  await connection._refreshTicketUsage();
  assert.equal((await connection.createTicketCommand())[5], 1024);
  assert.equal(connection.totalBytes, 1024);
});
