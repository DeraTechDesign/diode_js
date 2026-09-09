// utils.js
const { Buffer } = require('buffer');
const logger = require('./logger');
const { KJUR } = require("jsrsasign");
const { KEYUTIL } = require("jsrsasign");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Zero-copy view for Uint8Array -> Buffer where possible
function toBufferView(u8) {
  if (Buffer.isBuffer(u8)) return u8;
  if (u8 && u8.buffer && typeof u8.byteOffset === 'number') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  return Buffer.from(u8);
}

function makeReadable(decodedMessage) {
  if (Array.isArray(decodedMessage)) {
    return decodedMessage.map((item) => makeReadable(item));
  } else if (decodedMessage instanceof Uint8Array) {
    const buffer = toBufferView(decodedMessage);
    // Try to interpret the Buffer as a UTF-8 string
    const str = buffer.toString('utf8');
    if (/^[\x20-\x7E]+$/.test(str)) {
      // If it's printable ASCII, return the string
      return str;
    } else if (buffer.length <= 6) {
      // If it's a small Buffer, interpret it as an integer
      return buffer.length > 0 && buffer.length <= 6 ? buffer.readUIntBE(0, buffer.length) : '0x' + buffer.toString('hex');
    } else {
      // Otherwise, return the hex representation
      return '0x' + buffer.toString('hex');
    }
  } else if (Buffer.isBuffer(decodedMessage)) {
    // Similar handling for Buffer
    const str = decodedMessage.toString('utf8');
    if (/^[\x20-\x7E]+$/.test(str)) {
      return str;
    } else if (decodedMessage.length <= 6) {
      return decodedMessage.readUIntBE(0, decodedMessage.length);
    } else {
      return '0x' + decodedMessage.toString('hex');
    }
  } else if (typeof decodedMessage === 'number') {
    return decodedMessage;
  }
  return decodedMessage;
}

// Helper functions
function parseRequestId(requestIdRaw) {
  if (requestIdRaw instanceof Uint8Array || Buffer.isBuffer(requestIdRaw)) {
    const buffer = toBufferView(requestIdRaw);
    return buffer.readUIntBE(0, buffer.length);
  } else if (typeof requestIdRaw === 'number') {
    return requestIdRaw;
  } else {
    return null;
  }
}

function parseResponseType(responseTypeRaw) {
  if (responseTypeRaw instanceof Uint8Array || Buffer.isBuffer(responseTypeRaw)) {
    return toBufferView(responseTypeRaw).toString('utf8');
  } else if (Array.isArray(responseTypeRaw)) {
    // Convert each element to Buffer and concatenate
    const buffers = responseTypeRaw.map((item) => toBufferView(item));
    const concatenated = Buffer.concat(buffers);
    return concatenated.toString('utf8');
  } else if (typeof responseTypeRaw === 'string') {
    return responseTypeRaw;
  } else {
    throw new Error('Invalid responseType type');
  }
}

function parseReason(reasonRaw) {
  if (Buffer.isBuffer(reasonRaw) || reasonRaw instanceof Uint8Array) {
    return toBufferView(reasonRaw).toString('utf8');
  } else if (typeof reasonRaw === 'string') {
    return reasonRaw;
  } else {
    return '';
  }
}

function parseUInt(valueRaw) {
  if (valueRaw === null || valueRaw === undefined) {
    return null;
  }
  if (typeof valueRaw === 'number') {
    return valueRaw;
  }
  if (typeof valueRaw === 'string') {
    if (valueRaw.startsWith('0x')) {
      return parseInt(valueRaw.slice(2), 16);
    }
    const parsed = Number(valueRaw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Buffer.isBuffer(valueRaw) || valueRaw instanceof Uint8Array) {
    const buffer = toBufferView(valueRaw);
    if (buffer.length === 0) return 0;
    return buffer.readUIntBE(0, buffer.length);
  }
  return null;
}

function generateCert(privateKeyObj, publicKeyObj) {
  // Generate a certificate valid for 1 month
  function formatDate(date) {
    const pad = n => n < 10 ? '0' + n : n;
    return String(date.getUTCFullYear()).slice(2) +
           pad(date.getUTCMonth() + 1) +
           pad(date.getUTCDate()) +
           pad(date.getUTCHours()) +
           pad(date.getUTCMinutes()) +
           pad(date.getUTCSeconds()) +
           'Z';
  }
  
  const now = new Date();
  const notBefore = formatDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)); // 30 days before now
  const notAfter = formatDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));  // 30 days after now
  
  
  var x = new KJUR.asn1.x509.Certificate({
      version: 3,
      serial: { int: Math.floor(Math.random() * 1000000) },
      issuer: { str: "/CN=device" },
      notbefore: notBefore,
      notafter: notAfter,
      subject: { str: "/CN=device" },
      sbjpubkey: publicKeyObj, 
      ext: [
          { extname: "basicConstraints", cA: false },
          { extname: "keyUsage", critical: true, names: ["digitalSignature"] },
          {
              extname: "cRLDistributionPoints",
              array: [{ fulluri: 'https://diode.io/' }]
          }
      ],
      sigalg: "SHA256withECDSA",
      cakey: privateKeyObj
  });

  // Get PEM representations
  const priv = KEYUTIL.getPEM(privateKeyObj, "PKCS8PRV");
  
  
  // Return the certificate with private key
  return priv + x.getPEM();
}

