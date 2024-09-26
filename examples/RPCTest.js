const { DiodeConnection, DiodeRPC } = require('../index');
const { makeReadable } = require('../utils');

async function main() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const certPath = 'device_certificate.pem';

  const connection = new DiodeConnection(host, port, certPath);
  await connection.connect();
  const rpc = connection.RPC;

  try {
    const address = connection.getEthereumAddress();
    console.log('Address:', address);
    const ping = await rpc.ping();
    console.log('Ping:', ping);
    const blockPeak = await rpc.getBlockPeak();
    console.log('Current Block Peak:', blockPeak);
    const blockHeader = await rpc.getBlockHeader(blockPeak);
    console.log('Block Header:', makeReadable(blockHeader));
  } catch (error) {
    console.error('RPC Error:', error);
  } finally {
    connection.close();
  }
}

main();
