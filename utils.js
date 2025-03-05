// utils.js
const { Buffer } = require('buffer');
const logger = require('./logger');
const { KJUR } = require("jsrsasign");
const { KEYUTIL } = require("jsrsasign");
const fs = require('fs');
var path = require('path');

function makeReadable(decodedMessage) {
  if (Array.isArray(decodedMessage)) {
    return decodedMessage.map((item) => makeReadable(item));
  } else if (decodedMessage instanceof Uint8Array) {
    const buffer = Buffer.from(decodedMessage);
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
    const buffer = Buffer.from(requestIdRaw);
    return buffer.readUIntBE(0, buffer.length);
  } else if (typeof requestIdRaw === 'number') {
    return requestIdRaw;
  } else {
    return null;
  }
}

function parseResponseType(responseTypeRaw) {
  logger.debug(`responseTypeRaw: ${responseTypeRaw}`);
  logger.debug(`Type of responseTypeRaw: ${typeof responseTypeRaw}`);
  logger.debug(`Instance of responseTypeRaw: ${responseTypeRaw instanceof Uint8Array}`);
  logger.debug(`Is Array: ${Array.isArray(responseTypeRaw)}`);
  if (responseTypeRaw instanceof Uint8Array || Buffer.isBuffer(responseTypeRaw)) {
    return Buffer.from(responseTypeRaw).toString('utf8');
  } else if (Array.isArray(responseTypeRaw)) {
    // Convert each element to Buffer and concatenate
    const buffers = responseTypeRaw.map((item) => Buffer.from(item));
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
    return Buffer.from(reasonRaw).toString('utf8');
  } else if (typeof reasonRaw === 'string') {
    return reasonRaw;
  } else {
    return '';
  }
}

function generateCert(path) {
  var kp = KEYUTIL.generateKeypair("EC", "secp256k1");

  var priv = KEYUTIL.getPEM(kp.prvKeyObj, "PKCS8PRV");

  pub = KEYUTIL.getPEM(kp.pubKeyObj, "PKCS8PUB");

  var x = new KJUR.asn1.x509.Certificate({
      version: 3,
      serial: { int: 4 },
      issuer: { str: "/CN=device" },
      subject: { str: "/CN=device" },
      sbjpubkey: kp.pubKeyObj, 
      ext: [
          { extname: "basicConstraints", cA: false },
          { extname: "keyUsage", critical: true, names: ["digitalSignature"] },
          {
              extname: "cRLDistributionPoints",
              array: [{ fulluri: 'https://diode.io/' }]
          }
      ],
      sigalg: "SHA256withECDSA",
      cakey: kp.prvKeyObj
  });


  const pemFile = priv + x.getPEM();
  ensureDirectoryExistence(path);

  fs.writeFileSync(path, pemFile , 'utf8');
}

function ensureDirectoryExistence(filePath) {
  var dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

module.exports = { makeReadable, parseRequestId, parseResponseType, parseReason, generateCert };
