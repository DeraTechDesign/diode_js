// connection.js
const tls = require('tls');
const fs = require('fs');
const { RLP } = require('@ethereumjs/rlp');
const EventEmitter = require('events');
const {
  makeReadable,
  parseRequestId,
  parseResponseType,
  parseReason,
  parseUInt,
  generateCert,
  ensureDirectoryExistence,
  loadOrGenerateKeyPair,
  toBufferView,
  DEFAULT_FLEET_CONTRACT,
  normalizeFleetContractAddress,
} = require('./utils');
const { Buffer } = require('buffer'); // Import Buffer
const asn1 = require('asn1.js');
const secp256k1 = require('secp256k1');
const ethUtil = require('ethereumjs-util');
const crypto = require('crypto');
const DiodeRPC = require('./rpc');
const abi = require('ethereumjs-abi');
const logger = require('./logger');
const path = require('path');
// Add dotenv for environment variables
require('dotenv').config();

// Try to use native keccak if available (optional perf boost)
let nativeKeccak = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  nativeKeccak = require('keccak');
} catch (_) {
  // optional dependency; fallback to ethereumjs-util.keccak256
}

class DiodeConnection extends EventEmitter {
  constructor(host, port, keyLocation = './db/keys.json') {
    super();
    this.host = host;
    this.port = port;
    this.keyLocation = keyLocation;
    this.socket = null;
    this.requestId = 0; // Initialize request ID counter
    this.pendingRequests = new Map(); // Map to store pending requests
    this.totalConnections = 0;
    this.totalBytes = 128000; // start with 128KB
    // Add buffer to handle partial data
    this.receiveBuffer = Buffer.alloc(0);
    this.RPC = new DiodeRPC(this);
    this.isReconnecting = false;
    this.connectPromise = null;
    
    // Add maps for storing client sockets and connections
    this.clientSockets = new Map(); // For BindPort
    this.connections = new Map(); // For PublishPort
    this.certPem = null;
    this._serverEthAddress = null; // cache after first read
    this.localAddressProvider = null;
    this.fleetContractHex = DEFAULT_FLEET_CONTRACT;
    this.fleetContract = Buffer.from(DEFAULT_FLEET_CONTRACT.slice(2), 'hex');
    // Load or generate keypair
    this.keyPair = loadOrGenerateKeyPair(this.keyLocation);
    
    // Load reconnection properties from environment variables with defaults
    const envMaxRetries = process.env.DIODE_MAX_RETRIES;
    this.maxRetries = envMaxRetries !== undefined ? 
                      (envMaxRetries.toLowerCase() === 'infinity' ? Infinity : parseInt(envMaxRetries, 10)) : 
                      Infinity;
    
    this.retryDelay = parseInt(process.env.DIODE_RETRY_DELAY, 10) || 1000; // Default: 1 second
    this.maxRetryDelay = parseInt(process.env.DIODE_MAX_RETRY_DELAY, 10) || 30000; // Default: 30 seconds
    
    // Parse boolean from string ('true'/'false')
    const envAutoReconnect = process.env.DIODE_AUTO_RECONNECT;
    this.autoReconnect = envAutoReconnect !== undefined ? 
                        (envAutoReconnect.toLowerCase() === 'true') : 
                        true;
    
    this.retryCount = 0;
    this.retryTimeoutId = null;
    
    // Log the reconnection settings
    logger.info(() => `Connection settings - Auto Reconnect: ${this.autoReconnect}, Max Retries: ${
      this.maxRetries === Infinity ? 'Infinity' : this.maxRetries
    }, Retry Delay: ${this.retryDelay}ms, Max Retry Delay: ${this.maxRetryDelay}ms`);

    // Add ticket batching configuration
    this.lastTicketUpdate = Date.now();
    this.accumulatedBytes = 0;
    this.ticketUpdateThreshold = parseInt(process.env.DIODE_TICKET_BYTES_THRESHOLD, 10) || 512000; // 512KB default
    this.ticketUpdateInterval = parseInt(process.env.DIODE_TICKET_UPDATE_INTERVAL, 10) || 30000; // 30 seconds default
    this.ticketUpdateTimer = null;
    
    // Log the ticket batching settings
    logger.info(() => `Ticket batching settings - Bytes Threshold: ${this.ticketUpdateThreshold} bytes, Update Interval: ${this.ticketUpdateInterval}ms`);

    // Handle server ticket requests on the API socket
    this._onUnsolicited = (message) => {
      this._handleUnsolicitedMessage(message);
    };
    this.on('unsolicited', this._onUnsolicited);
  }

