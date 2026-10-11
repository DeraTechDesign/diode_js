'use strict';

// Real local endpoints and library transport, simulated relay for repeatable
// impairment tests; --live also uses public relays with disposable identities.
process.env.LOG = 'false';
process.env.DEBUG = 'false';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const round = n => Number(n.toFixed(3));
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const percentile = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { count: sorted.length, min: round(sorted[0]), p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: round(sorted.at(-1)) };
}
async function completeFlows(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

async function measure(name, settings, task, repetitions) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const cpu = process.cpuUsage(), start = performance.now(), rssStart = process.memoryUsage().rss;
  let peakRss = rssStart;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  delay.enable();
  const samples = [];
  try {
    for (let i = 0; i < repetitions; i++) {
      const started = performance.now();
      try { samples.push({ ok: true, ...await task(), wallMs: round(performance.now() - started) }); }
      catch (error) { samples.push({ ok: false, error: error.code || error.name || 'Error', message: String(error.message).slice(0, 240), wallMs: round(performance.now() - started) }); }
    }
  } finally { clearInterval(sampler); delay.disable(); }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const usage = process.cpuUsage(cpu);
  const result = {
    name, settings, passed: samples.filter(s => s.ok).length, failed: samples.filter(s => !s.ok).length,
    wallMs: round(performance.now() - start), latencyMs: distribution(samples.filter(s => s.ok).map(s => s.elapsedMs ?? s.wallMs)),
    firstByteMs: distribution(samples.filter(s => s.ok).map(s => s.firstByteMs ?? s.firstEchoMs)),
    cpuMs: round((usage.user + usage.system) / 1000), rssStartBytes: rssStart, rssPeakBytes: peakRss,
    rssEndBytes: process.memoryUsage().rss, eventLoopP99Ms: round(delay.percentile(99) / 1e6), samples,
  };
  process.stderr.write(`${name}: ${result.passed}/${samples.length} passed, p50 ${result.latencyMs?.p50 ?? '-'} ms\n`);
  return result;
}

async function smallWrites(ackRttMs) {
  const DiodeSocket = require('../diodeSocket');
  let frames = 0, inFlight = 0, peak = 0;
  const timers = new Set(), received = [];
  const socket = new DiodeSocket(Buffer.from([1]), { portSend(_ref, data) {
    frames++; inFlight++; peak = Math.max(peak, inFlight); received.push(Buffer.from(data));
    return new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); inFlight--; resolve(); }, ackRttMs); timers.add(timer); });
  } });
  const started = performance.now();
  try {
    const finished = once(socket, 'finish');
    for (let i = 0; i < 512; i++) socket.write(Buffer.alloc(128, i % 251));
    socket.end(); await finished;
    const expected = Buffer.concat(Array.from({ length: 512 }, (_, i) => Buffer.alloc(128, i % 251)));
    require('node:assert/strict').deepEqual(Buffer.concat(received), expected);
    return { elapsedMs: round(performance.now() - started), frames, peakInFlightFrames: peak, bytes: expected.length, integrity: true };
  } finally { socket.destroy(); for (const timer of timers) clearTimeout(timer); }
}

async function localMatrix(repetitions, quick) {
  const { runTunnel } = require('../test/apiTls.integration.test');
  const { runNativeTunnel } = require('../test/nativeTcp.integration.test');
  const rows = [];
  for (const rtt of [20, 100]) rows.push(await measure(`small-write-burst-${rtt}`, { ackRttMs: rtt, writes: 512, writeBytes: 128 }, () => smallWrites(rtt), repetitions));
  for (const protocol of ['tcp', 'tls']) {
    for (const ackRttMs of quick ? [0, 80] : [0, 40, 150]) {
      for (const bytes of [1024, 1024 * 1024]) {
        for (const concurrency of quick ? [1] : [1, 4]) {
          const settings = { protocol, transport: 'api', ackRttMs, bytes, concurrency };
          rows.push(await measure(`api-${protocol}-${bytes}-${ackRttMs}-${concurrency}`, settings, async () => {
            const started = performance.now();
            const flows = await completeFlows(Array.from({ length: concurrency }, () => runTunnel({ bytes, protocol, ackRttMs })));
            const elapsedMs = performance.now() - started;
            return { elapsedMs: round(elapsedMs), firstByteMs: Math.max(...flows.map(f => f.firstByteMs)), payloadOnceMbps: round(bytes * concurrency * 8 / elapsedMs / 1000), integrity: true, flows };
          }, repetitions));
        }
      }
    }
    for (const direction of ['upload', 'download']) {
      const settings = { protocol, bytes: 2 * 1024 * 1024, ackRttMs: 40, slowReaderDelayMs: 20, direction };
      rows.push(await measure(`slow-${protocol}-${direction}`, settings, () => runTunnel({ protocol, bytes: settings.bytes, ackRttMs: 40, readDelayMs: 20, clientEnds: direction === 'upload', slowBackend: direction === 'upload', backendEnds: direction === 'download', slowReader: direction === 'download' }), repetitions));
    }
    for (const side of ['binder', 'publisher']) rows.push(await measure(`send-failure-${protocol}-${side}`, { protocol, side }, () => runTunnel({ protocol, bytes: 4096, ackRttMs: 40, failSend: side }), repetitions));
  }
  for (const settings of [
    { requestBytes: 1024, responseBytes: 1024, serverFirst: true },
    { requestBytes: 1024 * 1024, responseBytes: 1024 * 1024 },
    { requestBytes: 2 * 1024 * 1024, responseBytes: 128, slowBackend: true },
    { requestBytes: 128, responseBytes: 2 * 1024 * 1024, slowClient: true },
  ]) rows.push(await measure(`native-tcp-${rows.length}`, { ...settings, scope: 'local relay pairing, no simulated WAN latency' }, () => runNativeTunnel(settings), repetitions));
  return rows;
}

