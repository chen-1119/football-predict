"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), Module = require("node:module"), acorn = require("acorn");
const childRegistryPath = process.argv[2] === "--bounded-child" ? path.join(process.argv[3], "trust.json") : null;
let sync;
if (childRegistryPath) {
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH = childRegistryPath;
  sync = require("../scripts/syncData.cjs");
}
const bounded = require("../server/boundedPredictionSnapshots.cjs");
const baseline = require("./fixtures/prediction-snapshot-original-functions.json");
const { buildReferencePerformanceWithPairs } = require("../server/referencePairedBaseline.cjs");
const { fixture, trust, auditAt } = require("../scripts/verifyPublicReferencePairs.cjs");
if (childRegistryPath) process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH = childRegistryPath;
sync ||= require("../scripts/syncData.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.parse(JSON.stringify(value));
function originalModule() {
  assert.equal(sha(JSON.stringify(baseline.functions)), "741abbc1f696ee400d69163325d7d74e67ea63de41bdb17191014f8bf407897e");
  let source = fs.readFileSync(require.resolve("../scripts/syncData.cjs"), "utf8");
  const replacements = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" }).body
    .filter(node => node.type === "FunctionDeclaration" && baseline.functions[node.id.name]).sort((a, b) => b.start - a.start);
  for (const node of replacements) source = source.slice(0, node.start) + baseline.functions[node.id.name] + source.slice(node.end);
  const filename = path.join(path.dirname(require.resolve("../scripts/syncData.cjs")), "snapshot-original-oracle.cjs");
  const oracle = new Module(filename, module); oracle.filename = filename; oracle.paths = Module._nodeModulePaths(path.dirname(filename));
  oracle._compile(source, filename);
  return oracle.exports;
}
const oracle = originalModule();
let registry = trust.registry;
const written = new WeakMap();
function equalPipelines(actual, expected) {
  if (actual.fileHash !== expected.fileHash) {
    const left = fs.readFileSync(written.get(actual), "utf8"), right = fs.readFileSync(written.get(expected), "utf8");
    let at = 0; while (at < left.length && left[at] === right[at]) at++;
    console.log(JSON.stringify({ firstByteDifference: at, actual: left.slice(Math.max(0, at - 90), at + 180), expected: right.slice(Math.max(0, at - 90), at + 180) }));
    assert.deepEqual(JSON.parse(left), JSON.parse(right), "serialized values differ");
  }
  assert.deepEqual(actual, expected);
}
function hashFile(file) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), b = Buffer.allocUnsafe(65536);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function row(i, extra = {}) {
  const sourceMatchId = String(900000 + i % 64), at = new Date(Date.parse(auditAt) - (1000 + i % 19) * 60000).toISOString();
  return { sourceMatchId, phase: ["baseline", "mid", "late"][i % 3], signature: `signature-${i}`, featureSnapshotHash: `feature-${i}`,
    firstSeenAt: at, capturedAt: at, lastSeenAt: auditAt,
    featureSnapshot: { hash: `feature-${i}`, sourceMatchId, capturedAt: at }, best: { tipCode: "X", odds: 3.4 }, ...extra };
}
function sourceFile(directory, payload) {
  fs.mkdirSync(path.join(directory, "data"), { recursive: true });
  const file = path.join(directory, "data", "prediction-snapshots.json");
  fs.writeFileSync(file, JSON.stringify(payload)); return file;
}
function pipeline(api, directory, matches, options, output) {
  const payload = api.appendPredictionSnapshots(directory, matches, auditAt, options);
  try {
    let enriched = api.attachPredictionSnapshotSummary(matches, payload, auditAt);
    enriched = api.attachArchivedPreMatchPredictions(enriched, payload, null, auditAt);
    const reviewed = api.attachPostMatchReviews(enriched, auditAt, payload);
    const provisional = api.buildProvisionalResultReviews(reviewed.matches, payload, null, auditAt);
    const performance = buildReferencePerformanceWithPairs({ matches: reviewed.matches, snapshotPayload: payload, trustRegistry: registry, generatedAt: auditAt });
    api.writeJson(output, payload);
    assert.equal(api.writeJson(output, payload), false);
    const result = { fileHash: hashFile(output), rows: payload.rows.length, summary: payload.summary,
      derivedHash: sha(JSON.stringify({ reviewed, provisional, performance })) };
    written.set(result, output); return result;
  } finally { bounded.closePayload(payload); }
}

