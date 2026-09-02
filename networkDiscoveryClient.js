const WebSocket = require('ws');

const MAX_NODE_TIMER_MS = 0x7fffffff;

function normalizeTimerMs(value, fallback) {
  const parsed = Number(value);
  const parsedFallback = Number(fallback);
  const safeFallback = Number.isFinite(parsedFallback) && parsedFallback > 0
    ? Math.max(1, Math.min(Math.floor(parsedFallback), MAX_NODE_TIMER_MS))
    : 1;
  if (!Number.isFinite(parsed) || parsed <= 0) return safeFallback;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_NODE_TIMER_MS));
}

function fetchNetworkDirectory(options = {}) {
  const endpoint = typeof options.endpoint === 'string' && options.endpoint.trim()
    ? options.endpoint
    : 'wss://prenet.diode.io:8443/ws';
  const method = typeof options.method === 'string' && options.method.trim()
    ? options.method
    : 'dio_network';
  const timeoutMs = normalizeTimerMs(options.timeoutMs, 1500);

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (socket) {
        const closingSocket = socket;
        closingSocket.removeAllListeners();
        // Closing a ws while it is still CONNECTING emits an asynchronous
        // `error`. Keep a consumer installed through shutdown so a discovery
        // timeout cannot become an uncaught process-level exception.
        closingSocket.on('error', () => {});
        closingSocket.once('close', () => closingSocket.removeAllListeners());
        try {
          closingSocket.close();
        } catch (_) {}
        socket = null;
      }
    };

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };

    socket = new WebSocket(endpoint, {
      handshakeTimeout: timeoutMs,
      origin: 'https://diode.io',
    });

    socket.on('open', () => {
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: [],
      }));
    });

    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        if (parsed && parsed.id === 1) {
          if (parsed.error) {
            finish(reject, new Error(parsed.error.message || 'Network discovery request failed'));
            return;
          }
          finish(resolve, Array.isArray(parsed.result) ? parsed.result : []);
        }
      } catch (error) {
        finish(reject, error);
      }
    });

    socket.on('error', (error) => {
      finish(reject, error);
    });

    socket.on('close', () => {
      if (!settled) {
        finish(reject, new Error('Network discovery socket closed before a response was received'));
      }
    });

    timer = setTimeout(() => {
      finish(reject, new Error(`Network discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

module.exports = {
  fetchNetworkDirectory,
};
