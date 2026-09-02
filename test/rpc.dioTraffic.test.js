const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const DiodeRPC = require('../rpc');

function withServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeRpc(port) {
  return new DiodeRPC({ host: '127.0.0.1' }).dioTraffic({
    protocol: 'http',
    rpcPort: port,
    chainId: 1284,
    epoch: 687,
  });
}

test('dioTraffic posts dio_traffic to the connected relay node RPC endpoint', async () => {
  let requestBody = null;
  const result = {
    chain_id: '0x504',
    epoch: '0x2af',
    fleets: {},
  };
  const server = await withServer(async (req, res) => {
    requestBody = await readJson(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: requestBody.id,
      result,
    }));
  });

  try {
    const response = await makeRpc(server.port);

    assert.deepEqual(response, result);
    assert.equal(requestBody.method, 'dio_traffic');
    assert.deepEqual(requestBody.params, [1284, 687]);
  } finally {
    await server.close();
  }
});

test('dioTraffic defaults to chain 1284 and omits epoch when not supplied', async () => {
  let requestBody = null;
  const server = await withServer(async (req, res) => {
    requestBody = await readJson(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: requestBody.id, result: { fleets: {} } }));
  });

  try {
    const rpc = new DiodeRPC({ host: '127.0.0.1' });

    await rpc.dioTraffic({
      protocol: 'http',
      rpcPort: server.port,
    });

    assert.deepEqual(requestBody.params, [1284]);
  } finally {
    await server.close();
  }
});

test('dio_traffic aliases dioTraffic', async () => {
  let requestBody = null;
  const server = await withServer(async (req, res) => {
    requestBody = await readJson(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: requestBody.id, result: { fleets: {} } }));
  });

  try {
    const rpc = new DiodeRPC({ host: '127.0.0.1' });

    await rpc.dio_traffic({
      protocol: 'http',
      rpcPort: server.port,
      chainId: 1284,
    });

    assert.deepEqual(requestBody.params, [1284]);
  } finally {
    await server.close();
  }
});

test('dioTraffic throws JSON-RPC errors', async () => {
  const server = await withServer(async (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'bad params' } }));
  });

  try {
    await assert.rejects(
      () => makeRpc(server.port),
      /bad params/,
    );
  } finally {
    await server.close();
  }
});

test('nodeRpc clamps huge timeouts and falls back for invalid timeout values', async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: 'ok' }),
  });
  global.setTimeout = (_callback, delayMs) => {
    delays.push(delayMs);
    return { fakeTimer: true };
  };
  global.clearTimeout = () => {};

  try {
    const rpc = new DiodeRPC({ host: '127.0.0.1' });
    for (const timeoutMs of [Number.MAX_SAFE_INTEGER, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.equal(await rpc.nodeRpc('test_timer', [], { timeoutMs }), 'ok');
    }
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(delays, [0x7fffffff, 30000, 30000, 30000]);
});
