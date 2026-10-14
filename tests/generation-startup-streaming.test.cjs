'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../server/dataGenerationStore.cjs');
const bundles = require('../server/dataGenerationBundle.cjs');

function fixture(run, replacements = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'football-startup-stream-'));
  const publicDataDir = path.join(directory, 'public'); fs.mkdirSync(publicDataDir);
  const payloads = new Map([
    ['matches-current.json', [{ id: 'current' }]], ['matches-history.json', [{ id: 'history' }]],
    ['sync-meta.json', { sourceCycleId: 'startup-fixture', updatedAt: '2030-01-01T00:00:00Z',
      files: { current: 1, history: 1, predictionSnapshots: 3 } }],
    ['external-signals.json', { matches: {} }],
    ['odds-history.json', { rows: [{ odds: 1.72 }, { odds: 2.5 }], metadata: { rows: [0] } }],
    ['prediction-snapshots.json', { rows: [{ text: '首个原版' }, null, ['nested']], metadata: { rows: [0] } }],
    ['model-calibration.json', { version: 'fixture', generatedAt: '2030-01-01T00:00:00Z' }],
  ]);
  try {
    const files = Object.fromEntries([...payloads].map(([name, value]) => [name,
      { rows: Array.isArray(value) ? value.length : 0,
        ...(replacements[name] || { bytes: JSON.stringify(value) }) }]));
    const accepted = store.commitDataGeneration({ storeDir: directory, sourceCycleId: 'startup-fixture',
      files, coreFiles: [...payloads.keys()], committedAt: '2030-01-01T00:00:01Z' });
    const identity = { mode: 'active-generation', ...accepted.pointer }; delete identity.schemaVersion;
    const resolve = () => bundles.resolveCommittedPostgresPublication({ storeDir: directory, publicDataDir,
      postgresIdentity: identity });
    return run({ directory, publicDataDir, accepted, identity, payloads, resolve });
  } finally {
    assert.equal(fs.realpathSync(directory).toLowerCase(), path.resolve(directory).toLowerCase());
    assert(path.basename(directory).startsWith('football-startup-stream-'));
    fs.rmSync(directory, { recursive: true });
  }
}

test('startup streams exact root row counts and preserves complete semantic-hash callers', () => fixture(x => {
  const before = x.accepted.context.manifest.files.map(entry => [entry.path, entry.bytes, entry.sha256]);
  const publication = x.resolve(), result = bundles.validateGenerationBundle(publication.context);
  assert.equal(result.predictionRows, 3); assert.equal(result.oddsRows, 2);
  assert.equal(result.currentRows, 1); assert.equal(result.historyRows, 1);
  assert.equal(bundles.validateGenerationBundle(publication.context, { includeSemanticHash: true }).semanticHash,
    bundles.bundleSemanticHash(x.payloads));
  assert.deepEqual(publication.context.manifest.files.map(entry => [entry.path, entry.bytes, entry.sha256]), before);
}));

for (const value of ['{}', '{"rows":null}', '{"rows":{}}', '[]']) {
  test('startup rejects missing or non-array root rows: ' + value, () => fixture(x => {
    assert.throws(x.resolve);
  }, { 'prediction-snapshots.json': { bytes: value } }));
}
for (const value of [
  '{"rows":[],"rows":[0]}', '{"rows":[0,]}', '{"rows":[{"x":"bad\\q"}]}',
  '{"rows":[0]}trailing', '{"rows":[],"unselected":{"bad":}}',
]) test('startup validates the entire document and rejects ambiguous/malformed rows: ' + value,
  () => fixture(x => assert.throws(x.resolve), { 'prediction-snapshots.json': { bytes: value } }));

test('startup cannot substitute observed row count for sync-meta declared count', () => fixture(x => {
  assert.throws(x.resolve, error => error.code === 'GENERATION_SEMANTIC_INVALID');
}, { 'prediction-snapshots.json': { bytes: '{"rows":[0,1]}' } }));

for (const fault of ['bytes', 'hash']) test('startup refuses generation payload ' + fault + ' tampering',
  () => fixture(x => {
    const file = path.join(x.accepted.context.generationDir, 'prediction-snapshots.json');
    if (fault === 'bytes') fs.appendFileSync(file, ' ');
    else fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('首个原版', '另外原版'));
    assert.throws(x.resolve);
  }));

test('large committed generation cold validation fits a 64 MiB child heap without omitting rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'football-startup-large-'));
  try {
    const file = path.join(directory, 'large.json'), count = 256;
    const fd = fs.openSync(file, 'wx');
    const row = JSON.stringify({ text: 'x'.repeat(512 * 1024) });
    try {
      fs.writeSync(fd, '{"unselected":{"rows":[0]},"rows":[');
      for (let i = 0; i < count; i++) fs.writeSync(fd, (i ? ',' : '') + row);
      fs.writeSync(fd, '],"tail":{"validated":true}}');
    } finally { fs.closeSync(fd); }
    assert(fs.statSync(file).size > 128 * 1024 * 1024);
    fixture(x => {
      const code = `const b=require(${JSON.stringify(require.resolve('../server/dataGenerationBundle.cjs'))});
        const p=b.resolveCommittedPostgresPublication(${JSON.stringify({ storeDir: x.directory,
          publicDataDir: x.publicDataDir, postgresIdentity: x.identity })});
        const r=b.validateGenerationBundle(p.context);
        process.stdout.write(JSON.stringify({generationId:p.identity.generationId,predictionRows:r.predictionRows}));`;
      const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code], {
        encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.deepEqual(JSON.parse(child.stdout), { generationId: x.identity.generationId, predictionRows: count });
    }, {
      'prediction-snapshots.json': { sourcePath: file },
      'sync-meta.json': { bytes: JSON.stringify({ sourceCycleId: 'startup-fixture', updatedAt: '2030-01-01T00:00:00Z',
        files: { current: 1, history: 1, predictionSnapshots: count } }) },
    });
  } finally {
    assert.equal(fs.realpathSync(directory).toLowerCase(), path.resolve(directory).toLowerCase());
    assert(path.basename(directory).startsWith('football-startup-large-'));
    fs.rmSync(directory, { recursive: true });
  }
});
