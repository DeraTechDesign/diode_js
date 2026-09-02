const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');

const DOMAIN = Buffer.from('diode-pp2-v1', 'utf8');
const UDP_MAGIC = Buffer.from('DUD1', 'utf8');
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_TCP_FRAME_BYTES = 1024 * 1024;
const MAX_TCP_BUFFER_BYTES = MAX_TCP_FRAME_BYTES + 64 * 1024;
// Maximum IPv4 UDP payload: 65,535-byte IP packet - 20-byte IPv4 header -
// 8-byte UDP header. The encrypted envelope must fit inside this value.
const MAX_UDP_PACKET_BYTES = 65507;
const MAX_TIMER_MS = 0x7fffffff;
const UDP_REPLAY_WINDOW_BITS = 64n;
const UDP_REPLAY_WINDOW_MASK = (1n << UDP_REPLAY_WINDOW_BITS) - 1n;

function toDeviceIdBuffer(deviceId) {
  if (!deviceId) return Buffer.alloc(0);
  if (Buffer.isBuffer(deviceId)) return deviceId;
  if (deviceId instanceof Uint8Array) return Buffer.from(deviceId);
  if (typeof deviceId === 'string') {
    const hex = deviceId.toLowerCase().startsWith('0x') ? deviceId.slice(2) : deviceId;
    return Buffer.from(hex, 'hex');
  }
  return Buffer.alloc(0);
}

function encodeHandshakeData(role, deviceId, ephPub, nonce, physicalPort) {
  const deviceIdBuf = toDeviceIdBuffer(deviceId);
  const portBuf = Buffer.alloc(4);
  portBuf.writeUInt32BE(physicalPort >>> 0, 0);
  return Buffer.concat([
    DOMAIN,
    Buffer.from(role, 'utf8'),
    deviceIdBuf,
    ephPub,
    nonce,
    portBuf,
  ]);
}

function signHandshake(privateKey, data) {
  const hash = ethUtil.keccak256(data);
  const sig = ethUtil.ecsign(hash, privateKey);
  return Buffer.concat([sig.r, sig.s, Buffer.from([sig.v])]);
}

function verifyHandshakeSignature(data, signature, expectedDeviceId) {
  if (!signature || signature.length !== 65) {
    return { ok: false, reason: 'Invalid signature length' };
  }
  const hash = ethUtil.keccak256(data);
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  let v = signature[64];
  if (v < 27) v += 27;
  let pubKey;
  try {
    pubKey = ethUtil.ecrecover(hash, v, r, s);
  } catch (error) {
    return { ok: false, reason: 'Invalid signature' };
  }
  const addr = `0x${ethUtil.pubToAddress(pubKey).toString('hex')}`.toLowerCase();
  if (expectedDeviceId && addr !== expectedDeviceId.toLowerCase()) {
    return { ok: false, reason: 'Device mismatch', address: addr };
  }
  return { ok: true, address: addr };
}

function generateEphemeralKeyPair() {
  let privKey;
  do {
    privKey = crypto.randomBytes(32);
  } while (!secp256k1.privateKeyVerify(privKey));
  const pubKey = Buffer.from(secp256k1.publicKeyCreate(privKey, true)); // compressed 33 bytes
  return { privKey, pubKey };
}

function createHandshakeMessage({ role, deviceId, physicalPort, privateKey }) {
  if (role !== 'bind' && role !== 'publish') {
    throw new TypeError('Handshake role must be bind or publish');
  }
  if (!Number.isInteger(Number(physicalPort)) || Number(physicalPort) <= 0 || Number(physicalPort) > 65535) {
    throw new RangeError('Handshake physical port is invalid');
  }
  const { privKey, pubKey } = generateEphemeralKeyPair();
  const nonce = crypto.randomBytes(16);
  const data = encodeHandshakeData(role, deviceId, pubKey, nonce, physicalPort);
  const sig = signHandshake(privateKey, data);
  const message = {
    v: 1,
    role,
    deviceId: deviceId.toLowerCase(),
    physicalPort,
    ephPub: pubKey.toString('hex'),
    nonce: nonce.toString('hex'),
    sig: sig.toString('hex'),
  };
  return { message, privKey, nonce };
}

