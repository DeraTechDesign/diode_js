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
| DIODE_TICKET_BYTES_THRESHOLD | Bytes threshold for ticket updates | 512000 (512KB) |
| DIODE_TICKET_UPDATE_INTERVAL | Time interval for ticket updates (ms) | 30000 (30s) |

Example `.env` file:
```
DIODE_MAX_RETRIES=10
DIODE_RETRY_DELAY=2000
DIODE_MAX_RETRY_DELAY=20000
DIODE_AUTO_RECONNECT=true
DIODE_TICKET_BYTES_THRESHOLD=512000
DIODE_TICKET_UPDATE_INTERVAL=30000
```

These settings can also be configured programmatically on the relay connections managed by `DiodeClientManager`:
```javascript
const { DiodeClientManager } = require('diodejs');

async function main() {
  const client = new DiodeClientManager({ keyLocation: './db/keys.json' });
  await client.connect();

  for (const connection of client.getConnections()) {
    connection.setReconnectOptions({
      maxRetries: 10,
      retryDelay: 2000,
      maxRetryDelay: 20000,
      autoReconnect: true
    });

    connection.setTicketBatchingOptions({
      threshold: 512000,
      interval: 30000
    });
  }
}

main();
```

### Multi-Relay Connections (Recommended)

You can connect to multiple Diode relays and automatically route binds to the relay where the target device is connected.

```javascript
const { DiodeClientManager, BindPort } = require('diodejs');

async function main() {
  // Connect to default relay pool (pre-net defaults)
  const client = new DiodeClientManager({ keyLocation: './db/keys.json' });
  await client.connect();

  const bind = new BindPort(client, {
    3003: { targetPort: 8080, deviceIdHex: '0x...', protocol: 'tcp' }
  });
  bind.bind();
}
```

If you provide a host, only that relay is used initially (similar to `-diodeaddrs`):

```javascript
const client = new DiodeClientManager({
  host: 'us2.prenet.diode.io',
  port: 41046,
  keyLocation: './db/keys.json'
});
await client.connect();
```

### Test RPC

Here's a quick example to get you started with RPC functions using `DiodeRPC` Class

```javascript
const { DiodeClientManager, DiodeRPC, makeReadable } = require('diodejs');

async function main() {
  const host = 'eu2.prenet.diode.io';
  const port = 41046;
  const keyLocation = './db/keys.json'; // Optional, defaults to './db/keys.json'

  const client = new DiodeClientManager({ host, port, keyLocation });
  await client.connect();

  const connection = client.getConnections()[0];
  if (!connection) {
    throw new Error('No relay connection available');
  }

  // Configure reconnection (optional - overrides environment variables)
  connection.setReconnectOptions({
    maxRetries: Infinity, // Unlimited reconnection attempts
    retryDelay: 1000,     // Initial delay of 1 second
    maxRetryDelay: 30000, // Maximum delay of 30 seconds
    autoReconnect: true   // Automatically reconnect on disconnection
  });

  // Configure ticket batching (optional - overrides environment variables)
  connection.setTicketBatchingOptions({
    threshold: 512000, // Bytes threshold for ticket updates
    interval: 30000    // Time interval for ticket updates
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
    client.close();
  }
}

main();

```

### Bind Port
Here's a quick example to get you started with port forwarding using the `BindPort` class.

#### Port Binding
```javascript
const { DiodeClientManager, BindPort } = require('diodejs');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const keyLocation = './db/keys.json';
  
    const client = new DiodeClientManager({ host, port, keyLocation });
    await client.connect();
  
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
        protocol: "tcp", // Can be "tls", "tcp", or "udp"
        transport: "native" // Optional - "api" (default) or "native" for portopen2 (tcp/udp only)
      }
    };
    
    const portForward = new BindPort(client, portsConfig);
    portForward.bind();
    
    // You can also dynamically add ports with protocol specification
    portForward.addPort(3004, 8080, "5365baf29cb7ab58de588dfc448913cb609283e2", "udp");
    portForward.removePort(3003);
}

main();
```

#### Single Port Binding (Legacy)
```javascript
const { DiodeClientManager, BindPort } = require('diodejs');

async function main() {
    const host = 'eu2.prenet.diode.io';
    const port = 41046;
    const keyLocation = './db/keys.json';
  
    const client = new DiodeClientManager({ host, port, keyLocation });
    await client.connect();
  
    // Legacy method - single port binding (defaults to TLS protocol)
    const portForward = new BindPort(client, 3002, 80, "5365baf29cb7ab58de588dfc448913cb609283e2");
    portForward.bind();
}

main();
```

