const { DiodeClientManager, PublishPort, BindPort } = require('../index')

const host = 'us2.prenet.diode.io';
const port = 41046;
const keyLocation = './db/keys.json';

const client = new DiodeClientManager({ host, port, keyLocation });

async function main() {
    await client.connect();
    const publishedPorts = [8080]; // Ports you want to publish
    const publishPort = new PublishPort(client, publishedPorts);

    const portForward = new BindPort(client, 3002, 8080, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();

}

main();

    
