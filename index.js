// index.js
const DiodeConnection = require('./connection');
const DiodeClientManager = require('./clientManager');
const DiodeRPC = require('./rpc');
const BindPort = require('./bindPort');
const PublishPort = require('./publishPort');
const makeReadable = require('./utils').makeReadable;
const logger = require('./logger');

// A library must not install process-wide exception handlers. Doing so changes
// the host application's crash semantics and can leave it running after an
// unrecoverable error. Applications that need custom reporting should install
// their own handlers at the process boundary.
module.exports = { DiodeConnection, DiodeClientManager, DiodeRPC, BindPort , PublishPort, makeReadable, logger };
