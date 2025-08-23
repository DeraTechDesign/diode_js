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

// Evaluate function args lazily to avoid building strings if logs are disabled
const evalArg = (a) => (typeof a === 'function' ? a() : a);
const mapArgs = (args) => args.map(evalArg);
const shouldDebug = isDebug && isLogEnabled;

// Wrap logger calls to respect debug mode
module.exports = {
  debug: (...args) => { if (shouldDebug) logger.debug(...mapArgs(args), 'app'); },
  info: (...args) => { if (isLogEnabled) logger.info(...mapArgs(args), 'app'); },
  warn: (...args) => { if (isLogEnabled) logger.warn(...mapArgs(args), 'app'); },
  error: (...args) => { if (isLogEnabled) logger.error(...mapArgs(args), 'app'); },
};