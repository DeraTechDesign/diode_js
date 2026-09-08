'use strict';

// Small live-network benchmark with disposable identities. Only the temporary
// echo service is published, privately to the benchmark's other identity.
process.env.LOG = 'false';
process.env.DEBUG = 'false';
process.env.DIODE_AUTO_RECONNECT = 'false';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const libraryPath = process.env.DIODE_BENCH_LIBRARY ? path.resolve(process.env.DIODE_BENCH_LIBRARY) : path.resolve(__dirname, '..');
const { DiodeConnection, PublishPort, BindPort } = require(libraryPath);
let { DiodeClientManager } = require(libraryPath);
const assert = require('node:assert/strict');
if (process.env.DIODE_BENCH_MANAGER_REF) {
  // Isolate manager changes against the same connection/transport code.
  const Module = require('node:module');
  const { execFileSync } = require('node:child_process');
  const filename = path.join(libraryPath, 'clientManager.js');
  const source = execFileSync('git', ['show', `${process.env.DIODE_BENCH_MANAGER_REF}:clientManager.js`], { cwd: libraryPath, encoding: 'utf8', windowsHide: true });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(libraryPath);
  loaded._compile(source, filename);
  DiodeClientManager = loaded.exports;
}

const round = (n) => Number(n.toFixed(2));
const hostKey = (c) => c && (c._managerHostKey || `${c.host}:${c.port}`);
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function timed(fn) {
  const start = performance.now();
  try { const value = await fn(); return { ok: true, ms: round(performance.now() - start), value }; }
  catch (error) { return { ok: false, ms: round(performance.now() - start), error: error.message }; }
}

// Record command names and timings, never ticket/key/payload contents.
function instrument(connection, events) {
  const send = connection._sendCommandTransportReady;
  connection._sendCommandTransportReady = async function(command, ...args) {
    const start = performance.now();
    try { return await send.call(this, command, ...args); }
    finally { events.push({ command: String(command[0]), ms: round(performance.now() - start) }); }
  };
}

async function selection(temp) {
  const manager = new DiodeClientManager({ keyLocation: path.join(temp, 'selection.json'), relaySelection: { scoreCachePath: null } });
  const fetchDirectory = manager._fetchNetworkDiscoveryNodes.bind(manager);
  let directoryClassification;
  manager._fetchNetworkDiscoveryNodes = async () => {
    const entries = await fetchDirectory();
    directoryClassification = { total: entries.length, disconnected: entries.filter((e) => !e.connected).length, connectedButUnusable: entries.filter((e, i) => e.connected && !manager._normalizeNetworkNode(e, i)).length };
    return entries;
  };
  const start = performance.now();
  let ready;
  try {
    await manager.connect();
    ready = { ms: round(performance.now() - start), relay: hostKey(manager.getNearestConnection()) };
    await manager._startupWorkPromise;
    if (manager._backgroundWarmupPromise) await manager._backgroundWarmupPromise;
    const relays = [...manager.relayScores.values()].map((s) => ({ host: s.hostKey, rttMs: s.lastProbeLatencyMs, failures: s.failureCount, source: s.discoveredFrom }));
    const settled = { ready, settledMs: round(performance.now() - start), selected: hostKey(manager.getNearestConnection()), discovery: manager._lastNetworkDiscoveryStats, directoryClassification, relays };
    // Reproduce score aging without waiting five minutes or changing the clock.
    // Hold measured RTTs fixed and age only the fastest relay's sample.
    const fastest = manager.getNearestConnection();
    const score = manager.relayScores.get(hostKey(fastest));
    if (score) {
      score.lastSuccessAt = Date.now() - 61000;
      manager._lastProbeStartedAt.set(hostKey(fastest), Date.now() - 61000);
      const selected = manager.getNearestConnection();
      settled.agedFastestScore = { selected: hostKey(selected), selectedRttMs: manager.relayScores.get(hostKey(selected))?.ewmaLatencyMs, fastest: hostKey(fastest), fastestRttMs: score.ewmaLatencyMs };
    }
    return settled;
  } finally { manager.close(); }
}

