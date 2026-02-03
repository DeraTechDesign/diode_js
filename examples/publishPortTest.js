// example.js

const { DiodeClientManager, PublishPort } = require('../index');

async function startPublishing() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const keyLocation = './db/keys.json';

  const client = new DiodeClientManager({ host, port, keyLocation });
  await client.connect();

  // Create a PublishPort instance with initial ports
  const publishPort = new PublishPort(client, {
    3000: { mode: 'public' },
    8080: { 
      mode: 'private',
      whitelist: ['0xca1e71d8105a598810578fb6042fa8cbc1e7f039'] // Replace with actual addresses
    }
  }, keyLocation);
  
  console.log('Initial published ports:', publishPort.getPublishedPorts());
  
  // After 10 seconds, remove a port
  setTimeout(() => {
    console.log("Removing port 8080");
    publishPort.removePort(3000);
    console.log('Updated published ports:', publishPort.getPublishedPorts());
  }, 10000);
  
  // After 15 seconds, add multiple ports
  setTimeout(() => {
    console.log("Adding multiple ports");
    publishPort.addPort(3000,{ mode: 'public' });
    console.log('Updated published ports:', publishPort.getPublishedPorts());
  }, 15000);
  
}

startPublishing().catch(console.error);
