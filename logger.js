const fs = require('fs');
const path = require('path');
const setupLogger = require('dera-logger');
require('dotenv').config();

const isLogEnabled = process.env.LOG === 'true';
const isDebugEnabled = isLogEnabled && process.env.DEBUG === 'true';
const disableFileLogs = process.env.DIODE_DISABLE_FILE_LOGS === 'true';

const consoleMethods = {
  debug: console.debug.bind(console, '[diode]'),
  info: console.info.bind(console, '[diode]'),
  warn: console.warn.bind(console, '[diode]'),
  error: console.error.bind(console, '[diode]'),
};

function resolveLogDirectory() {
  const envDir = (process.env.DIODE_LOG_DIR || process.env.LOG_DIR || '').trim();
  const fallbackDir = path.join(process.cwd(), 'logs');
  const targetDir = envDir || fallbackDir;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
  } catch (err) {
    if (isLogEnabled && process.env.NODE_ENV !== 'production') {
      console.warn('[diode]', `Falling back to console logger. Unable to use "${targetDir}": ${err.code || err.message}`);
    }
    return null;
  }
}

function createFileLogger(logDirectory) {
  try {
    return setupLogger({
      logDirectory,
      timestampFormat: 'HH:mm:ss',
      fileDatePattern: 'YYYY-MM-DD',
      zippedArchive: false,
      maxLogFileSize: null,
      maxFiles: '14d',
      addConsoleInNonProduction: true,
      transports: [
        { filename: 'combined', level: 'silly', source: 'app' },
        { filename: 'error', level: 'warn', source: 'app' },
      ],
    });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[diode]', `Failed to create file logger: ${err.message}`);
    }
    return null;
  }
}

const logDirectory = isLogEnabled && !disableFileLogs ? resolveLogDirectory() : null;
const fileLogger = logDirectory ? createFileLogger(logDirectory) : null;

const evalArg = (a) => (typeof a === 'function' ? a() : a);
const mapArgs = (args) => args.map(evalArg);

function logToConsole(level, messages) {
  const consoleMethod = consoleMethods[level] || console.log.bind(console, '[diode]');
  consoleMethod(...messages);
}

function createLoggerMethod(level) {
  const levelEnabled = level === 'debug' ? isDebugEnabled : isLogEnabled;
  if (!levelEnabled) {
    return () => {};
  }
  return (...args) => {
    const messages = mapArgs(args);
    if (fileLogger) {
      fileLogger[level](...messages, 'app');
    } else {
      logToConsole(level, messages);
    }
  };
}

module.exports = {
  debug: createLoggerMethod('debug'),
  info: createLoggerMethod('info'),
  warn: createLoggerMethod('warn'),
  error: createLoggerMethod('error'),
};
