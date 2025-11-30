const cordova = require('cordova-bridge');
const path = require('path');
const fs = require('fs');
const appDataDir = cordova.app.datadir();
const defaultLogDir = path.join(appDataDir, 'logs');
try {
  fs.mkdirSync(defaultLogDir, { recursive: true });
} catch (_) {
  // best effort
}
if (!process.env.DIODE_LOG_DIR) {
  process.env.DIODE_LOG_DIR = defaultLogDir;
}

const { DiodeConnection, BindPort, PublishPort } = require('diodejs');
const { ensureDirectoryExistence } = require('diodejs/utils');

const state = {
  connection: null,
  bindPort: null,
  publishPort: null,
  options: null,
  boundPorts: {},
  publishedPorts: {},
  lastError: null,
};

function send(kind, payload) {
  cordova.channel.send({ kind, ...payload });
}

function respond(id, success, result, error) {
  send('response', { id, success, result, error: error ? String(error) : undefined });
}

function emit(event, data) {
  send('event', { event, data });
}

function log(level, message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  if (level === 'error') {
    console.error('[diode-node]', text);
  } else if (level === 'warn') {
    console.warn('[diode-node]', text);
  } else if (level === 'debug') {
    console.debug('[diode-node]', text);
  } else {
    console.log('[diode-node]', text);
  }
  emit('log', { level, message: text });
}

function ensureConnectionAvailable() {
  if (!state.connection) {
    throw new Error('Diode connection not initialized');
  }
}

function normalizeBindPorts(payload) {
  const configs = Array.isArray(payload)
    ? payload
    : payload && payload.ports
    ? payload.ports
    : payload && typeof payload === 'object'
    ? Object.entries(payload).map(([localPort, config]) => ({
        localPort,
        targetPort: config.targetPort,
        deviceIdHex: config.deviceIdHex || config.deviceId,
        protocol: config.protocol,
      }))
    : [];
  const normalized = {};
  for (const entry of configs) {
    if (!entry) continue;
    const localPort = Number(entry.localPort);
    const targetPort = Number(entry.targetPort);
    const deviceIdHex = entry.deviceIdHex || entry.deviceId;
    if (!localPort || !targetPort || !deviceIdHex) {
      continue;
    }
    normalized[localPort] = {
      targetPort,
      deviceIdHex,
      protocol: (entry.protocol || 'tls').toLowerCase(),
    };
  }
  return normalized;
}

function normalizePublishPorts(payload) {
  if (!payload) return {};
  const normalized = {};
  const addEntry = (portValue, configValue) => {
    const portNum = Number(portValue);
    if (!portNum) return;
    if (!configValue || typeof configValue === 'string') {
      normalized[portNum] = {
        mode: typeof configValue === 'string' ? configValue : 'public',
        whitelist: [],
      };
      return;
    }
    normalized[portNum] = {
      mode: configValue.mode || 'public',
      whitelist: Array.isArray(configValue.whitelist) ? configValue.whitelist : [],
    };
  };

  if (Array.isArray(payload)) {
    payload.forEach((entry) => {
      if (entry == null) return;
      if (typeof entry === 'number') {
        addEntry(entry, { mode: 'public', whitelist: [] });
      } else if (typeof entry === 'object') {
        const port = entry.port !== undefined && entry.port !== null ? entry.port : entry.localPort;
        addEntry(port, entry);
      }
    });
  } else if (typeof payload === 'object') {
    Object.entries(payload).forEach(([portKey, configValue]) => {
      addEntry(portKey, configValue);
    });
  }

  return normalized;
}

function attachConnectionEvents(connection) {
  connection.on('reconnecting', (info) => emit('reconnecting', info));
  connection.on('reconnected', () => emit('reconnected', {}));
  connection.on('reconnect_failed', () => emit('reconnect_failed', {}));
  connection.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    state.lastError = message;
    log('error', `Connection error: ${state.lastError}`);
  });
}

