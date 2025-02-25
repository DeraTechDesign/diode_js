const setupLogger = require('dera-logger');

const isDebug = (process.env.DEBUG === 'true'); // Simple debug flag

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
  debug: (...args) => { if (isDebug) logger.debug(...args, 'app'); },
  info: (...args) => logger.info(...args, 'app'),
  warn: (...args) => logger.warn(...args, 'app'),
  error: (...args) => logger.error(...args, 'app'),
};
