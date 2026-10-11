'use strict';
// Synthetic teleoperation qualification. Independent controller/robot processes
// share this host's monotonic clock. No robot hardware or customer service.
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { Worker, isMainThread, workerData } = require('node:worker_threads');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => Math.round(n * 1000) / 1000;
const PACKET_BYTES = 128, MAGIC = 0x4f524354;
const PACKET_PADDING = Buffer.alloc(PACKET_BYTES - 40, 0x69);
function distribution(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const p = q => round(a[Math.max(0, Math.ceil(q * a.length) - 1)]);
  return { count: a.length, min: a[0], p50: p(.5), p95: p(.95), p99: p(.99), p999: p(.999), max: a.at(-1) };
}
function deadlineCounts(expected, hz, warmupSeconds, sequences) {
  const delivered = new Set(sequences);
  let onTime = 0, burst = 0, longest = 0, steadyOnTime = 0, steadyBurst = 0, longestSteady = 0;
  const warmupSlots = Math.min(expected, Math.ceil(hz * warmupSeconds));
  for (let seq = 0; seq < expected; seq++) {
    const present = delivered.has(seq);
    if (present) onTime++;
    burst = present ? 0 : burst + 1; longest = Math.max(longest, burst);
    if (seq >= warmupSlots) {
      if (present) steadyOnTime++;
      steadyBurst = present ? 0 : steadyBurst + 1; longestSteady = Math.max(longestSteady, steadyBurst);
    }
  }
  return { expected, onTime, deadlineMissed: expected - onTime, deadlineMissPct: 100 * (expected - onTime) / expected,
    longestMissBurstMs: longest * 1000 / hz,
    steadyState: { warmupSeconds, expected: expected - warmupSlots, onTime: steadyOnTime,
      deadlineMissPct: 100 * (expected - warmupSlots - steadyOnTime) / (expected - warmupSlots), longestMissBurstMs: longestSteady * 1000 / hz } };
}
function packet(seq, epoch, scheduled) {
  const data = Buffer.alloc(PACKET_BYTES, 0x69);
  data.writeUInt32BE(MAGIC, 0); data.writeUInt32BE(seq, 4); data.writeUInt32BE(epoch, 8);
  data.writeUInt32BE(0, 12); data.writeDoubleBE(scheduled, 16); data.writeDoubleBE(now(), 24); data.writeDoubleBE(0, 32);
  return data;
}
function freshnessTimeline(expected, hz, started, injectedAt, arrivals) {
  const firstArrival = values => values.length ? values.reduce((first, value) => Math.min(first, value.receivedAtMonoMs), Infinity) : null;
  const first = firstArrival(arrivals);
  const result = { firstFreshCommandAtRunMs: first === null ? null : first - started };
  if (!Number.isFinite(injectedAt)) return result;
  // Attribute commands by their scheduled time, not by when delayed bytes
  // finally arrive. Otherwise startup congestion can look like failed recovery.
  const split = Math.max(0, Math.min(expected, Math.ceil((injectedAt - started) * hz / 1000)));
  const before = arrivals.filter(value => value.sequence < split), after = arrivals.filter(value => value.sequence >= split);
  const range = (offset, count, values) => count ? { firstScheduledSequence: offset,
    ...deadlineCounts(count, hz, 0, values.map(value => value.sequence - offset)) } : null;
  const recovered = firstArrival(after);
  return { ...result, beforeInjection: range(0, split, before), afterInjection: range(split, expected - split, after),
    firstFreshPostInjectionMs: recovered === null ? null : recovered - injectedAt };
}
function frames(callback) {
  let pending = Buffer.alloc(0);
  return data => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= PACKET_BYTES) { const frame = Buffer.from(pending.subarray(0, PACKET_BYTES)); pending = pending.subarray(PACKET_BYTES); callback(frame); }
  };
}
function checkWatchdog(state, deadlineNs, atNs = process.hrtime.bigint()) {
  const last = Atomics.load(state, 0);
  if (last <= 0n || atNs - last < deadlineNs) return false;
  // Race the receiver's timestamp update on one atomic cell. A fresh command
  // wins OR the stop latches; the receiver can never overwrite a latched stop.
  if (Atomics.compareExchange(state, 0, last, -1n) !== last) return false;
  Atomics.store(state, 2, atNs - last); Atomics.store(state, 3, atNs); Atomics.store(state, 1, 1n);
  return true;
}
function robotReceiver(job, watch, clock = now) {
  const ages = [], arrivalGaps = [], onTimeArrivals = new Map();
  const counts = { received: 0, accepted: 0, expired: 0, reordered: 0, invalid: 0, stopped: 0 };
  let lastSequence = -1, lastArrival = 0, stallInjected = false, injectedFaultAtMonoMs, firstAcceptedAtMonoMs;
  return {
    receive(data, reply) {
      if (data.length !== PACKET_BYTES || data.readUInt32BE() !== MAGIC || data.readUInt32BE(8) !== job.epoch || data.readUInt32BE(4) >= Math.floor(job.hz * job.seconds) || !data.subarray(40).equals(PACKET_PADDING)) { counts.invalid++; return; }
      if (job.fault === 'robot-stall' && !stallInjected && data.readUInt32BE(4) >= job.hz * job.seconds / 2) {
        stallInjected = true; injectedFaultAtMonoMs = now(); const until = injectedFaultAtMonoMs + 250; while (now() < until) {}
      }
      const receivedAt = clock(), age = receivedAt - data.readDoubleBE(16), sequence = data.readUInt32BE(4);
      counts.received++; ages.push(age);
      if (Number.isFinite(age) && age >= 0 && age <= job.deadlineMs && !onTimeArrivals.has(sequence)) onTimeArrivals.set(sequence, receivedAt);
      if (lastArrival) arrivalGaps.push(receivedAt - lastArrival); lastArrival = receivedAt;
      let status = 0;
      if (!Number.isFinite(age) || age < 0 || age > job.deadlineMs) { counts.expired++; status = 1; }
      else if (sequence <= lastSequence) { counts.reordered++; status = 2; }
      else {
        const previous = Atomics.load(watch, 0);
        if (previous < 0n || Atomics.compareExchange(watch, 0, previous, BigInt(Math.round(receivedAt * 1e6))) !== previous) { counts.stopped++; status = 3; }
        else { counts.accepted++; lastSequence = sequence; firstAcceptedAtMonoMs ??= receivedAt; }
      }
      const response = Buffer.from(data); response.writeUInt32BE(status, 12); response.writeDoubleBE(receivedAt, 32); reply(response);
    },
    report: () => ({ counts, onTimeSequences: [...onTimeArrivals.keys()],
      onTimeArrivals: [...onTimeArrivals].map(([sequence, receivedAtMonoMs]) => ({ sequence, receivedAtMonoMs })),
      firstAcceptedAtMonoMs, injectedFaultAtMonoMs, commandAgeMs: distribution(ages), arrivalGapMs: distribution(arrivalGaps) }),
  };
}
function scheduleRate({ hz, seconds, started, send, skip, clock = now, schedule = setTimeout }) {
  const period = 1000 / hz, expected = Math.floor(hz * seconds);
  return new Promise(resolve => {
    let next = 0;
    const tick = () => {
      const current = Math.max(next, Math.floor((clock() - started) / period));
      if (current >= expected) { skip(Math.max(0, expected - next)); resolve(); return; }
      if (clock() < started + next * period) { schedule(tick, Math.max(1, started + next * period - clock())); return; }
      skip(current - next); send(current, started + current * period); next = current + 1;
      schedule(tick, Math.max(1, started + next * period - clock()));
    };
    tick();
  });
}

