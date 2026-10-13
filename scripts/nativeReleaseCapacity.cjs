'use strict';
// A conservative free-space budget, not a reservation or permission to delete.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const GiB = 1024 ** 3;
function positive(v) { assert(Number.isSafeInteger(v) && v > 0, 'capacity-input-invalid'); return v; }
function planCapacity({ databaseBytes, generationBytes, applicationBytes, volumes }, mode = 'database') {
  assert(['database', 'code-only'].includes(mode), 'capacity-mode-invalid');
  [databaseBytes, generationBytes, applicationBytes].forEach(positive);
  const demands = { postgres: mode === 'code-only' ? 0 : positive(3 * databaseBytes), native: positive(mode === 'code-only' ? 4 * generationBytes : databaseBytes + 2 * generationBytes),
    application: positive(3 * applicationBytes + 2 * GiB) };
  const devices = new Map();
  for (const role of Object.keys(demands)) {
    const v = volumes[role]; assert(v && typeof v.device === 'string' && v.device.length > 0);
    assert(Number.isSafeInteger(v.availableBytes) && v.availableBytes >= 0, 'available-capacity-invalid');
    const group = devices.get(v.device) || { device: v.device, roles: [], requiredWorkBytes: 0, availableBytes: v.availableBytes };
    group.roles.push(role); group.requiredWorkBytes += demands[role]; assert(Number.isSafeInteger(group.requiredWorkBytes) && group.requiredWorkBytes >= 0);
    group.availableBytes = Math.min(group.availableBytes, v.availableBytes); devices.set(v.device, group);
  }
  const checks = [...devices.values()].map(g => { const reserveBytes = Math.max(5 * GiB, Math.ceil(g.requiredWorkBytes / 10));
    const requiredBytes = positive(g.requiredWorkBytes + reserveBytes);
    return { ...g, reserveBytes, requiredBytes, deficitBytes: Math.max(0, requiredBytes - g.availableBytes), ok: g.availableBytes >= requiredBytes }; });
  return { version: 'native-release-capacity-v1', ok: checks.every(c => c.ok), demands, checks,
    productionWrites: 0, spaceReserved: false, deletionAuthorized: false };
}
function treeBytes(root) {
  let bytes = 0, entries = 0; const start = Date.now(), device = fs.statSync(root).dev;
  function visit(file) { assert(++entries <= 150000 && Date.now() - start < 20000, 'capacity-tree-budget');
    const s = fs.lstatSync(file); assert.equal(s.dev, device, 'capacity-tree-cross-mount');
    if (s.isSymbolicLink()) return; // Never follow dependency links out of the tree.
    if (s.isDirectory()) { for (const name of fs.readdirSync(file)) visit(path.join(file, name)); }
    else { assert(s.isFile(), 'capacity-tree-special-file'); bytes += s.size; assert(Number.isSafeInteger(bytes)); }
  }
  visit(root); return positive(bytes);
}
function observeCapacity() {
  assert(process.platform === 'linux' && process.getuid() === 0, 'root-linux-capacity-observer-required');
  const sql = "BEGIN READ ONLY;SET LOCAL statement_timeout='10000';SELECT json_build_object('databaseBytes',pg_database_size('football'),'dataDirectory',current_setting('data_directory'),'externalTablespaces',(SELECT count(*) FROM pg_tablespace WHERE pg_tablespace_location(oid)<>''));ROLLBACK;";
  const result = spawnSync('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '--dbname=football'],
    { input: sql, encoding: 'utf8', timeout: 15000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', PGHOST: '/var/run/postgresql', PGCONNECT_TIMEOUT: '5' } });
  assert.equal(result.status, 0, 'capacity-database-observation-failed'); const database = JSON.parse(result.stdout);
  assert.equal(Number(database.externalTablespaces), 0, 'external-tablespace-capacity-not-supported');
  assert(path.isAbsolute(database.dataDirectory));
  const pointerPath = '/var/lib/football-predict/data-generations/current.json', ps = fs.lstatSync(pointerPath);
  assert(ps.isFile() && !ps.isSymbolicLink() && ps.size <= 16384);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')); assert.match(pointer.generationId, /^g-[a-f0-9]{64}$/);
  const generation = '/var/lib/football-predict/data-generations/generations/' + pointer.generationId;
  assert.equal(fs.realpathSync(generation), generation);
  const volume = p => { const s = fs.statfsSync(p, { bigint: true }); const b = s.bavail * s.bsize;
    assert(b >= 0n && b <= BigInt(Number.MAX_SAFE_INTEGER)); return { device: String(fs.statSync(p).dev), availableBytes: Number(b) }; };
  return { observedAt: new Date().toISOString(), databaseBytes: Number(database.databaseBytes), generationBytes: treeBytes(generation),
    applicationBytes: treeBytes('/opt/football-predict'), volumes: { postgres: volume(database.dataDirectory), native: volume('/var/lib/football-release'), application: volume('/opt') } };
}
function assertNativeReleaseCapacity(mode = 'database') {
  const observation = observeCapacity(), report = { ...planCapacity(observation, mode), mode, observation };
  if (!report.ok) { const error = new Error('native-release-insufficient-capacity'); error.capacity = report; throw error; }
  return report;
}
module.exports = { planCapacity, treeBytes, observeCapacity, assertNativeReleaseCapacity };
if (require.main === module) { try { console.log(JSON.stringify(assertNativeReleaseCapacity())); }
  catch (error) { console.error(JSON.stringify({ ok: false, reason: error.message, capacity: error.capacity || null })); process.exitCode = 1; } }
