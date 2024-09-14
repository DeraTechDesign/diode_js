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
    
      portSend(ref, data) {
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
  }
  
  module.exports = DiodeRPC;
  