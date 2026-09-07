'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readSelectedJsonObjectFile: read } = require('../server/selectedJsonObjectFile.cjs');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
if (process.argv[2] === '--large-child') {
  const result = read({ filePath: process.argv[3], expectedBytes: Number(process.argv[4]), expectedSha256: process.argv[5], keys: ['keep', 'updatedAt'] });
  assert.equal(result.value.keep.x, '中😀');
  assert.deepEqual(result.value.keep.n, [1, true, null]);
  assert.equal(result.value.keep.bulk.length, 32 * 1024 * 1024);
  assert.equal(result.value.updatedAt, '2026-09-07');
  console.log(JSON.stringify({ evidence: result.evidence, maxRssKiB: process.resourceUsage().maxRSS }));
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-selected-json-'));
const filename = path.join(dir, 'fixture.json'), checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const fixture = (source, keys = ['keep'], options = {}) => {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  fs.writeFileSync(filename, bytes);
  return read({ filePath: filename, expectedBytes: bytes.length, expectedSha256: sha(bytes), keys, ...options });
};
let largeEvidence = null;
try {
  check('selected values match JSON.parse through every small chunk boundary', () => {
    const text = '{"ignored":[{"x":"quote\\\" } ] and \\u4e2d"},-1.2e+4,true,null],"keep":{"中😀":"slash\\\\line\\n\\uD83D\\uDE00","a":[{},[],false,0,-0,1E-9]},"tail":"skip"}';
    for (let chunkBytes = 1; chunkBytes <= 67; chunkBytes++) {
      const result = fixture(text, ['keep'], { chunkBytes });
      assert.deepEqual(result.value.keep, JSON.parse(text).keep);
      assert.equal(result.evidence.bytes, Buffer.byteLength(text));
      assert.equal(result.evidence.sha256, sha(text));
    }
  });
  check('primitives, null, missing keys, escaped keys and duplicate top-level keys retain exact semantics', () => {
    for (const text of ['{}', '{"keep":null}', '{"keep":-1.5e-2}', '{"keep":true}', '{"keep":"x"}',
      '{"ke\\u0065p":[1,2]}', '{"keep":1,"keep":{"last":true}}', '{"skip":1,"__proto__":{"x":1}}']) {
      const expected = JSON.parse(text), result = fixture(text, ['keep', '__proto__'], { chunkBytes: 1 });
      for (const key of ['keep', '__proto__']) assert.deepEqual(result.value[key], Object.hasOwn(expected, key) ? expected[key] : undefined);
      assert.equal(Object.getPrototypeOf(result.value), null);
    }
  });
  check('malformed skipped values cannot bypass the complete JSON grammar', () => {
    const invalid = ['{"skip":[1,]}', '{"skip":{"x":1,}}', '{"skip":01}', '{"skip":1.}', '{"skip":1e}',
      '{"skip":+1}', '{"skip":NaN}', '{"skip":tru}', '{"skip":nullfalse}', '{"skip":"\\x41"}',
      '{"skip":"\\u12x4"}', '{"skip":"raw\nline"}', '{"skip":[}', '{"skip" 1}', '{skip:1}',
      '{"skip":[] "keep":2}', '{"skip":1', '{"skip":"unterminated}', '{}true', '[]', 'null', '\ufeff{}'];
    for (const text of invalid) {
      if (!['[]', 'null'].includes(text)) assert.throws(() => JSON.parse(text));
      for (const chunkBytes of [1, 7, 65536]) assert.throws(() => fixture(text, ['keep'], { chunkBytes }), e => e.code === 'FILE_JSON_INVALID', text);
    }
  });
  check('invalid UTF-8, wrong size/hash and trailing bytes fail closed', () => {
    assert.throws(() => fixture(Buffer.from([123,34,120,34,58,34,255,34,125])), e => e.code === 'FILE_JSON_INVALID');
    assert.throws(() => fixture('{}', [], { expectedSha256: '0'.repeat(64) }), e => e.code === 'FILE_HASH_MISMATCH');
    assert.throws(() => fixture('{}', [], { expectedBytes: 3 }), e => e.code === 'FILE_SIZE_MISMATCH');
    assert.throws(() => fixture('{}x', []), e => e.code === 'FILE_JSON_INVALID');
  });
  check('depth, retained characters, key size and scalar bounds are explicit refusals', () => {
    assert.throws(() => fixture('{"skip":[[[]]]}', [], { maxDepth: 3 }), e => e.code === 'SELECTED_JSON_DEPTH_LIMIT');
    assert.throws(() => fixture('{"keep":"12345"}', ['keep'], { maxSelectedChars: 4 }), e => e.code === 'SELECTED_JSON_VALUE_LIMIT');
    assert.throws(() => fixture(`{"${'x'.repeat(17000)}":1}`), e => e.code === 'SELECTED_JSON_KEY_LIMIT');
    assert.throws(() => fixture(`{"skip":${'1'.repeat(5000)}}`), e => e.code === 'SELECTED_JSON_SCALAR_LIMIT');
  });
  check('deterministic mixed nested objects agree with JSON.parse selection', () => {
    let seed = 17;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const value = depth => depth > 3 ? `值😀${random()}\\\"` : [null, true, random() / 7, [value(depth + 1)], { [String(random())]: value(depth + 1) }][random() % 5];
    for (let i = 0; i < 80; i++) {
      const source = { ignored: value(0), keep: value(0), tail: value(0) };
      const result = fixture(JSON.stringify(source), ['keep'], { chunkBytes: 1 + random() % 4096 });
      assert.deepEqual(result.value.keep, JSON.parse(JSON.stringify(source.keep)));
    }
  });
  check('generation wrapper binds normalized paths, expected bytes and hash; caller limits cannot replace identity', () => {
    const { readGenerationSelectedObject, DataGenerationError } = require('../server/dataGenerationStore.cjs');
    const source = '{"keep":{"x":1},"ignored":[2,3]}';
    fs.writeFileSync(filename, source);
    const context = { generationDir: dir, manifest: { files: [{ path: 'fixture.json', bytes: Buffer.byteLength(source), sha256: sha(source) }] } };
    assert.deepEqual(readGenerationSelectedObject(context, 'fixture.json', { keys: ['keep'], filePath: 'not-used', expectedBytes: 999, expectedSha256: '0'.repeat(64) }).value.keep, { x: 1 });
    assert.throws(() => readGenerationSelectedObject(context, '../fixture.json', { keys: ['keep'] }), e => e instanceof DataGenerationError && e.code === 'UNSAFE_PATH');
    assert.throws(() => readGenerationSelectedObject(context, 'other.json', { keys: ['keep'] }), e => e.code === 'FILE_NOT_IN_MANIFEST');
    fs.writeFileSync(filename, source.replace('1', '9'));
    assert.throws(() => readGenerationSelectedObject(context, 'fixture.json', { keys: ['keep'] }), e => e instanceof DataGenerationError && e.code === 'FILE_HASH_MISMATCH');
  });
  check('a path replaced during streaming is rejected and the descriptor is closed', () => {
    const source = '{"keep":1,"ignored":[2,3]}';
    fs.writeFileSync(filename, source);
    const original = fs.readSync; let changed = false;
    fs.readSync = function(fd, ...args) {
      const n = original.call(fs, fd, ...args);
      if (!changed) { changed = true; fs.renameSync(filename, path.join(dir, 'replaced.json')); fs.writeFileSync(filename, source); }
      return n;
    };
    try {
      assert.throws(() => read({ filePath: filename, expectedBytes: source.length, expectedSha256: sha(source), keys: ['keep'], chunkBytes: 3 }), e => e.code === 'GENERATION_FILE_CHANGED');
    } finally { fs.readSync = original; }
  });
  if (process.env.VERIFY_SELECTED_JSON_SKIP_LARGE !== '1') check('440 MiB ignored plus 32 MiB retained content runs in a 128 MiB V8 heap', () => {
    const fd = fs.openSync(filename, 'w'), hash = crypto.createHash('sha256'); let bytes = 0;
    const write = data => { const b = Buffer.from(data); fs.writeSync(fd, b); hash.update(b); bytes += b.length; };
    try {
      write('{"ignored":"');
      const block = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 440; i++) write(block);
      write('","keep":{"x":"中😀","n":[1,true,null],"bulk":"');
      for (let i = 0; i < 32; i++) write(block);
      write('"},"updatedAt":"2026-09-07"}');
    } finally { fs.closeSync(fd); }
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--large-child', filename, String(bytes), hash.digest('hex')], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    largeEvidence = JSON.parse(child.stdout);
    assert.ok(largeEvidence.maxRssKiB < 320 * 1024, JSON.stringify(largeEvidence));
    assert.ok(largeEvidence.evidence.selectedChars < 33 * 1024 * 1024);
  });
  console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks, largeEvidence }, null, 2));
} finally {
  // Only this invocation's freshly generated test directory is disposable.
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('football-selected-json-')) fs.rmSync(resolved, { recursive: true, force: true });
}
