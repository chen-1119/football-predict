'use strict';
// Exercise the actual validator with in-memory file overlays; no real writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.join(__dirname, 'validateData.cjs');
const source = fs.readFileSync(file, 'utf8');
const baseRequire = createRequire(file);
const archivePath = path.resolve(__dirname, '../outputs/synthetic-validation-archive.json');
let checks = 0;
function run({ publicOnly = false, archive = null, count = 14, policyCount = count, omitCounts = false, badScore = false } = {}) {
  const io = Object.create(fs), messages = [];
  let payload = null, exitCode = 0, archiveReads = 0;
  io.existsSync = p => path.resolve(p) === archivePath ? archive !== null : fs.existsSync(p);
  io.readFileSync = (p, ...args) => {
    if (path.resolve(p) === archivePath) { archiveReads++; return JSON.stringify(archive); }
    const raw = fs.readFileSync(p, ...args);
    if (String(p).replaceAll('\\', '/').endsWith('/public/data/sync-meta.json')) {
      const meta = JSON.parse(raw); meta.files.archivedUnsettled = count;
      meta.currentListPolicy.archivedUnsettled = policyCount;
      if (omitCounts) { delete meta.files.archivedUnsettled; delete meta.currentListPolicy.archivedUnsettled; }
      return JSON.stringify(meta);
    }
    if (badScore && String(p).replaceAll('\\', '/').endsWith('/public/data/matches-history.json')) {
      const rows = JSON.parse(raw); assert.ok(rows.length); rows[0].scoreHome = null; return JSON.stringify(rows);
    }
    return raw;
  };
  const stop = {};
  const proc = { env: { ...process.env, UNRESOLVED_MATCH_ARCHIVE_PATH: archivePath },
    argv: ['node', file, ...(publicOnly ? ['--public-distribution'] : [])],
    exit: code => { exitCode = code; throw stop; } };
  const fn = vm.runInNewContext(`(function(require,__dirname,process,console){${source}\n})`, {});
  try { fn(name => ['fs', 'node:fs'].includes(name) ? io : baseRequire(name), __dirname, proc,
    { error: s => messages.push(s), log: s => { payload = JSON.parse(s); } });
  } catch (e) { if (e !== stop) throw e; }
  return { exitCode, payload, messages: messages.join('\n'), archiveReads };
}
const verify = (name, test) => { test(); checks++; };
verify('default server validation rejects missing private archive', () => {
  const r = run(); assert.equal(r.exitCode, 1); assert.match(r.messages, /must match the private unresolved archive/);
});
verify('explicit public scope validates without claiming private verification', () => {
  const r = run({ publicOnly: true }); assert.equal(r.exitCode, 0, r.messages);
  assert.equal(r.payload.validationScope, 'public-distribution'); assert.equal(r.payload.privateArchiveVerified, false);
  assert.equal(r.payload.currentListPolicy.archivedUnsettled, null); assert.equal(r.payload.currentListPolicy.declaredArchivedUnsettled, 14);
});
verify('public build never reads an accidentally present private file', () => {
  const r = run({ publicOnly: true, archive: [{ status: 'FINISHED' }] }); assert.equal(r.exitCode, 0, r.messages); assert.equal(r.archiveReads, 0);
});
for (const publicOnly of [true, false]) verify(`absent counters cannot become zero / ${publicOnly}`, () => {
  const r = run({ publicOnly, omitCounts: true }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
});
for (const count of [null, '', '14', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  for (const publicOnly of [true, false]) verify(`invalid archive counter ${JSON.stringify(count)} / ${publicOnly}`, () => {
    const r = run({ publicOnly, count }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
  });
}
verify('public archive counters must agree', () => {
  const r = run({ publicOnly: true, count: 14, policyCount: 13 }); assert.equal(r.exitCode, 1); assert.match(r.messages, /explicit equal non-negative/);
});
verify('public scope still rejects a missing finished score', () => {
  const r = run({ publicOnly: true, badScore: true }); assert.equal(r.exitCode, 1); assert.match(r.messages, /score/i);
});
verify('server still inspects malformed private rows', () => {
  const r = run({ count: 1, archive: [{ id: 'synthetic-unresolved-invalid', status: 'FINISHED' }] });
  assert.equal(r.exitCode, 1); assert.equal(r.archiveReads, 1); assert.match(r.messages, /archive must not retain FINISHED/);
});
verify('valid empty server archive remains zero, not unavailable', () => {
  const r = run({ count: 0, archive: [] }); assert.equal(r.exitCode, 0, r.messages);
  assert.equal(r.payload.privateArchiveVerified, true); assert.equal(r.payload.currentListPolicy.archivedUnsettled, 0);
});
verify('Pages uses explicit public scope while default npm task stays strict', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts['validate:data'], 'node scripts/validateData.cjs');
  assert.equal(pkg.scripts['validate:data:public'], 'node scripts/validateData.cjs --public-distribution');
  assert.match(fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8'), /npm run validate:data:public/);
});
console.log(JSON.stringify({ ok: true, checks, productionDataTouched: false, scope: 'actual validator with isolated in-memory overlays' }, null, 2));
