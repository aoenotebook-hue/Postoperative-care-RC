// Runs the ACTUAL sw.js activate handler against a stubbed caches API, so
// this tests the real deliverable file's cleanup logic deterministically —
// no real service-worker lifecycle timing involved. Run with:
//   node tests/sw_cache_isolation.test.js
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function run() {
  const src = fs.readFileSync(__dirname + '/../sw.js', 'utf8');

  const existingKeys = ['shouldercare-v1', 'osteoporosis-care-v3', 'shouldercare-v0-old', 'some-other-unrelated-cache'];
  const deleted = [];
  let activateHandler = null;

  const sandbox = {
    self: {
      addEventListener: (type, handler) => { if (type === 'activate') activateHandler = handler; },
      clients: { claim: async () => {} },
      location: { origin: 'http://example.test' },
    },
    caches: {
      keys: async () => existingKeys.slice(),
      delete: async (key) => { deleted.push(key); return true; },
      open: async () => ({ addAll: async () => {} }),
    },
    console,
  };
  sandbox.self.self = sandbox.self; // sw.js refers to bare `self` inside its own scope
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sw.js' });

  assert.ok(activateHandler, 'sw.js must register an activate listener');

  let waited;
  activateHandler({ waitUntil: (p) => { waited = p; } });

  return waited.then(() => {
    console.log('cache keys before:', existingKeys);
    console.log('cache keys deleted by activate handler:', deleted);

    assert.ok(!deleted.includes('osteoporosis-care-v3'), 'FAIL: deleted a foreign app\'s cache');
    assert.ok(!deleted.includes('some-other-unrelated-cache'), 'FAIL: deleted an unrelated cache');
    assert.ok(deleted.includes('shouldercare-v0-old'), 'FAIL: did not clean up this app\'s own stale cache version');
    assert.ok(!deleted.includes('shouldercare-v1'), 'FAIL: deleted this app\'s own current cache');

    console.log('\nALL ASSERTIONS PASSED — cache cleanup only ever touches this app\'s own prefix');
  });
}

run().catch(e => { console.error('FAIL -', e.message); process.exit(1); });
