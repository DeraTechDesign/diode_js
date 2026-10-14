'use strict';

const tls = require('tls');

// Diode node's default EDGE2_PORT listeners. Custom ports stay pinned.
const DEFAULT_RELAY_PORTS = [41046, 443, 993, 1723, 10000];

function connectRelayPorts({ host, port, tlsOptions, fallback = true, preferredPort,
  fallbackDelayMs = 250, onAttempt, onSecure, onError }) {
  const ports = fallback && Number(port) === DEFAULT_RELAY_PORTS[0]
    ? DEFAULT_RELAY_PORTS.slice()
    : [port];
  if (ports.includes(preferredPort)) {
    ports.splice(ports.indexOf(preferredPort), 1);
    ports.unshift(preferredPort);
  }
  const pending = new Set();
  let next = 0;
  let timer = null;
  let finished = false;
  let lastError;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const cancel = () => {
    finished = true;
    clearTimer();
    for (const socket of pending) socket.destroy();
    pending.clear();
  };
  const startNext = () => {
    clearTimer();
    if (finished) return;
    if (next >= ports.length) {
      if (pending.size === 0) {
        finished = true;
        onError(lastError || new Error('No Diode relay ports available'));
      }
      return;
    }
    const candidatePort = ports[next++];
    let socket;
    const failed = (error) => {
      if (finished || !pending.delete(socket)) return;
      lastError = error;
      socket.destroy();
      startNext();
    };
    try {
      socket = tls.connect(candidatePort, host, tlsOptions, () => {
        if (finished || !pending.has(socket)) return;
        // Only a completed Diode-compatible TLS handshake can win. A TCP
        // accept on an HTTPS listener or a TLS black hole must not stop fallback.
        pending.delete(socket);
        cancel();
        socket.removeListener('error', failed);
        socket.removeListener('end', ended);
        socket.removeListener('close', ended);
        return onSecure(socket, candidatePort);
      });
    } catch (error) {
      lastError = error;
      startNext();
      return;
    }
    const ended = () => failed(new Error(`Diode relay ${host}:${candidatePort} closed during TLS setup`));
    pending.add(socket);
    // Retain error handlers on cancelled sockets: destroy may emit a late error.
    socket.on('error', failed);
    socket.once('end', ended);
    socket.once('close', ended);
    if (onAttempt) onAttempt(socket);
    if (!finished && next < ports.length) timer = setTimeout(startNext, fallbackDelayMs);
  };
  startNext();
  return cancel;
}

module.exports = { connectRelayPorts };
