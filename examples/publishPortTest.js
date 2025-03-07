// example.js

const DiodeConnection = require('../connection')
const PublishPort = require('../publishPort')

async function startPublishing() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const certPath = 'device_certificate.pem';

  const connection = new DiodeConnection(host, port, certPath);
  await connection.connect();

  const publishedPorts = {8080: {mode: 'private', whitelist: ['0xca1e71d8105a598810578fb6042fa8cbc1e7f039']}}
  const publishPort = new PublishPort(connection, publishedPorts, certPath);

}

startPublishing();