// Test-only impairment after native encryption/local submission. This models a
// bounded link queue; it does not change host networking or a customer's relay.
function impairDatagrams(bind, job, getStarted) {
  const originalOpen = bind._getOrOpenNativeUdpRelay.bind(bind), wrapped = new WeakSet(), pending = new Set();
  const stats = { affected: 0, dropped: 0, delayed: 0, peakQueued: 0, cancelled: 0, sendErrors: 0 };
  bind._getOrOpenNativeUdpRelay = async (...args) => {
    const relay = await originalOpen(...args);
    if (!relay || wrapped.has(relay.socket)) return relay;
    wrapped.add(relay.socket); const originalSend = relay.socket.send.bind(relay.socket);
    relay.socket.send = (data, port, host, callback) => {
      const elapsed = now() - getStarted(), start = job.seconds * 500;
      if (elapsed < start || elapsed >= start + 500) return originalSend(data, port, host, callback);
      if (!stats.affected) stats.startedAtMonoMs = now();
      stats.affected++;
      const delay = job.fault === 'packet-delay' ? 80 : job.fault === 'packet-reorder' && stats.affected % 3 === 0 ? 25 : 0;
      if (job.fault === 'burst-loss' || pending.size >= 64) { stats.dropped++; queueMicrotask(() => callback?.(null)); return; }
      if (!delay) return originalSend(data, port, host, callback);
      stats.delayed++; const owned = Buffer.from(data);
      const timer = setTimeout(() => {
        pending.delete(timer);
        try { originalSend(owned, port, host, error => { if (error) stats.sendErrors++; }); } catch (_) { stats.sendErrors++; }
      }, delay);
      pending.add(timer); stats.peakQueued = Math.max(stats.peakQueued, pending.size);
      // The source completed submission. The artificial link now owns the bytes.
      queueMicrotask(() => callback?.(null));
    };
    return relay;
  };
  return { stats, close() { for (const timer of pending) clearTimeout(timer); stats.cancelled += pending.size; pending.clear(); } };
}

