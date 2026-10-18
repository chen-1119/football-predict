"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const custody = require("../server/publicReferenceCompanionStore.cjs");
const { fixture, trust, auditAt } = require("../scripts/verifyPublicReferencePairs.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-original-pair-"));
const modulePath = require.resolve("../server/publicReferenceCompanionStore.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
let sequence = 0;
const directory = () => fs.mkdtempSync(path.join(root, "case-"));
const original = () => fixture({ id: String(891000 + sequence++) });
const current = f => ({ ...f.record, predictionMeta: { publicReferenceDecision: f.record } });
after(() => { trust.cleanup(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });

test("original pair survives JSON/restart and later model mutations without rebuilding evidence", () => {
  const store = directory(), f = original(), entry = JSON.stringify(f.entry);
  const receipt = custody.persistOriginalCompanion(store, f.record, f.entry);
  assert.equal(receipt.inserted, true);
  const pairFile = path.join(store, "public-reference-companions", f.record.contentHash, "pair.json");
  const before = fs.readFileSync(pairFile);
  f.match.probabilityModel = { changed: true };
  f.match.predictionMeta.featureSnapshot = { changed: true };
  const actual = custody.readOriginalCompanion(store, JSON.parse(JSON.stringify(f.record)));
  assert.equal(JSON.stringify(actual.entry), entry);
  assert.equal(custody.persistOriginalCompanion(store, f.record, f.entry).inserted, false);
  assert.deepEqual(fs.readFileSync(pairFile), before);
  assert.equal(receipt.durability, process.platform === "win32" ? "process-crash" : "directory-fsync");
});

test("invalid evidence, forged original record, absent companion and conflicting extras remain refused", () => {
  const store = directory(), f = original();
  const changed = structuredClone(f.entry); changed.evidence.probabilityModel.version = "current-model-is-not-the-original";
  assert.throws(() => custody.persistOriginalCompanion(store, f.record, changed), /BINDING_INVALID/);
  assert.throws(() => custody.persistOriginalCompanion(store, { ...f.record, decisionId: "new" }, f.entry), /BINDING_INVALID/);
  assert.equal(custody.readOriginalCompanion(store, f.record), null);
  assert.throws(() => custody.assertCurrentReferenceCompanions(store, [current(f)]), /BINDING_MISSING/);
  assert.throws(() => custody.persistCurrentReferenceCompanions(store, [current(f)], []), /BINDING_MISSING/);
  custody.persistOriginalCompanion(store, f.record, f.entry);
  assert.throws(() => custody.persistOriginalCompanion(store, f.record, { ...f.entry, different: true }), /PAIR_CONFLICT/);
  assert.throws(() => custody.readOriginalCompanion(store, { ...f.record, different: true }), /RECORD_CONFLICT/);
});

test("actual append boundary replays only previously durable originals after current commits before warehouse", () => {
  const { appendPredictionSnapshots } = require("../scripts/syncData.cjs");
  const store = directory(), publicDir = directory(), f = original();
  fs.mkdirSync(path.join(publicDir, "data"));
  const warehouse = path.join(publicDir, "data", "prediction-snapshots.json");
  const before = JSON.stringify({ rows: [], publicReferenceDecisions: [], publicReferenceEvidence: [] });
  fs.writeFileSync(warehouse, before);
  const serialized = JSON.parse(JSON.stringify(f.match));
  serialized.probabilityModel = { version: "later-current-must-not-reconstruct" };
  const args = { observationMatches: [], companionStoreDir: store };
  assert.throws(() => appendPredictionSnapshots(publicDir, [serialized], auditAt, args), /BINDING_MISSING/);
  custody.persistOriginalCompanion(store, f.record, f.entry);
  const payload = appendPredictionSnapshots(publicDir, [serialized], auditAt, args);
  assert.deepEqual(payload.publicReferenceDecisions, [f.record]);
  assert.deepEqual(payload.publicReferenceEvidence, [f.entry]);
  assert.equal(fs.readFileSync(warehouse, "utf8"), before);
  const pair = path.join(store, "public-reference-companions", f.record.contentHash, "pair.json");
  fs.appendFileSync(pair, " ");
  assert.throws(() => appendPredictionSnapshots(publicDir, [serialized], auditAt, args), /CUSTODY_BYTES_INVALID/);
  assert.equal(fs.readFileSync(warehouse, "utf8"), before);
});

test("changed/truncated bytes, symlinks and oversized sealed files fail without replacement", () => {
  for (const change of [file => fs.appendFileSync(file, " "), file => fs.truncateSync(file, 20),
    file => fs.truncateSync(file, 32 * 1024 * 1024 + 1)]) {
    const store = directory(), f = original(); custody.persistOriginalCompanion(store, f.record, f.entry);
    const file = path.join(store, "public-reference-companions", f.record.contentHash, "pair.json");
    change(file); const before = fs.statSync(file);
    assert.throws(() => custody.readOriginalCompanion(store, f.record), /CUSTODY/);
    assert.throws(() => custody.persistOriginalCompanion(store, f.record, f.entry), /CUSTODY/);
    assert.equal(fs.statSync(file).size, before.size);
  }
  const store = directory(), f = original(), target = directory();
  fs.symlinkSync(target, path.join(store, "public-reference-companions"), "junction");
  assert.throws(() => custody.persistOriginalCompanion(store, f.record, f.entry), /UNSAFE_PATH/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("disk failure retains pending originals and cannot admit a public current", () => {
  const store = directory(), f = original(), saved = fs.fsyncSync;
  fs.fsyncSync = () => { const error = new Error("injected ENOSPC"); error.code = "ENOSPC"; throw error; };
  try { assert.throws(() => custody.persistOriginalCompanion(store, f.record, f.entry), { code: "ENOSPC" }); }
  finally { fs.fsyncSync = saved; }
  assert.equal(custody.readOriginalCompanion(store, f.record), null);
  assert.throws(() => custody.assertCurrentReferenceCompanions(store, [current(f)]), /BINDING_MISSING/);
  // Linux can fail syncing the root before a stage is created; Windows fails
  // syncing pair.json. Neither case is a completed custody receipt.
  const files = fs.readdirSync(path.join(store, "public-reference-companions"));
  assert(files.every(name => name.startsWith(".pending-")));
});

test("actual killed writers before file sync, before rename, after rename and after public current never expose a pair prefix", async () => {
  for (const boundary of ["pair-sync", "seal-sync", "rename", "current"]) {
    const store = directory(), f = original(), input = path.join(store, "input.json");
    fs.writeFileSync(input, JSON.stringify({ record: f.record, entry: f.entry }));
    const program = `const fs=require('node:fs'),p=require('node:path');
      const input=JSON.parse(fs.readFileSync(process.argv[1]));const boundary=process.argv[2];
      const originalSync=fs.fsyncSync,originalRename=fs.renameSync;let fileSyncs=0;
      const stop=()=>{process.stdout.write('BOUNDARY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      fs.fsyncSync=function(fd){const s=fs.fstatSync(fd);const r=originalSync(fd);if(s.isFile()){fileSyncs++;if((boundary==='pair-sync'&&fileSyncs===1)||(boundary==='seal-sync'&&fileSyncs===2))stop();}return r;};
      fs.renameSync=function(a,b){const r=originalRename(a,b);if(boundary==='rename')stop();return r;};
      const c=require(${JSON.stringify(modulePath)});c.persistOriginalCompanion(p.dirname(process.argv[1]),input.record,input.entry);
      c.assertCurrentReferenceCompanions(p.dirname(process.argv[1]),[{...input.record,predictionMeta:{publicReferenceDecision:input.record}}]);
      fs.writeFileSync(p.join(p.dirname(process.argv[1]),'current.json'),JSON.stringify(input.record));stop();`;
    const child = spawn(process.execPath, ["-e", program, input, boundary], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const exited = once(child, "exit");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("boundary timeout: " + stderr)); }, 15000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", reject);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("writer exited before boundary: " + stderr)); });
    });
    child.kill("SIGKILL"); await exited;
    const pair = custody.readOriginalCompanion(store, f.record);
    if (["pair-sync", "seal-sync"].includes(boundary)) {
      assert.equal(pair, null);
      assert(fs.readdirSync(path.join(store, "public-reference-companions")).some(name => name.startsWith(".pending-")));
    } else assert.deepEqual(pair.entry, f.entry);
    assert.equal(fs.existsSync(path.join(store, "current.json")), boundary === "current");
    if (boundary === "current") assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, "current.json"))), f.record);
  }
});