function verifyHandshakeMessage(message, { expectedRole, expectedDeviceId, expectedPhysicalPort }) {
  if (!message || message.v !== 1) {
    return { ok: false, reason: 'Invalid version' };
  }
  if (expectedRole && message.role !== expectedRole) {
    return { ok: false, reason: 'Role mismatch' };
  }
  if (expectedPhysicalPort && Number(message.physicalPort) !== Number(expectedPhysicalPort)) {
    return { ok: false, reason: 'Physical port mismatch' };
  }
  if (typeof message.deviceId !== 'string' || !/^0x[0-9a-f]{40}$/i.test(message.deviceId)) {
    return { ok: false, reason: 'Invalid device ID' };
  }
  if (expectedDeviceId && message.deviceId.toLowerCase() !== expectedDeviceId.toLowerCase()) {
    return { ok: false, reason: 'Device mismatch' };
  }
  if (!Number.isInteger(Number(message.physicalPort)) || Number(message.physicalPort) <= 0 || Number(message.physicalPort) > 65535) {
    return { ok: false, reason: 'Invalid physical port' };
  }
  if (typeof message.ephPub !== 'string' || !/^(?:[0-9a-f]{66}|[0-9a-f]{130})$/i.test(message.ephPub)) {
    return { ok: false, reason: 'Invalid ephemeral key' };
  }
  if (typeof message.nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(message.nonce)) {
    return { ok: false, reason: 'Invalid nonce' };
  }
  if (typeof message.sig !== 'string' || !/^[0-9a-f]{130}$/i.test(message.sig)) {
    return { ok: false, reason: 'Invalid signature length' };
  }

  const ephPub = Buffer.from(message.ephPub, 'hex');
  const nonce = Buffer.from(message.nonce, 'hex');
  const sig = Buffer.from(message.sig, 'hex');
  if (!secp256k1.publicKeyVerify(ephPub)) {
    return { ok: false, reason: 'Invalid ephemeral key' };
  }
  const data = encodeHandshakeData(message.role, message.deviceId, ephPub, nonce, message.physicalPort);
  const verification = verifyHandshakeSignature(data, sig, message.deviceId);
  if (!verification.ok) {
    return { ok: false, reason: verification.reason };
  }
  return { ok: true, deviceId: message.deviceId, ephPub, nonce };
}

function deriveSessionKeys({
  role,
  localDeviceId,
  remoteDeviceId,
  localEphPriv,
  remoteEphPub,
  localNonce,
  remoteNonce,
  physicalPort,
}) {
  const shared = Buffer.from(secp256k1.ecdh(remoteEphPub, localEphPriv));
  const bindFirst = role === 'bind';
  const nonceBind = bindFirst ? localNonce : remoteNonce;
  const noncePublish = bindFirst ? remoteNonce : localNonce;
  const idBind = toDeviceIdBuffer(bindFirst ? localDeviceId : remoteDeviceId);
  const idPublish = toDeviceIdBuffer(bindFirst ? remoteDeviceId : localDeviceId);
  const portBuf = Buffer.alloc(4);
  portBuf.writeUInt32BE(physicalPort >>> 0, 0);
  const salt = crypto.createHash('sha256')
    .update(Buffer.concat([nonceBind, noncePublish, idBind, idPublish, portBuf]))
    .digest();
  const info = Buffer.from('diode-pp2-v1', 'utf8');
  const keyMaterial = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 72));

  let txKey = keyMaterial.slice(0, 32);
  let rxKey = keyMaterial.slice(32, 64);
  let txSalt = keyMaterial.slice(64, 68);
  let rxSalt = keyMaterial.slice(68, 72);

  if (role === 'publish') {
    [txKey, rxKey] = [rxKey, txKey];
    [txSalt, rxSalt] = [rxSalt, txSalt];
  }

  return {
    txKey,
    rxKey,
    txSalt,
    rxSalt,
    txCounter: 0n,
    rxCounter: 0n,
    rxBuffer: Buffer.alloc(0),
    rxUdpHighest: null,
    rxUdpSeen: 0n,
  };
}

function buildNonce(salt, counter) {
  const nonce = Buffer.alloc(12);
  salt.copy(nonce, 0, 0, 4);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

function encryptAead(key, nonce, plaintext, aad) {
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, tag };
}