function controlPathSockets(bind, dataPath = false) {
  const selected = new Set();
  for (const context of bind._activeContexts || []) {
    if (context.closed) continue;
    if (dataPath && context.physicalPort) {
      for (const socket of context.sockets || []) if (!socket.destroyed && socket.remotePort === context.physicalPort) selected.add(socket);
    } else if (context.connection?.socket && !context.connection.socket.destroyed) selected.add(context.connection.socket);
  }
  return [...selected];
}

async function endpoint(role, keyPath, direct = false) {
  const snapshotIndex = process.argv.indexOf('--source-snapshot');
  if (snapshotIndex >= 0) require('./source-snapshot.cjs').loadSourceSnapshot(process.argv[snapshotIndex + 1]);
  const { DiodeClientManager, BindPort, PublishPort } = require('..');
  const manager = direct ? { connect: async () => {}, close() {}, getNearestConnection: () => ({ getEthereumAddress: () => '0x' + '00'.repeat(20) }) }
    : new DiodeClientManager({ keyLocation: keyPath, relaySelection: { scoreCachePath: null } });
  const sockets = new Set(), binds = [], servers = [], faultTimers = new Set(), activePaths = new Map();
  const sendReport = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
  let publish, watchdog, sampler, impairment, stopBackground = () => {}, stopping = false;
  const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
  const cpuStart = process.cpuUsage(); let peakRss = process.memoryUsage().rss;
  const queues = { sampleIntervalMs: 100, peakRelayWritableBytes: 0, peakSendWindowBytes: 0, peakStreamWritableBytes: 0, peakStreamInboundBytes: 0, peakUnsolicitedFrames: 0 };
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    for (const bind of binds) for (const context of bind._activeContexts || []) {
      if (context.closed) continue;
      const host = context.connection?.host;
      const key = `${bind._benchmarkRole}:${host}:${context.physicalPort || 'api'}`;
      if (!activePaths.has(key)) activePaths.set(key, { stream: bind._benchmarkRole, relayHost: host,
        nativePort: context.physicalPort || null, firstObservedMonoMs: now() });
      activePaths.get(key).lastObservedMonoMs = now();
    }
    for (const connection of manager.getConnections?.() || []) {
      queues.peakRelayWritableBytes = Math.max(queues.peakRelayWritableBytes, connection.socket?.writableLength || 0);
      queues.peakUnsolicitedFrames = Math.max(queues.peakUnsolicitedFrames, connection._queuedUnsolicited?.length || 0);
      for (const info of [...(connection.clientSockets?.values() || []), ...(connection.connections?.values() || [])]) {
        for (const stream of [info.diodeSocket, info.sendSocket, info._diodeContext?.sendSocket]) {
          if (!stream) continue;
          queues.peakSendWindowBytes = Math.max(queues.peakSendWindowBytes, stream._sendingBytes || 0);
          queues.peakStreamWritableBytes = Math.max(queues.peakStreamWritableBytes, stream.writableLength || 0);
          queues.peakStreamInboundBytes = Math.max(queues.peakStreamInboundBytes, (stream._inboundBytes || 0) + (stream.readableLength || 0));
        }
      }
    }
  };
  sampler = setInterval(sample, 100);
  const resources = () => { sample(); const cpu = process.cpuUsage(cpuStart), rssBytes = process.memoryUsage().rss; peakRss = Math.max(peakRss, rssBytes); return { pid: process.pid, cpuMs: (cpu.user + cpu.system) / 1000, peakRssBytes: peakRss, rssBytes, eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6, queues, activePaths: [...activePaths.values()] }; };
  const cleanup = async () => {
    if (stopping) return; stopping = true; clearInterval(sampler); loop.disable(); stopBackground(); impairment?.close();
    for (const timer of faultTimers) clearTimeout(timer); faultTimers.clear();
    for (const socket of sockets) { try { socket.destroy ? socket.destroy() : socket.close(); } catch (_) {} }
    binds.forEach(bind => bind.dispose()); publish?.close(); manager.close();
    for (const server of servers) { try { server.close(); } catch (_) {} }
    await watchdog?.terminate();
  };
  let robotReport, watch;
  process.on('message', async message => {
    try {
      if (message.type === 'stop') {
        const report = robotReport();
        const injectedAt = message.timing.injectedAt ?? report.injectedFaultAtMonoMs ?? report.injectedReadPauseAtMonoMs;
        report.freshness = freshnessTimeline(message.timing.expected, message.timing.hz, message.timing.started, injectedAt, report.onTimeArrivals);
        delete report.onTimeArrivals;
        // Flush reports before disconnecting IPC, including longer runs where
        // the serialized receiver data exceeds the channel's immediate buffer.
        await sendReport({ type: 'robot-result', ...report, resources: resources() });
        await cleanup(); process.disconnect(); return;
      }
      const job = message.job;
      if (message.type === 'publish') {
        const shared = new SharedArrayBuffer(32); watch = new BigInt64Array(shared);
        watchdog = new Worker(__filename, { workerData: { watchdog: true, shared, watchdogMs: job.watchdogMs } });
        const receiver = robotReceiver(job, watch), guard = receiver.receive;
        const bulkSockets = new Set(), faultPaused = new WeakSet(); let injectedReadPauseAtMonoMs, readPauseScheduled = false;
        const consume = (data, socket) => {
          guard(data, response => socket.write(response));
          if (['control-reader-pause', 'bulk-reader-pause', 'stream-reset'].includes(job.fault) && !readPauseScheduled && data.length === PACKET_BYTES) {
            readPauseScheduled = true;
            const start = data.readDoubleBE(16) - data.readUInt32BE(4) * 1000 / job.hz;
            const timer = setTimeout(() => {
              faultTimers.delete(timer); injectedReadPauseAtMonoMs = now();
              if (job.fault === 'stream-reset') { socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy(); return; }
              const paused = job.fault === 'control-reader-pause' ? [socket] : [...bulkSockets];
              paused.forEach(s => { faultPaused.add(s); s.pause(); });
              const resume = setTimeout(() => { faultTimers.delete(resume); paused.forEach(s => { faultPaused.delete(s); if (!s.destroyed) s.resume(); }); }, job.fault === 'control-reader-pause' ? 500 : 3000);
              faultTimers.add(resume);
            }, Math.max(0, start + job.seconds * 500 - now()));
            faultTimers.add(timer);
          }
        };
        let control;
        if (job.protocol === 'udp') {
          control = dgram.createSocket('udp4'); control.on('message', (data, peer) => guard(data, response => control.send(response, peer.port, peer.address)));
          control.bind(0, '127.0.0.1');
        } else {
          control = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setNoDelay(true); socket.on('data', frames(data => consume(data, socket))); });
          control.listen(0, '127.0.0.1');
        }
        servers.push(control); await once(control, 'listening');
        // A continuously drained bulk stream produces competing relay traffic.
        let backgroundBytes = 0;
        const bulk = net.createServer(socket => {
          sockets.add(socket); bulkSockets.add(socket);
          socket.on('close', () => { sockets.delete(socket); bulkSockets.delete(socket); }); socket.on('error', () => {}); socket.setNoDelay(true);
          socket.on('data', data => { backgroundBytes += data.length; if (!socket.write(data)) socket.pause(); });
          socket.on('drain', () => { if (!faultPaused.has(socket)) socket.resume(); });
          socket.on('end', () => socket.end());
        });
        servers.push(bulk); bulk.listen(0, '127.0.0.1'); await once(bulk, 'listening');
        if (!direct) publish = new PublishPort(manager, Object.fromEntries([control.address().port, bulk.address().port].map(port => [port, { host: '127.0.0.1', mode: 'private', whitelist: [message.peer] }])));
        robotReport = () => ({ ...receiver.report(), injectedReadPauseAtMonoMs, backgroundBytes,
          watchdog: { latched: !!Atomics.load(watch, 1), observedGapMs: Number(Atomics.load(watch, 2)) / 1e6, stopAtMonoMs: Number(Atomics.load(watch, 3)) / 1e6, independentThread: true, physicalStopMeasured: false } });
        process.send({ type: 'published', controlPort: control.address().port, bulkPort: bulk.address().port });
      }
      if (message.type === 'run') {
        const { controlPort, bulkPort } = message.ports;
        const addBind = async (port, protocol, transport, policy) => {
          if (direct) return { port, bind: { getUdpSendStats: () => null } };
          const bind = new BindPort(manager, { 0: { targetPort: port, deviceIdHex: message.peer, protocol, transport, listenHost: '127.0.0.1', ...(policy ? { udpSendPolicy: policy } : {}) } });
          bind._benchmarkRole = port === controlPort ? 'control' : 'bulk';
          binds.push(bind); const listening = once(bind, 'listening'); bind.bindSinglePort(0); const [info] = await listening; return { bind, port: info.localPort };
        };
        const target = await addBind(controlPort, job.protocol, job.transport, job.policy);
        let runStarted = Infinity;
        if (['burst-loss', 'packet-delay', 'packet-reorder'].includes(job.fault)) impairment = impairDatagrams(target.bind, job, () => runStarted);
        let control, writable = true, reconnectTimer, peakControlWritableBytes = 0, peakBulkWritableBytes = 0;
        const arrived = new Set(), onTime = new Set(), rtts = [], ages = [], scheduling = [];
        const counts = { expected: Math.floor(job.hz * job.seconds), offered: 0, schedulerSkipped: 0, faultSuppressed: 0, backpressureSkipped: 0, echoed: 0, duplicateEchoes: 0, invalidEchoes: 0, sendErrors: 0, reconnects: 0 };
        const receive = data => {
          if (data.length !== PACKET_BYTES || data.readUInt32BE() !== MAGIC || data.readUInt32BE(8) !== job.epoch || !data.subarray(40).equals(PACKET_PADDING)) { counts.invalidEchoes++; return; }
          const seq = data.readUInt32BE(4);
          if (arrived.has(seq)) { counts.duplicateEchoes++; return; }
          arrived.add(seq); counts.echoed++;
          const age = data.readDoubleBE(32) - data.readDoubleBE(16); ages.push(age); rtts.push(now() - data.readDoubleBE(24));
          if (age >= 0 && age <= job.deadlineMs) onTime.add(seq);
        };
        const connect = () => {
          if (stopping) return;
          if (job.protocol === 'udp') { control = dgram.createSocket('udp4'); control.on('message', receive); }
          else {
            writable = true; control = net.connect({ host: '127.0.0.1', port: target.port }); control.setNoDelay(true);
            const generationSocket = control;
            control.on('data', frames(receive)); control.on('drain', () => { if (control === generationSocket) writable = true; });
            control.on('close', () => { sockets.delete(generationSocket); if (!stopping && control === generationSocket) reconnectTimer = setTimeout(() => { counts.reconnects++; connect(); }, 100); });
          }
          control.on('error', () => { counts.sendErrors++; }); sockets.add(control);
        };
        connect();
        let backgroundSent = 0, backgroundReceived = 0, backgroundReconnects = 0;
        if (job.backgroundMbps > 0) {
          const [backgroundTransport, backgroundProtocol] = job.backgroundMode.split('-');
          const bg = await addBind(bulkPort, backgroundProtocol, backgroundTransport);
          let socket, reconnectTimer, running = true, ready = true, credit = 0, last = now();
          const connectBulk = () => {
            if (!running || stopping) return;
            ready = true; credit = 0; last = now();
            socket = net.connect({ host: '127.0.0.1', port: bg.port }); sockets.add(socket); socket.setNoDelay(true);
            const generationSocket = socket;
            socket.on('error', () => {}); socket.on('data', data => { backgroundReceived += data.length; });
            socket.on('drain', () => { if (socket === generationSocket) ready = true; });
            socket.on('close', () => {
              sockets.delete(generationSocket);
              if (running && !stopping && socket === generationSocket) reconnectTimer = setTimeout(() => { backgroundReconnects++; connectBulk(); }, 100);
            });
          };
          connectBulk();
          const chunk = Buffer.alloc(16384, 0x61);
          const timer = setInterval(() => {
            const elapsed = now() - last; last = now();
            credit = Math.min(65536, credit + elapsed * job.backgroundMbps * 125);
            while (ready && !socket.destroyed && credit >= chunk.length) { ready = socket.write(chunk); peakBulkWritableBytes = Math.max(peakBulkWritableBytes, socket.writableLength); credit -= chunk.length; backgroundSent += chunk.length; }
          }, 10);
          stopBackground = () => { running = false; clearInterval(timer); clearTimeout(reconnectTimer); };
        }
        const started = now() + 100;
        runStarted = started;
        let faultTimer, injectedFaultAtMonoMs, injectedSocketCount = 0;
        const faultDelay = Math.max(0, started + job.seconds * 500 - now());
        if (['relay-drop', 'data-socket-drop'].includes(job.fault)) faultTimer = setTimeout(() => {
          const selected = controlPathSockets(target.bind, job.fault === 'data-socket-drop');
          injectedSocketCount = selected.length;
          if (selected.length) { injectedFaultAtMonoMs = now(); selected.forEach(socket => socket.destroy()); }
        }, faultDelay);
        if (job.fault === 'sender-stall') faultTimer = setTimeout(() => { injectedFaultAtMonoMs = now(); const until = now() + 250; while (now() < until) {} }, faultDelay);
        await scheduleRate({ hz: job.hz, seconds: job.seconds, started,
          skip: n => { counts.schedulerSkipped += n; },
          send: (seq, due) => {
            if (job.fault === 'command-outage' && due - started >= job.seconds * 500 && due - started < job.seconds * 500 + 500) { injectedFaultAtMonoMs ??= now(); counts.faultSuppressed++; return; }
            if (!writable || control.destroyed) { counts.backpressureSkipped++; return; }
            scheduling.push(now() - due); const data = packet(seq, job.epoch, due); counts.offered++;
            if (job.protocol === 'udp') control.send(data, target.port, '127.0.0.1', error => { if (error) counts.sendErrors++; });
            else { writable = control.write(data); peakControlWritableBytes = Math.max(peakControlWritableBytes, control.writableLength); }
          },
        });
        clearTimeout(faultTimer); stopBackground(); await sleep(500);
        const echoDeadlines = deadlineCounts(counts.expected, job.hz, job.warmupSeconds, onTime);
        counts.onTime = onTime.size; counts.deadlineMissed = counts.expected - onTime.size; counts.missingEchoes = counts.offered - arrived.size;
        await sendReport({ type: 'controller-result', counts, startedMonoMs: started, endedMonoMs: started + job.seconds * 1000,
          steadyState: echoDeadlines.steadyState,
          deadlineMissPct: 100 * counts.deadlineMissed / counts.expected,
          longestDeadlineMissBurst: echoDeadlines.longestMissBurstMs * job.hz / 1000, longestDeadlineMissBurstMs: echoDeadlines.longestMissBurstMs,
          scheduleLatenessMs: distribution(scheduling), commandAgeMs: distribution(ages), rttMs: distribution(rtts),
          udpSendStats: target.bind.getUdpSendStats(0), injectedFaultAtMonoMs, injectedSocketCount, injectedLink: impairment?.stats, backgroundSent, backgroundReceived,
          peakControlWritableBytes, peakBulkWritableBytes, backgroundReconnects, backgroundDeliveredMbps: backgroundReceived * 8 / job.seconds / 1e6, resources: resources() });
        await cleanup(); clearTimeout(reconnectTimer); process.disconnect();
      }
    } catch (error) { process.send?.({ type: 'failure', error: error.message }); await cleanup(); process.disconnect(); }
  });
  process.on('disconnect', () => { void cleanup(); });
  try {
    await manager.connect(); await manager._startupWorkPromise;
    process.send({ type: 'ready', address: manager.getNearestConnection().getEthereumAddress() });
  } catch (error) {
    await cleanup();
    if (process.connected) { process.send({ type: 'failure', error: error.message }); process.disconnect(); }
    else throw error;
  }
}

