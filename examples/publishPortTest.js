// example.js

const DiodeConnection = require('../connection')
const PublishPort = require('../publishPort')

async function startPublishing() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const certPath = 'device_certificate.pem';

  const connection = new DiodeConnection(host, port, certPath);
  await connection.connect();

  const publishedPorts = [8080]; // Ports you want to publish
  const publishPort = new PublishPort(connection, publishedPorts, certPath);

}

startPublishing();
