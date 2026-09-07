'use strict';

// Controlled local benchmark: real BindPort/PublishPort TLS and loopback TCP,
// with a simulated relay's data delivery at half RTT and ACK at full RTT.
// These measurements describe the send pipeline, not public-network speeds.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function worker(mode, ackRttMs) {
  process.env.LOG = 'false';
  process.env.DEBUG = 'false';
  if (mode === 'serial') {
    const socketPath = require.resolve('../diodeSocket');
    const DiodeSocket = require(socketPath);
    class SerialAcknowledgedSocket extends DiodeSocket {
      _write(chunk, encoding, callback) {
        // Previous DiodeSocket behavior: one TLS write waits for every relay
        // ACK before Node may submit the next write to this transport.
        this.rpc.portSend(this.ref, chunk, { timeoutMs: this.timeoutMs })
          .then(() => callback(), callback);
      }
    }
    require.cache[socketPath].exports = SerialAcknowledgedSocket;
  }
  const { runTunnel } = require('../test/apiTls.integration.test');
  const result = await runTunnel({ ackRttMs });
  process.stdout.write(`${JSON.stringify({ mode, ackRttMs, ...result })}\n`);
}

async function benchmark() {
  const repetitions = 2;
  const measurements = [];
  for (const ackRttMs of [40, 80]) {
    const byMode = {};
    for (const mode of ['serial', 'pipeline']) {
      const samples = [];
      for (let sample = 0; sample < repetitions; sample += 1) {
        const { stdout } = await execute(process.execPath, [__filename, '--worker', mode, String(ackRttMs)], {
          timeout: 25000,
          windowsHide: true,
          env: { ...process.env, LOG: 'false', DEBUG: 'false' },
        });
        const result = JSON.parse(stdout.trim());
        samples.push(result);
      }
      byMode[mode] = samples.reduce((sum, result) => sum + result.elapsedMs, 0) / samples.length;
      measurements.push({
        ackRttMs,
        mode,
        payloadBytes: 1024 * 1024,
        repetitions,
        meanEchoMs: Number(byMode[mode].toFixed(1)),
        maxInFlightFrames: Math.max(...samples.map((sample) => sample.maxInFlightFrames)),
        samplesMs: samples.map((sample) => Number(sample.elapsedMs.toFixed(1))),
      });
    }
    measurements.push({ ackRttMs, echoSpeedup: Number((byMode.serial / byMode.pipeline).toFixed(2)) });
  }
  process.stdout.write(`${JSON.stringify({ scope: 'local TLS tunnel with simulated relay ACK latency; 1 MiB upload and echo', measurements }, null, 2)}\n`);
}

if (require.main === module) {
  const command = process.argv[2] === '--worker'
    ? worker(process.argv[3], Number(process.argv[4]))
    : benchmark();
  command.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
