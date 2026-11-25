"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Module = require("node:module");
const { execFileSync, spawnSync } = require("node:child_process");
const partition = require("../server/referenceIntegrityPartition.cjs");
const originals = require("./fixtures/public-reference-unresolved-originals.json");
const store = require("../server/dataGenerationStore.cjs");
const bundle = require("../server/dataGenerationBundle.cjs");
const { buildStreamedPublicReferenceArchive } = require("../server/streamedPublicReferenceArchive.cjs");
const integrity = partition.buildReferenceIntegrity(originals);
const capturedAt = "2026-10-23T07:00:00.000Z";

function payloads() {
  return new Map([
    ["matches-current.json", []], ["matches-history.json", []],
    ["sync-meta.json", { sourceCycleId: "partition-test", updatedAt: capturedAt }],
    ["external-signals.json", {}], ["odds-history.json", { rows: [] }],
    ["prediction-snapshots.json", { version: 4, rows: [], publicReferenceDecisions: [],
      publicReferenceEvidence: [], publicReferenceIntegrity: integrity }],
    ["model-calibration.json", { version: "test", generatedAt: capturedAt }],
    [partition.FILE_NAME, integrity],
  ]);
}

function withGeneration(run, values = payloads()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-integrity-generation-"));
  try {
    const files = Object.fromEntries([...values].map(([name, value]) => [name, { bytes: JSON.stringify(value), rows: 0 }]));
    const committed = store.commitDataGeneration({ storeDir: root, sourceCycleId: "partition-test",
      files, coreFiles: bundle.CORE_FILES, committedAt: capturedAt });
    return run(committed.context, root);
  } finally {
    assert.equal(fs.realpathSync(root).toLowerCase(), path.resolve(root).toLowerCase());
    assert(path.basename(root).startsWith("football-integrity-generation-"));
    fs.rmSync(root, { recursive: true });
  }
}

test("new manifest makes unresolved originals core and streams both bound copies", () => withGeneration(context => {
  assert.equal(context.manifest.schemaVersion, 2);
  assert(context.manifest.coreFiles.includes(partition.FILE_NAME));
  assert.equal(bundle.validateGenerationBundle(context).ok, true);
  assert.equal(bundle.validateGenerationBundle(context, { includeSemanticHash: true }).semanticHash, bundle.bundleSemanticHash(payloads()));
  const archive = buildStreamedPublicReferenceArchive(context);
  try { assert.equal([...archive.rows()].length, 2); } finally { archive.close(); }
}));

test("r912 reader explicitly rejects the new generation rather than dropping originals", () => withGeneration((context, root) => {
  const filename = require.resolve("../server/dataGenerationStore.cjs");
  const old = new Module(filename + ".r912", module);
  old.filename = filename; old.paths = Module._nodeModulePaths(path.dirname(filename));
  old._compile(execFileSync("git", ["show", "aa498c37e3710c87c176636aedd257a87bce1b20:server/dataGenerationStore.cjs"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true,
  }), filename);
  assert.throws(() => old.exports.resolveGeneration({ storeDir: root, generationId: context.generationId }),
    error => error.code === "MANIFEST_INVALID");
}));

test("version four cannot omit either independently hashed copy", () => {
  const missingFile = payloads(); missingFile.delete(partition.FILE_NAME);
  assert.throws(() => bundle.validateBundlePayloads({ payloads: missingFile }), /SNAPSHOT_BINDING/);
  const missingEmbedded = payloads(); delete missingEmbedded.get("prediction-snapshots.json").publicReferenceIntegrity;
  assert.throws(() => bundle.validateBundlePayloads({ payloads: missingEmbedded }), /SNAPSHOT_BINDING/);
});

test("a changed historical member fails before generation acceptance", () => {
  const changed = payloads();
  changed.set(partition.FILE_NAME, { ...integrity, records: originals.slice(1) });
  withGeneration(context => assert.throws(() => bundle.validateGenerationBundle(context), /MEMBERSHIP/), changed);
});

test("unresolved records cannot leak back into the complete-pair archive", () => {
  const changed = payloads(); changed.get("prediction-snapshots.json").publicReferenceDecisions = [originals[0]];
  withGeneration(context => assert.throws(() => buildStreamedPublicReferenceArchive(context), /ACTIVE_OVERLAP/), changed);
});

test("PostgreSQL jsonb key ordering cannot mutate preserved original bytes", () => {
  const stored = partition.storedReferenceIntegrity(integrity);
  const reordered = { sha256: stored.sha256, originalJson: stored.originalJson, version: stored.version };
  assert.deepEqual(partition.validateStoredReferenceIntegrity(reordered), integrity);
  assert.throws(() => partition.validateStoredReferenceIntegrity({ ...stored, originalJson: stored.originalJson + " " }), /DATABASE_BYTES/);
});

