'use strict';
const { EventEmitter } = require('node:events');
const { RLP } = require('@ethereumjs/rlp');
const DiodeConnection = require('../../connection');
function parserConnection() {
  // Actual parser/dispatcher without identity generation or a WAN.
  const connection = Object.create(DiodeConnection.prototype); EventEmitter.call(connection);
  Object.assign(connection, { receiveBuffer: Buffer.alloc(0), _receiveFrameStorage: null, pendingRequests: new Map(),
    _queuedUnsolicited: [], _deferredUnsolicited: new Set(), _socketGeneration: 1, _lastDisconnectedGeneration: -1 });
  return connection;
}
function frame(id, payload) {
  const encoded = Buffer.from(RLP.encode([id, ['portsend', Buffer.from([1]), payload]]));
  const header = Buffer.alloc(2); header.writeUInt16BE(encoded.length); return Buffer.concat([header, encoded]);
}
module.exports = { parserConnection, frame };
