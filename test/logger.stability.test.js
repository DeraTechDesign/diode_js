const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const loggerPath = require.resolve('../logger');

function makeTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diode-logger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runLogger(script, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('logger child timed out'));
    }, 15000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

test('default warning visibility does not create cwd log files', async (t) => {
  const cwd = makeTempDir(t);
  const script = `const logger=require(${JSON.stringify(loggerPath)});logger.warn('relay unavailable')`;

  const result = await runLogger(script, { cwd, env: { LOG: 'false' } });

  assert.equal(result.code, 0);
  assert.match(result.stderr, /\[diodejs\] relay unavailable/);
  assert.equal(fs.existsSync(path.join(cwd, 'logs')), false);
});

test('enabled persistent logging stays within a bounded rolling file set', async (t) => {
  const cwd = makeTempDir(t);
  const logDirectory = path.join(cwd, 'bounded-logs');
  const script = [
    `const logger=require(${JSON.stringify(loggerPath)})`,
    "for(let index=0;index<900;index+=1)logger.warn('x'.repeat(1024)+index)",
    'setTimeout(()=>process.exit(0),1500)',
  ].join(';');

  const result = await runLogger(script, {
    cwd,
    env: {
      LOG: 'true',
      NODE_ENV: 'production',
      DIODE_LOG_DIRECTORY: logDirectory,
      DIODE_LOG_MAX_BYTES: '65536',
      DIODE_LOG_MAX_FILES: '3',
    },
  });

  assert.equal(result.code, 0);
  const files = fs.readdirSync(logDirectory)
    .map((name) => ({ name, size: fs.statSync(path.join(logDirectory, name)).size }))
    .filter((entry) => entry.name.startsWith('diodejs'));
  assert.ok(files.length >= 2, 'storm should exercise file rotation');
  assert.ok(files.length <= 3, `expected at most 3 log files, got ${files.length}`);
  assert.ok(files.every((entry) => entry.size <= 70 * 1024), JSON.stringify(files));
  assert.ok(files.reduce((total, entry) => total + entry.size, 0) <= 210 * 1024);
  if (process.platform !== 'win32') {
    assert.ok(files.every((entry) => (fs.statSync(path.join(logDirectory, entry.name)).mode & 0o777) === 0o600));
  }
});
