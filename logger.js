const setupLogger = require('dera-logger');
require('dotenv').config();
const isDebug = (process.env.DEBUG === 'true'); // Simple debug flag
const isLogEnabled = (process.env.LOG === 'true'); // Simple log flag

const options = {
  logDirectory: 'logs',
  timestampFormat: 'HH:mm:ss',
  fileDatePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxLogFileSize: null,
  maxFiles: '14d',
  addConsoleInNonProduction: true,
  transports: [
    { filename: 'combined', level: 'silly', source: 'app' },
    { filename: 'error', level: 'warn', source: 'app' }
  ]
};

const logger = setupLogger(options);

// Wrap logger calls to respect debug mode
module.exports = {
  debug: (...args) => { if (isDebug && isLogEnabled) logger.debug(...args, 'app'); },
  info: (...args) => { if (isLogEnabled) logger.info(...args, 'app'); },
  warn: (...args) => { if (isLogEnabled) logger.warn(...args, 'app'); },
  error: (...args) => { if (isLogEnabled) logger.error(...args, 'app'); },
};
