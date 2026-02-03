const { DiodeClientManager, DiodeRPC } = require('../index');
const { makeReadable } = require('../utils');

async function main() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const keyLocation = './db/keys.json';

  const client = new DiodeClientManager({ host, port, keyLocation });
  await client.connect();
  const [connection] = client.getConnections();
  if (!connection) {
    throw new Error('No relay connection available');
  }
  const rpc = connection.RPC || new DiodeRPC(connection);

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
    client.close();
  }
}

main();
