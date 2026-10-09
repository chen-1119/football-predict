'use strict';
// Source compatibility is necessary, never sufficient, for a code-only
// release. The root executor also verifies the actual installed PG catalog.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const VERSION = 'release-data-plane-policy-v1';
const FIXED = Object.freeze([
  'server/postgresStore.cjs', 'server/storageMode.cjs',
  'deploy/light-server/candidate-revision-transition.json',
  'deploy/light-server/native-release-policy.json',
  'deploy/light-server/recommendation-schema-bridge.cjs',
]);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
function capture(root) {
  assert(path.isAbsolute(root)); root = path.resolve(root);
  const entries = [];
  function plain(relative) {
    const file = path.join(root, relative);
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const s = fs.lstatSync(dir); assert(s.isDirectory() && !s.isSymbolicLink(), 'data-contract-directory');
      if (dir === root) break;
      assert(dir !== path.dirname(dir), 'data-contract-outside-root');
    }
    const before = fs.lstatSync(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 4 * 1024 * 1024, 'data-contract-file');
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    assert(before.ino === after.ino && before.size === bytes.length && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'data-contract-changed');
    entries.push({ path: relative, sha256: hash(bytes.toString('utf8').replace(/\r\n/g, '\n')) });
  }
  const dir = path.join(root, 'server/postgres/migrations');
  const s = fs.lstatSync(dir); assert(s.isDirectory() && !s.isSymbolicLink());
  const names = fs.readdirSync(dir).sort();
  assert(names.length > 0 && names.length <= 256 && names.every(n => /^\d+_[a-z0-9_-]+\.sql$/.test(n)), 'unrecognized-migration-member');
  for (const file of FIXED) plain(file);
  for (const name of names) plain('server/postgres/migrations/' + name);
  assert.deepEqual(fs.readdirSync(dir).sort(), names, 'migration-membership-changed');
  entries.sort((a, b) => a.path < b.path ? -1 : 1);
  return { version: VERSION, entries, hash: hash(JSON.stringify(entries)) };
}
function validate(value) {
  assert.equal(value?.version, VERSION); assert(Array.isArray(value.entries));
  assert(value.entries.length > FIXED.length && value.entries.length <= 256 + FIXED.length);
  let prior = '';
  for (const row of value.entries) {
    assert.deepEqual(Object.keys(row).sort(), ['path', 'sha256']);
    assert(row.path > prior && (FIXED.includes(row.path) || /^server\/postgres\/migrations\/\d+_[a-z0-9_-]+\.sql$/.test(row.path)));
    assert.match(row.sha256, /^[a-f0-9]{64}$/); prior = row.path;
  }
  for (const name of FIXED) assert(value.entries.some(row => row.path === name));
  assert.equal(value.hash, hash(JSON.stringify(value.entries))); return value;
}
function classify(baseline, candidate) {
  validate(baseline); validate(candidate);
  return { version: VERSION, mode: baseline.hash === candidate.hash ? 'code-only' : 'database',
    baselineHash: baseline.hash, candidateHash: candidate.hash,
    reason: baseline.hash === candidate.hash ? 'same-schema-and-storage-contract' : 'schema-or-storage-contract-changed',
    requiresInstalledSchemaCheck: true, parameterRegistration: 'separate', spaceReserved: false };
}
module.exports = { VERSION, FIXED, capture, validate, classify };
if (require.main === module) {
  assert.equal(process.argv.length, 4);
  console.log(JSON.stringify(classify(capture(process.argv[2]), capture(process.argv[3]))));
}
