'use strict';
// Benchmark-only source substitution. Never used by the library entrypoint.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
function loadSourceSnapshot(folder) {
  const root = path.resolve(__dirname, '..'), replacements = new Map();
  for (const name of ['connection.js', 'diodeSocket.js', 'nativeTcpBridge.js', 'nativeCrypto.js', 'publishPort.js', 'bindPort.js', 'relayBackpressure.js']) {
    replacements.set(path.join(root, name), fs.readFileSync(path.resolve(folder, name), 'utf8'));
    if (require.cache[path.join(root, name)]) throw new Error('Load the source snapshot before importing transport modules');
  }
  const previous = Module._extensions['.js'];
  Module._extensions['.js'] = (mod, filename) => replacements.has(filename) ? mod._compile(replacements.get(filename), filename) : previous(mod, filename);
}
if (process.env.DIODE_TEST_SOURCE_SNAPSHOT) loadSourceSnapshot(process.env.DIODE_TEST_SOURCE_SNAPSHOT);
module.exports = { loadSourceSnapshot };