function decryptAead(key, nonce, ciphertext, tag, aad) {
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext;
}

function createTcpFrame(session, plaintext) {
  if (!Buffer.isBuffer(plaintext) && !(plaintext instanceof Uint8Array)) {
    throw new TypeError('TCP frame plaintext must be a Buffer or Uint8Array');
  }
  if (plaintext.length > MAX_TCP_FRAME_BYTES) {
    throw new RangeError(`TCP frame exceeds ${MAX_TCP_FRAME_BYTES} bytes`);
  }
  const counter = session.txCounter++;
  const nonce = buildNonce(session.txSalt, counter);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(plaintext.length, 0);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const aad = Buffer.concat([lenBuf, counterBuf]);
  const { ciphertext, tag } = encryptAead(session.txKey, nonce, plaintext, aad);
  return Buffer.concat([lenBuf, counterBuf, ciphertext, tag]);
}

function consumeTcpFrames(session, data) {
  const messages = [];
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new TypeError('TCP frame data must be a Buffer or Uint8Array');
  }
  if (session.rxBuffer.length + data.length > MAX_TCP_BUFFER_BYTES) {
    session.rxBuffer = Buffer.alloc(0);
    throw new RangeError('TCP receive buffer limit exceeded');
  }
  let buffer = Buffer.concat([session.rxBuffer, data]);
  while (buffer.length >= 12) {
    const len = buffer.readUInt32BE(0);
    if (len > MAX_TCP_FRAME_BYTES) {
      session.rxBuffer = Buffer.alloc(0);
      throw new RangeError(`TCP frame exceeds ${MAX_TCP_FRAME_BYTES} bytes`);
    }
    const counter = buffer.readBigUInt64BE(4);
    const frameLength = 12 + len + 16;
    if (buffer.length < frameLength) break;
    if (counter < session.rxCounter) {
      buffer = buffer.slice(frameLength);
      continue;
    }
    const nonce = buildNonce(session.rxSalt, counter);
    const aad = buffer.slice(0, 12);
    const ciphertext = buffer.slice(12, 12 + len);
    const tag = buffer.slice(12 + len, frameLength);
    try {
      const plaintext = decryptAead(session.rxKey, nonce, ciphertext, tag, aad);
      messages.push(plaintext);
      session.rxCounter = counter + 1n;
    } catch (error) {
      throw new Error('TCP decrypt failed');
    }
    buffer = buffer.slice(frameLength);
  }
  session.rxBuffer = buffer;
  return messages;
}

function createUdpPacket(session, plaintext) {
  if (!Buffer.isBuffer(plaintext) && !(plaintext instanceof Uint8Array)) {
    throw new TypeError('UDP plaintext must be a Buffer or Uint8Array');
  }
  if (plaintext.length + UDP_MAGIC.length + 8 + 16 > MAX_UDP_PACKET_BYTES) {
    throw new RangeError(`UDP packet exceeds ${MAX_UDP_PACKET_BYTES} bytes`);
  }
  const counter = session.txCounter++;
  const nonce = buildNonce(session.txSalt, counter);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const aad = Buffer.concat([UDP_MAGIC, counterBuf]);
  const { ciphertext, tag } = encryptAead(session.txKey, nonce, plaintext, aad);
  return Buffer.concat([UDP_MAGIC, counterBuf, ciphertext, tag]);
}