  connect() {
    // Clear any existing retry timeout
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    return new Promise((resolve, reject) => {
      // Generate a temporary certificate valid for 1 month
      this.certPem = generateCert(this.keyPair.prvKeyObj, this.keyPair.pubKeyObj);

      const options = {
        cert: this.certPem,
        key: this.certPem,
        rejectUnauthorized: false,
        ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
        ecdhCurve: 'secp256k1',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      };

      this.socket = tls.connect(this.port, this.host, options, async () => {
        const relayHost = this.getServerRelayHost();
        const relayPort = (this.socket && this.socket.remotePort) ? this.socket.remotePort : this.port;
        logger.info(() => `Connected to Diode relay ${relayHost}:${relayPort}`);
        // Reset retry counter on successful connection
        this.retryCount = 0;
        // Set keep-alive to prevent connection timeout forever
        this.socket.setKeepAlive(true, 1500);
        this.socket.setNoDelay(true);
        // Cache server address after handshake
        const cachedServerAddress = await this._waitForServerEthereumAddress();
        if (cachedServerAddress) {
          this._serverEthAddress = cachedServerAddress;
        }
        // Start periodic ticket updates now that we are fully connected
        this._startTicketUpdateTimer();
        // Send the ticketv2 command
        try {
          const ticketCommand = await this.createTicketCommand();
          const response = await this.sendCommand(ticketCommand).catch(reject);
          resolve();
        } catch (error) {
          logger.error(() => `Error sending ticket: ${error}`);
          reject(error);
        }
      });

      this.socket.on('data', (data) => {
        // logger.debug(() => `Received data: ${data.toString('hex')}`);
        try {
          this._handleData(data);
        } catch (error) {
          logger.error(() => `Error handling data: ${error}`);
        }
      });

      // No-op: rely on secure handshake callback above for timers/caching

      this.socket.on('error', (err) => {
        logger.error(() => `Connection error: ${err}`);
          reject(err);
      });

      this.socket.on('end', () => {
        logger.info(() => 'Disconnected from server');
        this._handleDisconnect();
      });

      this.socket.on('close', (hadError) => {
        logger.info(() => `Connection closed${hadError ? ' due to error' : ''}`);
        this._handleDisconnect();
      });

      this.socket.on('timeout', () => {
        logger.warn(() => 'Connection timeout');
        this._handleDisconnect();
      });
    });
  }

  // New method to handle reconnection with exponential backoff
  _reconnect() {
    if (!this.autoReconnect || this.isReconnecting) return;
    
    this.retryCount++;
    
    if (this.maxRetries !== Infinity && this.retryCount > this.maxRetries) {
      logger.error(() => `Maximum reconnection attempts (${this.maxRetries}) reached. Giving up.`);
      this.emit('reconnect_failed');
      return;
    }
    
    // Calculate delay with exponential backoff
    const delay = Math.min(this.retryDelay * Math.pow(1.5, this.retryCount - 1), this.maxRetryDelay);
    
    logger.info(() => `Reconnecting in ${delay}ms... (Attempt ${this.retryCount})`);
    this.emit('reconnecting', { attempt: this.retryCount, delay });
    
    this.retryTimeoutId = setTimeout(() => {
      this.isReconnecting = true;
      
      // Clear existing socket if any
      if (this.socket) {
        this.socket.removeAllListeners();
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        this.socket = null;
      }
      
      // Connect again
      this.connect()
        .then(() => {
          this.isReconnecting = false;
          this.emit('reconnected');
          logger.info(() => 'Successfully reconnected to Diode.io server');
        })
        .catch((err) => {
          this.isReconnecting = false;
          logger.error(() => `Reconnection attempt failed: ${err}`);
        });
    }, delay);
  }

  // Helper method to handle disconnection events
  _handleDisconnect() {
    // Reset socket to null to ensure we don't try to use it
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    
    // Don't try to reconnect if we're intentionally closing
    if (this.autoReconnect && !this.isReconnecting) {
      this._reconnect();
    }
  }

