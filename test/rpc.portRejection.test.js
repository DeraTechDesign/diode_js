'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RPC = require('../rpc');

test('publisher rejections settle relay pending ports without blocking unrelated config opens', async () => {
  // Model the edge_v2 wire dispatch, not a mock of RPC.sendError: only these
  // two envelopes resolve PortCollection's pre_open entries.
  const pending = new Map();
  const connection = {
    async sendCommandWithSessionId(command, sessionId) {
      const [kind, ref, result] = command;
      assert.equal(sessionId, pending.get(ref.toString('hex')));
      if (command.length === 3 && (kind === 'error' || (kind === 'response' && result === 'ok')))
        pending.delete(ref.toString('hex'));
    },
  };
  const rpc = new RPC(connection);
  for (let attempt = 1; attempt <= 100; ++attempt) {
    const ref = Buffer.alloc(4); ref.writeUInt32BE(attempt);
    pending.set(ref.toString('hex'), attempt);
    await rpc.sendError(attempt, ref, 'Local service connection failed');
    assert.equal(pending.size, 0, 'failed apps must release the relay pending slot immediately');
  }
  const config = Buffer.from('01020304', 'hex'); pending.set(config.toString('hex'), 101);
  await rpc.sendResponse(101, config, 'ok');
  assert.equal(pending.size, 0);
});

test('rejection write failure remains observable to the publisher', async () => {
  const rpc = new RPC({ sendCommandWithSessionId: async () => { throw new Error('relay unavailable'); } });
  await assert.rejects(rpc.sendError(1, Buffer.alloc(4), 'denied'), /relay unavailable/);
});
