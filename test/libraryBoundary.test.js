const test = require('node:test');
const assert = require('node:assert/strict');

test('requiring diodejs does not install process-wide exception handlers', () => {
  const beforeUnhandled = process.listenerCount('unhandledRejection');
  const beforeUncaught = process.listenerCount('uncaughtException');

  const modulePath = require.resolve('../index');
  delete require.cache[modulePath];
  require('../index');

  assert.equal(process.listenerCount('unhandledRejection'), beforeUnhandled);
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught);
});
