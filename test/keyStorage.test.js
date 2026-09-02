const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadOrGenerateKeyPair } = require('../utils');

function makeTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-key-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function runKeyLoader(keyLocation) {
  const utilsPath = require.resolve('../utils');
  const script = [
    "const crypto=require('node:crypto')",
    `const {loadOrGenerateKeyPair}=require(${JSON.stringify(utilsPath)})`,
    'const keyPair=loadOrGenerateKeyPair(process.argv[1])',
    "process.stdout.write(crypto.createHash('sha256').update(keyPair.prvKeyObj.prvKeyHex).digest('hex'))",
  ].join(';');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, keyLocation], {
      env: { ...process.env, LOG: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`key loader exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

test('generated identity is atomically stored without a duplicate raw secret', (t) => {
  const root = makeTempDir(t);
  const keyDirectory = path.join(root, 'identity');
  const keyLocation = path.join(keyDirectory, 'keys.json');

  const generated = loadOrGenerateKeyPair(keyLocation);
  const stored = JSON.parse(fs.readFileSync(keyLocation, 'utf8'));
  const loaded = loadOrGenerateKeyPair(keyLocation);

  assert.equal(typeof stored.privateKey, 'string');
  assert.equal(typeof stored.publicKey, 'string');
  assert.equal(Object.hasOwn(stored, 'check'), false);
  assert.equal(loaded.prvKeyObj.prvKeyHex, generated.prvKeyObj.prvKeyHex);
  assert.deepEqual(
    fs.readdirSync(keyDirectory).filter((name) => name.endsWith('.tmp')),
    []
  );
  if (process.platform !== 'win32') {
    assert.equal(mode(keyDirectory), 0o700);
    assert.equal(mode(keyLocation), 0o600);
  }
});

test('loading an existing identity tightens permissive file permissions', (t) => {
  if (process.platform === 'win32') return;
  const root = makeTempDir(t);
  const keyLocation = path.join(root, 'keys.json');
  const generated = loadOrGenerateKeyPair(keyLocation);
  fs.chmodSync(keyLocation, 0o644);

  const loaded = loadOrGenerateKeyPair(keyLocation);

  assert.equal(loaded.prvKeyObj.prvKeyHex, generated.prvKeyObj.prvKeyHex);
  assert.equal(mode(keyLocation), 0o600);
});

test('concurrent first-start processes converge on one complete identity', async (t) => {
  const root = makeTempDir(t);
  const keyLocation = path.join(root, 'identity', 'keys.json');

  const fingerprints = await Promise.all([
    runKeyLoader(keyLocation),
    runKeyLoader(keyLocation),
    runKeyLoader(keyLocation),
    runKeyLoader(keyLocation),
  ]);

  assert.equal(new Set(fingerprints).size, 1);
  const stored = JSON.parse(fs.readFileSync(keyLocation, 'utf8'));
  const storedFingerprint = crypto
    .createHash('sha256')
    .update(loadOrGenerateKeyPair(keyLocation).prvKeyObj.prvKeyHex)
    .digest('hex');
  assert.equal(fingerprints[0], storedFingerprint);
  assert.equal(typeof stored.privateKey, 'string');
});

test('failed atomic installation leaves no partial target or temporary secret', (t) => {
  const root = makeTempDir(t);
  const keyLocation = path.join(root, 'identity', 'keys.json');
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    const error = new Error('simulated atomic install failure');
    error.code = 'EPERM';
    throw error;
  };

  try {
    assert.throws(() => loadOrGenerateKeyPair(keyLocation), /atomic install failure/);
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(fs.existsSync(keyLocation), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(keyLocation)).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('a corrupt existing identity is never silently replaced', (t) => {
  const root = makeTempDir(t);
  const keyLocation = path.join(root, 'keys.json');
  fs.writeFileSync(keyLocation, '{broken', { mode: 0o600 });

  assert.throws(() => loadOrGenerateKeyPair(keyLocation), /JSON/);
  assert.equal(fs.readFileSync(keyLocation, 'utf8'), '{broken');
});