  _ensureConnected() {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    
    this.connectPromise = new Promise((resolve, reject) => {

      if (this.isReconnecting) {
        // If we're already reconnecting, wait for the reconnection to complete
        this.once('reconnected', resolve);
        //wait for max retry delay
        setTimeout(() => {
          reject(new Error('Reconnection timed out'));
        }, this.maxRetryDelay);
      } else {
        this._reconnect();
        this.once('reconnected', resolve);
        //wait for max retry delay
        setTimeout(() => {
          reject(new Error('Reconnection timed out'));
        }, this.maxRetryDelay);
      }
    });
    
    return this.connectPromise;
  }

  // Method to set reconnection options
  setReconnectOptions(options = {}) {
    if (typeof options.maxRetries === 'number') {
      this.maxRetries = options.maxRetries;
    }
    if (typeof options.retryDelay === 'number') {
      this.retryDelay = options.retryDelay;
    }
    if (typeof options.maxRetryDelay === 'number') {
      this.maxRetryDelay = options.maxRetryDelay;
    }
    if (typeof options.autoReconnect === 'boolean') {
      this.autoReconnect = options.autoReconnect;
    }
    return this;
  }

  // Optional provider for LocalAddr ticket hint (Buffer or string)
  setLocalAddressProvider(provider) {
    this.localAddressProvider = typeof provider === 'function' ? provider : null;
    return this;
  }

  setFleetContract(fleetContract) {
    const normalizedFleetContract = normalizeFleetContractAddress(fleetContract);
    this.fleetContractHex = normalizedFleetContract;
    this.fleetContract = Buffer.from(normalizedFleetContract.slice(2), 'hex');
    return this;
  }

  // Update close method to prevent reconnection when intentionally closing
  close() {
    if (this.ticketUpdateTimer) {
      clearTimeout(this.ticketUpdateTimer);
      this.ticketUpdateTimer = null;
    }
    
    this.autoReconnect = false;
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
    if (this.socket) {
      this.socket.end();
    }
  }

