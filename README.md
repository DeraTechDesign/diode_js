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

### Connection Settings

Connection retry behavior can be configured via environment variables:

| Environment Variable | Description | Default |
|----------------------|-------------|---------|
| DIODE_MAX_RETRIES | Maximum number of reconnection attempts | Infinity |
| DIODE_RETRY_DELAY | Initial delay between retries (ms) | 1000 |
| DIODE_MAX_RETRY_DELAY | Maximum delay between retries (ms) | 30000 |
| DIODE_AUTO_RECONNECT | Whether to automatically reconnect | true |

Example `.env` file:
```
DIODE_MAX_RETRIES=10
DIODE_RETRY_DELAY=2000
DIODE_MAX_RETRY_DELAY=20000
DIODE_AUTO_RECONNECT=true
```

These settings can also be configured programmatically:
```javascript
connection.setReconnectOptions({
  maxRetries: 10,
  retryDelay: 2000,
  maxRetryDelay: 20000,
  autoReconnect: true
});
```

### Test RPC

Here's a quick example to get you started with RPC functions using `DiodeRPC` Class

```javascript
const { DiodeConnection, DiodeRPC, makeReadable } = require('diodejs');

async function main() {
  const host = 'eu2.prenet.diode.io';
  const port = 41046;
  const keyLocation = './db/keys.json'; // Optional, defaults to './db/keys.json'

  const connection = new DiodeConnection(host, port, keyLocation);
  
  // Configure reconnection (optional - overrides environment variables)
  connection.setReconnectOptions({
    maxRetries: Infinity, // Unlimited reconnection attempts
    retryDelay: 1000,     // Initial delay of 1 second
    maxRetryDelay: 30000, // Maximum delay of 30 seconds
    autoReconnect: true   // Automatically reconnect on disconnection
  });
  
  // Listen for reconnection events (optional)
  connection.on('reconnecting', (info) => {
    console.log(`Reconnecting... Attempt #${info.attempt} in ${info.delay}ms`);
  });
  connection.on('reconnected', () => {
    console.log('Successfully reconnected!');
  });
  connection.on('reconnect_failed', () => {
    console.log('Failed to reconnect after maximum attempts');
  });
  
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
    const keyLocation = './db/keys.json';
  
    const connection = new DiodeConnection(host, port, keyLocation);
    await connection.connect();
  
    // Multiple or single port binding with configuration object
    const portsConfig = {
      3002: { 
        targetPort: 80, 
        deviceIdHex: "5365baf29cb7ab58de588dfc448913cb609283e2",
        protocol: "tls" // Optional - defaults to TLS if not specified
      },
      3003: { 
        targetPort: 443, 
        deviceIdHex: "0x5365baf29cb7ab58de588dfc448913cb609283e2",
        protocol: "tcp" // Can be "tls", "tcp", or "udp"
      }
    };
    
    const portForward = new BindPort(connection, portsConfig);
    portForward.bind();
    
    // You can also dynamically add ports with protocol specification
    portForward.addPort(3004, 8080, "5365baf29cb7ab58de588dfc448913cb609283e2", "udp");
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
    const keyLocation = './db/keys.json';
  
    const connection = new DiodeConnection(host, port, keyLocation);
    await connection.connect();
  
    // Legacy method - single port binding (defaults to TLS protocol)
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
  const keyLocation = './db/keys.json';

  const connection = new DiodeConnection(host, port, keyLocation);
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
  
  // certPath parameter is maintained for backward compatibility but not required
  const publishPort = new PublishPort(connection, publishedPortsWithConfig);
}