test("diagnostic readers retain the exact partition and independently validate its sidecar", () => withGeneration(context => {
  const native = require("../scripts/postgresGenerationSource.cjs").readPostgresReferenceSnapshot(context);
  const mutable = require("../server/referencePairedBaseline.cjs").readReferenceSnapshotFile(path.join(context.generationDir, "prediction-snapshots.json"));
  assert.equal(native.version, 4);
  assert.equal(mutable.version, 4);
  assert.equal(JSON.stringify(native.publicReferenceIntegrity), JSON.stringify(integrity));
  assert.equal(JSON.stringify(mutable.publicReferenceIntegrity), JSON.stringify(integrity));
  fs.unlinkSync(path.join(context.generationDir, partition.FILE_NAME));
  assert.throws(() => require("../scripts/postgresGenerationSource.cjs").readPostgresReferenceSnapshot(context));
  assert.throws(() => require("../server/referencePairedBaseline.cjs").readReferenceSnapshotFile(path.join(context.generationDir, "prediction-snapshots.json")), /SNAPSHOT_BINDING/);
}));

test("legacy diagnostic readers still accept ledgers without a version or partition", () => {
  const legacy = payloads();
  legacy.delete(partition.FILE_NAME);
  legacy.set("prediction-snapshots.json", { rows: [], publicReferenceDecisions: [], publicReferenceEvidence: [] });
  withGeneration(context => {
    const native = require("../scripts/postgresGenerationSource.cjs").readPostgresReferenceSnapshot(context);
    const mutable = require("../server/referencePairedBaseline.cjs").readReferenceSnapshotFile(path.join(context.generationDir, "prediction-snapshots.json"));
    assert.equal(native.version, undefined);
    assert.equal(mutable.version, undefined);
    assert.deepEqual(native.publicReferenceDecisions, []);
    assert.deepEqual(mutable.publicReferenceEvidence, []);
  }, legacy);
});

test("SQLite export rejects partitioned originals before opening or creating a database", () => withGeneration((_context, root) => {
  const sqlitePath = path.join(root, "must-not-create.db");
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/exportDataStoreSqlite.cjs")], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30000,
    env: { ...process.env, SERVER_STORE_DIR: root, DATA_STORE_DIR: root,
      SQLITE_EXPORT_PUBLIC_DATA_DIR: path.join(root, "unused-public"), DATASTORE_SQLITE_PATH: sqlitePath,
      SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "0", SQLITE_EXPORT_ALLOW_REFERENCE_POLICY_UPGRADE: "0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REFERENCE_PARTITION_SQLITE_UNSUPPORTED/);
  assert.equal(fs.existsSync(sqlitePath), false);
  assert.equal(fs.existsSync(sqlitePath + "-wal"), false);
}));

test("frontend build and cloud artifact filtering never copy unresolved originals", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.resolve(__dirname, "../vite.config.ts"), "utf8");
  const start = source.indexOf("const largeStaticPayloads =");
  const end = source.indexOf("// https://vite.dev/config/", start);
  assert(start > 0 && end > start);
  const compiled = require("typescript").transpileModule(source.slice(start, end), {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2022 },
  }).outputText;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-integrity-static-"));
  try {
    const publicDir = path.join(root, "public"), distDir = path.join(root, "dist");
    fs.mkdirSync(path.join(publicDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(publicDir, "data", partition.FILE_NAME), JSON.stringify(integrity));
    fs.writeFileSync(path.join(publicDir, "data/runtime-config.json"), "{}");
    const context = vm.createContext({ publicDir, distDir, resolve: path.resolve, relative: path.relative, dirname: path.dirname,
      copyFileSync: fs.copyFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, readdirSync: fs.readdirSync,
      rmSync: fs.rmSync, statSync: fs.statSync });
    vm.runInContext(compiled + "\ncopyFilteredPublicAssets().closeBundle();stripLargeStaticPayloads().closeBundle();", context);
    assert.equal(fs.existsSync(path.join(distDir, "data", partition.FILE_NAME)), false);
    assert.equal(fs.existsSync(path.join(distDir, "data/runtime-config.json")), true);
    const cloud = fs.readFileSync(path.resolve(__dirname, "../scripts/pushCloudSync.cjs"), "utf8");
    const definition = cloud.match(/const disabledDistPayloads = (\[[\s\S]*?\]);/);
    assert(definition);
    assert(vm.runInNewContext(definition[1]).includes("data/" + partition.FILE_NAME));
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith("football-integrity-static-"));
    fs.rmSync(resolved, { recursive: true });
  }
});

test("a new complete source cannot drop a previously committed unresolved partition", () => withGeneration((_context, root) => {
  const publicDataDir = path.join(root, "public"); fs.mkdirSync(publicDataDir);
  const legacy = payloads(); legacy.delete(partition.FILE_NAME);
  legacy.set("prediction-snapshots.json", { version: 3, rows: [], publicReferenceDecisions: [], publicReferenceEvidence: [] });
  for (const [name, value] of legacy) fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(value));
  assert.throws(() => bundle.commitCurrentDataGeneration({ storeDir: root, publicDataDir }), /cannot drop unresolved/);
}));
