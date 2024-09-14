# diode_client_js

## Overview
`diode_client_js` is a JavaScript client for interacting with the Diode network. It provides functionalities to bind ports, send RPC commands, and handle responses.

## Quick Start

To get started, you need to generate a device certificate using OpenSSL. You can use this command:

```bash
openssl ecparam -name secp256k1 -out secp256k1_params.pem
openssl req -newkey ec:./secp256k1_params.pem -nodes -keyout device_certificate.pem -x509 -days 365 -out device_certificate.pem -subj "/CN=device"
```

### Test RPC

Here's a quick example to get you started with RPC functions using `DiodeRPC` Class

```javascript
const { DiodeConnection, DiodeRPC } = require('../index');
const { makeReadable } = require('../utils');

async function main() {
  const host = 'eu2.prenet.diode.io';
  const port = 41046;
  const certPath = 'device_certificate.pem';

  const connection = new DiodeConnection(host, port, certPath);
  await connection.connect();

  const rpc = new DiodeRPC(connection);

  try {
    const ping = await rpc.ping();
    console.log('Ping:', ping);
    const blockPeak = await rpc.getBlockPeak();
    console.log('Current Block Peak:', blockPeak);

    const blockHeader = await rpc.getBlockHeader(blockPeak);
    console.log('Block Header:', makeReadable(blockHeader));
  } catch (error) {
    console.error('RPC Error:', error);
  } finally {
    connection.close();
  }
}

main();

```

### Bind Port
Here's a quick example to get you started with port forwarding using the `BindPort` class.

```javascript
const { DiodeConnection, BindPort } = require('../index');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const certPath = 'device_certificate.pem';
  
    const connection = new DiodeConnection(host, port, certPath);
    await connection.connect();
  
    const portForward = new BindPort(connection, 3002, 80, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();
    
}

main();
```