  _handleData(data) {
    // Append new data to the receive buffer
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    // logger.debug(() => `Received data: ${data.toString('hex')}`);
  
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
        // Avoid copying: pass Buffer directly to RLP.decode
        const decodedMessage = RLP.decode(messageBuffer);
        // logger.debug(() => `Decoded message: ${makeReadable(decodedMessage)}`);
    
        if (Array.isArray(decodedMessage) && decodedMessage.length > 1) {
          const requestIdRaw = decodedMessage[0];
          const responseArray = decodedMessage[1];
    
          // Parse requestId
          const requestId = parseRequestId(requestIdRaw);
    
          // Debug statements
          logger.debug(() => `requestIdRaw: ${requestIdRaw}`);
          logger.debug(() => `Parsed requestId: ${requestId}`);
    
          if (requestId !== null && this.pendingRequests.has(requestId)) {
            // This is a response to a pending request
            const [responseTypeRaw, ...responseData] = responseArray;
            const responseRaw = responseData[0];
    
            // Debug statements
            logger.debug(() => `responseTypeRaw: ${responseTypeRaw}`);
            logger.debug(() => `Type of responseTypeRaw: ${typeof responseTypeRaw}`);
    
            // Parse responseType
            const responseType = parseResponseType(responseTypeRaw);
    
            logger.debug(() => `Received response for requestId: ${requestId}`);
            logger.debug(() => `Response Type: '${responseType}'`);
    
            const { resolve, reject } = this.pendingRequests.get(requestId);
            try{
              if (responseType === 'response') {
                if (!Array.isArray(responseRaw) && makeReadable(responseRaw) === 'too_low') {
                  this.fixResponse(responseData);
                  // Re-send the ticket command
                  this.createTicketCommand().then((ticketCommand) => {
                    this.sendCommand(ticketCommand).then(resolve).catch(reject);
                  }).catch(reject);
                  resolve(responseData);
                }
                resolve(responseData);
              } else if (responseType === 'error') {
                if (responseData.length > 1) {
                  const reason = parseReason(responseData[1]);
                  reject(reason);
                } else {
                  const reason = parseReason(responseData[0]);
                  reject(reason);
                }
              } else {
                resolve(responseData);
              }
            } catch (error) {
              logger.error(() => `Error handling response: ${error}`);
            }
            this.pendingRequests.delete(requestId);
          } else {
            // This is an unsolicited message
            logger.debug(() => `Received unsolicited message`);
            this.emit('unsolicited', decodedMessage);
          }
        } else {
          // Invalid message format
          logger.error(() => `Invalid message format: ${makeReadable(decodedMessage)}`);
        }
      } catch (error) {
        logger.error(() => `Error decoding message: ${error}`);
      }
    }
    
  
    // Remove processed data from the buffer
    this.receiveBuffer = this.receiveBuffer.slice(offset);
  }

  _handleUnsolicitedMessage(message) {
    if (!Array.isArray(message) || message.length < 2) return;
    const messageContent = message[1];
    if (!Array.isArray(messageContent) || messageContent.length < 1) return;

    const messageTypeRaw = messageContent[0];
    const messageType = toBufferView(messageTypeRaw).toString('utf8');

    if (messageType === 'ticket_request') {
      const deviceUsageRaw = messageContent[1];
      const deviceUsage = parseUInt(deviceUsageRaw);
      if (typeof deviceUsage === 'number' && deviceUsage > this.totalBytes) {
        this.totalBytes = deviceUsage;
      }

      // Send a fresh ticket promptly to avoid disconnect
      this.createTicketCommand()
        .then((ticketCommand) => this.sendCommand(ticketCommand))
        .then(() => {
          this.accumulatedBytes = 0;
          this.lastTicketUpdate = Date.now();
        })
        .catch((error) => {
          logger.error(() => `Error handling ticket_request: ${error}`);
        });
    }
  }

  fixResponse(response) {
    /* response is : 
    [
    'too_low',
    1284,
    666,
    11,
    135591,
    'test',
    '0x01eb1726dd7286d2dab222ea5dfef7c820cd01c30936240f5780a6e468e731f3b55d4c963b3eb768663263b396555aa52be49d7d3ae2a9173732fa410ad46434f3'
  ]
    [3] is last totalConnections
    [4] is last totalBytes
    */
    const totalConnectionsBuffer = Buffer.from(response[3]);
    const totalBytesBuffer = Buffer.from(response[4]);
    this.totalConnections = parseInt(totalConnectionsBuffer.readUIntBE(0, totalConnectionsBuffer.length), 10) +1;
    this.totalBytes = parseInt(totalBytesBuffer.readUIntBE(0, totalBytesBuffer.length), 10) + 128000;
  }

  sendCommand(commandArray) {
    return new Promise((resolve, reject) => {
      this._ensureConnected().then(() => {
        const requestId = this._getNextRequestId();
        // Build the message as [requestId, [commandArray]]
        const commandWithId = [requestId, commandArray];

        // Store the promise callbacks to resolve/reject later
        this.pendingRequests.set(requestId, { resolve, reject });

        const commandBuffer = RLP.encode(commandWithId);
        const byteLength = commandBuffer.length; // Buffer/Uint8Array length is bytes

        // Create a 2-byte length buffer
        const lengthBuffer = Buffer.alloc(2);
        lengthBuffer.writeUInt16BE(byteLength, 0);

        const message = Buffer.concat([lengthBuffer, commandBuffer]);
  
        logger.debug(() => `Sending command with requestId ${requestId}: ${commandArray}`);
        // logger.debug(() => `Command buffer: ${message.toString('hex')}`);
  
        this.socket.write(message);
      }).catch(reject);
    });
  }

  sendCommandWithSessionId(commandArray, sessionId) {
    return new Promise((resolve, reject) => {
      this._ensureConnected().then(() => {
        const requestId = sessionId;
        // Build the message as [requestId, [commandArray]]
        const commandWithId = [requestId, commandArray];

        // Store the promise callbacks to resolve/reject later
        this.pendingRequests.set(requestId, { resolve, reject });

        const commandBuffer = RLP.encode(commandWithId);
        const byteLength = commandBuffer.length; // Buffer/Uint8Array length is bytes

        // Create a 2-byte length buffer
        const lengthBuffer = Buffer.alloc(2);
        lengthBuffer.writeUInt16BE(byteLength, 0);

        const message = Buffer.concat([lengthBuffer, commandBuffer]);
  
        logger.debug(() => `Sending command with requestId ${requestId}: ${commandArray}`);
        // logger.debug(() => `Command buffer: ${message.toString('hex')}`);
  
        this.socket.write(message);
        resolve();
      }).catch(reject);
    });
  }

  getEthereumAddress() {
    try {
      // Use the stored keyPair.pubKeyObj to derive Ethereum address
      const publicKeyDer = this.keyPair.prvKeyObj.generatePublicKeyHex();
      const publicKeyBuffer = Buffer.from(publicKeyDer, 'hex');
      
      // Derive the Ethereum address
      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');

      return address;
    } catch (error) {
      logger.error(() => `Error extracting Ethereum address: ${error}`);
      throw error;
    }
  }
  
  getServerEthereumAddress(quiet = false) {
    try {
      if (this._serverEthAddress) {
        return this._serverEthAddress;
      }
      const serverCert = this.socket.getPeerCertificate(true);
      if (!serverCert.raw) {
        const err = new Error('Failed to get server certificate.');
        if (!quiet) {
          throw err;
        }
        return null;
      }

      const publicKeyBuffer = Buffer.isBuffer(serverCert.pubkey)
        ? serverCert.pubkey
        : Buffer.from(serverCert.pubkey);

      logger.debug(() => `Public key Server: ${publicKeyBuffer.toString('hex')}`);

      const addressBuffer = ethUtil.pubToAddress(publicKeyBuffer, true);
      const address = '0x' + addressBuffer.toString('hex');
      this._serverEthAddress = address;
      return this._serverEthAddress;
    } catch (error) {
      if (!quiet) {
        logger.error(() => `Error extracting server Ethereum address: ${error}`);
        throw error;
      }
      return null;
    }
  }

  getServerRelayHost() {
    if (this.socket && this.socket.remoteAddress) {
      const address = this.socket.remoteAddress;
      if (address.startsWith('::ffff:')) {
        return address.slice(7);
      }
      if (address.includes(':')) {
        return this.host;
      }
      return address;
    }
    return this.host;
  }

  async _waitForServerEthereumAddress(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2000;
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 50;
    const start = Date.now();
    let address = this.getServerEthereumAddress(true);
    if (address) return address;
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      address = this.getServerEthereumAddress(true);
      if (address) return address;
    }
    return null;
  }

  // Method to extract private key bytes from keyPair
  getPrivateKey() {
    try {
      // Extract private key bytes from the keyPair.prvKeyObj
      const privateKeyHex = this.keyPair.prvKeyObj.prvKeyHex;
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      return privateKeyBytes;
    } catch (error) {
      logger.error(() => `Error extracting private key: ${error}`);
      throw error;
    }
  }

  async createTicketSignature(serverIdBuffer, totalConnections, totalBytes, localAddress, epoch) { 
    const chainId = 1284;
    const fleetContractBuffer = this.fleetContract;
  
    const localAddressBytes = Buffer.isBuffer(localAddress) || localAddress instanceof Uint8Array
      ? toBufferView(localAddress)
      : Buffer.from(localAddress || '', 'utf8');
    const localAddressHash = crypto.createHash('sha256').update(localAddressBytes).digest();
  
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

    // Elements are already bytes32; concatenate directly to avoid ABI overhead
    const encodedData = Buffer.concat(dataToSign);

    logger.debug(() => `Encoded data: ${encodedData.toString('hex')}`);

    logger.debug(() => `Data to sign: ${makeReadable(dataToSign)}`);
  
  
    // Sign the data
    const privateKey = this.getPrivateKey();
    const msgHash = nativeKeccak
      ? nativeKeccak('keccak256').update(encodedData).digest()
      : ethUtil.keccak256(encodedData);
    logger.debug(() => `Message hash: ${msgHash.toString('hex')}`);
    const signature = secp256k1.ecdsaSign(msgHash, privateKey);
    logger.debug(() => `Signature: ${signature.signature.toString('hex')}`);
    
    const signatureBuffer = Buffer.concat([
      Buffer.from([signature.recid]),
      signature.signature
    ]);

    return signatureBuffer;
  }

  async createTicketCommand() {
    const chainId = 1284;
    const fleetContract = this.fleetContract;
    let localAddress = '';
    if (typeof this.localAddressProvider === 'function') {
      try {
        localAddress = this.localAddressProvider();
      } catch (error) {
        logger.warn(() => `Failed to get local address hint: ${error}`);
        localAddress = '';
      }
    }
    if (localAddress === null || localAddress === undefined) {
      localAddress = '';
    }
  
    // Increment totalConnections
    this.totalConnections += 1;
    const totalConnections = this.totalConnections;
  
    // Assume totalBytes is managed elsewhere
    const totalBytes = this.totalBytes;
  
    // Get server Ethereum address as Buffer
    const serverIdBuffer = await this._waitForServerEthereumAddress();
    if (!serverIdBuffer) {
      throw new Error('Failed to get server certificate.');
    }

    // Get epoch
    const epoch = await this.RPC.getEpoch();
    const signature = await this.createTicketSignature(
      serverIdBuffer,
      totalConnections,
      totalBytes,
      localAddress,
      epoch
    );
    logger.debug(() => `Signature hex: ${signature.toString('hex')}`);

  
    // Construct the ticket command
    const ticketCommand = [
      'ticketv2',
      chainId,
      epoch,
      fleetContract,
      totalConnections,
      totalBytes,
      localAddress,
      signature
    ];
  
    return ticketCommand;
  }

  getDeviceCertificate() {
    return this.certPem;
  }

    

  _getNextRequestId() {
    // Increment the request ID counter, wrap around if necessary
    this.requestId = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
    return this.requestId;
  }

  // Client sockets management methods (for BindPort)
  addClientSocket(ref, socket) {
    this.clientSockets.set(ref.toString('hex'), socket);
  }

  getClientSocket(ref) {
    return this.clientSockets.get(ref.toString('hex'));
  }

  deleteClientSocket(ref) {
    return this.clientSockets.delete(ref.toString('hex'));
  }

  hasClientSocket(ref) {
    return this.clientSockets.has(ref.toString('hex'));
  }

  // Connections management methods (for PublishPort)
  addConnection(ref, connectionInfo) {
    this.connections.set(ref.toString('hex'), connectionInfo);
  }

  getConnection(ref) {
    return this.connections.get(ref.toString('hex'));
  }

  deleteConnection(ref) {
    return this.connections.delete(ref.toString('hex'));
  }

  hasConnection(ref) {
    return this.connections.has(ref.toString('hex'));
  }

  // Start timer for periodic ticket updates
  _startTicketUpdateTimer() {
    if (this.ticketUpdateTimer) {
      clearTimeout(this.ticketUpdateTimer);
    }
    
    this.ticketUpdateTimer = setTimeout(() => {
      this._updateTicketIfNeeded(true);
    }, this.ticketUpdateInterval);
  }

  // Method to check if ticket update is needed and perform it
  async _updateTicketIfNeeded(force = false) {
    // If socket is not connected, don't try to update
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    
    const timeSinceLastUpdate = Date.now() - this.lastTicketUpdate;
    
    if (force || 
      (this.accumulatedBytes > 0 && 
      (this.accumulatedBytes >= this.ticketUpdateThreshold || 
      timeSinceLastUpdate >= this.ticketUpdateInterval))) {
      
      try {
      if (this.accumulatedBytes > 0 || force) {
        logger.debug(() => `Updating ticket: accumulated ${this.accumulatedBytes} bytes, ${timeSinceLastUpdate}ms since last update`);
        const ticketCommand = await this.createTicketCommand();
        await this.sendCommand(ticketCommand);
        
        // Reset counters
        this.accumulatedBytes = 0;
        this.lastTicketUpdate = Date.now();
      }
      } catch (error) {
      logger.error(() => `Error updating ticket: ${error}`);
      }
    }
    
    // Restart the timer
    this._startTicketUpdateTimer();
  }

  // Add method to track bytes without immediate ticket update
  addBytes(bytesCount) {
    this.totalBytes += bytesCount;
    this.accumulatedBytes += bytesCount;
    
    // Optionally check if we should update ticket now
    if (this.accumulatedBytes >= this.ticketUpdateThreshold) {
      this._updateTicketIfNeeded();
    }
  }

  // Method to set ticket batching options
  setTicketBatchingOptions(options = {}) {
    if (typeof options.threshold === 'number') {
      this.ticketUpdateThreshold = options.threshold;
    }
    if (typeof options.interval === 'number') {
      this.ticketUpdateInterval = options.interval;
    }
    
    logger.info(() => `Updated ticket batching settings - Bytes Threshold: ${this.ticketUpdateThreshold} bytes, Update Interval: ${this.ticketUpdateInterval}ms`);
    
    // Reset the timer with new interval
    if (this.socket && !this.socket.destroyed) {
      this._startTicketUpdateTimer();
    }
    
    return this;
  }
}


module.exports = DiodeConnection;
