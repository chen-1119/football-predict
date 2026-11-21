'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { externalGenerationRow } = require('../scripts/postgresExternalGenerationRow.cjs');
const { fileJsonPayloadChunks } = require('../scripts/postgresFileJsonPayload.cjs');

function fixture(t, pieces) {
  const generationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-signals-'));
  t.after(() => fs.rmSync(generationDir, { recursive: true, force: true }));
  const file = path.join(generationDir, 'external-signals.json');
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'wx');
  try {
    for (const piece of pieces) {
      fs.writeFileSync(fd, piece);
      hash.update(piece);
    }
  } finally {
    fs.closeSync(fd);
  }
  const entry = { path: path.basename(file), bytes: fs.statSync(file).size, sha256: hash.digest('hex') };
  return { file, entry, context: { generationDir, manifest: { files: [entry] } } };
}

async function streamedDigest(payload) {
  const hash = createHash('sha256');
  for await (const chunk of fileJsonPayloadChunks(payload)) hash.update(chunk);
  return hash.digest('hex');
}

test('source fields and the full original UTF-8 file survive projection', async t => {
  const raw = ' { "source":"球队", "updatedAt":"2026-11-04T03:00:00.000Z", "evidence":"😀" }\n';
  const { context, entry } = fixture(t, [raw]);
  const row = externalGenerationRow(context);
  assert.equal(row.source, '球队');
  assert.equal(row.captured_at, '2026-11-04T03:00:00.000Z');
  assert.equal(await streamedDigest(row.payload), entry.sha256);
});

test('malformed unselected fields, invalid metadata, and stale manifests fail admission', t => {
  for (const raw of ['{"matches":[1,]}', '[]', '{"source":{}}']) {
    const { context } = fixture(t, [raw]);
    assert.throws(() => externalGenerationRow(context));
  }
  const { context, entry } = fixture(t, ['{}']);
  entry.sha256 = '0'.repeat(64);
  assert.throws(() => externalGenerationRow(context));
});

test('changing equal-length bytes after admission is detected by the writer', async t => {
  const { context, file } = fixture(t, ['{"n":1}']);
  const row = externalGenerationRow(context);
  fs.writeFileSync(file, '{"n":2}');
  await assert.rejects(streamedDigest(row.payload));
});

test('a source larger than 128 MiB is streamed in full', async t => {
  const chunk = 'x'.repeat(1024 * 1024);
  const { context, entry } = fixture(t, ['{"matches":{"evidence":"', ...Array(129).fill(chunk), '"}}']);
  assert.ok(entry.bytes > 128 * 1024 * 1024);
  assert.equal(await streamedDigest(externalGenerationRow(context).payload), entry.sha256);
});
