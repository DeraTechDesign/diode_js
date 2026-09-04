const test = require('node:test');
const assert = require('node:assert/strict');

const DiodeRPC = require('../rpc');

const EPOCH_DURATION_SECONDS = 2592000;

function encodeUInt(value) {
  if (value === 0) return Buffer.alloc(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

function blockHeader(timestamp) {
  return [
    [Buffer.from('number'), encodeUInt(123)],
    [Buffer.from('timestamp'), encodeUInt(timestamp)],
  ];
}

test('ticket epoch is read from Moonbeam rather than Diode L1', async () => {
  const timestamp = (689 * EPOCH_DURATION_SECONDS) + 1234;
  const commands = [];
  const connection = {
    async sendCommand(command) {
      commands.push(command);
      if (command[0] === 'glmr:getblockpeak') return [encodeUInt(123)];
      if (command[0] === 'glmr:getblockheader') return [blockHeader(timestamp)];
      throw new Error(`Unexpected command: ${command[0]}`);
    },
  };

  const rpc = new DiodeRPC(connection);

  assert.equal(await rpc.getEpoch(), 689);
  assert.deepEqual(commands, [
    ['glmr:getblockpeak'],
    ['glmr:getblockheader', 123],
  ]);
});

test('ticket epoch lookup does not fall back to the workstation clock', async () => {
  const rpc = new DiodeRPC({
    async sendCommand(command) {
      if (command[0] === 'glmr:getblockpeak') return [encodeUInt(123)];
      return [[]];
    },
  });

  await assert.rejects(
    rpc.getEpoch(),
    /ticket epoch: block header did not contain a valid timestamp/
  );
  assert.deepEqual(rpc.epochCache, { epoch: null, expiry: null });
});

test('ticket epoch lookup propagates Moonbeam query failures', async () => {
  const failure = new Error('Moonbeam unavailable');
  const rpc = new DiodeRPC({
    async sendCommand() {
      throw failure;
    },
  });

  await assert.rejects(rpc.getEpoch(), (error) => error === failure);
  assert.deepEqual(rpc.epochCache, { epoch: null, expiry: null });
});