main();
```

## Reference

### Classes and Methods

#### `DiodeConnection`

- **Constructor**: `new DiodeConnection(host, port, keyLocation)`
  - `host` (string): The host address of the Diode server.
  - `port` (number): The port number of the Diode server.
  - `keyLocation` (string)(default: './db/keys.json'): The path to the key storage file. If the file doesn't exist, keys are generated automatically.

- **Methods**:
  - `connect()`: Connects to the Diode server. Returns a promise.
  - `sendCommand(commandArray)`: Sends a command to the Diode server. Returns a promise.
  - `sendCommandWithSessionId(commandArray, sessionId)`: Sends a command with a session ID. Returns a promise.
  - `getEthereumAddress()`: Returns the Ethereum address derived from the device keys.
  - `getServerEthereumAddress()`: Returns the Ethereum address of the server.
  - `createTicketCommand()`: Creates a ticket command for authentication. Returns a promise.
  - `close()`: Closes the connection to the Diode server.
  - `getDeviceCertificate()`: Returns the generated certificate PEM.
  - `setReconnectOptions(options)`: Configures reconnection behavior with the following options:
    - `maxRetries` (number): Maximum reconnection attempts (default: Infinity)
    - `retryDelay` (number): Initial delay between retries in ms (default: 1000)
    - `maxRetryDelay` (number): Maximum delay between retries in ms (default: 30000)
    - `autoReconnect` (boolean): Whether to automatically reconnect on disconnection (default: true)

- **Events**:
  - `reconnecting`: Emitted when a reconnection attempt is about to start, with `attempt` and `delay` information
  - `reconnected`: Emitted when reconnection is successful
  - `reconnect_failed`: Emitted when all reconnection attempts have failed

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
    - `deviceIdHex` (string): The device ID in hexadecimal format (with or without '0x' prefix).
  
  New Constructor:
  - `new BindPort(connection, portsConfig)`
    - `connection` (DiodeConnection): An instance of `DiodeConnection`.
    - `portsConfig` (object): A configuration object where keys are local ports and values are objects with:
      - `targetPort` (number): The target port on the device.
      - `deviceIdHex` (string): The device ID in hexadecimal format (with or without '0x' prefix).
      - `protocol` (string, optional): The protocol to use ("tls", "tcp", or "udp"). Defaults to "tls".

- **Methods**:
  - `bind()`: Binds all configured local ports to their target ports on the devices.
  - `addPort(localPort, targetPort, deviceIdHex, protocol)`: Adds a new port binding configuration.
    - `protocol` (string, optional): The protocol to use. Can be "tls", "tcp", or "udp". Defaults to "tls".
  - `removePort(localPort)`: Removes a port binding configuration.
  - `bindSinglePort(localPort)`: Binds a single local port to its target.
  - `closeAllServers()`: Closes all active server instances.

#### `PublishPort`

- **Constructor**: `new PublishPort(connection, publishedPorts, _certPath)`
  - `connection` (DiodeConnection): An instance of `DiodeConnection`.
  - `publishedPorts` (array|object): Either:
    - An array of ports to publish (all public mode)
    - An object mapping ports to their configuration: `{ port: { mode: 'public'|'private', whitelist: ['0x123...'] } }`
  - `_certPath` (string): Has no functionality and maintained for backward compatibility.

- **Methods**:
  - `addPort(port, config)`: Adds a new port to publish. Config is optional and defaults to public mode.
    - `port` (number): The port number to publish.
    - `config` (object): Optional configuration with `mode` ('public'|'private') and `whitelist` array.
  - `removePort(port)`: Removes a published port.
    - `port` (number): The port number to remove.
  - `addPorts(ports)`: Adds multiple ports at once (equivalent to the constructor's publishedPorts parameter).
    - `ports` (array|object): Either an array of port numbers or an object mapping ports to their configurations.
  - `getPublishedPorts()`: Returns a plain object with all published ports and their configurations.
  - `clearPorts()`: Removes all published ports. Returns the number of ports that were cleared.
  - `startListening()`: Starts listening for unsolicited messages.
  - `handlePortOpen(sessionIdRaw, messageContent)`: Handles port open requests.
  - `handlePortSend(sessionIdRaw, messageContent)`: Handles port send requests.
  - `handlePortClose(sessionIdRaw, messageContent)`: Handles port close requests.
