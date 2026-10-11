'use strict';
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createHarness } = require('../test/fixtures/udp-control-harness.cjs');
const { scheduleRate } = require('./benchmark-teleoperation');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sample(transport, policy) {
  const harness = await createHarness({ transport, policy, openingMs: 300 });
  try {
    const started = performance.now(); let offered = 0, skipped = 0;
    const sends = [];
    await scheduleRate({ hz: 100, seconds: .25, started, clock: () => performance.now(),
      send(seq) { const data = Buffer.alloc(64); data.writeUInt32BE(seq); data.writeDoubleBE(performance.now(), 4); offered++; sends.push(harness.send(data)); },
      skip(count) { skipped += count; },
    });
    await Promise.all(sends);
    await sleep(400);
    return { transport, policy: policy || 'legacy', scheduled: 25, sent: offered, schedulerSkipped: skipped, received: harness.packets.length,
      expiredDelivered: harness.packets.filter(p => p.receivedAt - p.data.readDoubleBE(4) > 50).length,
      maxAgeMs: Math.max(0, ...harness.packets.map(p => p.receivedAt - p.data.readDoubleBE(4))),
      sequences: harness.packets.map(p => p.data.readUInt32BE()), stats: harness.bind.getUdpSendStats?.(0) };
  } finally { await harness.close(); }
}
async function main() {
  const results = [];
  for (const transport of ['api', 'native']) for (const policy of process.argv.includes('--baseline') ? [null] : [null, { mode: 'latest', maxAgeMs: 50 }]) results.push(await sample(transport, policy));
  const json = JSON.stringify({ scope: 'Real local UDP; simulated 300 ms setup; open-loop 100 Hz source for 250 ms, missed sender ticks counted. Ages use the same monotonic clock.', results }, null, 2) + '\n';
  const output = process.argv.indexOf('--output');
  if (output >= 0) fs.writeFileSync(process.argv[output + 1], json); else process.stdout.write(json);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
