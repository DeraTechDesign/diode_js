'use strict';

const { Transform } = require('node:stream');
const nativeCrypto = require('./nativeCrypto');

const HIGH_WATER_MARK = 256 * 1024;
const PLAINTEXT_FRAME_BYTES = 64 * 1024;

function bridgeNativeTcp({ localSocket, relaySocket, session, onClose, onError }) {
  let ended = false;
  let destroying = false;
  let resolveClosed;
  const closedSockets = new Set();
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const encrypt = new Transform({
    readableHighWaterMark: HIGH_WATER_MARK,
    writableHighWaterMark: HIGH_WATER_MARK,
    transform(chunk, _encoding, callback) {
      try {
        for (let offset = 0; offset < chunk.length; offset += PLAINTEXT_FRAME_BYTES) {
          this.push(nativeCrypto.createTcpFrame(session, chunk.subarray(offset, offset + PLAINTEXT_FRAME_BYTES)));
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
  const decrypt = new Transform({
    readableHighWaterMark: HIGH_WATER_MARK,
    writableHighWaterMark: HIGH_WATER_MARK,
    transform(chunk, _encoding, callback) {
      try {
        for (const message of nativeCrypto.consumeTcpFrames(session, chunk)) this.push(message);
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      callback(session.rxBuffer && session.rxBuffer.length > 0
        ? new Error('Native TCP relay closed with an incomplete encrypted frame')
        : null);
    },
  });

  const finish = () => {
    if (ended) return;
    ended = true;
    resolveClosed();
    if (onClose) onClose();
  };
  const destroy = (error) => {
    if (destroying || ended) return;
    destroying = true;
    // Errors and explicit disposal terminate promptly. Graceful EOF instead
    // follows both pipes through their queued transforms and socket writes.
    encrypt.destroy();
    decrypt.destroy();
    localSocket.destroy();
    relaySocket.destroy();
    if (error && onError) onError(error);
    finish();
  };
  const onSocketClose = (socket, hadError) => {
    closedSockets.add(socket);
    if (destroying || ended) return;
    if (hadError || !socket.readableEnded || !socket.writableFinished) {
      destroy(new Error('Native TCP socket closed before its stream drained'));
      return;
    }
    if (closedSockets.size === 2) finish();
  };
  for (const socket of [localSocket, relaySocket]) {
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30000);
    socket.on('error', destroy);
    socket.once('close', (hadError) => onSocketClose(socket, hadError));
  }
  encrypt.on('error', destroy);
  decrypt.on('error', destroy);

  // Both net.Socket instances must use allowHalfOpen:true. A request EOF can
  // then reach the backend while its final response is still flowing back.
  localSocket.pipe(encrypt).pipe(relaySocket);
  relaySocket.pipe(decrypt).pipe(localSocket);
  if (localSocket.destroyed || relaySocket.destroyed) destroy(new Error('Native TCP socket closed before bridge setup'));
  return { closed, destroy };
}

module.exports = { bridgeNativeTcp };