if (process.argv[2] === "--bounded-child") {
  try {
    const directory = process.argv[3], matches = JSON.parse(fs.readFileSync(path.join(directory, "matches.json")));
    process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH = path.join(directory, "trust.json");
    registry = JSON.parse(fs.readFileSync(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH));
    const output = path.join(directory, "child", "prediction-snapshots.json");
    const result = pipeline(sync, directory, matches, { observationMatches: [], boundedHistory: true }, output);
    console.log(JSON.stringify({ ...result, heapLimitMiB: 128, maxRssKiB: process.resourceUsage().maxRSS }));
  } finally { trust.cleanup(); }
} else {
  const { test, after } = require("node:test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-bounded-sync-tests-"));
  const directory = () => fs.mkdtempSync(path.join(root, "case-"));
  const output = dir => path.join(dir, "out", "prediction-snapshots.json");
  after(() => { trust.cleanup(); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true }); });

  test("original merge, last-duplicate Map order, stable ties, per-match and global retention keep byte-identical output", () => {
    const dir = directory(), rows = Array.from({ length: 6250 }, (_, i) => row(i, {
      sourceMatchId: String(910000 + i % 1100), firstSeenAt: i % 7 === 0 ? "invalid" : "2026-09-07T01:00:00.000Z",
      arbitrary: { chinese: "球队😀", null: null, negativeZero: -0 },
    }));
    rows.push({ ...rows[2], replacement: "last duplicate keeps original insertion position" });
    rows.push(row(88888, { lastSeenAt: "2024-01-01T00:00:00Z" }), null, { sourceMatchId: "", signature: "bad" });
    sourceFile(dir, { rows, observations: [{ old: true }], updatedAt: "2026-09-06T00:00:00Z" });
    const expected = pipeline(oracle, dir, [], { observationMatches: [] }, output(directory()));
    const actual = pipeline(sync, dir, [], { observationMatches: [], boundedHistory: true }, output(directory()));
    equalPipelines(actual, expected); assert.equal(actual.rows, 5000);
  });

  test("real current revisions, frozen publication clocks and exact prospective ties match the original algorithm", () => {
    const dir = directory(), f = fixture({ id: "900000" });
    const current = json(f.match), prospective = json(f.match);
    current.status = "SCHEDULED"; prospective.status = "SCHEDULED";
    prospective.probabilityModel = { ...prospective.probabilityModel, version: "prospective" };
    prospective.predictionMeta.featureSnapshot.hash = "separate-prospective-feature";
    const old = sync.predictionSnapshotRow(current, auditAt);
    assert.ok(old); old.best.livePublicationEvidence = { frozen: true }; old.best.odds = 7.7;
    sourceFile(dir, { rows: [old, { ...old, featureSnapshotHash: "same-clock-conflicting-public-row" }],
      publicReferenceDecisions: [f.record], publicReferenceEvidence: [f.entry] });
    const args = { observationMatches: [prospective] };
    equalPipelines(pipeline(sync, dir, [current], { ...args, boundedHistory: true }, output(directory())),
      pipeline(oracle, dir, [current], args, output(directory())));
  });

  test("all original reference revisions, duplicate evidence order, settled duplicates and paired totals remain exact", () => {
    const dir = directory(), fixtures = [fixture({ id: "900000" }), fixture({ id: "900001", pool: "HHAD", scores: [2, 1] })];
    sourceFile(dir, { rows: [row(0), row(1)], publicReferenceDecisions: fixtures.map(f => f.record),
      publicReferenceEvidence: [fixtures[1].entry, fixtures[0].entry, fixtures[1].entry] });
    const matches = fixtures.map(f => json(f.match)); matches.push(json(matches[0]));
    equalPipelines(pipeline(sync, dir, matches, { observationMatches: [], boundedHistory: true }, output(directory())),
      pipeline(oracle, dir, matches, { observationMatches: [] }, output(directory())));
  });

  test("incomplete, trailing, malformed UTF8, duplicate fields and wrong-shaped sources never admit a prefix", () => {
    for (const body of [Buffer.from('{"rows":[]'), Buffer.from('{"rows":[]} trailing'), Buffer.from('{"rows":[],"rows":[]}'),
      Buffer.from('{"rows":[],"publicReferenceEvidence":null}'), Buffer.from('{"observations":[]}'),
      Buffer.concat([Buffer.from('{"rows":[],"extra":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])]) {
      const dir = directory(), file = sourceFile(dir, { rows: [] }); fs.writeFileSync(file, body);
      assert.throws(() => sync.appendPredictionSnapshots(dir, [], auditAt, { boundedHistory: true }), /refusing to replace history/);
      assert.deepEqual(fs.readFileSync(file), body);
    }
  });

  test("missing or conflicting unrelated original evidence stays closed; only a durable exact original can fill a current gap", () => {
    const dir = directory(), store = directory(), f = fixture({ id: "900001" }), g = fixture({ id: "900002" });
    const current = json(f.match); current.probabilityModel = { changed: "not-original" };
    sourceFile(dir, { rows: [], publicReferenceDecisions: [f.record, g.record], publicReferenceEvidence: [g.entry] });
    const args = { observationMatches: [], boundedHistory: true, companionStoreDir: store };
    assert.throws(() => sync.appendPredictionSnapshots(dir, [current], auditAt, args), /BINDING_MISSING/);
    require("../server/publicReferenceCompanionStore.cjs").persistOriginalCompanion(store, f.record, f.entry);
    const payload = sync.appendPredictionSnapshots(dir, [current], auditAt, args);
    try { assert.deepEqual([...payload.publicReferenceEvidence], [g.entry, f.entry]); }
    finally { bounded.closePayload(payload); }
    const changed = { ...g.entry, unboundExtra: true };
    sourceFile(dir, { rows: [], publicReferenceDecisions: [f.record, g.record], publicReferenceEvidence: [g.entry, changed] });
    assert.throws(() => sync.appendPredictionSnapshots(dir, [current], auditAt, args), /BINDING_CONFLICT/);
    sourceFile(dir, { rows: [], publicReferenceDecisions: [g.record], publicReferenceEvidence: [] });
    assert.throws(() => sync.appendPredictionSnapshots(dir, [], auditAt, args), /BINDING_MISSING/);
  });

  test("private scratch write failure and later changed bytes cannot replace original source or completed output", () => {
    const dir = directory(), file = sourceFile(dir, { rows: [row(1)] }), prior = fs.readFileSync(file);
    const write = fs.writeSync, open = fs.openSync;
    let spoolFd, spoolPath;
    fs.openSync = function(target, ...args) {
      const result = open.call(this, target, ...args);
      if (path.basename(String(target)) === "items.bin") { spoolFd = result; spoolPath = target; }
      return result;
    };
    fs.writeSync = function(fd, buffer, ...args) {
      if (fd === spoolFd) throw new Error("synthetic scratch disk failure");
      return write.call(this, fd, buffer, ...args);
    };
    try { assert.throws(() => sync.appendPredictionSnapshots(dir, [], auditAt, { boundedHistory: true }), /scratch disk failure/); }
    finally { fs.writeSync = write; }
    assert.deepEqual(fs.readFileSync(file), prior);
    let payload;
    try { payload = sync.appendPredictionSnapshots(dir, [], auditAt, { boundedHistory: true }); }
    finally { fs.openSync = open; }
    const target = output(directory()); fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, "previous-complete-output\n");
    const damagedFd = fs.openSync(spoolPath, "r+");
    try { fs.writeSync(damagedFd, Buffer.from([0]), 0, 1, 0); } finally { fs.closeSync(damagedFd); }
    try {
      assert.throws(() => sync.writeJson(target, payload), /SPOOL_HASH/);
      assert.equal(fs.readFileSync(target, "utf8"), "previous-complete-output\n");
    } finally { bounded.closePayload(payload); }
    assert.throws(() => sync.writeJson(output(directory()), payload), /WORKSPACE_CLOSED/);
    assert.deepEqual(fs.readFileSync(file), prior);
  });

  test("private same-process spool preserves undefined keys, key order, holes and JSON output semantics", () => {
    const dir = directory(), workspace = bounded.openWorkspace(dir, { cutoff: 0, rowMetadata: () => ({}), acceptHistoryRow: () => {} });
    const array = new Array(3); array[0] = undefined; array[2] = Infinity;
    const value = { before: undefined, middle: 3, after: NaN, zero: -0, array };
    try {
      workspace.rowMap.set("fixture", value);
      const actual = workspace.rowMap.get("fixture");
      assert.deepEqual(actual, value); assert.deepEqual(Object.keys(actual), Object.keys(value));
      assert.equal(JSON.stringify(actual), JSON.stringify(value));
    } finally { workspace.close(); }
  });

  test("a complete graph larger than 256 MiB runs real append, all consumers, paired audit and exact serialization at fixed 128 MiB heap", () => {
    const dir = directory(), file = sourceFile(dir, { rows: [] }), matches = [], fd = fs.openSync(file, "w");
    const write = text => { const bytes = Buffer.from(text); let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); };
    try {
      write('{"updatedAt":"2026-09-07T01:00:01.000Z","rows":[');
      for (let i = 0; i < 264; i++) write((i ? ',' : '') + JSON.stringify(row(i, { padding: "row-原始😀".repeat(50000) })));
      write('],"publicReferenceDecisions":[');
      for (let i = 0; i < 64; i++) {
        const f = fixture({ id: String(900000 + i), mutateSource: match => { match.probabilityModel.padding = "original-evidence-😀".repeat(90000); } });
        write((i ? ',' : '') + JSON.stringify(f.record));
        const match = json(f.match); delete match.probabilityModel;
        match.predictionMeta.lockedAt = "2026-09-07T11:55:00Z"; match.predictionMeta.snapshot = { latestSignature: "frozen" };
        matches.push(match);
      }
      write('],"publicReferenceEvidence":[');
      for (let i = 0; i < 64; i++) {
        const f = fixture({ id: String(900000 + i), mutateSource: match => { match.probabilityModel.padding = "original-evidence-😀".repeat(90000); } });
        write((i ? ',' : '') + JSON.stringify(f.entry));
      }
      write(']}');
    } finally { fs.closeSync(fd); }
    assert.ok(fs.statSync(file).size > 256 * 1024 ** 2, String(fs.statSync(file).size));
    fs.writeFileSync(path.join(dir, "matches.json"), JSON.stringify(matches));
    fs.writeFileSync(path.join(dir, "trust.json"), JSON.stringify(registry));
    const inputHash = hashFile(file);
    const expected = pipeline(oracle, dir, matches, { observationMatches: [] }, output(directory()));
    const child = require("node:child_process").spawnSync(process.execPath, ["--max-old-space-size=128", __filename, "--bounded-child", dir],
      { encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const actual = JSON.parse(child.stdout); assert.equal(actual.heapLimitMiB, 128);
    delete actual.heapLimitMiB; delete actual.maxRssKiB; assert.deepEqual(actual, expected);
    assert.equal(hashFile(file), inputHash);
  });
}
