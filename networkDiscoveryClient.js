const WebSocket = require('ws');

function fetchNetworkDirectory(options = {}) {
  const endpoint = typeof options.endpoint === 'string' && options.endpoint.trim()
    ? options.endpoint
    : 'wss://prenet.diode.io:8443/ws';
  const method = typeof options.method === 'string' && options.method.trim()
    ? options.method
    : 'dio_network';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : 1500;

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
        socket.removeAllListeners();
        try {
          socket.close();
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
