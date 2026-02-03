const dgram = require('dgram');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 3006);
const message = process.argv.slice(4).join(' ') || 'hello-udp';
const intervalMs = Number(process.env.INTERVAL_MS || 1000);

const socket = dgram.createSocket('udp4');
let intervalId = null;
let counter = 0;

const sendPayload = () => {
  const payload = Buffer.from(`${message} #${counter++} ${new Date().toISOString()}`, 'utf8');
  socket.send(payload, port, host);
};

socket.on('message', (msg) => {
  if (msg.length === 0 || (msg.length === 1 && msg[0] === 0)) {
    return;
  }
  console.log(msg.toString('utf8'));
});

socket.on('error', (err) => {
  if (intervalId) clearInterval(intervalId);
  console.error(`UDP error: ${err.message}`);
  socket.close();
  process.exitCode = 1;
});

sendPayload();
intervalId = setInterval(sendPayload, intervalMs);

const shutdown = () => {
  if (intervalId) clearInterval(intervalId);
  socket.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