function loadOrGenerateKeyPair(keyLocation) {
  try {
    ensureDirectoryExistence(keyLocation);
    
    // Try to load existing keys
    if (fs.existsSync(keyLocation)) {
      logger.info(() => `Loading keys from ${keyLocation}`);
      return loadKeyPairFile(keyLocation);
    }

    // Generate into a private temporary file, then publish it atomically with
    // a hard link. linkSync is create-if-absent, so concurrent starters all
    // converge on the same on-disk identity without exposing a partial JSON
    // file or overwriting the winner.
    logger.info(() => `Generating new key pair at ${keyLocation}`);
    const kp = KEYUTIL.generateKeypair("EC", "secp256k1");
    const keyData = {
      privateKey: KEYUTIL.getPEM(kp.prvKeyObj, "PKCS8PRV"),
      publicKey: KEYUTIL.getPEM(kp.pubKeyObj, "PKCS8PUB")
    };
    const directory = path.dirname(keyLocation);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(keyLocation)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    let temporaryFd = null;
    try {
      temporaryFd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(temporaryFd, JSON.stringify(keyData, null, 2), 'utf8');
      fs.fsyncSync(temporaryFd);
      fs.closeSync(temporaryFd);
      temporaryFd = null;

      try {
        installKeyFile(temporaryPath, keyLocation);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          return loadKeyPairFile(keyLocation);
        }
        throw error;
      }
      enforcePrivateFileMode(keyLocation);
      return kp;
    } finally {
      if (temporaryFd !== null) {
        try { fs.closeSync(temporaryFd); } catch (_) {}
      }
      try { fs.unlinkSync(temporaryPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          logger.warn(() => `Could not remove temporary Diode key file ${temporaryPath}: ${error}`);
        }
      }
    }
  } catch (error) {
    logger.error(() => `Error loading or generating key pair: ${error}`);
    throw error;
  }
}

function installKeyFile(temporaryPath, keyLocation) {
  try {
    fs.linkSync(temporaryPath, keyLocation);
    return;
  } catch (error) {
    // Android app storage rejects hard links under SELinux. Keep the same
    // complete-file, single-writer guarantee using mkdir and rename there.
    if (!['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) throw error;
  }
  const lockPath = `${keyLocation}.lock`;
  const deadline = Date.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    if (fs.existsSync(keyLocation)) {
      const exists = new Error('Diode identity already exists');
      exists.code = 'EEXIST';
      throw exists;
    }
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        const busy = new Error('Diode identity creation is locked; existing identity was not changed');
        busy.code = 'EBUSY';
        throw busy;
      }
      Atomics.wait(wait, 0, 0, 20);
    }
  }
  try {
    // Another starter can finish between the first read and acquiring the lock.
    if (fs.existsSync(keyLocation)) {
      const exists = new Error('Diode identity already exists');
      exists.code = 'EEXIST';
      throw exists;
    }
    fs.renameSync(temporaryPath, keyLocation);
  } finally {
    fs.rmdirSync(lockPath);
  }
}

function enforcePrivateFileMode(filePath) {
  if (process.platform === 'win32') return;
  fs.chmodSync(filePath, 0o600);
}

function loadKeyPairFile(keyLocation) {
  enforcePrivateFileMode(keyLocation);
  const keyData = JSON.parse(fs.readFileSync(keyLocation, 'utf8'));
  if (!keyData || typeof keyData.privateKey !== 'string' || typeof keyData.publicKey !== 'string') {
    throw new Error('Invalid Diode key file');
  }
  const prvKeyObj = KEYUTIL.getKeyFromPlainPrivatePKCS8PEM(keyData.privateKey);
  const pubKeyObj = KEYUTIL.getKey(keyData.publicKey);
  return { prvKeyObj, pubKeyObj };
}

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) return true;
  fs.mkdirSync(dirname, { recursive: true, mode: 0o700 });
  return true;
}

const DEFAULT_FLEET_CONTRACT = '0x6000000000000000000000000000000000000000';

function normalizeFleetContractAddress(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = toBufferView(value);
    if (buffer.length !== 20) {
      throw new Error('fleetContract must be a 20-byte EVM address');
    }
    return `0x${buffer.toString('hex')}`.toLowerCase();
  }

  if (typeof value !== 'string') {
    throw new Error('fleetContract must be a 20-byte EVM address hex string');
  }

  const trimmed = value.trim();
  const hex = trimmed.toLowerCase().startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error('fleetContract must be a 20-byte EVM address hex string');
  }

  return `0x${hex.toLowerCase()}`;
}

module.exports = { 
  makeReadable, 
  parseRequestId, 
  parseResponseType, 
  parseReason, 
  parseUInt,
  generateCert, 
  loadOrGenerateKeyPair,
  ensureDirectoryExistence,
  toBufferView,
  DEFAULT_FLEET_CONTRACT,
  normalizeFleetContractAddress,
};