function parseUdpPacket(session, packet) {
  if (!Buffer.isBuffer(packet) && !(packet instanceof Uint8Array)) {
    return null;
  }
  if (packet.length < UDP_MAGIC.length + 8 + 16) {
    return null;
  }
  if (packet.length > MAX_UDP_PACKET_BYTES) {
    return null;
  }
  if (!packet.slice(0, 4).equals(UDP_MAGIC)) {
    return null;
  }
  const counter = packet.readBigUInt64BE(4);
  const highest = session.rxUdpHighest;
  if (highest !== null && highest !== undefined) {
    if (counter <= highest) {
      const distance = highest - counter;
      if (distance >= UDP_REPLAY_WINDOW_BITS || (session.rxUdpSeen & (1n << distance)) !== 0n) {
        return null;
      }
    }
  }
  const nonce = buildNonce(session.rxSalt, counter);
  const aad = packet.slice(0, 12);
  const ciphertext = packet.slice(12, packet.length - 16);
  const tag = packet.slice(packet.length - 16);
  try {
    const plaintext = decryptAead(session.rxKey, nonce, ciphertext, tag, aad);
    if (highest === null || highest === undefined) {
      session.rxUdpHighest = counter;
      session.rxUdpSeen = 1n;
    } else if (counter > highest) {
      const shift = counter - highest;
      session.rxUdpSeen = shift >= UDP_REPLAY_WINDOW_BITS
        ? 1n
        : ((session.rxUdpSeen << shift) | 1n) & UDP_REPLAY_WINDOW_MASK;
      session.rxUdpHighest = counter;
    } else {
      session.rxUdpSeen |= 1n << (highest - counter);
    }
    return plaintext;
  } catch (error) {
    return null;
  }
}

function writeHandshakeMessage(socket, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_HANDSHAKE_BYTES) {
    throw new RangeError(`Handshake message exceeds ${MAX_HANDSHAKE_BYTES} bytes`);
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const frame = Buffer.concat([lenBuf, payload]);

  return new Promise((resolve, reject) => {
    if (!socket || typeof socket.write !== 'function') {
      reject(new TypeError('Handshake socket is not writable'));
      return;
    }

    let settled = false;
    let writeReturned = false;
    let writeComplete = false;
    let waitingForDrain = false;
    let drained = false;

    const cleanup = () => {
      if (typeof socket.off !== 'function') return;
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('drain', onDrain);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const maybeFinish = () => {
      if (!writeReturned || !writeComplete) return;
      if (waitingForDrain && !drained) return;
      finish();
    };
    const onWrite = (error) => {
      if (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      writeComplete = true;
      maybeFinish();
    };
    const onError = (error) => finish(
      error instanceof Error ? error : new Error(String(error || 'Handshake socket write failed'))
    );
    const onClose = () => finish(new Error('Handshake socket closed before write completed'));
    const onDrain = () => {
      drained = true;
      maybeFinish();
    };

    if (typeof socket.once === 'function') {
      socket.once('error', onError);
      socket.once('close', onClose);
    }

    let accepted;
    try {
      accepted = socket.write(frame, onWrite);
    } catch (error) {
      finish(error);
      return;
    }
    if (settled) return;

    waitingForDrain = accepted === false;
    writeReturned = true;
    if (waitingForDrain) {
      if (socket.destroyed || socket.writable === false) {
        finish(new Error('Handshake socket closed before write drained'));
        return;
      }
      if (socket.writableNeedDrain === false) {
        drained = true;
      } else if (typeof socket.once === 'function') {
        socket.once('drain', onDrain);
      } else {
        finish(new Error('Handshake socket cannot report write drain'));
        return;
      }
    }
    maybeFinish();
  });
}

function readHandshakeMessage(socket, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const parsedTimeoutMs = Number(timeoutMs);
    const boundedTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
      ? Math.min(Math.floor(parsedTimeoutMs), MAX_TIMER_MS)
      : 10000;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Handshake timeout'));
    }, boundedTimeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Handshake socket closed'));
    };

    const onData = (chunk) => {
      if (buffer.length + chunk.length > MAX_HANDSHAKE_BYTES + 4) {
        cleanup();
        reject(new RangeError('Handshake receive buffer limit exceeded'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (len > MAX_HANDSHAKE_BYTES) {
        cleanup();
        reject(new RangeError(`Handshake message exceeds ${MAX_HANDSHAKE_BYTES} bytes`));
        return;
      }
      if (buffer.length < 4 + len) return;
      const payload = buffer.slice(4, 4 + len);
      cleanup();
      try {
        const message = JSON.parse(payload.toString('utf8'));
        resolve(message);
      } catch (error) {
        reject(error);
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

module.exports = {
  createHandshakeMessage,
  verifyHandshakeMessage,
  deriveSessionKeys,
  writeHandshakeMessage,
  readHandshakeMessage,
  createTcpFrame,
  consumeTcpFrames,
  createUdpPacket,
  parseUdpPacket,
};
