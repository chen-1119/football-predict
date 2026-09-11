'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readChunkedJsonFile } = require('../server/chunkedJsonFile.cjs');
const { readGenerationFile } = require('../server/dataGenerationStore.cjs');
const { readMutableBundle, readPublicationJson, CORE_FILES } = require('../server/dataGenerationBundle.cjs');
const { writeJson, loadPredictionSnapshots } = require('./syncData.cjs');

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'football-chunked-json-'));
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const file = path.join(root, 'value.json');
  let boundaryProof = null;
  try {
    check('all chunk boundaries preserve exact native parse semantics', () => {
      const samples = ['null', 'true', '-0', '1e+100', '"中文😀\\uD800\\n\\\\\\\""',
        '{"__proto__":{"polluted":true},"constructor":1,"x":1,"x":2,"nested":[[],{},null,false,-0,1.25e-2]}',
        JSON.stringify({ rows: Array.from({ length: 8 }, (_, n) => ({ n, label: '球队😀', data: [null, 'a\nb', { a: true }] })) })];
      for (const source of samples) {
        fs.writeFileSync(file, source);
        for (const chunkBytes of [1, 2, 3, 7, 31, 65536])
          assert.deepEqual(readChunkedJsonFile(file, { chunkBytes }).value, JSON.parse(source));
      }
      assert.equal({}.polluted, undefined);
    });
    check('invalid syntax and invalid UTF8 never become empty data', () => {
      const bad = ['', '[1,]', '{"a":1,}', '[01]', '[1 2]', '{"a" 1}', '[tru]', '{]',
        '{}{}', '"bad\ntext"', '"\\q"', '"\\u1x34"', '"unterminated', '\uFEFF{}', ' [', '[1e+]',
        Buffer.from([123, 34, 120, 34, 58, 34, 0xc0, 0x80, 34, 125])];
      for (const source of bad) {
        fs.writeFileSync(file, source);
        for (const chunkBytes of [1, 7, 65536])
          assert.throws(() => readChunkedJsonFile(file, { chunkBytes }), { code: 'FILE_JSON_INVALID' });
      }
    });
    check('admission and content hash mismatches fail closed', () => {
      fs.writeFileSync(file, '{"a":["123456789"]}');
      for (const [options, code] of [
        [{ maxBytes: 1 }, 'CHUNKED_JSON_FILE_LIMIT'],
        [{ maxScalarChars: 4 }, 'CHUNKED_JSON_SCALAR_LIMIT'],
        [{ maxDepth: 1 }, 'CHUNKED_JSON_DEPTH_LIMIT'],
        [{ expectedBytes: 1 }, 'FILE_SIZE_MISMATCH'],
        [{ expectedSha256: '0'.repeat(64) }, 'FILE_HASH_MISMATCH'],
      ]) assert.throws(() => readChunkedJsonFile(file, options), { code });
    });
    check('mid-read mutation and replacement are rejected', () => {
      fs.writeFileSync(file, '{"n":1}');
      const original = fs.readSync;
      let injected = false;
      fs.readSync = function(...args) {
        const n = original.apply(this, args);
        if (!injected) { injected = true; fs.appendFileSync(file, ' '); }
        return n;
      };
      try { assert.throws(() => readChunkedJsonFile(file, { chunkBytes: 2 }), { code: 'GENERATION_FILE_CHANGED' }); }
      finally { fs.readSync = original; }
      fs.writeFileSync(file, '{"n":1}'); injected = false;
      fs.readSync = function(...args) {
        const n = original.apply(this, args);
        if (!injected) {
          injected = true;
          fs.renameSync(file, path.join(root, 'replaced-original.json'));
          fs.writeFileSync(file, '{"n":2}');
        }
        return n;
      };
      try { assert.throws(() => readChunkedJsonFile(file, { chunkBytes: 2 }), { code: 'GENERATION_FILE_CHANGED' }); }
      finally { fs.readSync = original; }
    });
    const data = path.join(root, 'public', 'data'); fs.mkdirSync(data, { recursive: true });
    const snapshots = path.join(data, 'prediction-snapshots.json');
    check('existing unreadable or wrong-shaped snapshot stops the real sync loader', () => {
      for (const body of ['{', '{"rows":null}', '[]', '{"rows":[],"publicReferenceEvidence":null}']) {
        fs.writeFileSync(snapshots, body);
        assert.throws(() => loadPredictionSnapshots(path.dirname(data)), /refusing to replace history/);
        assert.equal(fs.readFileSync(snapshots, 'utf8'), body);
      }
    });
    check('existing invalid core publication is not a successful empty bootstrap', () => {
      fs.writeFileSync(snapshots, '{');
      assert.throws(() => readPublicationJson({ publicDataDir: data }, 'prediction-snapshots.json', { rows: [] }),
        { code: 'FILE_JSON_INVALID' });
      assert.deepEqual(readPublicationJson({ publicDataDir: data }, 'optional-absent.json', { missing: true }), { missing: true });
    });
    check('compact streamed snapshots preserve every field, direction and idempotent bytes', () => {
      const payload = { rows: [{ sourceMatchId: 'original-draw', best: { tipCode: 'D', sp: 3.6 } }],
        observations: Array.from({ length: 110 }, (_, n) => ({ n, frozen: { tipCode: 'D' } })),
        publicReferenceDecisions: [{ direction: 'D', contentHash: 'original' }],
        publicReferenceEvidence: [{ clock: '2026-09-10T01:00:00Z' }], extra: { nested: [1, 2] } };
      assert.equal(writeJson(snapshots, payload), true);
      assert.equal(fs.readFileSync(snapshots, 'utf8'), JSON.stringify(payload) + '\n');
      assert.deepEqual(readChunkedJsonFile(snapshots).value, payload);
      assert.equal(writeJson(snapshots, payload), false);
      assert.deepEqual(loadPredictionSnapshots(path.dirname(data)).rows, payload.rows);
      const prior = fs.readFileSync(snapshots);
      assert.throws(() => writeJson(snapshots, { ...payload, observations: [1n] }), /BigInt/);
      assert.deepEqual(fs.readFileSync(snapshots), prior);
      assert.equal(fs.readdirSync(data).filter(name => name.endsWith('.tmp')).length, 0);
    });
    check('real evidence collector preserves loaded bindings instead of reporting missing history', () => {
      const { capturePublicReferenceEvidence, collectPublicReferenceEvidence } = require('../src/services/publicReferenceEvidence.cjs');
      const record = { version: 'public-reference-decision-v2', contentHash: 'synthetic-reader-fixture',
        sourceMatchId: 'fixture', kickoffTime: '2026-09-10T14:00:00Z', eventVersion: '2026-09-10T14:00:00Z',
        decisionAt: '2026-09-10T12:00:00Z', recordedAt: '2026-09-10T12:00:00Z',
        cutoffTime: '2026-09-10T13:00:00Z', decisionId: 'fixture-draw', prediction: { tipCode: 'D', sp: 3.6 } };
      const match = { eventVersion: record.eventVersion, probabilityModel: { version: 'fixture-model', generatedAt: record.decisionAt },
        predictionMeta: { modelVersion: 'fixture-model', policyVersion: 'fixture-policy',
          featureSnapshot: { sourceMatchId: record.sourceMatchId, kickoffTime: record.kickoffTime, capturedAt: record.decisionAt } } };
      const capture = capturePublicReferenceEvidence(match, record); assert.ok(capture);
      record.evidenceBinding = capture.binding;
      const entry = { version: 'public-reference-evidence-v1', referenceHash: record.contentHash,
        evidenceHash: capture.binding.evidenceHash, evidence: capture.evidence };
      writeJson(snapshots, { rows: [], publicReferenceDecisions: [record], publicReferenceEvidence: [entry] });
      const loaded = loadPredictionSnapshots(path.dirname(data));
      assert.deepEqual(collectPublicReferenceEvidence(loaded.publicReferenceDecisions, loaded.publicReferenceEvidence), [entry]);
      assert.throws(() => collectPublicReferenceEvidence([record], []), /PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING/);
      assert.equal(loaded.publicReferenceDecisions[0].prediction.tipCode, 'D');
    });
    check('actual mutable generation, immutable export and sync readers cross the V8 string boundary', () => {
      const child = spawnSync(process.execPath, ['--max-old-space-size=96', __filename, '--boundary-child', data], {
        encoding: 'utf8', timeout: 60000, maxBuffer: 1024 ** 2, windowsHide: true,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      boundaryProof = JSON.parse(child.stdout);
      assert.ok(boundaryProof.bytes > require('node:buffer').constants.MAX_STRING_LENGTH);
      assert.equal(boundaryProof.readers, 5); assert.equal(boundaryProof.direction, 'D');
    });
    return { ok: true, verifier: 'chunked-json-foundation-v1', checks, boundaryProof,
      productionWrites: 0, providerRequests: 0 };
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('football-chunked-json-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function boundaryChild(data) {
  const snapshots = path.join(data, 'prediction-snapshots.json');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(snapshots, 'w');
  const write = bytes => { fs.writeSync(fd, bytes); hash.update(bytes); };
  try {
    write(Buffer.from('{"rows":['));
    const padding = Buffer.alloc(1024 ** 2, 32);
    for (let n = 0; n < 513; n++) write(padding);
    write(Buffer.from('{"id":"keep","best":{"tipCode":"D","sp":3.6}}],"observations":[{"id":"last"}],"extra":"球队😀"}'));
  } finally { fs.closeSync(fd); }
  const sha256 = hash.digest('hex'), bytes = fs.statSync(snapshots).size;
  for (const name of CORE_FILES) if (name !== 'prediction-snapshots.json')
    fs.writeFileSync(path.join(data, name), name.startsWith('matches-') ? '[]' : '{}');
  const context = { generationDir: data, manifest: { files: [{ path: 'prediction-snapshots.json', bytes, sha256 }] } };
  const original = fs.readFileSync;
  fs.readFileSync = function(target, ...args) {
    assert.notEqual(path.resolve(String(target)), path.resolve(snapshots), 'no file-sized Buffer or string allowed');
    return original.call(this, target, ...args);
  };
  try {
    const a = readMutableBundle({ publicDataDir: data }).readPayload('prediction-snapshots.json');
    const b = readGenerationFile(context, 'prediction-snapshots.json', { parseJson: true });
    const c = readPublicationJson({ context }, 'prediction-snapshots.json');
    const d = loadPredictionSnapshots(path.dirname(data));
    const e = require('./migrateArchivedPreMatchReferences.cjs').migrateArchivedPreMatchReferences({ dataDir: data, write: false });
    assert.equal(e.ok, true);
    assert.deepEqual(a, b); assert.deepEqual(a, c); assert.deepEqual(a.rows, d.rows);
    assert.equal(a.observations[0].id, 'last'); assert.equal(a.extra, '球队😀');
    console.log(JSON.stringify({ bytes, sha256, readers: 5, direction: a.rows[0].best.tipCode,
      maxRssKiB: process.resourceUsage().maxRSS, heapLimitMiB: 96 }));
  } finally { fs.readFileSync = original; }
}
module.exports = { run };
if (require.main === module) {
  if (process.argv[2] === '--boundary-child') boundaryChild(process.argv[3]);
  else console.log(JSON.stringify(run(), null, 2));
}
