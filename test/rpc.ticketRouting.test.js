const test = require('node:test');
const assert = require('node:assert/strict');
const { RLP } = require('@ethereumjs/rlp');
const DiodeRPC = require('../rpc');

const issuer = Buffer.alloc(20, 1);
const preferred = Buffer.alloc(20, 2);
const hex = value => `0x${value.toString('hex')}`;
async function parse(type, hint) {
  const object = type === 'ticketv2'
    ? [type, issuer, 1284, 690, Buffer.alloc(20), 1, 128000, hint, Buffer.alloc(65), Buffer.alloc(65)]
    : [type, issuer, 123, Buffer.alloc(20), 1, 128000, hint, Buffer.alloc(65), Buffer.alloc(65)];
  return new DiodeRPC({ sendCommand: async () => [object] }).getObject(Buffer.alloc(20, 3));
}

for (const type of ['ticket', 'ticketv2']) {
  test(`${type} preserves the issuing relay and decodes host relay preference`, async () => {
    const secondary = await parse(type, Buffer.concat([Buffer.from([0]), preferred]));
    assert.equal(secondary.serverIdHex, hex(issuer));
    assert.deepEqual(secondary.preferredServerIds, [hex(preferred), hex(issuer)]);
    const primary = await parse(type, Buffer.concat([Buffer.from([1]), preferred]));
    assert.deepEqual(primary.preferredServerIds, [hex(issuer), hex(preferred)]);
  });
  test(`${type} accepts metadata relay hints and ignores unknown fields`, async () => {
    const hint = Buffer.concat([Buffer.from([2]), Buffer.from(RLP.encode([
      ['future', ['ignored']], ['s', [preferred, preferred, Buffer.alloc(19), issuer]], ['t', 1792000000],
    ]))]);
    const result = await parse(type, hint);
    assert.deepEqual(result.preferredServerIds, [hex(preferred), hex(issuer)]);
  });
  test(`${type} falls back to issuer for absent or malformed hints`, async () => {
    for (const hint of [undefined, Buffer.alloc(0), Buffer.from([0]), Buffer.alloc(22), Buffer.from([2, 255]),
      Buffer.from([3, ...preferred]), Buffer.concat([Buffer.from([2]), Buffer.from(RLP.encode([['s', [Buffer.alloc(19)]]]))])]) {
      assert.deepEqual((await parse(type, hint)).preferredServerIds, [hex(issuer)]);
    }
  });
}
