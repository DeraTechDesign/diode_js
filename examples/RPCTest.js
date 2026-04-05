const { DiodeClientManager, DiodeRPC } = require('../index');
const { makeReadable } = require('../utils');

async function main() {
  const keyLocation = './db/keys.json';
  const fleetContract = process.env.DIODE_FLEET_CONTRACT;
  const nextFleetContract = process.env.DIODE_NEXT_FLEET_CONTRACT;

  const client = new DiodeClientManager({
    keyLocation,
    ...(fleetContract ? { fleetContract } : {}),
  });
  await client.connect();
  const [connection] = client.getConnections();
  if (!connection) {
    throw new Error('No relay connection available');
  }
  const rpc = connection.RPC || new DiodeRPC(connection);

  try {
    const address = connection.getEthereumAddress();
    console.log('Address:', address);
    console.log('Current fleet contract:', connection.fleetContractHex);
    if (nextFleetContract) {
      client.setFleetContract(nextFleetContract);
      console.log('Updated fleet contract for future tickets:', connection.fleetContractHex);
    }
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