async function probeSeeds(temp) {
  const manager = new DiodeClientManager({ keyLocation: path.join(temp, 'probe.json'), relaySelection: { scoreCachePath: null } });
  const results = [];
  // Sequential trials avoid competing handshakes distorting RTT samples.
  for (const host of manager.initialHosts) {
    const [hostname, port] = host.split(':');
    const c = new DiodeConnection(hostname, Number(port), path.join(temp, 'probe.json'));
    c.setReconnectOptions({ autoReconnect: false, connectTimeoutMs: 8000 });
    const commands = [];
    instrument(c, commands);
    const start = performance.now();
    try {
      await c.connect();
      const connectMs = round(performance.now() - start);
      const rtt = [];
      for (let i = 0; i < 5; i += 1) {
        const pingStart = performance.now();
        if (!await c.RPC.ping({ timeoutMs: 1500 })) throw new Error('Ping failed');
        rtt.push(round(performance.now() - pingStart));
      }
      results.push({ host, ok: true, connectMs, medianRttMs: median(rtt), rtt, commands });
    } catch (error) { results.push({ host, ok: false, ms: round(performance.now() - start), error: error.message, commands }); }
    finally { c.close(); }
    process.stderr.write(`Probed ${host}: ${JSON.stringify(results.at(-1))}\n`);
  }
  manager.close();
  return results;
}

function exchange(socket, payload, udpPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const chunks = [];
    const start = performance.now();
    const event = udpPort ? 'message' : 'data';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off(event, onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) return reject(error);
      try { assert.deepEqual(Buffer.concat(chunks), payload); resolve(round(performance.now() - start)); }
      catch (e) { reject(e); }
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error(`Socket closed after ${received}/${payload.length} echo bytes`));
    const onData = (data) => { chunks.push(data); received += data.length; if (received >= payload.length) finish(); };
    const timer = setTimeout(() => finish(new Error(`Echo timed out after ${received}/${payload.length} bytes`)), timeoutMs);
    socket.on(event, onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (udpPort) socket.send(payload, udpPort, '127.0.0.1', (e) => { if (e) finish(e); });
    else socket.write(payload);
  });
}

async function udpBulk(socket, port) {
  const count = 200;
  const payload = Buffer.alloc(1024, 0x6b);
  const seen = new Set();
  let lastReceive = 0;
  let invalidPacket = null;
  const start = performance.now();
  const receive = (data) => {
    try {
      assert.equal(data.length, payload.length);
      const id = data.readUInt32BE();
      assert.ok(id < count && data.subarray(4).every((b) => b === 0x6b));
      seen.add(id);
      lastReceive = performance.now();
    } catch (error) { invalidPacket = error; }
  };
  socket.on('message', receive);
  try {
    for (let i = 0; i < count; i += 1) {
      const packet = Buffer.from(payload);
      packet.writeUInt32BE(i);
      await new Promise((resolve, reject) => socket.send(packet, port, '127.0.0.1', (e) => e ? reject(e) : resolve()));
      await delay(2);
    }
    const sentMs = performance.now() - start;
    const deadline = performance.now() + 3000;
    while (seen.size < count && performance.now() < deadline) await delay(20);
    if (invalidPacket) throw invalidPacket;
    return { sent: count, received: seen.size, lossPct: round(100 * (count - seen.size) / count), offeredMbps: round(count * 1024 * 8 / sentMs / 1000), echoMbps: lastReceive ? round(seen.size * 1024 * 8 / (lastReceive - start) / 1000) : 0 };
  } finally { socket.off('message', receive); }
}

