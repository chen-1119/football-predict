'use strict';
const path = require('node:path'), fs = require('node:fs'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(file => /^(market-|betting-display\.).*\.test\.(?:cjs|mjs)$/.test(file)).sort();
if (!files.length) throw new Error('Market platform tests are missing');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files.map(file => path.join(root, 'tests', file))],
  { cwd: root, stdio: 'inherit', timeout: 60000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
