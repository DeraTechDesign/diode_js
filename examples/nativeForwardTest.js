const net = require('net');
const dgram = require('dgram');
const { KEYUTIL } = require('jsrsasign');
const { DiodeClientManager, PublishPort } = require('../index');

function printPublicKey(connection) {
  try {
    const pem = KEYUTIL.getPEM(connection.keyPair.pubKeyObj, 'PKCS8PUB');
    console.log('Public key (PEM):');
    console.log(pem);
  } catch (error) {
    console.error('Failed to print public key:', error);
  }
  try {
    console.log('Ethereum address:', connection.getEthereumAddress());
  } catch (error) {
    console.error('Failed to print address:', error);
  }
}

function startTcpEcho(port) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      socket.write(data);
    });
  });

  server.listen(port, () => {
    console.log(`TCP echo listening on ${port}`);
  });

  return server;
}

function startUdpEcho(port) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    socket.send(msg, rinfo.port, rinfo.address);
  });
  socket.bind(port, () => {
    console.log(`UDP echo listening on ${port}`);
  });
  return socket;
}

async function main() {
  const keyLocation = './db/keys.json';

  const tcpServer = startTcpEcho(8089);
  const udpSocket = startUdpEcho(8090);

  const client = new DiodeClientManager({keyLocation });
  await client.connect();
  const [connection] = client.getConnections();
  if (!connection) {
    throw new Error('No relay connection available');
  }

  printPublicKey(connection);

  const publishPort = new PublishPort(client, {
    8089: { mode: 'public' },
    8090: { mode: 'public' }
  });

  console.log('Native forward ports published:', publishPort.getPublishedPorts());

  const shutdown = () => {
    try { client.close(); } catch {}
    try { tcpServer.close(); } catch {}
    try { udpSocket.close(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
