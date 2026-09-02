//rpc.js
const {
  makeReadable,
  parseRequestId,
  parseResponseType,
  parseReason,
  parseUInt,
  toBufferView,
} = require('./utils');
const logger = require('./logger');

const MAX_NODE_TIMER_MS = 0x7fffffff;

function normalizeTimerMs(value, fallback) {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.floor(value), MAX_NODE_TIMER_MS);
}

class DiodeRPCError extends Error {
    constructor(operation, reason, options = {}) {
      const message = reason instanceof Error ? reason.message : String(reason || `${operation} failed`);
      super(`${operation}: ${message}`);
      this.name = 'DiodeRPCError';
      this.code = 'DIODE_RPC_ERROR';
      this.operation = operation;
      this.reason = message;
      if (reason instanceof Error) this.cause = reason;
      if (options.status) this.status = options.status;
    }
}

function decodeToken(value) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return toBufferView(value).toString('utf8');
    }
    return '';
}

function normalizeAddressParam(value) {
    if (!value) return value;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return toBufferView(value);
    if (typeof value === 'string') {
      const hex = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
      if (!hex) return Buffer.alloc(0);
      return Buffer.from(hex, 'hex');
    }
    return value;
}

function parseDeviceTicketObject(obj) {
    if (!Array.isArray(obj) || obj.length < 2) {
      return null;
    }
    const objectType = decodeToken(obj[0]);
    if (objectType !== 'ticket' && objectType !== 'ticketv2') {
      return null;
    }
    const serverIdRaw = obj[1];
    let serverId = null;
    if (Buffer.isBuffer(serverIdRaw) || serverIdRaw instanceof Uint8Array) {
      serverId = toBufferView(serverIdRaw);
    } else if (typeof serverIdRaw === 'string') {
      const hex = serverIdRaw.toLowerCase().startsWith('0x') ? serverIdRaw.slice(2) : serverIdRaw;
      if (hex && /^[0-9a-f]+$/.test(hex)) {
        serverId = Buffer.from(hex, 'hex');
      }
    }
    const serverIdHex = serverId ? `0x${serverId.toString('hex')}` : '';

    const ticket = {
      objectType,
      serverId,
      serverIdHex,
    };

    if (objectType === 'ticketv2') {
      ticket.chainId = parseUInt(obj[2]);
      ticket.epoch = parseUInt(obj[3]);
    } else {
      ticket.blockNumber = parseUInt(obj[2]);
    }

    return ticket;
}

function parseServerObject(obj) {
    if (!Array.isArray(obj) || obj.length < 4) {
      return null;
    }
    const type = decodeToken(obj[0]);
    if (type !== 'server') {
      return null;
    }

    const hostRaw = obj[1];
    const host = (Buffer.isBuffer(hostRaw) || hostRaw instanceof Uint8Array)
      ? toBufferView(hostRaw).toString('utf8')
      : (typeof hostRaw === 'string' ? hostRaw : '');
    const edgePort = parseUInt(obj[2]);
    const serverPort = parseUInt(obj[3]);

    return {
      host,
      edgePort,
      serverPort,
    };
}

class DiodeRPC {
    constructor(connection) {
      this.connection = connection;
      this.epochCache = {
        epoch: null,
        expiry: null,
      };
    }

    async dioTraffic(options = {}) {
      const chainId = options.chainId === undefined ? 1284 : options.chainId;
      const params = options.epoch === undefined ? [chainId] : [chainId, options.epoch];

      return this.nodeRpc('dio_traffic', params, options);
    }

    dio_traffic(options = {}) {
      return this.dioTraffic(options);
    }

    async nodeRpc(method, params = [], options = {}) {
      if (typeof fetch !== 'function') {
        throw new Error('global fetch is required for node RPC calls');
      }

      const timeoutMs = normalizeTimerMs(options.timeoutMs, 30000);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const response = await fetch(this._nodeRpcEndpoint(options), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: options.id || 1,
            method,
            params,
          }),
          signal: controller ? controller.signal : undefined,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch (_) {
          payload = {};
        }

