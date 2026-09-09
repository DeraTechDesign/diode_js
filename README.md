# DiodeJs

Native TCP relay selection now checks the allocated data socket before accepting
a relay. An unreachable socket closes that allocation and releases its lease,
then tries the other available relays while the application socket stays paused.
Cancellation closes late allocations. There is no API downgrade or replay of
application data; failures after authentication still end the stream.

On 2026-09-09, the live disposable-peer benchmark through `eu1.prenet.diode.io`
passed Native TCP twice (1 MiB upload-plus-echo, 60.32 and 73.56 Mbps, not one-way
capacity). The OrendaService application test still failed on its automatically
selected route: allocated data-port timeouts and a handshake timeout. A successful
control connection or local relay test does not qualify a public Native route.
This branch is unreleased; installed diodejs 0.5.4 does not contain this retry fix.

### Relay selection and live performance

Connected relays rank by measured RTT, with recently failed probes demoted.
An older RTT sample triggers a background refresh without automatically losing
to a slower, newer sample. Slow destination tickets are reconciled even when
their relay already has a warm connection. Existing tunnels stay on their relay.

Run `node scripts/benchmark-network.js --help` for live seed discovery, handshake
timings, and API TCP/TLS/UDP and Native TCP/UDP echo measurements. The benchmark
uses disposable identities and a temporary echo service restricted to its own
client. `--routing` reproduces score aging while measuring the actual selected
data path. See [the September performance report](https://github.com/DeraTechDesign/diode_js/blob/main/docs/performance-2026-09-08.md)
for results, historical comparisons, limitations, and reproduction commands.

### Native TCP/UDP transport

Native transport (`transport: "native"`) uses `portopen2` and the existing
authenticated, encrypted native wire protocol. It runs with Node's built-in
TCP/UDP/streams/crypto APIs and the existing cryptography packages' JavaScript
fallbacks; the transport choice does not require a native addon.

Native TCP now uses bounded stream backpressure in both directions, preserves
half-close responses and final buffered bytes, and flushes its TLS handshake
before releasing the handshake channel. Native opens can retry another relay
without switching transport or replaying application data. TCP frame processing
avoids repeated copies of fragmented ciphertext. Existing identity signatures,
publish whitelists, authenticated encryption, and UDP replay checks remain.

Native supports TCP and UDP. API remains the default and handles the library's
TLS protocol. Select the transport explicitly; application protocols such as
RDP and SQL are carried inside the selected stream.

Run `node scripts/benchmark-native-framing.js` for the controlled receive-codec
benchmark. It compares copying/decryption with 0.5.2 and does not measure public
network performance. Native integration tests run with addons disabled using
`node --require ./test/fixtures/no-native-addons.cjs --test test/nativeTcp.integration.test.js`.

### API transport stability

API TCP and TLS streams use an ordered send window capped at 256 KiB and 16
unacknowledged frames per direction. This avoids waiting a full relay round trip
for every write while preserving Node stream backpressure. Frames remain below
the 65,535-byte wire limit; failed stream data is never replayed. Graceful EOF
drains queued data on both endpoints before closing the remote ref. Errors,
relay disconnects, access revocation, and explicit disposal still tear down the
session immediately.

Slow local readers apply receive pressure at 256 KiB of queued data and release
it below 128 KiB, keeping the existing 1 MiB queue limit. API tunnels multiplex
one relay TCP socket, so a paused reader can briefly delay other tunnels on that
relay. Every blocked consumer must drain or close before reads resume. A reader
making no queue progress for the I/O timeout (10 seconds by default) is closed;
progressing readers refresh that deadline. Disconnects discard the old relay's
queued frames and cannot resume a replacement socket.

The transport uses JavaScript with Node's built-in streams, TCP, and TLS. No new
native addon or `portopen2` transport is required. Run
`node scripts/benchmark-api-tls.js` for a local real-TLS comparison with simulated
40/80 ms relay acknowledgment latency. Its results are not public-network speed
measurements. `node --test test/apiTls.integration.test.js` checks client-first
binary traffic, backpressure, EOF in both directions, and asynchronous failures
for API TCP and TLS.

To verify the existing crypto dependencies' JavaScript fallbacks, run
`node --require ./test/fixtures/no-native-addons.cjs --test test/apiTls.integration.test.js`.
This blocks loading `.node` addons while exercising the same real TCP/TLS tests.

## Overview
`diodejs` is a JavaScript client for interacting with the Diode network. It provides functionalities to bind and publish ports, send RPC commands, and handle responses.

## Installation
```bash
npm install diodejs
```

### Quick Start

Warnings and errors are always written to stderr. Set `LOG=true` to also enable
bounded persistent logging in `logs/diodejs.log`; the default retention is five
files of at most 2 MiB each. Use `DIODE_LOG_DIRECTORY`,
`DIODE_LOG_MAX_BYTES`, and `DIODE_LOG_MAX_FILES` to reduce those limits or
change the directory. Set `DEBUG=true` together with `LOG=true` to enable debug
output.

Can also use .env files

### Connection Settings

Connection retry behavior can be configured via environment variables:

| Environment Variable | Description | Default |
|----------------------|-------------|---------|
| DIODE_MAX_RETRIES | Maximum number of reconnection attempts | Infinity |
| DIODE_RETRY_DELAY | Initial delay between retries (ms) | 1000 |
| DIODE_MAX_RETRY_DELAY | Maximum delay between retries (ms) | 30000 |
| DIODE_AUTO_RECONNECT | Whether to automatically reconnect | true |
| DIODE_TICKET_BYTES_THRESHOLD | Bytes threshold for ticket updates | 4194304 (4 MiB) |
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

Fleet contract selection is configured on the manager:
```javascript
const { DiodeClientManager } = require('diodejs');

async function main() {
  const client = new DiodeClientManager({
    keyLocation: './db/keys.json',
    fleetContract: '0x1111111111111111111111111111111111111111',
  });

  await client.connect();

  // Applies on the next ticket generated by each active relay connection.
  client.setFleetContract('0x2222222222222222222222222222222222222222');
}

main();
```

If `fleetContract` is omitted, tickets continue using the default contract `0x6000000000000000000000000000000000000000`.

### Multi-Relay Connections (Recommended)

You can connect to multiple Diode relays and automatically route binds to the relay where the target device is connected.

`DiodeClientManager` ranks relays by observed ping latency, excluding DNS, TLS, and ticket setup time. `connect()` resolves as soon as one relay completes its authenticated handshake. Remaining candidate measurements continue in the background, persist relay scores to disk, and improve the preferred relay for control-plane RPC calls. Idle pruning waits for startup coverage and preserves active tunnels and pending tunnel opens.

When neither `host` nor `hosts` is specified, the manager starts from the default seed pool, any discovery-provider candidates, built-in `dio_network` candidates, and previously successful non-provider relays saved in `relay-scores.json`. Without live network discovery it probes all default seeds once. When live network discovery returns usable relays, coverage uses a region-diverse seed bootstrap subset plus the bounded discovery sample, then continues measuring the remaining seeds while keeping region diversity in the warm set. If you pass `host` or `hosts`, startup stays constrained to those configured relays unless you explicitly opt into using the discovery provider alongside them.

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

You can tune relay selection if needed:

```javascript
const client = new DiodeClientManager({
  keyLocation: './db/keys.json',
  relaySelection: {
    startupConcurrency: 3,
    minReadyConnections: 2,
    probeTimeoutMs: 1200,
    connectionTimeoutMs: 5000,
    targetConnectTimeoutMs: 10000,
    warmConnectionBudget: 3,
    probeAllInitialCandidates: true,
    continueProbingUntestedSeeds: true,
    regionDiverseSeedOrdering: true,
    discoveryProviderTimeoutMs: 1500,
    backgroundProbeIntervalMs: 300000,
    slowRelayThresholdMs: 250,
    slowDeviceRetryTtlMs: 5000,
    scoreCachePath: './db/relay-scores.json'
  }
});
```

Routing note: the initiating client can prefer a better local relay, but it cannot override the relay encoded in the remote device ticket. Best results come when both clients use the manager's relay ranking so each side reconnects toward a closer relay over time.

Discovery note: startup discovery sources are now `configured/seed`, `discoveryProvider`, built-in live `dio_network` discovery, cached non-provider/non-network relays, and target-on-demand relay resolution from `getNode(serverId)`. Provider and network membership are not cached independently; only RTT/history is persisted in `relay-scores.json`.

Example discovery provider:

```javascript
const fs = require('fs/promises');

const client = new DiodeClientManager({
  keyLocation: './db/keys.json',
  relaySelection: {
    discoveryProvider: async () => {
      const data = JSON.parse(await fs.readFile('./relays.json', 'utf8'));
      return data;
    },
    networkDiscovery: {
      endpoint: 'wss://prenet.diode.io:8443/ws',
      startupProbeCount: 2,
      backgroundBatchSize: 12
    }
  }
});
```

`discoveryProvider(context)` may return either relay strings such as `'relay.example.com:41046'` or objects like `{ host, port, priority, region, metadata }`. The callback receives a read-only `context` object with:

- `defaultPort`
- `keyLocation`
- `explicitHost`
- `explicitHosts`
- `initialHosts`
- `knownRelayScores`

`knownRelayScores` contains the manager's current score snapshot for previously seen relays. Provider membership itself is not cached across runs; only relay score history is persisted.

Built-in network discovery uses the Diode JSON-RPC websocket endpoint and requests `dio_network`. It is enabled by default only when neither `host` nor `hosts` is set. Only connected `server` nodes are considered, and private/unroutable addresses are filtered unless `includePrivateAddresses` is enabled. When discovery succeeds, startup keeps the seed safety baseline by probing one seed per region before adding the configured discovery sample, instead of blocking on every seed before ready.

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
    8080: { mode: 'public' },  // Public port on 127.0.0.1, accessible by any device
    8081: { mode: 'public', host: '192.168.1.10' }, // Forward to another reachable host
    3000: { 
      mode: 'private',  
      host: 'backend.internal',
      whitelist: [
        '0x1234567890abcdef1234567890abcdef12345678',
        '0x9876543210fedcba9876543210fedcba98765432'
      ] // Only these 20-byte EVM device addresses can connect
    }
  };
  
  // certPath parameter is maintained for backward compatibility but not required
  const publishPort = new PublishPort(client, publishedPortsWithConfig);

  // When permanently stopping publication, release sessions and listeners.
  // clearPorts() only changes the live port set; close() is terminal.
  // publishPort.close();
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
  - `options.fleetContract` (string, optional): Fleet contract used for relay tickets. Must be a 20-byte EVM address hex string. Defaults to `0x6000000000000000000000000000000000000000`.
  - `options.deviceCacheTtlMs` (number, optional): Cache TTL for device relay resolution (default: `30000`).
  - `options.relaySelection` (object, optional): Relay ranking and probing options.
    - `enabled` (boolean, optional): Enables smart relay ranking. Defaults to `true`.
    - `startupConcurrency` (number, optional): Parallel startup probe limit. Defaults to `3`, allowing one seed from each default region to begin together.
    - `minReadyConnections` (number, optional): Minimum target connection count for the startup probe set. Defaults to `2`.
    - `probeTimeoutMs` (number, optional): Ping timeout for relay probes. Defaults to `1200`.
    - `connectionTimeoutMs` (number, optional): DNS/TLS/ticket setup timeout for startup and background relay probes. Defaults to `5000`.
    - `targetConnectTimeoutMs` (number, optional): Setup timeout for a relay resolved from a target device ticket. Defaults to `10000`.
    - `warmConnectionBudget` (number, optional): Maximum number of idle control relays to keep after startup coverage completes. Defaults to `3`.
    - `probeAllInitialCandidates` (boolean, optional): Probes all initial configured/default candidates once before final startup ranking is trusted. Defaults to `true`.
    - `continueProbingUntestedSeeds` (boolean, optional): Continues probing untested candidates after startup coverage completes. Defaults to `true`.
    - `regionDiverseSeedOrdering` (boolean, optional): Interleaves seed regions during first-pass probing and warm retention. Defaults to `true`.
    - `discoveryProvider` (function, optional): Async or sync callback that returns extra relay candidates as strings or `{ host, port, priority, region, metadata }` objects. The callback receives `{ defaultPort, keyLocation, explicitHost, explicitHosts, initialHosts, knownRelayScores }`.
    - `discoveryProviderTimeoutMs` (number, optional): Timeout for `discoveryProvider` results. Defaults to `1500`.
    - `useProviderWithExplicitHost` (boolean, optional): Allows provider candidates when `options.host` is set. Defaults to `false`.
    - `useProviderWithExplicitHosts` (boolean, optional): Allows provider candidates when `options.hosts` is set. Defaults to `false`.
    - `networkDiscovery` (object, optional): Built-in live directory discovery via the JSON-RPC websocket endpoint.
      - `enabled` (boolean, optional): Enables live network discovery when no explicit `host` or `hosts` is configured. Defaults to `true` in default mode.
      - `endpoint` (string, optional): Directory endpoint. Defaults to `wss://prenet.diode.io:8443/ws`.
      - `method` (string, optional): JSON-RPC method name. Defaults to `dio_network`.
      - `timeoutMs` (number, optional): Timeout for the discovery websocket request. Defaults to `1500`.
      - `startupProbeCount` (number, optional): Number of discovered network relays added to the startup coverage probe set. Defaults to `2`.
      - `backgroundBatchSize` (number, optional): Number of additional discovered relays measured in the background queue per run. Defaults to `12`.
      - `includePrivateAddresses` (boolean, optional): Allows private or unroutable discovery results to be used. Defaults to `false`.
    - `backgroundProbeIntervalMs` (number, optional): Minimum interval before background refresh probes are retried for a relay. Defaults to `300000`.
    - `slowRelayThresholdMs` (number, optional): RTT threshold used to shorten target relay cache entries. Defaults to `250`.
    - `slowDeviceRetryTtlMs` (number, optional): TTL used for slow target relays. Defaults to `5000`.
    - `deviceRelayReconciliation` (object, optional): Bounded fallback that re-resolves a device through alternate connected control relays when the initially resolved target relay is much slower than the current control relay baseline.
      - `enabled` (boolean, optional): Enables reconciliation. Defaults to `true`.
      - `maxControlRelays` (number, optional): Maximum number of alternate connected control relays queried per reconciliation attempt. Defaults to `2`.
      - `timeoutMs` (number, optional): Per-control-relay timeout for reconciliation lookups. Defaults to `probeTimeoutMs`.
      - `minLatencyDeltaMs` (number, optional): Minimum RTT gap between the target relay and the control relay baseline before reconciliation triggers. Defaults to `150`.
      - `slowdownFactor` (number, optional): Minimum multiple by which the target relay RTT must exceed the control relay baseline before reconciliation triggers. Defaults to `4`.
    - `scoreCachePath` (string|null, optional): Relay score cache file. Defaults to `./db/relay-scores.json` next to `keyLocation`. Set to `null` to disable persistence.

