const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const tls = require('node:tls');
const { KEYUTIL } = require('jsrsasign');
const { generateCert } = require('../utils');

test('unreachable IPv6 discovery reaches the IPv4 TLS candidate without terminating the process', async t => {
  const keys = KEYUTIL.generateKeypair('EC', 'secp256r1');
  const pem = generateCert(keys.prvKeyObj, keys.pubKeyObj);
  let attemptedIpv4 = false;
  const server = tls.createServer({ key: pem, cert: pem });
  server.on('connection', () => { attemptedIpv4 = true; });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const program = `
    const {fetchNetworkDirectory} = require(${JSON.stringify(require.resolve('../networkDiscoveryClient'))});
    const assert = require('node:assert/strict');
    (async () => {
      for (let i=0; i<3; i++) {
        await assert.rejects(fetchNetworkDirectory({endpoint:'wss://directory.test:${server.address().port}',timeoutMs:2000,
          lookup:(_h,_o,done)=>done(null,[{address:'2001:db8::1',family:6},{address:'127.0.0.1',family:4}])}),
          error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /Network discovery timed out/.test(error.message));
      }
      console.log('ipv4-certificate-verified');
    })().catch(error => { console.error(error.code || error.message); process.exitCode=1; });`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', program], { timeout: 15000 });
  assert.match(stdout, /ipv4-certificate-verified/);
  assert.equal(stderr, '');
  assert.equal(attemptedIpv4, true);
});
