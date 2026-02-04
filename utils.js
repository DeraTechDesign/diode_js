// utils.js
const { Buffer } = require('buffer');
const logger = require('./logger');
const { KJUR } = require("jsrsasign");
const { KEYUTIL } = require("jsrsasign");
const fs = require('fs');
var path = require('path');

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
      const keyData = JSON.parse(fs.readFileSync(keyLocation, 'utf8'));
      
      // Convert the stored JSON back to keypair objects
      const prvKeyObj = KEYUTIL.getKeyFromPlainPrivatePKCS8PEM(keyData.privateKey);
      const pubKeyObj = KEYUTIL.getKey(keyData.publicKey);
      
      return { prvKeyObj, pubKeyObj };
    } else {
      // Generate new keypair
      logger.info(() => `Generating new key pair at ${keyLocation}`);
      const kp = KEYUTIL.generateKeypair("EC", "secp256k1");
      
      // Store the keys in a serializable format
      const keyData = {
        privateKey: KEYUTIL.getPEM(kp.prvKeyObj, "PKCS8PRV"),
        publicKey: KEYUTIL.getPEM(kp.pubKeyObj, "PKCS8PUB"),
        check: kp.prvKeyObj.prvKeyHex
      };
      
      // Save to file
      fs.writeFileSync(keyLocation, JSON.stringify(keyData, null, 2), 'utf8');
      
      return kp;
    }
  } catch (error) {
    logger.error(() => `Error loading or generating key pair: ${error}`);
    throw error;
  }
}

function ensureDirectoryExistence(filePath) {
  var dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
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
};
