const { KEYUTIL } = require('jsrsasign');
const { DiodeClientManager, BindPort } = require('../index');

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

async function main() {
  const keyLocation = './db/keys2.json';

  const deviceIdHex = process.env.DIODE_TARGET_DEVICE || process.argv[2] || '0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c'; // Replace with actual device

  const client = new DiodeClientManager({keyLocation });
  await client.connect();
  const [connection] = client.getConnections();
  if (!connection) {
    throw new Error('No relay connection available');
  }

  printPublicKey(connection);

  const portsConfig = {
    3005: {
      targetPort: 8089,
      deviceIdHex,
      protocol: 'tcp',
      transport: 'native'
    },
    3006: {
      targetPort: 8090,
      deviceIdHex,
      protocol: 'udp',
      transport: 'native',
      flags: 'rwu'
    }
  };

  const portForward = new BindPort(client, portsConfig);
  portForward.bind();

  console.log('Native bind ports active:', Object.keys(portsConfig).join(', '));
}

main().catch(console.error);
