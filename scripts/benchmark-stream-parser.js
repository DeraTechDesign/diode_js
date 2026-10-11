'use strict';
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
if (option('--source-snapshot')) require('./source-snapshot.cjs').loadSourceSnapshot(option('--source-snapshot'));
const { parserConnection, frame } = require('../test/fixtures/stream-parser.cjs');
async function main() {
  const results = [];
  for (const fragmentBytes of [64, 1024, 16384, 65536]) {
    const payload = Buffer.alloc(65000, 0x39), wire = frame(1, payload), samples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const connection = parserConnection(); let delivered = 0;
      // Isolate framing/decoding cost; dispatcher fairness is measured separately.
      connection._deferUnsolicited = message => { assert.ok(Buffer.from(message[1][2]).equals(payload)); delivered++; };
      const start = performance.now();
      for (let i = 0; i < 128; i++) for (let offset = 0; offset < wire.length; offset += fragmentBytes) connection._handleData(wire.subarray(offset, offset + fragmentBytes), 1);
      assert.equal(delivered, 128); assert.equal(connection.receiveBuffer.length, 0);
      samples.push(performance.now() - start);
    }
    results.push({ fragmentBytes, payloadBytes: 128 * payload.length, samplesMs: samples, medianMs: [...samples].sort((a,b) => a-b)[2], integrity: true });
  }
  const connection = parserConnection(); let delivered = 0;
  connection.on('unsolicited', () => { delivered++; });
  for (let i = 0; i < 10000; i++) connection._deferUnsolicited(i, 1);
  await new Promise(resolve => setImmediate(resolve)); const beforeOtherWork = delivered;
  while (delivered < 10000) await new Promise(resolve => setImmediate(resolve));
  const report = { node: process.version, source: option('--source-snapshot', 'working tree'), scope: 'In-process real relay RLP parser, fragmentation sweep, five repetitions; CPU cost, not WAN latency.', results,
    dispatch: { total: delivered, beforeOtherEventLoopWork: beforeOtherWork } };
  const output = option('--output', 'out/stream-parser.json'); fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ source: report.source, results: results.map(r => ({ fragmentBytes: r.fragmentBytes, medianMs: r.medianMs })), dispatch: report.dispatch }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
