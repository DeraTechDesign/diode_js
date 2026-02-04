const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 3005);
const message = process.argv.slice(4).join(' ') || 'hello-tcp';
const intervalMs = Number(process.env.INTERVAL_MS || 1000);
const connectTimeoutMs = Number(process.env.CONNECT_TIMEOUT_MS || 5000);

let intervalId = null;
let connected = false;
let counter = 0;

const client = net.createConnection({ host, port }, () => {
  connected = true;
  client.setNoDelay(true);
  clearTimeout(connectTimer);
  const sendPayload = () => {
    const payload = `${message} #${counter++} ${new Date().toISOString()}`;
    client.write(Buffer.from(payload, 'utf8'));
  };
  sendPayload();
  intervalId = setInterval(sendPayload, intervalMs);
});

const connectTimer = setTimeout(() => {
  if (connected) return;
  console.error(`Connect timeout after ${connectTimeoutMs}ms`);
  client.destroy();
  process.exitCode = 1;
}, connectTimeoutMs);

client.on('data', (data) => {
  console.log(data.toString('utf8'));
});

client.on('end', () => {
  if (intervalId) clearInterval(intervalId);
});

client.on('close', () => {
  if (intervalId) clearInterval(intervalId);
});

client.on('error', (err) => {
  if (intervalId) clearInterval(intervalId);
  console.error(`TCP error: ${err.message}`);
  process.exitCode = 1;
});

const shutdown = () => {
  if (intervalId) clearInterval(intervalId);
  if (!client.destroyed) client.end();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