async function transportSample(binder, publisher, protocol, transport, bytes) {
  let publish, bind, client, backend;
  const sockets = new Set();
  const udp = protocol === 'udp';
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const cpuStart = process.cpuUsage();
  loop.enable();
  try {
    if (udp) {
      backend = dgram.createSocket('udp4');
      backend.on('message', (data, remote) => backend.send(data, remote.port, remote.address));
      backend.bind(0, '127.0.0.1');
    } else {
      backend = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.setNoDelay(true);
        socket.pipe(socket);
      });
      backend.listen(0, '127.0.0.1');
    }
    await once(backend, 'listening');
    const source = binder.getNearestConnection ? binder.getNearestConnection() : binder;
    const target = publisher.getNearestConnection ? publisher.getNearestConnection() : publisher;
    publish = new PublishPort(publisher, { [backend.address().port]: { mode: 'private', whitelist: [source.getEthereumAddress()], host: '127.0.0.1' } });
    bind = new BindPort(binder, { 0: { targetPort: backend.address().port, deviceIdHex: target.getEthereumAddress(), protocol, transport } });
    let openedRelay;
    const open = bind._openPortWithRelayFallback;
    if (open) bind._openPortWithRelayFallback = async function(...args) {
      const result = await open.apply(this, args);
      openedRelay = hostKey(result.connection);
      return result;
    };
    const listening = once(bind, 'listening');
    bind.bindSinglePort(0);
    const [address] = await listening;
    client = udp ? dgram.createSocket('udp4') : net.connect({ host: '127.0.0.1', port: address.localPort });
    client.on('error', () => {});
    if (!udp) client.setNoDelay(true);
    const udpPort = udp ? address.localPort : null;
    const firstEchoMs = await exchange(client, Buffer.alloc(32, 0x71), udpPort);
    const rtt = [];
    for (let i = 0; i < 5; i += 1) rtt.push(await exchange(client, Buffer.alloc(32, 0x72), udpPort));
    let bulk;
    if (udp) bulk = await udpBulk(client, udpPort);
    else {
      const payload = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;
      const ms = await exchange(client, payload);
      bulk = { bytes, ms, echoMbps: round(bytes * 8 / ms / 1000) };
    }
    const cpu = process.cpuUsage(cpuStart);
    return { openedRelay, firstEchoMs, rtt, medianRttMs: median(rtt), bulk, cpuMs: round((cpu.user + cpu.system) / 1000), eventLoopP99Ms: round(loop.percentile(99) / 1e6) };
  } finally {
    loop.disable();
    if (client) { if (udp) { try { client.close(); } catch (_) {} } else client.destroy(); }
    if (bind) bind.dispose();
    if (publish) publish.close();
    for (const socket of sockets) socket.destroy();
    if (backend) await new Promise((resolve) => { try { backend.close(resolve); } catch (_) { resolve(); } });
  }
}

async function transports(temp, relayHost, repetitions = 2) {
  const args = { host: relayHost, relaySelection: { scoreCachePath: null } };
  const binder = new DiodeClientManager({ ...args, keyLocation: path.join(temp, 'binder.json') });
  const publisher = new DiodeClientManager({ ...args, keyLocation: path.join(temp, 'publisher.json') });
  const results = [];
  try {
    await Promise.all([binder.connect(), publisher.connect()]);
    await Promise.all([binder._startupWorkPromise, publisher._startupWorkPromise]);
    const source = binder.getNearestConnection();
    const target = publisher.getNearestConnection();
    for (let sample = 0; sample < repetitions; sample += 1) {
      for (const [protocol, transport] of [['tcp', 'api'], ['tls', 'api'], ['udp', 'api'], ['tcp', 'native'], ['udp', 'native']]) {
        const result = { relay: relayHost, protocol, transport, sample, ...await timed(() => transportSample(source, target, protocol, transport, 1024 * 1024)) };
        results.push(result);
        process.stderr.write(`Transport: ${JSON.stringify(result)}\n`);
      }
    }
  } finally { binder.close(); publisher.close(); }
  return results;
}

