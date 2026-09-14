'use strict';

// Opt-in loopback comparison; no external relay or credentials are required.
// node scripts/benchmarkPublishFlows.js
// DIODE_FLOW_BENCH_ROUNDS=7 DIODE_FLOW_BENCH_MIB=8 may tune the workload.
const { runTunnel } = require('../test/apiTls.integration.test');

const rounds = Number(process.env.DIODE_FLOW_BENCH_ROUNDS || 5);
const mib = Number(process.env.DIODE_FLOW_BENCH_MIB || 4);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50 || !Number.isInteger(mib) || mib < 1 || mib > 64) {
  throw new Error('Benchmark rounds must be 1..50 and MiB must be 1..64');
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

(async () => {
  const results = [];
  for (const protocol of ['tcp', 'tls']) {
    for (const observed of [false, true]) {
      await runTunnel({ protocol, bytes: 1024 * 1024, flowObserver: observed ? () => {} : null });
    }
    const samples = { disabled: [], enabled: [] };
    const eventCounts = [];
    // Alternate order to reduce warmup/order bias. Snapshots every 25 ms are
    // deliberately frequent; real collectors generally snapshot less often.
    for (let round = 0; round < rounds; round += 1) {
      for (const observed of (round % 2 ? [true, false] : [false, true])) {
        let events = 0;
        const result = await runTunnel({
          protocol,
          bytes: mib * 1024 * 1024,
          flowObserver: observed ? () => { events += 1; } : null,
          flowSnapshotMs: observed ? 25 : 0,
        });
        samples[observed ? 'enabled' : 'disabled'].push(result.elapsedMs);
        if (observed) eventCounts.push(events);
      }
    }
    const disabledMedianMs = median(samples.disabled);
    const enabledMedianMs = median(samples.enabled);
    results.push({
      protocol, bytesEachDirection: mib * 1024 * 1024, rounds,
      disabledMedianMs, enabledMedianMs,
      changePercent: (enabledMedianMs / disabledMedianMs - 1) * 100,
      enabledEventCounts: eventCounts,
      samplesMs: samples,
    });
  }
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    scope: 'Loopback API tunnel with simulated relay RPC; measures observer lifecycle and 25ms snapshots, not a live-network guarantee.',
    results,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
