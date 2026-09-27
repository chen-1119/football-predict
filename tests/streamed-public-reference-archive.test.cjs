"use strict";
const { test, after } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { buildStreamedPublicReferenceArchive: build } = require("../server/streamedPublicReferenceArchive.cjs");
const { buildPublicReferenceArchive, buildPublicReferenceIndex, SOURCE_ID, INDEX_ID, resolveIndexedPublicReferenceEvidence } = require("../server/publicReferenceArchive.cjs");
const { isFileJsonPayload, fileJsonPayloadChunks } = require("../scripts/postgresFileJsonPayload.cjs");
const { spoolGenerationRows } = require("../scripts/postgresGenerationSource.cjs");
const { fixture, trust, auditAt } = require("../scripts/verifyPublicReferencePairs.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-stream-reference-test-")); let sequence = 0;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const payload = fixtures => ({ updatedAt: auditAt, retentionDays: 31, rows: [],
  publicReferenceDecisions: fixtures.map(value => value.record), publicReferenceEvidence: fixtures.map(value => value.entry) });
function context(value) {
  const directory = path.join(root, String(sequence++)); fs.mkdirSync(directory);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  fs.writeFileSync(path.join(directory, "prediction-snapshots.json"), text);
  return { generationDir: directory, manifest: { files: [{ path: "prediction-snapshots.json", bytes: Buffer.byteLength(text), sha256: sha(text) }] } };
}
after(() => { trust.cleanup(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
test("streamed archive and every odd/even Merkle shard preserve old JSON bytes including evidence order and duplicate retention", async () => {
  for (const fixtures of [[], [fixture({ id: "888001" })], [fixture({ id: "888002" }), fixture({ id: "888003" }), fixture({ id: "888004" })]]) {
    const input = payload(fixtures); input.publicReferenceEvidence.reverse();
    if (fixtures.length) input.publicReferenceEvidence.push(structuredClone(input.publicReferenceEvidence[0]), { referenceHash: "a".repeat(64), evidence: { orphan: true } });
    const archive = buildPublicReferenceArchive(input), index = buildPublicReferenceIndex(archive);
    const actual = build(context(input), { tempDir: root, inlineBytes: 0 }); const scratch = actual.directory;
    try {
      const rows = [];
      for (const row of actual.rows()) {
        let text = row.payload;
        if (isFileJsonPayload(text)) { text = ""; for await (const piece of fileJsonPayloadChunks(row.payload)) text += piece; }
        rows.push({ id: row.id, payload: text });
      }
      assert.deepEqual(rows, [{ id: SOURCE_ID, payload: JSON.stringify(archive) }, { id: INDEX_ID, payload: JSON.stringify(index.manifest) }, ...index.shards.map(row => ({ id: row.id, payload: JSON.stringify(row.payload) }))]);
      assert.equal(actual.archiveSha256, sha(JSON.stringify(archive)));
      for (const shard of index.shards) assert.equal(resolveIndexedPublicReferenceEvidence(actual.manifest, JSON.parse(rows.find(row => row.id === shard.id).payload), shard.payload.record.contentHash).ok, true);
    } finally { actual.close(); }
    assert.equal(fs.existsSync(scratch), false);
  }
});
test("invalid trailing input/binding/missing evidence, bounded scratch, and duplicate records fail without leftover scratch", () => {
  const original = payload([fixture({ id: "888005" })]);
  const cases = [() => { const p = structuredClone(original); p.publicReferenceEvidence[0].evidence.probabilityModel.version = "tampered"; return p; },
    () => ({ ...original, publicReferenceEvidence: [] }), () => ({ ...original, publicReferenceDecisions: [original.publicReferenceDecisions[0], original.publicReferenceDecisions[0]] })];
  for (const make of cases) {
    const c = context(make()); const before = fs.readdirSync(root);
    assert.throws(() => build(c, { tempDir: root }), /BINDING_INVALID|BINDING_MISSING|RECORD_INVALID/);
    assert.deepEqual(fs.readdirSync(root), before);
  }
  for (const options of [{ maxArchiveBytes: 10 }, { maxItems: 1 }]) {
    const c = context(original), before = fs.readdirSync(root); assert.throws(() => build(c, { tempDir: root, ...options }), { code: "POSTGRES_REFERENCE_ARCHIVE_LIMIT" }); assert.deepEqual(fs.readdirSync(root), before);
  }
  const c = context(JSON.stringify(original).slice(0, -1) + ',"rows":[1,]}'), before = fs.readdirSync(root);
  assert.throws(() => build(c, { tempDir: root }), { code: "FILE_JSON_INVALID" }); assert.deepEqual(fs.readdirSync(root), before);
  assert.throws(() => build(context('{"publicReferenceEvidence":[],"publicReferenceEvidence":null}'), { tempDir: root }), { code: "FILE_JSON_INVALID" });
});
test("absent legacy reference arrays stay absent; row spooling retains the original tail without retaining reference objects", () => {
  const c = context({ rows: [{ id: "old" }, { id: "middle", unicode: "球队⚽" }, { id: "last" }], publicReferenceEvidence: [{ ignored: true }] });
  assert.equal(build(c, { tempDir: root }), null);
  const spool = spoolGenerationRows(c, "prediction-snapshots.json", 2, root), scratch = spool.directory;
  try {
    assert.deepEqual([...spool.rows()], [{ id: "middle", unicode: "球队⚽" }, { id: "last" }]);
    assert.deepEqual([...spool.rowsForSource("middle")], [{ id: "middle", unicode: "球队⚽" }]);
    const state = { id: "state", firstSeenAt: auditAt, payload: { original: true, direction: "X" } };
    assert.deepEqual(spool.read(spool.append(state)), state);
  } finally { spool.close(); }
  assert.equal(fs.existsSync(scratch), false);
  assert.throws(() => spoolGenerationRows(c, "prediction-snapshots.json", 2, root, true), /complete native archive row inventory/);
});
test("scratch initialization failures leave neither reference nor state directories", () => {
  const c = context(payload([fixture({ id: "888006" })]));
  for (const operation of ["chmodSync", "openSync"]) {
    const original = fs[operation], before = fs.readdirSync(root);
    fs[operation] = function (file, ...args) {
      const name = path.basename(String(file));
      if (name.startsWith("football-pg-") || ["items.jsonl", "states.json"].includes(name)) {
        const error = new Error("injected scratch initialization failure"); error.code = "ENOSPC"; throw error;
      }
      return original.call(fs, file, ...args);
    };
    try {
      assert.throws(() => build(c, { tempDir: root }), { code: "ENOSPC" });
      assert.deepEqual(fs.readdirSync(root), before);
      assert.throws(() => spoolGenerationRows(c, "prediction-snapshots.json", 2, root), { code: "ENOSPC" });
      assert.deepEqual(fs.readdirSync(root), before);
    } finally { fs[operation] = original; }
  }
});
test("more than 320 MiB of unique bound evidence emits full archive and all shards with a 256 MiB JS heap", () => {
  const directory = path.join(root, "large"); fs.mkdirSync(directory); const file = path.join(directory, "prediction-snapshots.json"), fd = fs.openSync(file, "wx");
  const records = [], evidenceHash = crypto.createHash("sha256").update("[");
  try {
    fs.writeSync(fd, '{"updatedAt":' + JSON.stringify(auditAt) + ',"retentionDays":31,"publicReferenceEvidence":[');
    for (let index = 0; index < 161; index++) {
      const value = fixture({ id: String(888100 + index), mutateSource: source => { source.probabilityModel.padding = "x".repeat(2 * 1024 * 1024); } });
      records.push(value.record); const encoded = (index ? "," : "") + JSON.stringify(value.entry);
      evidenceHash.update(encoded); fs.writeSync(fd, encoded);
    }
    evidenceHash.update("]"); fs.writeSync(fd, '],"publicReferenceDecisions":' + JSON.stringify(records) + ',"rows":[]}');
  } finally { fs.closeSync(fd); }
  const inputHash = crypto.createHash("sha256"), readFd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let size; while ((size = fs.readSync(readFd, buffer, 0, buffer.length, null))) inputHash.update(buffer.subarray(0, size)); } finally { fs.closeSync(readFd); }
  const bytes = fs.statSync(file).size; assert.ok(bytes > 320 * 1024 * 1024);
  const c = { generationDir: directory, manifest: { files: [{ path: "prediction-snapshots.json", bytes, sha256: inputHash.digest("hex") }] } }, contextPath = path.join(directory, "context.json"); fs.writeFileSync(contextPath, JSON.stringify(c));
  const program = `const fs=require('node:fs'),crypto=require('node:crypto');const {buildStreamedPublicReferenceArchive:build}=require(${JSON.stringify(require.resolve("../server/streamedPublicReferenceArchive.cjs"))});const {isFileJsonPayload,fileJsonPayloadChunks}=require(${JSON.stringify(require.resolve("../scripts/postgresFileJsonPayload.cjs"))});(async()=>{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8')),a=build(c,{tempDir:c.generationDir,inlineBytes:0});let shards=0,bytes=0;const h=crypto.createHash('sha256');try{for(const row of a.rows()){if(isFileJsonPayload(row.payload)){for await(const piece of fileJsonPayloadChunks(row.payload)){bytes+=Buffer.byteLength(piece);h.update(piece);}}else if(row.id.includes(':row:'))shards++;}process.stdout.write(JSON.stringify({rows:a.manifest.rowCount,shards,archiveContentHash:a.manifest.archiveContentHash,evidenceContentHash:a.manifest.evidenceContentHash,archiveSha:a.archiveSha256,readSha:h.digest('hex'),bytes,heap:process.memoryUsage().heapUsed,maxRssKiB:process.resourceUsage().maxRSS}));}finally{a.close();}})().catch(e=>{console.error(e);process.exitCode=1});`;
  const child = spawnSync(process.execPath, ["--max-old-space-size=256", "-e", program, contextPath], { encoding: "utf8", timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.rows, 161); assert.equal(result.shards, 161); assert.equal(result.archiveContentHash, sha(JSON.stringify(records))); assert.equal(result.evidenceContentHash, evidenceHash.digest("hex"));
  assert.equal(result.archiveSha, result.readSha); assert.ok(result.bytes > 320 * 1024 * 1024); assert.ok(result.heap < 256 * 1024 * 1024);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith("football-pg-reference-")), false);
});