async function liveMatrix(repetitions) {
  const { DiodeClientManager } = require('..');
  const { transportSample } = require('./benchmark-network');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-stability-'));
  const managers = ['binder', 'publisher'].map(name => new DiodeClientManager({
    ...(option('--relay') ? { host: option('--relay') } : {}), keyLocation: path.join(temp, `${name}.json`), relaySelection: { scoreCachePath: null },
  }));
  const rows = [];
  try {
    const started = performance.now();
    await Promise.all(managers.map(m => m.connect()));
    const readyMs = round(performance.now() - started);
    await Promise.all(managers.map(m => m._startupWorkPromise));
    for (const [protocol, transport] of [['tcp', 'api'], ['tls', 'api'], ['udp', 'api'], ['tcp', 'native'], ['udp', 'native']]) {
      for (const concurrency of [1, 4]) rows.push(await measure(`live-${transport}-${protocol}-${concurrency}`, { protocol, transport, concurrency, readyMs }, async () => {
        const flows = await completeFlows(Array.from({ length: concurrency }, () => transportSample(managers[0], managers[1], protocol, transport, 1024 * 1024, { rttSamples: 20, idleMs: 1000 })));
        const rtts = flows.flatMap(f => f.rtt);
        const jitter = flows.flatMap(f => f.rtt.slice(1).map((value, i) => Math.abs(value - f.rtt[i])));
        return { firstEchoMs: Math.max(...flows.map(f => f.firstEchoMs)), rttMs: distribution(rtts), jitterMs: distribution(jitter), flows };
      }, repetitions));
    }
    const soakSeconds = Number(option('--soak-seconds', 30));
    if (!Number.isFinite(soakSeconds) || soakSeconds < 0 || soakSeconds > 86400) throw new Error('--soak-seconds must be 0..86400');
    if (soakSeconds) rows.push(await measure('live-persistent-mixed-soak', { seconds: soakSeconds, concurrency: 2 }, async () => ({
      flows: await completeFlows([['tls', 'api'], ['tcp', 'native']].map(([protocol, transport]) =>
        transportSample(managers[0], managers[1], protocol, transport, 1024 * 1024, { durationMs: soakSeconds * 1000, pingIntervalMs: 200 }))),
    }), 1));
    // Drop only these disposable managers' sockets, then verify new sessions.
    rows.push(await measure('live-relay-reconnect', { protocol: 'tls', transport: 'api' }, async () => {
      const started = performance.now();
      const connection = managers[0].getNearestConnection();
      connection.socket.destroy();
      await connection._ensureConnected();
      const flow = await transportSample(managers[0], managers[1], 'tls', 'api', 65536);
      return { elapsedMs: round(performance.now() - started), flow };
    }, repetitions));
  } finally {
    managers.forEach(m => m.close());
    // This exact path was returned by mkdtemp; no user-supplied deletion path.
    if (path.dirname(temp) === path.resolve(os.tmpdir())) fs.rmSync(temp, { recursive: true, force: true });
  }
  return rows;
}

async function main() {
  if (args.includes('--help')) {
    console.log('node scripts/benchmark-stability.js [--quick] [--live] [--live-only] [--relay HOST:PORT] [--soak-seconds N] [--samples N] [--output FILE] [--socket-ref GIT_REF]\nDefault: controlled local matrix. Live mode publishes only a disposable private loopback echo server. --soak-seconds defaults to 30 (0 disables; maximum 86400). PayloadOnceMbps counts echoed payload once; local concurrency uses independent simulated relay pairs.');
    return;
  }
  const repetitions = Number(option('--samples', 3));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('--samples must be 1..100');
  const reference = option('--socket-ref');
  if (reference) {
    const Module = require('node:module'), filename = require.resolve('../diodeSocket');
    const source = execFileSync('git', ['show', `${reference}:diodeSocket.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    const baseline = new Module(filename, module);
    baseline.filename = filename; baseline.paths = Module._nodeModulePaths(path.dirname(filename)); baseline._compile(source, filename);
    require.cache[filename] = baseline;
  }
  const report = { schemaVersion: 1, date: new Date().toISOString(), node: process.version, platform: process.platform, library: require('../package.json').version, socketRef: reference || 'working-tree', repetitions, scope: 'Synthetic binary workloads; local simulations and live public relay measurements are separate. No real RDP/SQL application or physical mobile qualification.', local: [], live: [] };
  if (!args.includes('--live-only')) report.local = await localMatrix(repetitions, args.includes('--quick'));
  if (args.includes('--live') || args.includes('--live-only')) report.live = await liveMatrix(repetitions);
  report.failed = [...report.local, ...report.live].reduce((n, row) => n + row.failed, 0);
  const json = JSON.stringify(report, null, 2) + '\n';
  const output = option('--output');
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, json); }
  else process.stdout.write(json);
  process.exitCode = report.failed ? 1 : 0;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { distribution, measure, smallWrites };