async function runCase(job, temp) {
  const children = [];
  const spawn = role => {
    const child = fork(__filename, ['--endpoint', role, path.join(temp, role + '.json'), ...(job.transport === 'direct' ? ['--direct'] : []), ...(job.sourceSnapshot ? ['--source-snapshot', job.sourceSnapshot] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, LOG: 'false', DEBUG: 'false' } });
    child.stderr.on('data', data => process.stderr.write(data));
    const inbox = [], waiters = new Map(); let exited;
    child.on('message', message => {
      if (message.type === 'failure') { for (const { reject } of waiters.values()) reject(new Error(message.error)); waiters.clear(); }
      else if (waiters.has(message.type)) { waiters.get(message.type).resolve(message); waiters.delete(message.type); }
      else inbox.push(message);
    });
    child.on('exit', code => { exited = code; for (const { reject } of waiters.values()) reject(new Error(`${role} exited (${code})`)); waiters.clear(); });
    children.push(child);
    return { child, wait(type) {
      const i = inbox.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      if (exited !== undefined) return Promise.reject(new Error(`${role} exited (${exited})`));
      return new Promise((resolve, reject) => waiters.set(type, { resolve, reject }));
    } };
  };
  let timeout;
  try {
    return await Promise.race([(async () => {
      const robot = spawn('robot'), controller = spawn('controller');
      const [r, c] = await Promise.all([robot.wait('ready'), controller.wait('ready')]);
      robot.child.send({ type: 'publish', job, peer: c.address }); const ports = await robot.wait('published');
      controller.child.send({ type: 'run', job, peer: r.address, ports }); const measured = await controller.wait('controller-result');
      robot.child.send({ type: 'stop', timing: { expected: measured.counts.expected, hz: job.hz, started: measured.startedMonoMs,
        injectedAt: measured.injectedFaultAtMonoMs ?? measured.injectedLink?.startedAtMonoMs } });
      const simulatedRobot = await robot.wait('robot-result');
      simulatedRobot.watchdog.latchedDuringRun = simulatedRobot.watchdog.stopAtMonoMs > 0 && simulatedRobot.watchdog.stopAtMonoMs <= measured.endedMonoMs;
      const commandDelivery = deadlineCounts(measured.counts.expected, job.hz, job.warmupSeconds, simulatedRobot.onTimeSequences);
      delete simulatedRobot.onTimeSequences;
      const injectedAt = measured.injectedFaultAtMonoMs ?? simulatedRobot.injectedFaultAtMonoMs ?? simulatedRobot.injectedReadPauseAtMonoMs ?? measured.injectedLink?.startedAtMonoMs;
      const freshness = simulatedRobot.freshness;
      delete simulatedRobot.freshness;
      simulatedRobot.watchdog.armedDuringRun = simulatedRobot.firstAcceptedAtMonoMs !== undefined && simulatedRobot.firstAcceptedAtMonoMs <= measured.endedMonoMs;
      simulatedRobot.watchdog.firstAcceptedAtRunMs = simulatedRobot.firstAcceptedAtMonoMs === undefined ? null : simulatedRobot.firstAcceptedAtMonoMs - measured.startedMonoMs;
      const stopAt = simulatedRobot.watchdog.latchedDuringRun ? simulatedRobot.watchdog.stopAtMonoMs : undefined;
      const faultAssessment = job.fault === 'none' ? undefined : { injected: injectedAt !== undefined,
        injectedAtRunMs: injectedAt === undefined ? null : injectedAt - measured.startedMonoMs,
        firstWatchdogAfterInjectionMs: stopAt === undefined || injectedAt === undefined ? null : stopAt - injectedAt,
        watchdogLatchedBeforeInjection: stopAt !== undefined && injectedAt !== undefined && stopAt < injectedAt,
        freshCommandsRejectedWhileStopped: simulatedRobot.counts.stopped };
      const integrityPassed = simulatedRobot.counts.invalid === 0 && measured.counts.invalidEchoes === 0 && (job.protocol === 'udp' || measured.counts.duplicateEchoes === 0);
      return { job, completed: true, integrityPassed, controller: measured, robot: simulatedRobot, commandDelivery, freshness, faultAssessment,
        nominalDeadlineTargetMet: job.fault === 'none' ? integrityPassed && commandDelivery.steadyState.deadlineMissPct <= .1 && !simulatedRobot.watchdog.latchedDuringRun && simulatedRobot.counts.stopped === 0 : null,
        scope: `Two processes on one host ${job.transport === 'direct' ? 'over direct loopback sockets without Diode' : 'through public Diode relays'}. Common monotonic clock. Simulated robot receiver and independent JS watchdog thread; no physical actuation or video codec.` };
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Case timed out')), (job.seconds + 90) * 1000); })]);
  } catch (error) { return { job, completed: false, error: error.message }; }
  finally {
    clearTimeout(timeout);
    await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); const timer = setTimeout(() => child.kill(), 3000); timer.unref(); })));
  }
}

