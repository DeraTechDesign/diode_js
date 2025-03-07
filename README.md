# DiodeJs

## Overview
`diodejs` is a JavaScript client for interacting with the Diode network. It provides functionalities to bind and publish ports, send RPC commands, and handle responses.

## Installation
```bash
npm install diodejs
```

### Quick Start

If you want to enable logs, set environment variable LOG to true. 
If you want to enable debug logs, set environment variable DEBUG to true. 

Can also use .env files

### Test RPC

Here's a quick example to get you started with RPC functions using `DiodeRPC` Class

```javascript
const { DiodeConnection, DiodeRPC, makeReadable } = require('diodejs');

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

#### Port Binding
```javascript
const { DiodeConnection, BindPort } = require('diodejs');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const certPath = 'device_certificate.pem';
  
    const connection = new DiodeConnection(host, port, certPath);
    await connection.connect();
  
    // Multiple or single port binding with configuration object
    const portsConfig = {
      3002: { targetPort: 80, deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2" },
      3003: { targetPort: 443, deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2" }
    };
    
    const portForward = new BindPort(connection, portsConfig);
    portForward.bind();
    
    // You can also dynamically add and remove ports
    portForward.addPort(3004, 8080, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.removePort(3003);
}

main();
```

#### Single Port Binding (Legacy)
```javascript
const { DiodeConnection, BindPort } = require('diodejs');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const certPath = 'device_certificate.pem';
  
    const connection = new DiodeConnection(host, port, certPath);
    await connection.connect();
  
    // Legacy method - single port binding
    const portForward = new BindPort(connection, 3002, 80, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();
}

main();
```

### Publish Port

Here's a quick example to get you started with publishing ports using the `PublishPort` class:

```javascript
const { DiodeConnection, PublishPort } = require('diodejs');

async function main() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const certPath = 'device_certificate.pem';

  const connection = new DiodeConnection(host, port, certPath);
  await connection.connect();

  // Option 1: Simple array of ports (all public)
  const publishedPorts = [8080, 3000]; 
  
  // Option 2: Object with port configurations for public/private access control
  const publishedPortsWithConfig = {
    8080: { mode: 'public' },  // Public port, accessible by any device
    3000: { 
      mode: 'private',  
      whitelist: ['0x1234abcd5678...', '0x9876fedc5432...'] // Only these devices can connect
    }
  };
  
  const publishPort = new PublishPort(connection, publishedPortsWithConfig, certPath);
}

main();
```

## Reference

### Classes and Methods

#### `DiodeConnection`

- **Constructor**: `new DiodeConnection(host, port, certPath)`
  - `host` (string): The host address of the Diode server.
  - `port` (number): The port number of the Diode server.
  - `certPath` (string)(default: ./cert/device_certificate.pem): The path to the device certificate. If doesn't exist, generates automaticly. 

- **Methods**:
  - `connect()`: Connects to the Diode server. Returns a promise.
  - `sendCommand(commandArray)`: Sends a command to the Diode server. Returns a promise.
  - `sendCommandWithSessionId(commandArray, sessionId)`: Sends a command with a session ID. Returns a promise.
  - `getEthereumAddress()`: Returns the Ethereum address derived from the device certificate.
  - `getServerEthereumAddress()`: Returns the Ethereum address of the server.
  - `createTicketCommand()`: Creates a ticket command for authentication. Returns a promise.
  - `close()`: Closes the connection to the Diode server.

#### `DiodeRPC`

- **Constructor**: `new DiodeRPC(connection)`
  - `connection` (DiodeConnection): An instance of `DiodeConnection`.

- **Methods**:
  - `getBlockPeak()`: Retrieves the current block peak. Returns a promise.
  - `getBlockHeader(index)`: Retrieves the block header for a given index. Returns a promise.
  - `getBlock(index)`: Retrieves the block for a given index. Returns a promise.
  - `ping()`: Sends a ping command. Returns a promise.
  - `portOpen(deviceId, port, flags)`: Opens a port on the device. Returns a promise.
  - `portSend(ref, data)`: Sends data to the device. Returns a promise.
  - `portClose(ref)`: Closes a port on the device. Returns a promise.
  - `sendError(sessionId, ref, error)`: Sends an error response. Returns a promise.
  - `sendResponse(sessionId, ref, response)`: Sends a response. Returns a promise.
  - `getEpoch()`: Retrieves the current epoch. Returns a promise.
  - `parseTimestamp(blockHeader)`: Parses the timestamp from a block header. Returns a number.

#### `BindPort`

- **Constructors**:
  
  Legacy Constructor:
  - `new BindPort(connection, localPort, targetPort, deviceIdHex)`
    - `connection` (DiodeConnection): An instance of `DiodeConnection`.
    - `localPort` (number): The local port to bind.
    - `targetPort` (number): The target port on the device.
    - `deviceIdHex` (string): The device ID in hexadecimal format.
  
  New Constructor:
  - `new BindPort(connection, portsConfig)`
    - `connection` (DiodeConnection): An instance of `DiodeConnection`.
    - `portsConfig` (object): A configuration object where keys are local ports and values are objects with `targetPort` and `deviceIdHex`.
      Example: `{ 3002: { targetPort: 80, deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2" } }`

- **Methods**:
  - `bind()`: Binds all configured local ports to their target ports on the devices.
  - `addPort(localPort, targetPort, deviceIdHex)`: Adds a new port binding configuration.
  - `removePort(localPort)`: Removes a port binding configuration.
  - `bindSinglePort(localPort)`: Binds a single local port to its target.
  - `closeAllServers()`: Closes all active server instances.

#### `PublishPort`

- **Constructor**: `new PublishPort(connection, publishedPorts, certPath)`
  - `connection` (DiodeConnection): An instance of `DiodeConnection`.
  - `publishedPorts` (array|object): Either:
    - An array of ports to publish (all public mode)
    - An object mapping ports to their configuration: `{ port: { mode: 'public'|'private', whitelist: ['0x123...'] } }`
  - `certPath` (string): The path to the device certificate.

- **Methods**:
  - `startListening()`: Starts listening for unsolicited messages.
  - `handlePortOpen(sessionIdRaw, messageContent)`: Handles port open requests.
  - `handlePortSend(sessionIdRaw, messageContent)`: Handles port send requests.
  - `handlePortClose(sessionIdRaw, messageContent)`: Handles port close requests.
