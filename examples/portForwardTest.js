const { DiodeConnection, BindPort } = require('../index');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const certPath = 'device_certificate.pem';
  
    const connection = new DiodeConnection(host, port, certPath);
    await connection.connect();
  
    const portForward = new BindPort(connection, 3002, 80, "5365baf29cb7ab58de588dfc448913cb609283e2");
    const portForward2 = new BindPort(connection, 3003, 80, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();
    portForward2.bind();
    
}

main();