async function main() {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (args.includes('--help')) {
    console.log([
      'node scripts/benchmark-teleoperation.js --live',
      '[--seconds 60] [--hz 100] [--deadline-ms 50] [--watchdog-ms 100] [--warmup-seconds 1]',
      '[--background-mbps 4] [--background-mode api-tcp|api-tls|native-tcp]',
      '[--modes direct-udp,api-tcp,api-tls,api-udp,native-tcp,native-udp]',
      '[--fault none|relay-drop|data-socket-drop|stream-reset|control-reader-pause|bulk-reader-pause|sender-stall|robot-stall|command-outage|burst-loss|packet-delay|packet-reorder]',
      '[--legacy-udp] [--source-snapshot DIRECTORY] [--output FILE] [--enforce-deadlines]',
      'Independent endpoints, fixed-rate source with missed ticks counted, receiver freshness guard and simulated watchdog.',
      'direct-udp is a loopback baseline. Datagram impairments require native-udp; reader pauses/resets require streams.',
      'relay-drop targets the control bind active API relay; data-socket-drop targets its Native data socket when applicable.',
      'Source snapshots are benchmark-only transport substitutions. --live is mandatory. Measurement completion and deadline qualification are separate.',
    ].join('\n')); return;
  }
  if (!args.includes('--live')) throw new Error('Explicit --live is required for public-relay tests');
  const number = (flag, fallback, min, max) => { const n = Number(option(flag, fallback)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${flag} must be ${min}..${max}`); return n; };
  const common = { seconds: number('--seconds', 60, 2, 3600), hz: number('--hz', 100, 1, 500), deadlineMs: number('--deadline-ms', 50, 1, 10000), watchdogMs: number('--watchdog-ms', 100, 1, 10000), backgroundMbps: number('--background-mbps', 4, 0, 50), backgroundMode: option('--background-mode', 'api-tcp'), warmupSeconds: number('--warmup-seconds', 1, 0, 60), fault: option('--fault', 'none'), sourceSnapshot: option('--source-snapshot') ? path.resolve(option('--source-snapshot')) : undefined };
  if (!['api-tcp', 'api-tls', 'native-tcp'].includes(common.backgroundMode)) throw new Error('Unsupported background mode');
  if (common.warmupSeconds >= common.seconds) throw new Error('--warmup-seconds must be less than --seconds');
  if (Math.ceil(common.hz * common.warmupSeconds) >= Math.floor(common.hz * common.seconds)) throw new Error('At least one scheduled command must remain after warmup');
  if (!['none', 'relay-drop', 'sender-stall', 'robot-stall', 'command-outage', 'burst-loss', 'packet-delay', 'packet-reorder', 'control-reader-pause', 'bulk-reader-pause', 'stream-reset', 'data-socket-drop'].includes(common.fault)) throw new Error('Unknown fault');
  const modes = option('--modes', 'direct-udp,api-tcp,api-tls,api-udp,native-tcp,native-udp').split(',');
  if (modes.some(mode => !['direct-udp', 'api-tcp', 'api-tls', 'api-udp', 'native-tcp', 'native-udp'].includes(mode))) throw new Error('Unsupported mode');
  if (['relay-drop', 'data-socket-drop'].includes(common.fault) && modes.includes('direct-udp')) throw new Error('Socket-drop faults require Diode modes');
  if (common.fault === 'data-socket-drop' && modes.some(mode => mode.endsWith('-udp'))) throw new Error('data-socket-drop requires stream modes');
  if (['burst-loss', 'packet-delay', 'packet-reorder'].includes(common.fault) && modes.some(mode => mode !== 'native-udp')) throw new Error('Link impairments require --modes native-udp');
  if (['control-reader-pause', 'bulk-reader-pause', 'stream-reset'].includes(common.fault) && modes.some(mode => mode.endsWith('-udp'))) throw new Error('Reader pauses/resets require stream modes');
  if (common.fault === 'bulk-reader-pause' && common.backgroundMbps === 0) throw new Error('Bulk pause requires background traffic');
  const output = option('--output', 'out/teleoperation.json'); fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  const report = { schemaVersion: 2, benchmarkRevision: 'control-v7-stream-recovery', date: new Date().toISOString(), node: process.version, platform: process.platform, library: require('../package.json').version, results: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-control-'));
  try {
    for (const mode of modes) {
      const [transport, protocol] = mode.split('-');
      const job = { ...common, protocol, transport, epoch: require('node:crypto').randomBytes(4).readUInt32BE(), policy: transport !== 'direct' && protocol === 'udp' && !args.includes('--legacy-udp') ? { mode: 'latest', maxAgeMs: common.deadlineMs } : undefined };
      const result = await runCase(job, temp); report.results.push(result); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      process.stderr.write(`${mode}: completed=${result.completed}; receiver deadline misses=${result.commandDelivery?.deadlineMissPct?.toFixed(3)}%; steady misses=${result.commandDelivery?.steadyState?.deadlineMissPct?.toFixed(3)}%; p99 age=${result.robot?.commandAgeMs?.p99} ms\n`);
    }
  } finally { if (path.dirname(temp) === path.resolve(os.tmpdir())) fs.rmSync(temp, { recursive: true, force: true }); }
  report.completed = report.results.every(r => r.completed); report.deadlineTargetMet = report.results.every(r => r.nominalDeadlineTargetMet === true);
  report.integrityPassed = report.results.every(r => r.integrityPassed);
  report.faultsApplied = report.results.every(r => r.job.fault === 'none' || r.faultAssessment?.injected);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.completed && report.integrityPassed && report.faultsApplied && (!args.includes('--enforce-deadlines') || report.deadlineTargetMet) ? 0 : 1;
}

if (!isMainThread && workerData?.watchdog) {
  const state = new BigInt64Array(workerData.shared), deadline = BigInt(Math.round(workerData.watchdogMs * 1e6));
  setInterval(() => checkWatchdog(state, deadline), 2);
} else if (require.main === module) {
  const i = process.argv.indexOf('--endpoint');
  const running = i >= 0 ? endpoint(process.argv[i + 1], process.argv[i + 2], process.argv.includes('--direct')) : main();
  running.catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { scheduleRate, deadlineCounts, freshnessTimeline, robotReceiver, checkWatchdog, controlPathSockets, distribution, packet, frames };
