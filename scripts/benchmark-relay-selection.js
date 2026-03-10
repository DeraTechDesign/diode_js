process.env.LOG = 'false';
process.env.DEBUG = 'false';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { performance } = require('perf_hooks');
const Module = require('module');

const repo = path.resolve(__dirname, '..');
const CurrentManager = require(path.join(repo, 'clientManager.js'));

const DEVICE_CANDIDATES = [
  '0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c',
  '0xca1e71d8105a598810578fb6042fa8cbc1e7f039',
  '0x5365baf29cb7ab58de588dfc448913cb609283e2',
];

function parseArgs(argv) {
  const args = {
    providerFile: null,
    networkDiscoveryLive: false,
    networkDiscoverySnapshot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--provider-file' && argv[index + 1]) {
      args.providerFile = path.resolve(repo, argv[index + 1]);
      index += 1;
    } else if (token === '--network-discovery-live') {
      args.networkDiscoveryLive = true;
    } else if (token === '--network-discovery-snapshot' && argv[index + 1]) {
      args.networkDiscoverySnapshot = path.resolve(repo, argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

function loadOldManager() {
  const source = execSync('git show HEAD:clientManager.js', { cwd: repo, encoding: 'utf8' });
  const replacements = {
    "require('./connection')": `require(${JSON.stringify(path.join(repo, 'connection.js'))})`,
    "require('./rpc')": `require(${JSON.stringify(path.join(repo, 'rpc.js'))})`,
    "require('./logger')": `require(${JSON.stringify(path.join(repo, 'logger.js'))})`,
  };

  let patched = source;
  for (const [from, to] of Object.entries(replacements)) {
    patched = patched.replace(from, to);
  }

  const moduleInstance = new Module(path.join(repo, '.old-clientManager.inline.js'), module);
  moduleInstance.filename = path.join(repo, '.old-clientManager.inline.js');
  moduleInstance.paths = Module._nodeModulePaths(repo);
  moduleInstance._compile(patched, moduleInstance.filename);
  return moduleInstance.exports;
}

function keyForConnection(connection) {
  if (!connection) return null;
  if (connection._managerHostKey) return connection._managerHostKey;
  return `${connection.host}:${connection.port}`;
}

function inferRelaySource(manager, hostKey) {
  if (!hostKey) return null;
  const score = manager.relayScores && manager.relayScores.get(hostKey);
  if (score && score.discoveredFrom) {
    return score.discoveredFrom;
  }
  if (Array.isArray(manager.initialHosts) && manager.initialHosts.includes(hostKey)) {
    return manager._hasExplicitHost || manager._hasExplicitHosts ? 'configured' : 'seed';
  }
  return 'unknown';
}

async function timed(fn) {
  const startedAt = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: performance.now() - startedAt, value };
  } catch (error) {
    return {
      ok: false,
      ms: performance.now() - startedAt,
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function pingConnection(manager, connection, count = 3) {
  const rpc = manager._getRpcFor ? manager._getRpcFor(connection) : (connection.RPC || null);
  const samplesMs = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const pong = await rpc.ping();
    const elapsedMs = performance.now() - startedAt;
    if (!pong) {
      throw new Error(`ping failed for ${keyForConnection(connection)}`);
    }
    samplesMs.push(elapsedMs);
  }

  const total = samplesMs.reduce((sum, value) => sum + value, 0);
  return {
    samplesMs,
    avgMs: total / samplesMs.length,
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
  };
}

function meanDefined(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

async function resolveDeviceSample(manager, deviceId) {
  const result = await timed(() => manager.getConnectionForDevice(deviceId));
  const reconciliationTrace = manager._lastDeviceResolutionTrace || null;
  if (!result.ok || !result.value) {
    return {
      deviceId,
      ok: false,
      error: result.error || 'resolution failed',
      resolutionMs: result.ms,
      hostKey: null,
      source: null,
      reconciliationTrace,
    };
  }

  const hostKey = keyForConnection(result.value);
  return {
    deviceId,
    ok: true,
    hostKey,
    source: inferRelaySource(manager, hostKey),
    resolutionMs: result.ms,
    reconciliationTrace,
  };
}

async function resolveAllDevices(manager) {
  const results = [];
  for (const deviceId of DEVICE_CANDIDATES) {
    const sample = await resolveDeviceSample(manager, deviceId);
    sample.category = classifyDeviceResolution(sample);
    results.push(sample);
  }
  return results;
}

function classifyDeviceResolution(deviceResolution) {
  if (!deviceResolution) {
    return null;
  }
  if (deviceResolution.ok === false) {
    return 'resolution failed';
  }
  const trace = deviceResolution && deviceResolution.reconciliationTrace;
  if (!trace) {
    return null;
  }
  if (trace.reconciliation && trace.reconciliation.choseAlternate) {
    return 'alternate answer available and chosen';
  }
  if (trace.controlPlaneSlow) {
    return 'control-plane lookup itself was slow';
  }
  if (
    trace.reconciliation
    && trace.reconciliation.triggered
    && trace.reconciliation.attempted
    && !trace.reconciliation.hadAlternateAnswer
  ) {
    return 'no alternate answer available';
  }
  if (trace.reconciliation && trace.reconciliation.triggered && trace.reconciliation.hadAlternateAnswer) {
    return 'alternate answer available but not chosen';
  }
  return 'no reconciliation needed';
}

function flattenDeviceResolutions(trials, version) {
  return trials.flatMap((trial) => (trial[version].deviceResolutions || []).map((resolution) => ({
    phase: trial.phase,
    ...resolution,
  })));
}

function summarizeDeviceResults(deviceResults) {
  const byDevice = new Map();
  for (const result of deviceResults) {
    if (!byDevice.has(result.deviceId)) {
      byDevice.set(result.deviceId, []);
    }
    byDevice.get(result.deviceId).push(result);
  }

  return Array.from(byDevice.entries()).map(([deviceId, results]) => {
    const successful = results.filter((result) => result.ok && Number.isFinite(result.resolutionMs));
    const categoryCounts = results.reduce((acc, result) => {
      const category = result.category || 'unclassified';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
    const hosts = Array.from(new Set(results.map((result) => result.hostKey).filter(Boolean)));
    return {
      deviceId,
      samples: results.length,
      successCount: successful.length,
      avgResolutionMs: round(meanDefined(successful.map((result) => result.resolutionMs)) || 0),
      hosts,
      categoryCounts,
    };
  });
}

async function runScenario(ManagerClass, keyLocation, options = {}) {
  const manager = new ManagerClass({ keyLocation, ...options });
  const connectResult = await timed(() => manager.connect());
  if (!connectResult.ok) {
    return {
      ok: false,
      connectMs: connectResult.ms,
      error: connectResult.error,
    };
  }

  const startupConnections = manager.getConnections().map(keyForConnection);
  const selectionSequence = [];
  for (let index = 0; index < Math.max(6, startupConnections.length); index += 1) {
    selectionSequence.push(keyForConnection(manager.getNearestConnection()));
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const warmedConnections = manager.getConnections().map(keyForConnection);

  const pingStats = {};
  for (const connection of manager.getConnections()) {
    const hostKey = keyForConnection(connection);
    try {
      pingStats[hostKey] = await pingConnection(manager, connection, 3);
    } catch (error) {
      pingStats[hostKey] = { error: String(error && error.message ? error.message : error) };
    }
  }

  const bestConnected = Object.entries(pingStats)
    .filter((entry) => Number.isFinite(entry[1].avgMs))
    .sort((left, right) => left[1].avgMs - right[1].avgMs)[0];
  const selectedHost = selectionSequence[0] || null;
  const selectedSource = inferRelaySource(manager, selectedHost);
  const deviceResolutions = await resolveAllDevices(manager);

  manager.close();

  return {
    ok: true,
    connectMs: connectResult.ms,
    startupConnections,
    warmedConnections,
    selectedHost,
    selectedSource,
    selectionSequence,
    selectedPingAvgMs: selectedHost && pingStats[selectedHost] && Number.isFinite(pingStats[selectedHost].avgMs)
      ? pingStats[selectedHost].avgMs
      : null,
    bestConnectedHost: bestConnected ? bestConnected[0] : null,
    bestConnectedPingAvgMs: bestConnected ? bestConnected[1].avgMs : null,
    gapToBestMs: bestConnected && selectedHost && Number.isFinite(pingStats[selectedHost]?.avgMs)
      ? pingStats[selectedHost].avgMs - bestConnected[1].avgMs
      : null,
    pingStats,
    deviceResolutions,
    networkDiscoveryStats: manager._lastNetworkDiscoveryStats || null,
  };
}

function round(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return Math.round(value * 100) / 100;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const OldManager = loadOldManager();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-relay-bench-'));
  const oldKeyLocation = path.join(tempRoot, 'old', 'keys.json');
  const currentKeyLocation = path.join(tempRoot, 'current', 'keys.json');
  const phases = ['cold', 'warm-1', 'warm-2'];
  const trials = [];
  let providerEntries = null;
  let networkDiscoverySnapshot = null;
  if (args.providerFile) {
    providerEntries = JSON.parse(fs.readFileSync(args.providerFile, 'utf8'));
    if (!Array.isArray(providerEntries)) {
      throw new Error('Provider file must contain a JSON array');
    }
  }
  if (args.networkDiscoverySnapshot) {
    networkDiscoverySnapshot = JSON.parse(fs.readFileSync(args.networkDiscoverySnapshot, 'utf8'));
    if (!Array.isArray(networkDiscoverySnapshot)) {
      throw new Error('Network discovery snapshot file must contain a JSON array');
    }
  }

  class SnapshotDiscoveryManager extends CurrentManager {
    async _fetchNetworkDiscoveryNodes() {
      return networkDiscoverySnapshot || [];
    }
  }

  const currentOptions = {
    relaySelection: {
      continueProbingUntestedSeeds: !(args.networkDiscoveryLive || networkDiscoverySnapshot),
      networkDiscovery: {
        enabled: !!(args.networkDiscoveryLive || networkDiscoverySnapshot),
        backgroundBatchSize: args.networkDiscoveryLive || networkDiscoverySnapshot ? 0 : undefined,
      },
    },
  };
  if (providerEntries) {
    currentOptions.relaySelection.discoveryProvider = async () => providerEntries;
  }

  const CurrentManagerClass = networkDiscoverySnapshot ? SnapshotDiscoveryManager : CurrentManager;

  for (const phase of phases) {
    trials.push({
      phase,
      old: await runScenario(OldManager, oldKeyLocation),
      current: await runScenario(CurrentManagerClass, currentKeyLocation, currentOptions),
    });
  }

  const summary = {
    oldAvgConnectMs: round(mean(trials.map((trial) => trial.old.connectMs))),
    currentAvgConnectMs: round(mean(trials.map((trial) => trial.current.connectMs))),
    oldAvgSelectedPingMs: round(meanDefined(trials.map((trial) => trial.old.selectedPingAvgMs)) || 0),
    currentAvgSelectedPingMs: round(meanDefined(trials.map((trial) => trial.current.selectedPingAvgMs)) || 0),
    oldAvgBestConnectedPingMs: round(meanDefined(trials.map((trial) => trial.old.bestConnectedPingAvgMs)) || 0),
    currentAvgBestConnectedPingMs: round(meanDefined(trials.map((trial) => trial.current.bestConnectedPingAvgMs)) || 0),
    oldAvgGapToBestMs: round(meanDefined(trials.map((trial) => trial.old.gapToBestMs)) || 0),
    currentAvgGapToBestMs: round(meanDefined(trials.map((trial) => trial.current.gapToBestMs)) || 0),
    oldAvgDeviceResolutionMs: round(meanDefined(flattenDeviceResolutions(trials, 'old').map((result) => (
      result.ok ? result.resolutionMs : null
    ))) || 0),
    currentAvgDeviceResolutionMs: round(meanDefined(flattenDeviceResolutions(trials, 'current').map((result) => (
      result.ok ? result.resolutionMs : null
    ))) || 0),
    currentDeviceResolutionCategories: flattenDeviceResolutions(trials, 'current').reduce((acc, result) => {
      const category = result.category || 'unclassified';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {}),
    oldPerDevice: summarizeDeviceResults(flattenDeviceResolutions(trials, 'old')),
    currentPerDevice: summarizeDeviceResults(flattenDeviceResolutions(trials, 'current')),
  };

  const generatedAt = new Date().toISOString().replace(/[:.]/g, '-');
  const reportBase = `relay-selection-benchmark-${generatedAt}`;
  const payload = {
    generatedAt: new Date().toISOString(),
    baselineCommit: execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim(),
    tempRoot,
    providerFile: args.providerFile,
    providerCandidatesLoaded: providerEntries ? providerEntries.length : 0,
    networkDiscoveryMode: args.networkDiscoveryLive ? 'live' : (networkDiscoverySnapshot ? 'snapshot' : 'disabled'),
    networkDiscoverySnapshot: args.networkDiscoverySnapshot,
    summary,
    trials,
  };

  fs.mkdirSync(path.join(repo, 'reports'), { recursive: true });
  const jsonPath = path.join(repo, 'reports', `${reportBase}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const lines = [];
  lines.push('# Relay Selection Benchmark Report');
  lines.push('');
  lines.push(`- Generated: ${payload.generatedAt}`);
  lines.push(`- Baseline old manager source: \`HEAD\` commit \`${payload.baselineCommit}\``);
  lines.push('- Candidate manager source: current working tree `clientManager.js`');
  lines.push('- Relay pool: default pre-net seeds');
  lines.push(`- Device lookup samples: ${DEVICE_CANDIDATES.join(', ')}`);
  lines.push(`- Network discovery mode: ${payload.networkDiscoveryMode}`);
  if (payload.networkDiscoveryMode !== 'disabled') {
    lines.push('- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing');
  }
  if (payload.providerFile) {
    lines.push(`- Provider file: \`${payload.providerFile}\``);
    lines.push(`- Provider candidates loaded: ${payload.providerCandidatesLoaded}`);
  }
  if (payload.networkDiscoverySnapshot) {
    lines.push(`- Network discovery snapshot: \`${payload.networkDiscoverySnapshot}\``);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Average connect time: old ${summary.oldAvgConnectMs} ms, current ${summary.currentAvgConnectMs} ms`);
  lines.push(`- Average selected relay RTT: old ${summary.oldAvgSelectedPingMs} ms, current ${summary.currentAvgSelectedPingMs} ms`);
  lines.push(`- Average best connected RTT: old ${summary.oldAvgBestConnectedPingMs} ms, current ${summary.currentAvgBestConnectedPingMs} ms`);
  lines.push(`- Average gap to best: old ${summary.oldAvgGapToBestMs} ms, current ${summary.currentAvgGapToBestMs} ms`);
  lines.push(`- Average device resolution: old ${summary.oldAvgDeviceResolutionMs} ms, current ${summary.currentAvgDeviceResolutionMs} ms`);
  if (payload.networkDiscoveryMode !== 'disabled') {
    const categories = Object.entries(summary.currentDeviceResolutionCategories)
      .map(([label, count]) => `${label}: ${count}`)
      .join('; ');
    lines.push(`- Current device-resolution categories: ${categories || 'n/a'}`);
  }
  lines.push('');
  lines.push('## Per-Phase Relay Summary');
  lines.push('');
  lines.push('| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup |');
  lines.push('| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const trial of trials) {
    for (const version of ['old', 'current']) {
      const row = trial[version];
      const discoveryUsable = row.networkDiscoveryStats ? row.networkDiscoveryStats.usableCount : 'n/a';
      const discoveryStartup = row.networkDiscoveryStats ? row.networkDiscoveryStats.startupProbeCount : 'n/a';
      lines.push(`| ${trial.phase} | ${version} | ${round(row.connectMs)} | ${row.startupConnections.length} | ${row.selectedHost} | ${row.selectedSource} | ${round(row.selectedPingAvgMs)} | ${row.bestConnectedHost} | ${round(row.bestConnectedPingAvgMs)} | ${round(row.gapToBestMs)} | ${discoveryUsable} | ${discoveryStartup} |`);
    }
  }

  lines.push('');
  lines.push('## Per-Device Summary');
  lines.push('');
  lines.push('| Device | Version | Samples | Successes | Avg resolution ms | Hosts seen | Categories |');
  lines.push('| --- | --- | ---: | ---: | ---: | --- | --- |');
  for (const version of ['oldPerDevice', 'currentPerDevice']) {
    const label = version === 'oldPerDevice' ? 'old' : 'current';
    for (const row of summary[version]) {
      const hostsSeen = row.hosts.length > 0 ? row.hosts.join(', ') : 'n/a';
      const categories = Object.entries(row.categoryCounts)
        .map(([category, count]) => `${category}: ${count}`)
        .join('; ');
      lines.push(`| ${row.deviceId} | ${label} | ${row.samples} | ${row.successCount} | ${row.avgResolutionMs} | ${hostsSeen} | ${categories || 'n/a'} |`);
    }
  }

  lines.push('');
  lines.push('## Per-Device Samples');
  lines.push('');
  lines.push('| Phase | Version | Device | Relay | Source | Resolution ms | Category |');
  lines.push('| --- | --- | --- | --- | --- | ---: | --- |');
  for (const trial of trials) {
    for (const version of ['old', 'current']) {
      for (const result of trial[version].deviceResolutions || []) {
        lines.push(`| ${trial.phase} | ${version} | ${result.deviceId} | ${result.hostKey || 'n/a'} | ${result.source || 'n/a'} | ${round(result.resolutionMs)} | ${result.category || 'n/a'} |`);
      }
    }
  }

  const mdPath = path.join(repo, 'reports', `${reportBase}.md`);
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify({ jsonPath, mdPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
