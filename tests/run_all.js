// Runs every test in this directory in-process. None of these tests touch
// script.google.com, any real Google Sheet, or any real deployment — they
// exercise the actual repo files (Code.gs, api/checkin.js, sw.js) against
// stubbed globals. Run with: node tests/run_all.js
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const files = [
  'apps_script_code.test.js',
  'api_checkin.test.js',
  'sw_cache_isolation.test.js',
];

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  } catch (e) {
    failed++;
  }
}

console.log(failed === 0 ? '\nAll test files passed.' : `\n${failed} test file(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
