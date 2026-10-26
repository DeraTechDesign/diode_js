const WebSocket = require('ws');
const dns = require('node:dns');
const net = require('node:net');

const MAX_NODE_TIMER_MS = 0x7fffffff;
const DEFAULT_TIMEOUT_MS = 10000;
const ADDRESS_STAGGER_MS = 250;

function normalizeTimerMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_NODE_TIMER_MS));
}

function fetchNetworkDirectory(options = {}) {
  const endpoint = typeof options.endpoint === 'string' && options.endpoint.trim()
    ? options.endpoint : 'wss://prenet.diode.io:8443/ws';
  const method = typeof options.method === 'string' && options.method.trim()
    ? options.method : 'dio_network';
  const timeoutMs = normalizeTimerMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    const deadline = Date.now() + timeoutMs;
    const signal = options.signal;
    const sockets = new Set();
    let addresses = [], next = 0, settled = false, stagger = null, lastError;
    const closeSocket = socket => {
      sockets.delete(socket);
      socket.removeAllListeners();
      // Aborting a CONNECTING ws emits a later error; keep it consumed.
      socket.on('error', () => {});
      socket.once('close', () => socket.removeAllListeners());
      // A stalled peer need not acknowledge a close handshake. Release the
      // transport immediately when its result is no longer usable.
      try { socket.terminate(); } catch (_) {}
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stagger);
      signal?.removeEventListener('abort', aborted);
      for (const socket of sockets) closeSocket(socket);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Network discovery timed out after ${timeoutMs}ms`)), timeoutMs);
    const aborted = () => finish(new Error('Network discovery aborted'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }

    const startNext = () => {
      clearTimeout(stagger);
      stagger = null;
      if (settled) return;
      if (next >= addresses.length) {
        if (!sockets.size) finish(lastError || new Error('No network directory addresses available'));
        return;
      }
      const address = addresses[next++];
      let socket;
      const failed = error => {
        if (settled || (socket && !sockets.has(socket))) return;
        lastError = error;
        if (socket) closeSocket(socket);
        startNext();
      };
      try {
        socket = new WebSocket(endpoint, {
          // Race complete directory responses ourselves, retaining the URL's
          // hostname for TLS verification/SNI. A fast TCP accept on a distant
          // or stalled server must not cancel a better directory response.
          // Keeping each socket single-address also avoids Node 20.11's
          // multi-address cancellation assertion on deadline/loser cleanup.
          autoSelectFamily: false,
          // Match dns.lookup's asynchronous contract. An immediate IPv6
          // ENETUNREACH can otherwise fire on TLSSocket before ClientRequest
          // has attached its socket error listener (including Node 20).
          lookup: (_host, lookupOptions, callback) => process.nextTick(() => {
            if (lookupOptions?.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          }),
          handshakeTimeout: Math.max(1, deadline - Date.now()),
          origin: 'https://diode.io',
        });
      } catch (error) { failed(error); return; }
      sockets.add(socket);
      socket.on('open', () => {
        if (settled) return;
        try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] })); }
        catch (error) { failed(error); }
      });
      socket.on('message', raw => {
        if (settled) return;
        try {
          const payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
          if (!payload || payload.id !== 1) return;
          if (payload.error) throw new Error(payload.error.message || 'Network discovery request failed');
          if (!Array.isArray(payload.result)) throw new Error('Network discovery returned a non-array result');
          finish(null, payload.result);
        } catch (error) { failed(error); }
      });
      socket.on('error', failed);
      socket.on('close', () => failed(new Error('Network discovery socket closed before a response was received')));
      if (next < addresses.length) stagger = setTimeout(startNext, ADDRESS_STAGGER_MS);
    };
    const resolved = (error, results) => {
      if (settled) return;
      if (error) { finish(error); return; }
      const seen = new Set();
      addresses = (Array.isArray(results) ? results : []).filter(entry => {
        if (!entry || !net.isIP(entry.address) || seen.has(entry.address)) return false;
        seen.add(entry.address);
        return true;
      }).slice(0, 8);
      startNext();
    };
    const family = net.isIP(hostname);
    if (family) resolved(null, [{ address: hostname, family }]);
    else {
      try { (options.lookup || dns.lookup)(hostname, { all: true }, resolved); }
      catch (error) { finish(error); }
    }
  });
}

module.exports = { fetchNetworkDirectory };
