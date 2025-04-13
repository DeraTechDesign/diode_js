//rpc.js
const { makeReadable, parseRequestId, parseResponseType, parseReason } = require('./utils');
const logger = require('./logger');

class DiodeRPC {
    constructor(connection) {
      this.connection = connection;
      this.epochCache = {
        epoch: null,
        expiry: null,
      };
    }
  
    getBlockPeak() {
        return this.connection.sendCommand(['getblockpeak']).then((responseData) => {
          // responseData is an array containing [blockNumber]
          const blockNumberRaw = responseData[0];
          let blockNumber;
          if (blockNumberRaw instanceof Uint8Array) {
            blockNumber = Buffer.from(blockNumberRaw).readUIntBE(0, blockNumberRaw.length);
          } else if (Buffer.isBuffer(blockNumberRaw)) {
            blockNumber = blockNumberRaw.readUIntBE(0, blockNumberRaw.length);
          } else if (typeof blockNumberRaw === 'number') {
            blockNumber = blockNumberRaw;
          } else {
            throw new Error('Invalid block number format. response:', makeReadable(responseData));
          }
          logger.debug(`Block number is: ${blockNumber}`);
          return blockNumber;
        }).catch((error) => {
          logger.error(`Error during get block peak: ${error}`);
          return;
        });
      }
    getBlockHeader(index) {
      return this.connection.sendCommand(['getblockheader', index]).then((responseData) => {
        return responseData[0]; // block_header
      }).catch((error) => {
        logger.error(`Error during get block header: ${error}`);
        return;
      });
    }
  
    getBlock(index) {
      return this.connection.sendCommand(['getblock', index]).then((responseData) => {
        return responseData[0]; // block
      }).catch((error) => {
        logger.error(`Error during get block: ${error}`);
        return;
      });
    }
  
    ping() {
      return this.connection.sendCommand(['ping']).then((responseData) => {
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
          logger.error(`Error during ping: ${error}`);
          return false;
        })
    }

        

    portOpen(deviceId, port, flags = 'rw') {
        return this.connection.sendCommand(['portopen', deviceId, port, flags]).then((responseData) => {
          // responseData is [status, refOrReason]
          const [statusRaw, refOrReasonRaw] = responseData;
      
          // Convert status to string
          const status = parseResponseType(statusRaw);
      
          if (status === 'ok') {
            let ref = refOrReasonRaw;
            if (Buffer.isBuffer(ref) || ref instanceof Uint8Array) {
              ref = Buffer.from(ref);
            }
            return ref;
          } else if (status === 'error') {
            let reason = parseReason(refOrReasonRaw);
            throw new Error(reason);
          } else {
            throw new Error(`Unknown status in response: '${status}'`);
          }
        }).catch((error) => {
          logger.error(`Error during port open: ${error}`);
          return;
        });
      }
    
      async portSend(ref, data) {
        // Update bytes count but don't update ticket yet
        const bytesToSend = data.length;
        this.connection.addBytes(bytesToSend);
    
        // Maximum size that can be sent in a single message (less than 65535 to be safe)
        const MAX_CHUNK_SIZE = 65000;
        
        try {
          // If data is too large, split it into chunks
          if (data.length > MAX_CHUNK_SIZE) {
            logger.debug(`Chunking large data of ${data.length} bytes into pieces of max ${MAX_CHUNK_SIZE} bytes`);
            let offset = 0;
            
            while (offset < data.length) {
              const chunkSize = Math.min(MAX_CHUNK_SIZE, data.length - offset);
              const chunk = data.slice(offset, offset + chunkSize);
              
              // Send this chunk
              const responseData = await this.connection.sendCommand(['portsend', ref, chunk]);
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
            return this.connection.sendCommand(['portsend', ref, data]).then((responseData) => {
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
          logger.error(`Error during port send: ${error}`);
          throw error; // Rethrow to allow proper error handling upstream
        }
      }
    
      portClose(ref) {
        return this.connection.sendCommand(['portclose', ref]).then((responseData) => {
          const [statusRaw] = responseData;
    
          const status = Buffer.isBuffer(statusRaw) || statusRaw instanceof Uint8Array
            ? Buffer.from(statusRaw).toString('utf8')
            : statusRaw;
    
          if (status === 'ok') {
            return;
          } else if (status === 'error') {
            throw new Error('Error during port close');
          } else {
            throw new Error(`Unknown status in response: '${status}'`);
          }
        }).catch((error) => {
          logger.error(`Error during port close: ${error}`);
          return;
        });
      }

      sendError(sessionId, ref, error) {
        return this.connection.sendCommandWithSessionId(['response', ref, 'error', error], sessionId).catch((error) => {
          logger.error(`Error during send error: ${error}`);
          return;
        });
      }

      sendResponse(sessionId, ref, response) {
        return this.connection.sendCommandWithSessionId(['response', ref, response], sessionId).catch((error) => {
          logger.error(`Error during send response: ${error}`);
          return;
        });
      }

      async getEpoch() {
        const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
        if (this.epochCache.expiry && this.epochCache.expiry > currentTime) {
          logger.debug(`Using cached epoch: ${this.epochCache.epoch}`);
          return this.epochCache.epoch;
        }
        logger.debug(`Fetching new epoch. Expiry: ${this.epochCache.expiry}, Current time: ${currentTime}`);
        const blockPeak = await this.getBlockPeak();
        const blockHeader = await this.getBlockHeader(blockPeak);
    
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
    
      parseTimestamp(blockHeader) {        
        // Search for the timestamp field by name
        if (Array.isArray(blockHeader)) {
          for (const field of blockHeader) {
            if (Array.isArray(field) && field.length >= 2 && field[0] === 'timestamp') {
              const timestampValue = field[1];
              
              // Handle different timestamp value types
              if (typeof timestampValue === 'number') {
                return timestampValue;
              } else if (typeof timestampValue === 'string' && timestampValue.startsWith('0x')) {
                // Handle hex string
                return parseInt(timestampValue.slice(2), 16);
              } else if (typeof timestampValue === 'string') {
                // Handle decimal string
                return parseInt(timestampValue, 10);
              } else if (timestampValue instanceof Uint8Array || Buffer.isBuffer(timestampValue)) {
                // Handle buffer - carefully determine the byte length
                const buf = Buffer.from(timestampValue);
                // Use a safe approach to read the value based on buffer length
                if (buf.length <= 6) {
                  return buf.readUIntBE(0, buf.length);
                } else {
                  // For larger buffers, convert to hex string first
                  return parseInt(buf.toString('hex'), 16);
                }
              }
            }
          }
        }
        
        // Fallback: if we couldn't find the timestamp or parse it correctly
        logger.warn('Could not find or parse timestamp in block header, using current time');
        return Math.floor(Date.now() / 1000);
      }
  }
  
  module.exports = DiodeRPC;
