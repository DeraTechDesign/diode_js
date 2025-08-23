// index.js
const DiodeConnection = require('./connection');
const DiodeRPC = require('./rpc');
const BindPort = require('./bindPort');
const PublishPort = require('./publishPort');
const makeReadable = require('./utils').makeReadable;
const logger = require('./logger');
process.on('unhandledRejection', (reason) => {
  try { logger.warn(() => `Unhandled promise rejection: ${reason}`); } catch {}
});
process.on('uncaughtException', (err) => {
  try { logger.error(() => `Uncaught exception: ${err.stack || err.message}`); } catch {}
});
module.exports = { DiodeConnection, DiodeRPC, BindPort , PublishPort, makeReadable, logger };