        if (!response.ok || payload.error) {
          const error = new Error(payload?.error?.message || `${method} failed with status ${response.status}`);
          error.status = response.status;
          error.response = payload;
          throw error;
        }

        return payload.result;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }

    _nodeRpcEndpoint(options = {}) {
      const protocol = options.protocol || 'https';
      const rpcPort = Number.isFinite(options.rpcPort) && options.rpcPort > 0 ? options.rpcPort : 8443;
      let host = options.host || '';
      if (!host && this.connection) {
        host = this.connection.host;
      }
      if (!host && this.connection && typeof this.connection.getServerRelayHost === 'function') {
        host = this.connection.getServerRelayHost();
      }
      if (!host) {
        throw new Error('No relay host available for node RPC call');
      }
      const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      return `${protocol}://${formattedHost}:${rpcPort}/`;
    }
  
    _getBlockPeakWithSender(sendCommand) {
        return sendCommand(['getblockpeak']).then((responseData) => {
          // responseData is an array containing [blockNumber]
          const blockNumberRaw = responseData[0];
          let blockNumber;
          if (blockNumberRaw instanceof Uint8Array) {
            const buf = toBufferView(blockNumberRaw);
            blockNumber = buf.readUIntBE(0, buf.length);
          } else if (Buffer.isBuffer(blockNumberRaw)) {
            blockNumber = blockNumberRaw.readUIntBE(0, blockNumberRaw.length);
          } else if (typeof blockNumberRaw === 'number') {
            blockNumber = blockNumberRaw;
          } else {
            throw new Error('Invalid block number format. response:', makeReadable(responseData));
          }
          logger.debug(() => `Block number is: ${blockNumber}`);
          return blockNumber;
        }).catch((error) => {
          logger.error(() => `Error during get block peak: ${error}`);
          return;
        });
      }

    getBlockPeak(options = {}) {
      return this._getBlockPeakWithSender((command) => this.connection.sendCommand(command, options));
    }

    _getBlockHeaderWithSender(index, sendCommand) {
      return sendCommand(['getblockheader', index]).then((responseData) => {
        return responseData[0]; // block_header
      }).catch((error) => {
        logger.error(() => `Error during get block header: ${error}`);
        return;
      });
    }

    getBlockHeader(index, options = {}) {
      return this._getBlockHeaderWithSender(index, (command) => this.connection.sendCommand(command, options));
    }
  
    getBlock(index) {
      return this.connection.sendCommand(['getblock', index]).then((responseData) => {
        return responseData[0]; // block
      }).catch((error) => {
        logger.error(() => `Error during get block: ${error}`);
        return;
      });
    }

    getObject(deviceId, options = {}) {
      const normalized = normalizeAddressParam(deviceId);
      return this.connection.sendCommand(['getobject', normalized], options).then((responseData) => {
        const obj = responseData[0];
        const parsed = parseDeviceTicketObject(obj);
        return parsed || obj;
      }).catch((error) => {
        logger.error(() => `Error during get object: ${error}`);
        return;
      });
    }

    getNode(nodeId, options = {}) {
      const normalized = normalizeAddressParam(nodeId);
      return this.connection.sendCommand(['getnode', normalized], options).then((responseData) => {
        const obj = responseData[0];
        const parsed = parseServerObject(obj);
        return parsed || obj;
      }).catch((error) => {
        logger.error(() => `Error during get node: ${error}`);
        return;
      });
    }
  
    ping(options = {}) {
      return this.connection.sendCommand(['ping'], options).then((responseData) => {
        // responseData is an array containing [status]
        const statusRaw = responseData[0];
        const status = parseResponseType(statusRaw);
    
        if (status === 'pong') {
            return true;
        } else if (status === 'error') {
            throw new Error('Ping failed');
        } else {
            throw new Error(`Unknown status in response: '${status}'`);
        }
        }).catch((error) => {
          logger.error(() => `Error during ping: ${error}`);
          return false;
        })
    }

        

    portOpen(deviceId, port, flags = 'rw', options = {}) {
        return this.connection.sendCommand(['portopen', deviceId, port, flags], options).then((responseData) => {
          // responseData is [status, refOrReason]
          const [statusRaw, refOrReasonRaw] = responseData;
      
          // Convert status to string
          const status = parseResponseType(statusRaw);
      
          if (status === 'ok') {
            let ref = refOrReasonRaw;
            if (Buffer.isBuffer(ref) || ref instanceof Uint8Array) {
              ref = toBufferView(ref);
            }
            return ref;
          } else if (status === 'error') {
            const reason = parseReason(refOrReasonRaw);
            throw new DiodeRPCError('portopen', reason, { status });
          } else {
            throw new DiodeRPCError('portopen', `Unknown status in response: '${status}'`, { status });
          }
        }).catch((error) => {
          logger.error(() => `Error during port open: ${error}`);
          throw error;
        });
      }

      portOpen2(deviceId, port, flags = 'rw', options = {}) {
        return this.connection.sendCommand(['portopen2', deviceId, port, flags], options).then((responseData) => {
          // responseData is [status, physicalPortOrReason]
          const [statusRaw, portOrReasonRaw] = responseData;
          const status = parseResponseType(statusRaw);
  
          if (status === 'ok') {
            const physicalPort = parseUInt(portOrReasonRaw);
            return physicalPort !== null ? physicalPort : portOrReasonRaw;
          } else if (status === 'error') {
            const reason = parseReason(portOrReasonRaw);
            throw new DiodeRPCError('portopen2', reason, { status });
          } else {
            throw new DiodeRPCError('portopen2', `Unknown status in response: '${status}'`, { status });
          }
        }).catch((error) => {
          logger.error(() => `Error during port open2: ${error}`);
          throw error;
        });
      }
    
      async portSend(ref, data, options = {}) {
        // Maximum size that can be sent in a single message (less than 65535 to be safe)
        const MAX_CHUNK_SIZE = 65000;
        
        try {
          // If data is too large, split it into chunks
          if (data.length > MAX_CHUNK_SIZE) {
            logger.debug(() => `Chunking large data of ${data.length} bytes into pieces of max ${MAX_CHUNK_SIZE} bytes`);
            let offset = 0;
            
            while (offset < data.length) {
              const chunkSize = Math.min(MAX_CHUNK_SIZE, data.length - offset);
              const chunk = data.slice(offset, offset + chunkSize);
              
              // Send this chunk
              const responseData = await this.connection.sendCommand(['portsend', ref, chunk], options);
              const [statusRaw] = responseData;
              const status = parseResponseType(statusRaw);
              
              if (status !== 'ok') {
                throw new Error(`Error during chunked port send: ${status}`);
              }
              
              offset += chunkSize;
            }
            
            return; // All chunks sent successfully
          } else {
            // Small enough to send in one piece
            return this.connection.sendCommand(['portsend', ref, data], options).then((responseData) => {
              const [statusRaw] = responseData;
              const status = parseResponseType(statusRaw);
          
              if (status === 'ok') {
                return;
              } else if (status === 'error') {
                throw new Error('Error during port send');
              } else {
                throw new Error(`Unknown status in response: '${status}'`);
              }
            });
          }
        } catch (error) {
          logger.error(() => `Error during port send: ${error}`);
          throw error; // Rethrow to allow proper error handling upstream
        }
      }
    
      portClose(ref, options = {}) {
        return this.connection.sendCommand(['portclose', ref], options).then((responseData) => {
          const [statusRaw, reasonRaw] = responseData;
    
          const status = Buffer.isBuffer(statusRaw) || statusRaw instanceof Uint8Array
            ? Buffer.from(statusRaw).toString('utf8')
            : statusRaw;
    
          if (status === 'ok') {
            return;
          } else if (status === 'error') {
            throw new DiodeRPCError('portclose', parseReason(reasonRaw) || 'Relay rejected port close', { status });
          } else {
            throw new DiodeRPCError('portclose', `Unknown status in response: '${status}'`, { status });
          }
        }).catch((error) => {
          logger.error(() => `Error during port close: ${error}`);
          throw error;
        });
      }

      portClose2(physicalPort, options = {}) {
        return this.connection.sendCommand(['portclose2', physicalPort], options).then((responseData) => {
          const [statusRaw, reasonRaw] = responseData;
          const status = parseResponseType(statusRaw);

          if (status === 'ok') {
            return;
          } else if (status === 'error') {
            throw new DiodeRPCError('portclose2', parseReason(reasonRaw) || 'Relay rejected native port close', { status });
          } else {
            throw new DiodeRPCError('portclose2', `Unknown status in response: '${status}'`, { status });
          }
        }).catch((error) => {
          logger.error(() => `Error during port close2: ${error}`);
          throw error;
        });
      }

      sendError(sessionId, ref, error) {
        return this.connection.sendCommandWithSessionId(['response', ref, 'error', error], sessionId).catch((error) => {
          logger.error(() => `Error during send error: ${error}`);
          throw error;
        });
      }

      sendResponse(sessionId, ref, response) {
        return this.connection.sendCommandWithSessionId(['response', ref, response], sessionId).catch((error) => {
          logger.error(() => `Error during send response: ${error}`);
          throw error;
        });
      }

      async _getEpochWithSender(sendCommand) {
        const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
        if (this.epochCache.expiry && this.epochCache.expiry > currentTime) {
          logger.debug(() => `Using cached epoch: ${this.epochCache.epoch}`);
          return this.epochCache.epoch;
        }
        logger.debug(() => `Fetching new epoch. Expiry: ${this.epochCache.expiry}, Current time: ${currentTime}`);
        const blockPeak = await this._getBlockPeakWithSender(sendCommand);
        const blockHeader = await this._getBlockHeaderWithSender(blockPeak, sendCommand);
    
        // Assuming blockHeader is an object with a timestamp property
        const timestamp = this.parseTimestamp(blockHeader);
        const epochDuration = 2592000; // 30 days in seconds
        const epoch = Math.floor(timestamp / epochDuration);
    
        // Calculate the time left for the next epoch
        const timeLeft = epochDuration - (timestamp % epochDuration);

        // Cache the epoch and the expiry time
        this.epochCache.epoch = epoch;
        this.epochCache.expiry = currentTime + timeLeft;

        return epoch;
      }

      getEpoch(options = {}) {
        return this._getEpochWithSender((command) => this.connection.sendCommand(command, options));
      }
    
      parseTimestamp(blockHeader) {
        // Search for the timestamp field by name (robust to Buffer/Uint8Array)
        if (Array.isArray(blockHeader)) {
          for (const field of blockHeader) {
            if (Array.isArray(field) && field.length >= 2) {
              const key = typeof field[0] === 'string' ? field[0] : toBufferView(field[0]).toString('utf8');
              if (key === 'timestamp') {
                const timestampValue = field[1];
                // Handle different timestamp value types
                if (typeof timestampValue === 'number') {
                  return timestampValue;
                } else if (typeof timestampValue === 'string' && timestampValue.startsWith('0x')) {
                  return parseInt(timestampValue.slice(2), 16);
                } else if (typeof timestampValue === 'string') {
                  return parseInt(timestampValue, 10);
                } else if (timestampValue instanceof Uint8Array || Buffer.isBuffer(timestampValue)) {
                  const buf = toBufferView(timestampValue);
                  if (buf.length <= 6) {
                    return buf.readUIntBE(0, buf.length);
                  }
                  return parseInt(buf.toString('hex'), 16);
                }
              }
            }
          }
        }
        // Fallback
        logger.warn(() => 'Could not find or parse timestamp in block header, using current time');
        return Math.floor(Date.now() / 1000);
      }
  }
  
module.exports = DiodeRPC;
DiodeRPC.Error = DiodeRPCError;
