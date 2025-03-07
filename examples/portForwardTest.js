const { DiodeConnection, BindPort } = require('../index');

async function main() {
    const host = 'us2.prenet.diode.io';
    const port = 41046;
    const keyLocation = './db/keys.json';
  
    const connection = new DiodeConnection(host, port, keyLocation);
    await connection.connect();
  
    const portForward = new BindPort(connection, {
        3003: { targetPort: 8080, deviceIdHex: "ca1e71d8105a598810578fb6042fa8cbc1e7f039" },
        3004: { targetPort: 443, deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2" }
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
        portForward.addPort(3003, 8080, "ca1e71d8105a598810578fb6042fa8cbc1e7f039");
    }, 10000);
    
    
}

main().catch(console.error);