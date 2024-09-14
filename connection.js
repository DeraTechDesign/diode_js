// connection.js
const tls = require('tls');
const fs = require('fs');
const { RLP } = require('@ethereumjs/rlp');
const EventEmitter = require('events');
const { makeReadable, parseRequestId, parseResponseType, parseReason } = require('./utils');
const { Buffer } = require('buffer'); // Import Buffer

class DiodeConnection extends EventEmitter {
  constructor(host, port, certPath) {
    super();
    this.host = host;
    this.port = port;
    this.certPath = certPath;
    this.socket = null;
    this.requestId = 0; // Initialize request ID counter
    this.pendingRequests = new Map(); // Map to store pending requests

    // Add buffer to handle partial data
    this.receiveBuffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const options = {
        cert: fs.readFileSync(this.certPath),
        key: fs.readFileSync(this.certPath),
        rejectUnauthorized: false,
        ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
        ecdhCurve: 'secp256k1',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      };

      this.socket = tls.connect(this.port, this.host, options, () => {
        console.log('Connected to Diode.io server');
        // Set keep-alive to prevent connection timeout forever
        this.socket.setKeepAlive(true, 0);

        resolve();
      });

      this.socket.on('data', (data) => this._handleData(data));
      this.socket.on('error', (err) => {
        console.error('Connection error:', err);
        reject(err);
      });
      this.socket.on('end', () => console.log('Disconnected from server'));
    });
  }

  _handleData(data) {
    // Append new data to the receive buffer
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    console.log('Received data:', data.toString('hex'));
  
    let offset = 0;
    while (offset + 2 <= this.receiveBuffer.length) {
      // Read the length of the message (2 bytes)
      const lengthBuffer = this.receiveBuffer.slice(offset, offset + 2);
      const length = lengthBuffer.readUInt16BE(0);
  
      if (offset + 2 + length > this.receiveBuffer.length) {
        // Not enough data received yet, wait for more
        break;
      }
  
      const messageBuffer = this.receiveBuffer.slice(offset + 2, offset + 2 + length);
      offset += 2 + length;
  
      try {
        const decodedMessage = RLP.decode(Uint8Array.from(messageBuffer));
        console.log('Decoded message:', decodedMessage);
    
        if (Array.isArray(decodedMessage) && decodedMessage.length > 1) {
          const requestIdRaw = decodedMessage[0];
          const responseArray = decodedMessage[1];
    
          // Parse requestId
          const requestId = parseRequestId(requestIdRaw);
    
          // Debug statements
          console.log('requestIdRaw:', requestIdRaw);
          console.log('Parsed requestId:', requestId);
    
          if (requestId !== null && this.pendingRequests.has(requestId)) {
            // This is a response to a pending request
            const [responseTypeRaw, ...responseData] = responseArray;
    
            // Debug statements
            console.log('responseTypeRaw:', responseTypeRaw);
            console.log('Type of responseTypeRaw:', typeof responseTypeRaw);
            console.log('Instance of responseTypeRaw:', responseTypeRaw instanceof Uint8Array);
            console.log('Is Array:', Array.isArray(responseTypeRaw));
    
            // Parse responseType
            const responseType = parseResponseType(responseTypeRaw);
    
            console.log(`Received response for requestId: ${requestId}`);
            console.log(`Response Type: '${responseType}'`);
    
            const { resolve, reject } = this.pendingRequests.get(requestId);
    
            if (responseType === 'response') {
              resolve(responseData);
            } else if (responseType === 'error') {
              const reason = parseReason(responseData[0]);
              reject(new Error(reason));
            } else {
              resolve(responseData);
            }
            this.pendingRequests.delete(requestId);
          } else {
            // This is an unsolicited message
            console.log('Received unsolicited message:', decodedMessage);
            this.emit('unsolicited', decodedMessage);
          }
        } else {
          // Invalid message format
          console.error('Invalid message format:', decodedMessage);
        }
      } catch (error) {
        console.error('Error decoding message:', error);
      }
    }
  
    // Remove processed data from the buffer
    this.receiveBuffer = this.receiveBuffer.slice(offset);
  }


  sendCommand(commandArray) {
    return new Promise((resolve, reject) => {
      //check if connection is alive
      if (!this.socket || this.socket.destroyed) {
        //reconnect
        this.connect().then(() => {
          this.sendCommand(commandArray).then(resolve).catch(reject);
        }).catch(reject);
        return;
      }
      const requestId = this._getNextRequestId();
      // Build the message as [requestId, [commandArray]]
      const commandWithId = [requestId, commandArray];

      // Store the promise callbacks to resolve/reject later
      this.pendingRequests.set(requestId, { resolve, reject });

      const commandBuffer = RLP.encode(commandWithId);
      const byteLength = Buffer.byteLength(commandBuffer);

      // Create a 2-byte length buffer
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(byteLength, 0);

      const message = Buffer.concat([lengthBuffer, commandBuffer]);

      console.log(`Sending command with requestId ${requestId}:`, commandArray);
      console.log('Command buffer:', message.toString('hex'));

      this.socket.write(message);
    });
  }

  _getNextRequestId() {
    // Increment the request ID counter, wrap around if necessary
    this.requestId = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
    return this.requestId;
  }

  close() {
    this.socket.end();
  }
}

module.exports = DiodeConnection;