function archiveContext(value) {
  const generationDir = directory(), text = typeof value === "string" ? value : JSON.stringify(value);
  fs.writeFileSync(path.join(generationDir, "prediction-snapshots.json"), text);
  return { generationDir, manifest: { files: [{ path: "prediction-snapshots.json", bytes: Buffer.byteLength(text), sha256: sha(text) }] } };
}
test("whole original archive is fully validated before any pair is imported; no admission from prefixes", () => {
  const f = original(), payload = { updatedAt: auditAt, rows: [], publicReferenceDecisions: [f.record], publicReferenceEvidence: [f.entry] };
  for (const value of [JSON.stringify(payload).slice(0, -1), JSON.stringify(payload) + "x",
    { ...payload, publicReferenceEvidence: [] }, { ...payload, publicReferenceDecisions: [f.record, f.record] }]) {
    const store = directory(); assert.throws(() => custody.importCompleteOriginalArchive(store, archiveContext(value)), /JSON|MISSING|RECORD_INVALID/);
    assert.deepEqual(fs.readdirSync(store), []);
  }
  const store = directory(), context = archiveContext(payload);
  assert.equal(custody.importCompleteOriginalArchive(store, context).references, 1);
  assert.deepEqual(custody.readOriginalCompanion(store, f.record).entry, f.entry);
  context.manifest.files[0].sha256 = "0".repeat(64);
  assert.throws(() => custody.importCompleteOriginalArchive(directory(), context), /hash mismatch/);
});

