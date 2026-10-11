'use strict';
// Release check against an extracted, published npm package. No source is
// copied into a consumer and no baseline package is included in this release.
process.env.LOG = 'false'; process.env.DEBUG = 'false';
const fs = require('node:fs'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runTunnel } = require('../test/apiTls.integration.test');
const { runNativeTunnel } = require('../test/nativeTcp.integration.test');

async function main() {
  const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
  if (!args.includes('--baseline')) throw new Error('--baseline must name an extracted published diodejs package');
  const baseline = path.resolve(option('--baseline')), metadata = require(path.join(baseline, 'package.json'));
  if (metadata.name !== 'diodejs') throw new Error('Baseline package must be diodejs');
  const report = { node: process.version, baseline: metadata.version, candidate: require('../package.json').version,
    scope: 'Real TCP/TLS and Native cryptography with a simulated relay; candidate and published peers in both directions.', results: [] };
  for (const oldSide of ['binder', 'publisher']) {
    const classes = oldSide === 'binder' ? { bindClass: require(path.join(baseline, 'bindPort')) }
      : { publishClass: require(path.join(baseline, 'publishPort')) };
    for (const mode of ['api-tcp', 'api-tls', 'native-tcp']) {
      for (const direction of ['upload', 'download']) {
        const started = performance.now(); let error;
        try {
          if (mode === 'native-tcp') await runNativeTunnel({ ...classes, serverFirst: true,
            requestBytes: direction === 'upload' ? 2 * 1024 * 1024 : 128,
            responseBytes: direction === 'download' ? 2 * 1024 * 1024 : 128,
            slowBackend: direction === 'upload', slowClient: direction === 'download' });
          else await runTunnel({ ...classes, protocol: mode.slice(4), bytes: 2 * 1024 * 1024, ackRttMs: 20,
            clientEnds: direction === 'upload', slowBackend: direction === 'upload',
            backendEnds: direction === 'download', slowReader: direction === 'download' });
        } catch (failure) { error = failure.message; }
        report.results.push({ mode, oldSide, direction, passed: !error, error, elapsedMs: performance.now() - started });
      }
    }
  }
  report.passed = report.results.every(result => result.passed);
  const output = args.includes('--output') ? path.resolve(option('--output')) : path.resolve('out/compatibility.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ baseline: report.baseline, candidate: report.candidate, cases: report.results.length, passed: report.results.filter(r => r.passed).length }));
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