### Publish Port

Here's a quick example to get you started with publishing ports using the `PublishPort` class:

```javascript
const { DiodeClientManager, PublishPort } = require('diodejs');

async function main() {
  const host = 'us2.prenet.diode.io';
  const port = 41046;
  const keyLocation = './db/keys.json';

  const client = new DiodeClientManager({ host, port, keyLocation });
  await client.connect();

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
  const publishPort = new PublishPort(client, publishedPortsWithConfig);
}

main();
```

## Reference

### Classes and Methods

#### `DiodeClientManager`

- **Constructor**: `new DiodeClientManager(options)`
  - `options.host` (string, optional): Single relay host (with or without port). If provided, only this relay is used initially.
  - `options.port` (number, optional): Port to use when `options.host` has no port. Defaults to `41046`.
  - `options.hosts` (string[] or comma-separated string, optional): Explicit relay list.
  - `options.keyLocation` (string, optional): Key storage path (default: `./db/keys.json`).
  - `options.deviceCacheTtlMs` (number, optional): Cache TTL for device relay resolution (default: `30000`).

- **Methods**:
  - `connect()`: Connects to the initial relay pool. Returns a promise.
  - `getConnectionForDevice(deviceId)`: Resolves and returns a relay connection for the device. Returns a promise.
  - `getConnections()`: Returns a list of active connections.
  - `close()`: Closes all managed connections.

Connections returned by `getConnections()` or `getConnectionForDevice()` emit `reconnecting`, `reconnected`, and `reconnect_failed` events, and support `setReconnectOptions(...)` and `setTicketBatchingOptions({ threshold, interval })`.

#### `DiodeRPC`

- **Constructor**: `new DiodeRPC(connection)`
  - `connection` (object): A relay connection from `DiodeClientManager.getConnections()` or `DiodeClientManager.getConnectionForDevice()`.

- **Methods**:
  - `getBlockPeak()`: Retrieves the current block peak. Returns a promise.
  - `getBlockHeader(index)`: Retrieves the block header for a given index. Returns a promise.
  - `getBlock(index)`: Retrieves the block for a given index. Returns a promise.
  - `getObject(deviceId)`: Retrieves a device ticket object. Returns a promise.
  - `getNode(nodeId)`: Retrieves relay node information. Returns a promise.
  - `ping()`: Sends a ping command. Returns a promise.
  - `portOpen(deviceId, port, flags)`: Opens a port on the device. Returns a promise.
  - `portOpen2(deviceId, port, flags)`: Opens a native relay port on the device (TCP/UDP). Returns the server relay port.
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
    - `connection` (DiodeClientManager): An instance of `DiodeClientManager`.
    - `localPort` (number): The local port to bind.
    - `targetPort` (number): The target port on the device.
    - `deviceIdHex` (string): The device ID in hexadecimal format (with or without '0x' prefix).
  
  New Constructor:
  - `new BindPort(connection, portsConfig)`
    - `connection` (DiodeClientManager): An instance of `DiodeClientManager`.
    - `portsConfig` (object): A configuration object where keys are local ports and values are objects with:
      - `targetPort` (number): The target port on the device.
      - `deviceIdHex` (string): The device ID in hexadecimal format (with or without '0x' prefix).
      - `protocol` (string, optional): The protocol to use ("tls", "tcp", or "udp"). Defaults to "tls".
      - `transport` (string, optional): The relay transport to use ("api" or "native"). Defaults to "api". Native uses `portopen2` and supports TCP/UDP only.

- **Methods**:
  - `bind()`: Binds all configured local ports to their target ports on the devices.
  - `addPort(localPort, targetPort, deviceIdHex, protocol, transport)`: Adds a new port binding configuration.
    - `protocol` (string, optional): The protocol to use. Can be "tls", "tcp", or "udp". Defaults to "tls".
    - `transport` (string, optional): The relay transport to use ("api" or "native"). Defaults to "api".
  - `removePort(localPort)`: Removes a port binding configuration.
  - `bindSinglePort(localPort)`: Binds a single local port to its target.
  - `closeAllServers()`: Closes all active server instances.

#### `PublishPort`

- **Constructor**: `new PublishPort(connection, publishedPorts, _certPath)`
  - `connection` (DiodeClientManager): An instance of `DiodeClientManager`.
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