test("complete history larger than the fixed 128 MiB heap imports one original entry at a time", () => {
  const generationDir = directory(), store = directory(), records = [], file = path.join(generationDir, "prediction-snapshots.json");
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeSync(fd, '{"updatedAt":' + JSON.stringify(auditAt) + ',"publicReferenceEvidence":[');
    for (let index = 0; index < 68; index++) {
      const f = fixture({ id: String(895000 + index), mutateSource: source => { source.probabilityModel.padding = "x".repeat(2 * 1024 * 1024); } });
      records.push(f.record); fs.writeSync(fd, (index ? "," : "") + JSON.stringify(f.entry));
    }
    fs.writeSync(fd, '],"publicReferenceDecisions":' + JSON.stringify(records) + ',"rows":[]}');
  } finally { fs.closeSync(fd); }
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024), inputFd = fs.openSync(file, "r"); let n;
  try { while ((n = fs.readSync(inputFd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(inputFd); }
  const context = { generationDir, manifest: { files: [{ path: "prediction-snapshots.json", bytes: fs.statSync(file).size, sha256: hash.digest("hex") }] } };
  assert(context.manifest.files[0].bytes > 128 * 1024 * 1024);
  const contextFile = path.join(generationDir, "context.json"); fs.writeFileSync(contextFile, JSON.stringify(context));
  const program = `const fs=require('node:fs'),c=require(${JSON.stringify(modulePath)}),context=JSON.parse(fs.readFileSync(process.argv[1]));const r=c.importCompleteOriginalArchive(process.argv[2],context,{inlineBytes:0});process.stdout.write(JSON.stringify(r));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", program, contextFile, store], { encoding: "utf8", timeout: 180000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { references: records.length, sourceSha256: context.manifest.files[0].sha256 });
  for (const record of records) assert.equal(custody.readOriginalCompanion(store, record).entry.referenceHash, record.contentHash);
});