async function handleInitialize(data = {}) {
  if (state.connection) {
    log('info', 'Reusing existing Diode connection');
    return getStatus();
  }
  const host = data.host || 'eu2.prenet.diode.io';
  const port = Number(data.port) || 41046;
  const dataDir = data.dataDir || cordova.app.datadir();
  const keyLocation = data.keyLocation || path.join(dataDir, 'diode', 'keys.json');
  ensureDirectoryExistence(keyLocation);

  const connection = new DiodeConnection(host, port, keyLocation);
  if (data.reconnect) {
    connection.setReconnectOptions(data.reconnect);
  }
  attachConnectionEvents(connection);
  await connection.connect();
  state.connection = connection;
  state.options = { host, port, keyLocation };
  log('info', `Connected to Diode at ${host}:${port}`);
  return getStatus();
}

async function handleBind(data) {
  ensureConnectionAvailable();
  const config = normalizeBindPorts((data && data.ports) || data);
  if (!Object.keys(config).length) {
    throw new Error('No bind ports specified');
  }
  if (state.bindPort) {
    state.bindPort.closeAllServers();
    state.bindPort = null;
  }
  state.bindPort = new BindPort(state.connection, config);
  state.bindPort.bind();
  state.boundPorts = config;
  log('info', `Bound ${Object.keys(config).length} ports`);
  return { ports: config };
}

async function handlePublish(data) {
  ensureConnectionAvailable();
  const ports = normalizePublishPorts((data && data.ports) || data);
  if (!Object.keys(ports).length) {
    throw new Error('No publish ports specified');
  }
  if (!state.publishPort) {
    state.publishPort = new PublishPort(state.connection, ports);
  } else {
    state.publishPort.clearPorts();
    state.publishPort.addPorts(ports);
  }
  state.publishedPorts = state.publishPort.getPublishedPorts();
  log('info', `Publishing ports: ${Object.keys(state.publishedPorts).join(', ')}`);
  return { ports: state.publishedPorts };
}

function getStatus() {
  const connected = Boolean(state.connection && state.connection.socket && !state.connection.socket.destroyed);
  return {
    connected,
    host: state.connection ? state.connection.host : undefined,
    port: state.connection ? state.connection.port : undefined,
    ethereumAddress: connected ? state.connection.getEthereumAddress() : undefined,
    keyLocation: state.options ? state.options.keyLocation : undefined,
    publishedPorts: state.publishedPorts,
    boundPorts: state.boundPorts,
    lastError: state.lastError,
  };
}

async function handleShutdown() {
  if (state.bindPort) {
    state.bindPort.closeAllServers();
    state.bindPort = null;
  }
  if (state.publishPort) {
    state.publishPort.clearPorts();
    state.publishPort.stopListening();
    state.publishPort = null;
  }
  if (state.connection) {
    state.connection.close();
    state.connection.removeAllListeners();
    state.connection = null;
  }
  state.boundPorts = {};
  state.publishedPorts = {};
  log('info', 'Diode runtime shut down');
}

const handlers = {
  initialize: handleInitialize,
  bind: handleBind,
  publish: handlePublish,
  status: async () => getStatus(),
  shutdown: handleShutdown,
};

cordova.channel.on('message', async (payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const { id, action, data } = payload;
  const handler = handlers[action];
  if (!handler) {
    respond(id, false, null, `Unknown action: ${action}`);
    return;
  }
  try {
    const result = await handler(data);
    respond(id, true, result);
  } catch (err) {
    state.lastError = err && err.message ? err.message : String(err);
    log('error', state.lastError);
    respond(id, false, null, state.lastError);
  }
});

process.on('uncaughtException', (err) => {
  const stack = err && err.stack ? err.stack : err;
  log('error', `Uncaught exception: ${stack}`);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

emit('ready', { platform: process.platform, node: process.version });
