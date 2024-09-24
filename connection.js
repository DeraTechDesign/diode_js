// connection.js
const tls = require('tls');
const fs = require('fs');
const { RLP } = require('@ethereumjs/rlp');
const EventEmitter = require('events');
const { makeReadable, parseRequestId, parseResponseType, parseReason } = require('./utils');
const { Buffer } = require('buffer'); // Import Buffer
const asn1 = require('asn1.js');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');
const crypto = require('crypto');
const DiodeRPC = require('./rpc');
const abi = require('ethereumjs-abi');
class DiodeConnection extends EventEmitter {
  constructor(host, port, certPath) {
    super();
    this.host = host;
    this.port = port;
    this.certPath = certPath;
    this.socket = null;
    this.requestId = 0; // Initialize request ID counter
    this.pendingRequests = new Map(); // Map to store pending requests
    this.totalConnections = 0;
    this.totalBytes = 128000; // start with 128KB
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

      this.socket = tls.connect(this.port, this.host, options, async () => {
        console.log('Connected to Diode.io server');
        // Set keep-alive to prevent connection timeout forever
        this.socket.setKeepAlive(true, 0);
  
        // Send the ticketv2 command
        try {
          const ticketCommand = await this.createTicketCommand();
          const response = await this.sendCommand(ticketCommand);
          console.log('Ticket accepted:', response);
          resolve();
        } catch (error) {
          console.error('Error sending ticket:', error);
          reject(error);
        }
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
              const errorCode = responseData[0]; // Optional: You can log or use this
              if (responseData.length > 1) {
                const reason = parseReason(responseData[1]);
                reject(new Error(reason));
              } else {
                const reason = parseReason(responseData[0]);
                reject(new Error(reason));
              }
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

  getEthereumAddress() {
    try {
      const pem = fs.readFileSync(this.certPath, 'utf8');
      let privateKeyPem;
      let privateKeyDer;
      let privateKeyBytes;

      if (pem.includes('-----BEGIN PRIVATE KEY-----')) {
        // Handle PKCS#8 format
        privateKeyPem = pem
          .replace('-----BEGIN PRIVATE KEY-----', '')
          .replace('-----END PRIVATE KEY-----', '')
          .replace(/\r?\n|\r/g, '');

        privateKeyDer = Buffer.from(privateKeyPem, 'base64');

        // Define ASN.1 structure for PKCS#8 private key
        const PrivateKeyInfoASN = asn1.define('PrivateKeyInfo', function () {
          this.seq().obj(
            this.key('version').int(),
            this.key('privateKeyAlgorithm').seq().obj(
              this.key('algorithm').objid(),
              this.key('parameters').optional()
            ),
            this.key('privateKey').octstr(),
            this.key('attributes').implicit(0).any().optional(),
            this.key('publicKey').implicit(1).bitstr().optional()
          );
        });

        // Decode the DER-encoded private key
        const privateKeyInfo = PrivateKeyInfoASN.decode(privateKeyDer, 'der');
        const privateKeyOctetString = privateKeyInfo.privateKey;

        // Now parse the ECPrivateKey structure inside the octet string
        const ECPrivateKeyASN = asn1.define('ECPrivateKey', function () {
          this.seq().obj(
            this.key('version').int(),
            this.key('privateKey').octstr(),
            this.key('parameters').explicit(0).objid().optional(),
            this.key('publicKey').explicit(1).bitstr().optional()
          );
        });

        const ecPrivateKey = ECPrivateKeyASN.decode(privateKeyOctetString, 'der');
        privateKeyBytes = ecPrivateKey.privateKey;
        console.log('Private key bytes:', privateKeyBytes.toString('hex'));
      } else {
        throw new Error('Unsupported key format. Expected EC PRIVATE KEY or PRIVATE KEY in PEM format.');
      }

      // Compute the public key
      const publicKeyUint8Array = secp256k1.publicKeyCreate(privateKeyBytes, false); // uncompressed

      // Convert publicKey to Buffer if necessary
      const publicKeyBuffer = Buffer.isBuffer(publicKeyUint8Array)
        ? publicKeyUint8Array
        : Buffer.from(publicKeyUint8Array);

      // Derive the Ethereum address
      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');

      console.log('Ethereum address:', address);
      return address;
    } catch (error) {
      console.error('Error extracting Ethereum address:', error);
      throw error;
    }
  }
  
  getServerEthereumAddress() {
    try {
      const serverCert = this.socket.getPeerCertificate(true);
      if (!serverCert.raw) {
        throw new Error('Failed to get server certificate.');
      }

      const publicKeyBuffer = Buffer.isBuffer(serverCert.pubkey)
        ? serverCert.pubkey
        : Buffer.from(serverCert.pubkey);

      console.log('Public key Server:', publicKeyBuffer.toString('hex'));

      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');

      console.log('Server Ethereum address:', address);
      return address;
    } catch (error) {
      console.error('Error extracting server Ethereum address:', error);
      throw error;
    }
  }

  // getServerEthereumAddress() {
  //   try {
  //     const serverCert = this.socket.getPeerCertificate(true);
  //     if (!serverCert.raw) {
  //       throw new Error('Failed to get server certificate.');
  //     }
  
  //     // Extract public key from the certificate
  //     const publicKey = serverCert.pubkey; // May need to parse ASN.1 structure to get the public key
  //     // Assume you have a method to extract the public key buffer from the certificate
  
  //     // Compute Ethereum address from public key
  //     const publicKeyBuffer = Buffer.from(publicKey); // Ensure it's a Buffer
  //     const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
  
  //     return addressBuffer; // Return as Buffer
  //   } catch (error) {
  //     console.error('Error extracting server Ethereum address:', error);
  //     throw error;
  //   }
  // }

  // Method to extract private key bytes from certPath
  getPrivateKey() {
    // Similar to getEthereumAddress(), but return privateKeyBytes
    // Ensure to handle different key formats (EC PRIVATE KEY and PRIVATE KEY)
    try {
      const pem = fs.readFileSync(this.certPath, 'utf8');
      let privateKeyPem;
      let privateKeyDer;
      let privateKeyBytes;

      if (pem.includes('-----BEGIN PRIVATE KEY-----')) {
        // Handle PKCS#8 format
        privateKeyPem = pem
          .replace('-----BEGIN PRIVATE KEY-----', '')
          .replace('-----END PRIVATE KEY-----', '')
          .replace(/\r?\n|\r/g, '');

        privateKeyDer = Buffer.from(privateKeyPem, 'base64');

        // Define ASN.1 structure for PKCS#8 private key
        const PrivateKeyInfoASN = asn1.define('PrivateKeyInfo', function () {
          this.seq().obj(
            this.key('version').int(),
            this.key('privateKeyAlgorithm').seq().obj(
              this.key('algorithm').objid(),
              this.key('parameters').optional()
            ),
            this.key('privateKey').octstr(),
            this.key('attributes').implicit(0).any().optional(),
            this.key('publicKey').implicit(1).bitstr().optional()
          );
        });

        // Decode the DER-encoded private key
        const privateKeyInfo = PrivateKeyInfoASN.decode(privateKeyDer, 'der');
        const privateKeyOctetString = privateKeyInfo.privateKey;

        // Now parse the ECPrivateKey structure inside the octet string
        const ECPrivateKeyASN = asn1.define('ECPrivateKey', function () {
          this.seq().obj(
            this.key('version').int(),
            this.key('privateKey').octstr(),
            this.key('parameters').explicit(0).objid().optional(),
            this.key('publicKey').explicit(1).bitstr().optional()
          );
        });

        const ecPrivateKey = ECPrivateKeyASN.decode(privateKeyOctetString, 'der');
        privateKeyBytes = ecPrivateKey.privateKey;
      } else if (pem.includes('-----BEGIN EC PRIVATE KEY-----')) {
        // Handle EC PRIVATE KEY format
        privateKeyPem = pem
          .replace('-----BEGIN EC PRIVATE KEY-----', '')
          .replace('-----END EC PRIVATE KEY-----', '')
          .replace(/\r?\n|\r/g, '');

        privateKeyDer = Buffer.from(privateKeyPem, 'base64');

        // Define ASN.1 structure for EC private key
        const ECPrivateKeyASN = asn1.define('ECPrivateKey', function () {
          this.seq().obj(
            this.key('version').int(),
            this.key('privateKey').octstr(),
            this.key('parameters').explicit(0).objid().optional(),
            this.key('publicKey').explicit(1).bitstr().optional()
          );
        });

        // Decode the DER-encoded private key
        const ecPrivateKey = ECPrivateKeyASN.decode(privateKeyDer, 'der');
        privateKeyBytes = ecPrivateKey.privateKey;
      } else {
        throw new Error('Unsupported key format. Expected EC PRIVATE KEY or PRIVATE KEY in PEM format.');
      }

      return privateKeyBytes;
    } catch (error) {
      console.error('Error extracting Ethereum address:', error);
      throw error;
    }
  }

  async createTicketSignature(serverIdBuffer, totalConnections, totalBytes, localAddress = '') {
    this.getEthereumAddress()
    const chainId = 1284;
    const fleetContractBuffer = ethUtil.toBuffer('0x6000000000000000000000000000000000000000'); // 20-byte Buffer
  
    // Get epoch
    const rpc = new DiodeRPC(this);
    const epoch = await rpc.getEpoch();
  
    // Hash of localAddress (empty string)
    const localAddressHash = crypto.createHash('sha256').update(Buffer.from(localAddress, 'utf8')).digest();
  
    // Data to sign
    const dataToSign = [
      ethUtil.setLengthLeft(ethUtil.toBuffer(chainId), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(epoch), 32),
      ethUtil.setLengthLeft(fleetContractBuffer, 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(serverIdBuffer), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(totalConnections), 32),
      ethUtil.setLengthLeft(ethUtil.toBuffer(totalBytes), 32),
      ethUtil.setLengthLeft(localAddressHash, 32),
    ];

    // Convert each element in dataToSign to bytes32 and concatenate them
    const encodedData = Buffer.concat(dataToSign.map(item => abi.rawEncode(['bytes32'], [item])));

    console.log('Encoded data:', encodedData.toString('hex'));

    console.log('Data to sign:', makeReadable(dataToSign));
  
  
    // Sign the data
    const privateKey = this.getPrivateKey();
    const msgHash = ethUtil.keccak256(encodedData);
    console.log('Message hash:', msgHash.toString('hex'));
    const signature = secp256k1.ecdsaSign(msgHash, privateKey);
    console.log('Signature:', signature);
    // // Extract r, s, and rec (v)
    // const r = signature.r;
    // const s = signature.s;
    // const rec = Buffer.from([signature.v - 27]); // Adjust v to rec (v should be 27 or 28)
  
    // return { r, s, rec };
    const signatureBuffer = Buffer.concat([
      ethUtil.toBuffer([signature.recid]),
      signature.signature
    ]);

    return signatureBuffer;
  }

  async createTicketCommand() {
    const chainId = 1284;
    const fleetContract = ethUtil.toBuffer('0x6000000000000000000000000000000000000000')
    const localAddress = 'test'; // Always empty string
  
    // Increment totalConnections
    this.totalConnections += 1;
  
    // Assume totalBytes is managed elsewhere
    const totalBytes = this.totalBytes;
  
    // Get server Ethereum address as Buffer
    const serverIdBuffer = this.getServerEthereumAddress();
  
    // Create device signature and extract r, s, rec
    // const { r, s, rec } = await this.createTicketSignature(
    //   serverIdBuffer,
    //   this.totalConnections,
    //   totalBytes,
    //   localAddress
    // );
  
    const signature = await this.createTicketSignature(
      serverIdBuffer,
      this.totalConnections,
      totalBytes,
      localAddress
    );
    console.log('Signature hex:', signature.toString('hex'));
    // Get epoch
    const rpc = new DiodeRPC(this);
    const epoch = await rpc.getEpoch();
  
    // Construct the ticket command
    const ticketCommand = [
      'ticketv2',
      chainId,
      epoch,
      fleetContract,
      this.totalConnections,
      totalBytes,
      localAddress,
      signature
      // r,
      // s,
      // rec,
    ];
  
    return ticketCommand;
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
