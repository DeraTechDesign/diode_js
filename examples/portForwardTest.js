const { DiodeClientManager, BindPort } = require('../index');

async function main() {
    const keyLocation = './db/keys.json';
  
    const client = new DiodeClientManager({ keyLocation });
    await client.connect();
  
    const portForward = new BindPort(client, {
        3003: { targetPort: 8080, deviceIdHex: "0xca1e71d8105a598810578fb6042fa8cbc1e7f039", protocol: "tcp" },
        3004: { targetPort: 8081, deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2", protocol: "tls" }
      });
    portForward.bind();

    // after 5 seconds, remove port 3003
    setTimeout(() => {
        console.log("Removing port 3003");
        portForward.removePort(3003);
    }, 5000);

    // after 10 seconds, add port 3003 back
    setTimeout(() => {
        console.log("Adding port 3003 back");
        portForward.addPort(3003, 8080, "0xca1e71d8105a598810578fb6042fa8cbc1e7f039", "tcp");
    }, 10000);
    
    
}

main().catch(console.error);