async function routing(temp) {
  const hosts = ['eu1.prenet.diode.io:41046', 'us2.prenet.diode.io:41046', 'as1.prenet.diode.io:41046'];
  const options = { hosts, relaySelection: { scoreCachePath: null } };
  const binder = new DiodeClientManager({ ...options, keyLocation: path.join(temp, 'route-binder.json') });
  const publisher = new DiodeClientManager({ ...options, keyLocation: path.join(temp, 'route-publisher.json') });
  const results = [];
  try {
    await Promise.all([binder.connect(), publisher.connect()]);
    await Promise.all([binder._startupWorkPromise, publisher._startupWorkPromise]);
    const fastest = binder.getNearestConnection();
    const score = binder.relayScores.get(hostKey(fastest));
    const target = publisher.getNearestConnection().getEthereumAddress();
    const answers = [];
    for (const c of binder.getConnections()) {
      const result = await timed(() => binder._resolveDeviceRelayCandidate(c, Buffer.from(target.replace(/^0x/, ''), 'hex')));
      answers.push({ via: hostKey(c), ok: result.ok, ms: result.ms, destination: result.value?.hostKey, error: result.error });
    }
    for (const phase of ['fresh', 'fast-score-aged']) {
      if (phase === 'fast-score-aged') {
        score.lastSuccessAt = Date.now() - 61000;
        binder._lastProbeStartedAt.set(hostKey(fastest), Date.now() - 61000);
      }
      for (const [protocol, transport] of [['tcp', 'api'], ['tls', 'api'], ['udp', 'api'], ['tcp', 'native'], ['udp', 'native']]) {
        binder.deviceRelayCache.clear();
        const controlRelay = hostKey(binder.getNearestConnection());
        const result = { phase, controlRelay, protocol, transport, ...await timed(() => transportSample(binder, publisher, protocol, transport, 1024 * 1024)) };
        const trace = binder._lastDeviceResolutionTrace;
        result.route = trace && { lookupMs: trace.primaryLookupMs, initial: trace.initialHostKey, final: trace.finalHostKey, reconciliation: trace.reconciliation };
        results.push(result);
        process.stderr.write(`Routing: ${JSON.stringify(result)}\n`);
      }
    }
    return { fastest: hostKey(fastest), answers, results };
  } finally { binder.close(); publisher.close(); }
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/benchmark-network.js [--routing | --relay HOST] [--output FILE]\nDefault: discover/rank relays, reproduce score aging, and measure all six seeds.\n--routing: five transports through three managed relays, with fresh and aged scores.\n--relay: two samples of API TCP/TLS/UDP and Native TCP/UDP through one relay.\nDIODE_BENCH_LIBRARY selects a historical checkout; DIODE_BENCH_MANAGER_REF replaces only the manager from a git ref.\n');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-network-bench-'));
  const report = { date: new Date().toISOString(), node: process.version, version: require(path.join(libraryPath, 'package.json')).version, managerRef: process.env.DIODE_BENCH_MANAGER_REF || 'working-tree', scope: 'Live public relay network, disposable local identities; echoMbps counts payload once over upload+echo time, not one-way capacity' };
  try {
    const relayIndex = process.argv.indexOf('--relay');
    if (process.argv.includes('--routing')) {
      report.routing = await routing(temp);
    } else if (relayIndex >= 0) {
      report.transports = await transports(temp, process.argv[relayIndex + 1]);
    } else {
      report.selection = await selection(temp);
      process.stderr.write(`Selection: ${JSON.stringify(report.selection)}\n`);
      report.seeds = await probeSeeds(temp);
    }
  } finally {
    // temp is the exact directory returned by mkdtemp, never an input path.
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const outputIndex = process.argv.indexOf('--output');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], json);
  process.stdout.write(json);
  if ((report.transports || report.routing?.results || []).some((result) => !result.ok)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
