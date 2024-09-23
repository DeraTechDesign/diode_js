const { makeReadable, parseRequestId, parseResponseType, parseReason } = require('./utils');

class DiodeRPC {
    constructor(connection) {
      this.connection = connection;
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
            throw new Error('Invalid block number format');
          }
          return blockNumber;
        });
      }
    getBlockHeader(index) {
      return this.connection.sendCommand(['getblockheader', index]).then((responseData) => {
        return responseData[0]; // block_header
      });
    }
  
    getBlock(index) {
      return this.connection.sendCommand(['getblock', index]).then((responseData) => {
        return responseData[0]; // block
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
            });
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
        });
      }
    
      async portSend(ref, data) {
        // Update totalBytes
        const bytesToSend = data.length;
        this.connection.totalBytes += bytesToSend;
    
        // Send a new ticket before sending data
        try {
          const ticketCommand = await this.connection.createTicketCommand();
          const ticketResponse = await this.connection.sendCommand(ticketCommand);
          console.log('Ticket updated:', ticketResponse);
        } catch (error) {
          console.error('Error updating ticket:', error);
          throw error;
        }
    
        // Now send the data
        return this.connection.sendCommand(['portsend', ref, data]).then((responseData) => {
          // responseData is [status]
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
        });
      }

      async getEpoch() {
        const blockPeak = await this.getBlockPeak();
        const blockHeader = await this.getBlockHeader(blockPeak);
    
        // Assuming blockHeader is an object with a timestamp property
        const timestamp = this.parseTimestamp(blockHeader);
        const epochDuration = 2592000; // 30 days in seconds
        const epoch = Math.floor(timestamp / epochDuration);
    
        return epoch;
      }
    
      parseTimestamp(blockHeader) {
        // Implement parsing of timestamp from blockHeader
        // This depends on the format of blockHeader
        // For example:
        const timestampRaw = blockHeader[0][1]; // Adjust index based on actual structure
        //Timestamp Raw: [ 'timestamp', 1726689425 ]
        if (timestampRaw instanceof Uint8Array || Buffer.isBuffer(timestampRaw)) {
          return Buffer.from(timestampRaw).readUIntBE(0, timestampRaw.length);
        } else if (typeof timestampRaw === 'number') {
          return timestampRaw;
        } else {
          throw new Error('Invalid timestamp format in block header');
        }
      }
  }
  
  module.exports = DiodeRPC;
  