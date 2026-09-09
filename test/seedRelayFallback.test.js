const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const DiodeClientManager = require('../clientManager');

function manager() {
  return new DiodeClientManager({hosts:['warm.test:1','first.test:1','second.test:1','third.test:1','fourth.test:1'],relaySelection:{scoreCachePath:null}});
}

test('seed trial survives idle pruning until the caller registers its tunnel', async () => {
  const m=manager();
  const pruned=[];
  m._pruneIdleConnections=()=>{for(const host of ['first.test:1','warm.test:1'])if(!m._isProtectedHost(host))pruned.push(host);};
  m._probeHost=async host=>{m._pruneIdleConnections();assert.ok(m._isProtectedHost(host));return {_managerHostKey:host};};
  const result=await m.withSeedRelayFallback(['warm.test:1'],async connection=>({connection}));
  assert.equal(result.connection._managerHostKey,'first.test:1');
  assert.ok(m._isProtectedHost('first.test:1'),'Promise continuation still owns the lease');
  assert.equal(pruned.includes('first.test:1'),false);
  await nextTurn();
  assert.equal(m._isProtectedHost('first.test:1'),false);
  assert.ok(pruned.includes('first.test:1'));
  m.close();
});

test('seed discovery is bounded and releases failed connection trials', async () => {
  const m=manager(),attempts=[];
  m._probeHost=async host=>{attempts.push(host);throw new Error('unreachable seed');};
  await assert.rejects(m.withSeedRelayFallback(['warm.test:1'],()=>assert.fail('Cannot open a failed seed')),/unreachable seed/);
  assert.deepEqual(attempts,['first.test:1','second.test:1','third.test:1']);
  await nextTurn();assert.equal(m._relayTrialHosts.size,0);m.close();
});

test('cancellation during seed connect prevents an application port from opening', async () => {
  const m=manager();let cancelled=false;
  m._probeHost=async()=>{cancelled=true;return {};};
  await assert.rejects(m.withSeedRelayFallback(['warm.test:1'],()=>assert.fail('Cancelled bind opened a port'),{cancelled:()=>cancelled}),/Bind closed/);
  await nextTurn();assert.equal(m._relayTrialHosts.size,0);m.close();
});