- **Methods**:
  - `connect()`: Returns a promise that resolves with the manager when the first relay completes its TLS and ticket handshake. Remaining seed/provider/network measurements continue in the background; idle pruning waits for the required coverage to finish. Failed latency measurements do not discard an otherwise authenticated relay. Rejects if no relay can connect.
  - `setFleetContract(address)`: Updates the fleet contract used for future ticket generation on managed connections. Accepts a 20-byte EVM address hex string and returns the manager instance.
  - `getNearestConnection()`: Returns the preferred connected relay. With relay selection enabled, this is the lowest-latency scored relay.
  - `getConnectionForDevice(deviceId)`: Resolves and returns a relay connection for the device. Returns a promise. Concurrent requests for the same device share the ticket/node lookup and relay handshake; each bind still opens its own tunnel.
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
  - `getObject(deviceId, options)`: Retrieves a device ticket object. Returns a promise.
  - `getNode(nodeId, options)`: Retrieves relay node information. Returns a promise.
  - `ping(options)`: Sends a ping command. Returns a promise.
  - `portOpen(deviceId, port, flags, options)`: Opens a port on the device. Returns a promise.
  - `portOpen2(deviceId, port, flags, options)`: Opens a native relay port on the device (TCP/UDP). Returns the server relay port.
  - `portSend(ref, data, options)`: Sends data to the device. Returns a promise.
  - `portClose(ref, options)`: Closes an API-relayed port. Returns a promise.
  - `portClose2(physicalPort, options)`: Closes a native relay port. Returns a promise.
  - `sendError(sessionId, ref, error)`: Sends an error response. Returns a promise.
  - `sendResponse(sessionId, ref, response)`: Sends a response. Returns a promise.
  - `getEpoch()`: Retrieves the current epoch. Returns a promise.
  - `parseTimestamp(blockHeader)`: Parses the timestamp from a block header. Returns a number.

