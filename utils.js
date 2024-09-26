// utils.js
const { Buffer } = require('buffer');
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
  console.log('responseTypeRaw:', responseTypeRaw);
  console.log('Type of responseTypeRaw:', typeof responseTypeRaw);
  console.log('Instance of responseTypeRaw:', responseTypeRaw instanceof Uint8Array);
  console.log('Is Array:', Array.isArray(responseTypeRaw));
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

module.exports = { makeReadable, parseRequestId, parseResponseType, parseReason };
