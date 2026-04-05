const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DiodeConnection = require('../connection');
const { DEFAULT_FLEET_CONTRACT } = require('../utils');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diode-fleet-test-'));
}

function makeConnection() {
  const tempDir = makeTempDir();
  const keyLocation = path.join(tempDir, 'keys.json');
  const connection = new DiodeConnection('relay.example', 41046, keyLocation);
  connection.RPC = {
    getEpoch: async () => 77,
  };
  connection._waitForServerEthereumAddress = async () => Buffer.from('aa'.repeat(20), 'hex');
  return connection;
}

test('createTicketCommand uses the configured fleet contract in ticketv2', async () => {
  const connection = makeConnection();

  connection.setFleetContract('0x1111111111111111111111111111111111111111');
  const command = await connection.createTicketCommand();

  assert.equal(command[0], 'ticketv2');
  assert.equal(command[2], 77);
  assert.ok(Buffer.isBuffer(command[3]));
  assert.equal(command[3].toString('hex'), '1111111111111111111111111111111111111111');
});

test('createTicketSignature changes when the fleet contract changes', async () => {
  const connection = makeConnection();
  const serverIdBuffer = Buffer.from('bb'.repeat(20), 'hex');
  const totalConnections = 5;
  const totalBytes = 123456;
  const localAddress = 'client-a';
  const epoch = 88;

  const defaultSignature = await connection.createTicketSignature(
    serverIdBuffer,
    totalConnections,
    totalBytes,
    localAddress,
    epoch,
  );

  connection.setFleetContract('0x2222222222222222222222222222222222222222');
  const updatedSignature = await connection.createTicketSignature(
    serverIdBuffer,
    totalConnections,
    totalBytes,
    localAddress,
    epoch,
  );

  assert.notDeepEqual(updatedSignature, defaultSignature);
});

test('DiodeConnection defaults to the existing fleet contract', async () => {
  const connection = makeConnection();

  const command = await connection.createTicketCommand();

  assert.equal(command[3].toString('hex'), DEFAULT_FLEET_CONTRACT.slice(2));
});
