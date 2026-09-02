const fs = require('fs');
const path = require('path');
const util = require('util');

require('dotenv').config();

const isDebug = process.env.DEBUG === 'true';
const isLogEnabled = process.env.LOG === 'true';

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

const MAX_LOG_BYTES = boundedInteger(
  process.env.DIODE_LOG_MAX_BYTES,
  2 * 1024 * 1024,
  64 * 1024,
  2 * 1024 * 1024
);
const MAX_LOG_FILES = boundedInteger(process.env.DIODE_LOG_MAX_FILES, 5, 1, 5);

let persistentLogger = null;
let persistentLoggerFailed = false;

function evaluate(args) {
  return args.map((value) => (typeof value === 'function' ? value() : value));
}

function formatMessage(args) {
  const evaluated = evaluate(args);
  return evaluated.length > 0 ? util.format(...evaluated) : '';
}

function reportLoggerFailure(error) {
  if (persistentLoggerFailed) return;
  persistentLoggerFailed = true;
  try {
    console.error(`[diodejs] Persistent logging disabled: ${error && error.message ? error.message : error}`);
  } catch (_) {}
}

function getPersistentLogger() {
  if (!isLogEnabled || persistentLoggerFailed) return null;
  if (persistentLogger) return persistentLogger;

  try {
    // Load Winston only when file logging is explicitly enabled. Requiring the
    // library with its default LOG=false setting must not create cwd files.
    const { createLogger, format, transports } = require('winston');
    const logDirectory = path.resolve(process.env.DIODE_LOG_DIRECTORY || 'logs');
    const logFile = path.join(logDirectory, 'diodejs.log');
    fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32' && fs.existsSync(logFile)) {
      fs.chmodSync(logFile, 0o600);
    }
    const fileTransport = new transports.File({
      filename: logFile,
      level: isDebug ? 'debug' : 'info',
      maxsize: MAX_LOG_BYTES,
      maxFiles: MAX_LOG_FILES,
      tailable: true,
      options: { flags: 'a', mode: 0o600 },
    });
    persistentLogger = createLogger({
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
      ),
      transports: [fileTransport],
    });
    persistentLogger.on('error', reportLoggerFailure);
    fileTransport.on('error', reportLoggerFailure);
    return persistentLogger;
  } catch (error) {
    reportLoggerFailure(error);
    return null;
  }
}

function emit(level, args) {
  const message = formatMessage(args);
  const logger = getPersistentLogger();
  if (logger) logger.log({ level, message });

  // Warnings and errors are always observable without enabling persistent
  // logging. This preserves host crash semantics without creating disk files.
  if (level === 'error') {
    console.error(`[diodejs] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[diodejs] ${message}`);
  } else if (isLogEnabled && process.env.NODE_ENV !== 'production') {
    console.log(`[diodejs] ${level}: ${message}`);
  }
}

module.exports = {
  debug: (...args) => { if (isDebug && isLogEnabled) emit('debug', args); },
  info: (...args) => { if (isLogEnabled) emit('info', args); },
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};
