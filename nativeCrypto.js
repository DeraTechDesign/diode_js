const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');

const DOMAIN = Buffer.from('diode-pp2-v1', 'utf8');
const UDP_MAGIC = Buffer.from('DUD1', 'utf8');

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
  if (expectedDeviceId && message.deviceId && message.deviceId.toLowerCase() !== expectedDeviceId.toLowerCase()) {
    return { ok: false, reason: 'Device mismatch' };
  }

  const ephPub = Buffer.from(message.ephPub, 'hex');
  const nonce = Buffer.from(message.nonce, 'hex');
  const sig = Buffer.from(message.sig, 'hex');
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
  let buffer = Buffer.concat([session.rxBuffer, data]);
  while (buffer.length >= 12) {
    const len = buffer.readUInt32BE(0);
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
  const counter = session.txCounter++;
  const nonce = buildNonce(session.txSalt, counter);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const aad = Buffer.concat([UDP_MAGIC, counterBuf]);
  const { ciphertext, tag } = encryptAead(session.txKey, nonce, plaintext, aad);
  return Buffer.concat([UDP_MAGIC, counterBuf, ciphertext, tag]);
}

function parseUdpPacket(session, packet) {
  if (packet.length < UDP_MAGIC.length + 8 + 16) {
    return null;
  }
  if (!packet.slice(0, 4).equals(UDP_MAGIC)) {
    return null;
  }
  const counter = packet.readBigUInt64BE(4);
  if (counter < session.rxCounter) {
    return null;
  }
  const nonce = buildNonce(session.rxSalt, counter);
  const aad = packet.slice(0, 12);
  const ciphertext = packet.slice(12, packet.length - 16);
  const tag = packet.slice(packet.length - 16);
  try {
    const plaintext = decryptAead(session.rxKey, nonce, ciphertext, tag, aad);
    session.rxCounter = counter + 1n;
    return plaintext;
  } catch (error) {
    return null;
  }
}

function writeHandshakeMessage(socket, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([lenBuf, payload]));
}

function readHandshakeMessage(socket, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Handshake timeout'));
    }, timeoutMs);

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
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
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
