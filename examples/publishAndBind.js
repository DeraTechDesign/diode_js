const DiodeConnection = require('../connection')
const PublishPort = require('../publishPort')
const BindPort = require('../bindPort')

const host = 'us2.prenet.diode.io';
const port = 41046;
const certPath = 'device_certificate.pem';

const connection = new DiodeConnection(host, port, certPath);

async function main() {
    await connection.connect();
    const publishedPorts = [8080]; // Ports you want to publish
    const publishPort = new PublishPort(connection, publishedPorts, certPath);

    const portForward = new BindPort(connection, 3002, 8080, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();

}

main();

    