For the RPC methods that accept `options`, pass `{ timeoutMs, signal }` to set a per-call deadline or an `AbortSignal`. Commands use a 15-second default deadline and reject with typed errors such as `DIODE_COMMAND_TIMEOUT`, `DIODE_COMMAND_ABORTED`, `DIODE_DISCONNECTED`, or `DIODE_RPC_ERROR`. Port open/close failures reject instead of resolving as an undefined success; callers should handle those promise rejections.

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
  - `dispose()`: Permanently closes servers, active tunnels, and shared manager listeners. Use this when replacing or discarding a `BindPort` instance.

#### `PublishPort`

- **Constructor**: `new PublishPort(connection, publishedPorts, _certPath)`
  - `connection` (DiodeClientManager): An instance of `DiodeClientManager`.
  - `publishedPorts` (array|object): Either:
    - An array of ports to publish (all public mode)
    - An object mapping ports to their configuration: `{ port: { mode: 'public'|'private', whitelist: ['0x123...'], host: '127.0.0.1' } }`
  - `_certPath` (string): Has no functionality and maintained for backward compatibility.

- **Methods**:
  - `addPort(port, config)`: Adds a new port to publish. Config is optional and defaults to public mode.
    - `port` (number): The port number to publish.
    - `config` (object): Optional configuration with `mode` ('public'|'private'), `whitelist` array, and `host` string.
      - `host` (string, optional): Target IP or hostname for the published service. Defaults to `127.0.0.1`.
      - Private whitelists accept complete 20-byte `0x` EVM addresses; address matching is case-insensitive and stored in lowercase.
  - `removePort(port)`: Removes a published port.
    - `port` (number): The port number to remove.
  - `addPorts(ports)`: Adds multiple ports at once (equivalent to the constructor's publishedPorts parameter).
    - `ports` (array|object): Either an array of port numbers or an object mapping ports to their configurations.
  - `getPublishedPorts()`: Returns a plain object with all published ports and their configurations.
  - `clearPorts()`: Removes all published ports. Returns the number of ports that were cleared.
  - `startListening()`: Starts listening for unsolicited messages.
  - `stopListening()`: Pauses unsolicited-message handling without closing active sessions.
  - `close()`: Permanently removes listeners and closes all API/native sessions. A closed instance cannot be restarted; create a new `PublishPort` instead.
  - `handlePortOpen(sessionIdRaw, messageContent)`: Handles port open requests.
  - `handlePortSend(sessionIdRaw, messageContent)`: Handles port send requests.
  - `handlePortClose(sessionIdRaw, messageContent)`: Handles port close requests.
