"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const bundles = require("../server/dataGenerationBundle.cjs");
const streaming = require("../server/streamedJsonObjectArrays.cjs");

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "football-rows-semantic-"));
  const publicDataDir = path.join(directory, "public"), storeDir = path.join(directory, "store");
  fs.mkdirSync(publicDataDir);
  const payloads = new Map([
    ["matches-current.json", [{ id: "current" }]], ["matches-history.json", [{ id: "history" }]],
    ["sync-meta.json", { sourceCycleId: "semantic-test", updatedAt: "2030-01-01T00:00:00Z" }],
    ["external-signals.json", {}], ["odds-history.json", { rows: [] }],
    ["prediction-snapshots.json", { rows: [] }],
    ["model-calibration.json", { version: "fixture", generatedAt: "2030-01-01T00:00:00Z" }],
  ]);
  const write = () => { for (const [name, value] of payloads) fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(value)); };
  const commit = () => bundles.commitCurrentDataGeneration({ publicDataDir, storeDir });
  const inspect = (name = "prediction-snapshots.json", hasher = crypto.createHash("sha256")) => {
    const result = bundles.readMutableBundle({ publicDataDir }).inspectRowsObject(name, { semanticHasher: hasher });
    return { ...result, semanticHash: hasher.digest("hex") };
  };
  try { write(); return run({ directory, publicDataDir, storeDir, payloads, write, commit, inspect }); }
  finally {
    assert.equal(fs.realpathSync(directory).toLowerCase(), path.resolve(directory).toLowerCase());
    assert(path.basename(directory).startsWith("football-rows-semantic-"));
    fs.rmSync(directory, { recursive: true });
  }
}

test("mutable and committed rows hashes equal the original canonical writer for every field", () => fixture(context => {
  const raw = '{"10":[3,2,1],"2":{"updatedAt":"retain","b":-0,"a":1e2},"":"empty-key",'
    + '"__proto__":[{"constructor":"ordinary","__proto__":{"x":1}}],"rows":[{"z":2,"a":1,"a":3,"updatedAt":"retain"},null,[true,false]],'
    + '"unknown":{"deep":{"z":2,"a":"中文😀\\ud800"}},"unknownArray":[[],{},"\\u0061"],"updatedAt":{"ignored":true},"empty":[]}';
  context.payloads.set("prediction-snapshots.json", JSON.parse(raw));
  context.payloads.set("odds-history.json", { rows: [2, 1], "": [false, { updatedAt: "retain" }], extra: { "2": 2, "10": 10 } });
  context.write();
  fs.writeFileSync(path.join(context.publicDataDir, "prediction-snapshots.json"), raw);
  const expected = bundles.bundleSemanticHash(context.payloads), first = context.commit();
  assert.equal(first.semanticHash, expected);
  assert.equal(bundles.validateGenerationBundle(first.context, { includeSemanticHash: true }).semanticHash, expected);
  assert.equal(context.commit().semanticNoop, true);
  context.payloads.get("prediction-snapshots.json").updatedAt = "changed-but-omitted";
  context.write();
  assert.equal(context.commit().semanticNoop, true);
  context.payloads.get("prediction-snapshots.json").unknown.deep.updatedAt = "must-change-hash";
  context.write();
  const changed = context.commit();
  assert.equal(changed.semanticHash, bundles.bundleSemanticHash(context.payloads));
  assert.notEqual(changed.semanticHash, expected);
  assert.equal(changed.semanticNoop, false);
}));

test("arrays keep order, nested duplicate keys keep JSON.parse last-wins semantics", () => fixture(context => {
  const file = path.join(context.publicDataDir, "prediction-snapshots.json");
  const documents = ['{"rows":[{"x":0,"x":1},2],"unknown":[{"a":0,"a":2}]}',
    '{"rows":[{"x":1},2],"unknown":[{"a":2}]}', '{"rows":[2,{"x":1}],"unknown":[{"a":2}]}'];
  const hashes = documents.map(document => {
    context.payloads.set("prediction-snapshots.json", JSON.parse(document));
    fs.writeFileSync(file, document);
    const result = context.commit();
    assert.equal(result.semanticHash, bundles.bundleSemanticHash(context.payloads));
    return result.semanticHash;
  });
  assert.equal(hashes[0], hashes[1]); assert.notEqual(hashes[1], hashes[2]);
}));

for (const document of [
  "{}", '{"rows":{}}', '{"rows":null}', "[]", '{"rows":[],"rows":[]}',
  '{"rows":[],"unknown":1,"unknown":2}', '{"rows":[],"updatedAt":1,"updatedAt":2}',
  '{"rows":[1,]}', '{"rows":[],"tail":{"bad":}}', '{"rows":[]} trailing',
  '{"rows":[{"bad":"\\q"}]}', '{"rows":[],"tail":"\\u00Z0"}',
]) test("semantic streaming refuses malformed or ambiguous complete input: " + document, () => fixture(context => {
  fs.writeFileSync(path.join(context.publicDataDir, "prediction-snapshots.json"), document);
  assert.throws(context.inspect);
  assert.equal(fs.existsSync(path.join(context.storeDir, "data-generations", "current.json")), false);
}));

for (const document of ['{"rows":[1e400]}', '{"rows":[],"unknown":1e400}', '{"rows":[],"unknown":[{"number":-1e400}]}']) {
  test("semantic streaming preserves non-finite rejection: " + document, () => fixture(context => {
    fs.writeFileSync(path.join(context.publicDataDir, "prediction-snapshots.json"), document);
    assert.throws(context.inspect, error => error.code === "INVALID_CANONICAL_VALUE");
    context.payloads.set("prediction-snapshots.json", JSON.parse(document));
    assert.throws(() => bundles.bundleSemanticHash(context.payloads), error => error.code === "INVALID_CANONICAL_VALUE");
  }));
}

test("UTF-8 and escaped strings survive every chunk boundary and invalid UTF-8 is refused", () => fixture(context => {
  const file = path.join(context.publicDataDir, "prediction-snapshots.json");
  const value = { rows: [{ text: "中😀\\\"\n\ud800" }], "": ["空"], unknown: ["中文"] };
  const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  for (const chunkBytes of [1, 2, 3, 7, 64]) {
    const observed = [];
    const result = streaming.streamJsonObjectArrays(file, { keys: ["rows", "", "unknown"], inventoryFields: true,
      expectedBytes: bytes.length, expectedSha256: sha256, chunkBytes, onItem: (key, row) => observed.push([key, row]) });
    assert.deepEqual(observed, [["rows", value.rows[0]], ["", "空"], ["unknown", "中文"]]);
    assert.deepEqual(result.rootFields, [{ key: "rows", array: true }, { key: "", array: true }, { key: "unknown", array: true }]);
  }
  const invalid = Buffer.concat([Buffer.from('{"rows":[],"tail":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]);
  fs.writeFileSync(file, invalid);
  assert.throws(context.inspect, error => error.code === "FILE_JSON_INVALID");
}));

test("each complete pass binds the original bytes and detects between-pass replacement", () => {
  for (const mutation of ["hash", "bytes", "identity"]) fixture(context => {
    const original = streaming.streamJsonObjectArrays;
    const file = path.join(context.publicDataDir, "prediction-snapshots.json");
    fs.writeFileSync(file, '{"rows":[{"value":1}],"unknown":[0]}');
    let calls = 0;
    streaming.streamJsonObjectArrays = (...args) => {
      const result = original(...args);
      if (!calls++) {
        const source = fs.readFileSync(file);
        if (mutation === "hash") fs.writeFileSync(file, source.toString().replace('"value":1', '"value":2'));
        else if (mutation === "bytes") fs.appendFileSync(file, " ");
        else { fs.renameSync(file, file + ".before"); fs.writeFileSync(file, source); }
      }
      return result;
    };
    try { assert.throws(context.inspect, error => ["FILE_HASH_MISMATCH", "FILE_SIZE_MISMATCH", "GENERATION_FILE_CHANGED"].includes(error.code)); }
    finally { streaming.streamJsonObjectArrays = original; }
  });
});

test("metadata and field inventory remain bounded without skipping unknown values", () => fixture(context => {
  const file = path.join(context.publicDataDir, "prediction-snapshots.json");
  fs.writeFileSync(file, '{"rows":[],"unknown":"' + "x".repeat(16 * 1024 * 1024) + '"}');
  assert.throws(context.inspect, error => error.code === "SELECTED_JSON_VALUE_LIMIT");
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries([["rows", []], ...Array.from({ length: 4096 }, (_, index) => ["key" + index, index])])));
  assert.throws(context.inspect, error => error.code === "STREAM_JSON_FIELDS_LIMIT");
}));

function countActiveArrayPasses(generationDir, run) {
  const original = streaming.streamJsonObjectArrays;
  let passes = 0;
  streaming.streamJsonObjectArrays = (file, ...args) => {
    if (path.dirname(file) === generationDir) passes++;
    return original(file, ...args);
  };
  try { return { result: run(), passes }; }
  finally { streaming.streamJsonObjectArrays = original; }
}

test("schema-two core-set change skips the old semantic scan even below the 64 MiB size delta", () => fixture(context => {
  context.payloads.set("prediction-snapshots.json", { rows: [{ text: "x".repeat(2 * 1024 * 1024) }] });
  context.write();
  const first = context.commit();
  const partition = require("../server/referenceIntegrityPartition.cjs");
  const integrity = partition.buildReferenceIntegrity(require("./fixtures/public-reference-unresolved-originals.json"));
  Object.assign(context.payloads.get("prediction-snapshots.json"), { version: 4, publicReferenceIntegrity: integrity });
  context.payloads.set(partition.FILE_NAME, integrity); context.write();
  const difference = fs.statSync(path.join(context.publicDataDir, "prediction-snapshots.json")).size
    - first.context.manifest.files.find(entry => entry.path === "prediction-snapshots.json").bytes;
  assert(difference > 0 && difference < 64 * 1024 * 1024);
  const observed = countActiveArrayPasses(first.context.generationDir, context.commit);
  assert.equal(observed.passes, 0); assert.equal(observed.result.semanticNoop, false);
  assert.equal(observed.result.context.manifest.schemaVersion, 2);
  assert.equal(observed.result.semanticHash, bundles.bundleSemanticHash(context.payloads));
}));

test("a changed small core proves inequality without revisiting an unknown changed large ledger", () => fixture(context => {
  context.payloads.set("prediction-snapshots.json", { rows: [{ text: "x".repeat(2 * 1024 * 1024) }], updatedAt: "before" });
  context.write(); const first = context.commit();
  context.payloads.get("prediction-snapshots.json").updatedAt = "later!";
  context.payloads.set("external-signals.json", { matches: { changed: true } }); context.write();
  const observed = countActiveArrayPasses(first.context.generationDir, context.commit);
  assert.equal(observed.passes, 0); assert.equal(observed.result.semanticNoop, false);
  assert.equal(observed.result.semanticHash, bundles.bundleSemanticHash(context.payloads));
}));

test("raw-equal large files plus canonical-equal small files reuse the fully validated source evidence", () => fixture(context => {
  context.payloads.set("prediction-snapshots.json", { rows: [{ text: "x".repeat(2 * 1024 * 1024) }] });
  context.write(); const first = context.commit();
  context.payloads.get("sync-meta.json").sourceCycleId = "next-cycle";
  context.payloads.get("sync-meta.json").updatedAt = "2030-01-01T00:01:00Z";
  context.payloads.get("odds-history.json").updatedAt = "only-volatile-change";
  context.write();
  const observed = countActiveArrayPasses(first.context.generationDir, context.commit);
  assert.equal(observed.result.semanticNoop, true);
  assert.equal(observed.result.semanticHash, first.semanticHash);
  assert.equal(observed.result.pointer.generationId, first.pointer.generationId);
  assert.equal(observed.result.activeSourceCycleId, "semantic-test");
  assert.equal(observed.result.requestedSourceCycleId, "next-cycle");
  assert.equal(observed.passes, 3);
}));

for (const changedMeaning of [false, true]) test("unknown large differences retain the full active semantic scan: " + changedMeaning, () => fixture(context => {
  context.payloads.set("prediction-snapshots.json", { rows: [{ text: "x".repeat(2 * 1024 * 1024) }], updatedAt: "before" });
  context.write(); const first = context.commit();
  if (changedMeaning) context.payloads.get("prediction-snapshots.json").rows[0].text = "y".repeat(2 * 1024 * 1024);
  else context.payloads.get("prediction-snapshots.json").updatedAt = "later!";
  context.write();
  const observed = countActiveArrayPasses(first.context.generationDir, context.commit);
  assert(observed.passes >= 4);
  assert.equal(observed.result.semanticNoop, !changedMeaning);
  assert.equal(observed.result.semanticHash, bundles.bundleSemanticHash(context.payloads));
}));

for (const changedCore of [false, true]) test("active byte tampering still fails before a comparison shortcut: " + changedCore, () => fixture(context => {
  const first = context.commit();
  if (changedCore) { context.payloads.set("external-signals.json", { changed: true }); context.write(); }
  fs.writeFileSync(path.join(first.context.generationDir, "odds-history.json"), '{"rows":[0]}');
  assert.throws(context.commit, error => ["FILE_HASH_MISMATCH", "FILE_SIZE_MISMATCH"].includes(error.code));
}));

for (const invalid of ["volatile-clock", "optional-kind"]) test("proved-equal core bytes cannot hide invalid active metadata or optional files: " + invalid, () => fixture(context => {
  const store = require("../server/dataGenerationStore.cjs");
  const values = new Map(context.payloads);
  if (invalid === "volatile-clock") values.set("sync-meta.json", { sourceCycleId: "semantic-test", updatedAt: "invalid" });
  else values.set("model-evaluation.json", []);
  store.commitDataGeneration({ storeDir: context.storeDir, sourceCycleId: "semantic-test", coreFiles: bundles.CORE_FILES,
    files: Object.fromEntries([...values].map(([name, value]) => [name, { bytes: JSON.stringify(value), rows: 0 }])) });
  assert.throws(context.commit, error => error.code === "GENERATION_SEMANTIC_INVALID");
}));

test("a cached large-file inspection cannot hide active tampering after its initial full byte validation", () => fixture(context => {
  context.payloads.set("prediction-snapshots.json", { rows: [{ text: "x".repeat(2 * 1024 * 1024) }] });
  context.write(); const first = context.commit();
  const ledger = path.join(first.context.generationDir, "prediction-snapshots.json");
  const originalBytes = fs.readFileSync(ledger, "utf8"), originalRead = fs.readFileSync;
  let changed = false;
  fs.readFileSync = (file, ...args) => {
    const result = originalRead(file, ...args);
    if (!changed && file === path.join(first.context.generationDir, "sync-meta.json")) {
      changed = true;
      fs.writeFileSync(ledger, originalBytes.replace("xxx", "yyy"));
    }
    return result;
  };
  try { assert.throws(context.commit, error => error.code === "FILE_HASH_MISMATCH"); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(changed, true);
}));

test("over one GiB mutable commit and active semantic equality both fit a 96 MiB child heap", { timeout: 240000 }, () => fixture(context => {
  const row = { z: "中文😀", a: "x".repeat(1024 * 1024) }, count = 1025;
  context.payloads.set("prediction-snapshots.json", { rows: Array(count).fill(row), unknown: { updatedAt: "retained" } });
  const expected = bundles.bundleSemanticHash(context.payloads);
  const file = path.join(context.publicDataDir, "prediction-snapshots.json"), fd = fs.openSync(file, "w");
  const serialized = JSON.stringify(row);
  try {
    fs.writeSync(fd, '{"unknown":{"updatedAt":"retained"},"rows":[');
    for (let index = 0; index < count; index++) fs.writeSync(fd, (index ? "," : "") + serialized);
    fs.writeSync(fd, "],\"updatedAt\":\"ignored\"}");
  } finally { fs.closeSync(fd); }
  assert(fs.statSync(file).size > 1024 ** 3);
  const code = `const bundles = require(${JSON.stringify(require.resolve("../server/dataGenerationBundle.cjs"))});
    const args = ${JSON.stringify({ publicDataDir: context.publicDataDir, storeDir: context.storeDir })};
    const first = bundles.commitCurrentDataGeneration(args);
    const second = bundles.commitCurrentDataGeneration(args);
    process.stdout.write(JSON.stringify({ first: first.semanticHash, second: second.semanticHash,
      rows: first.validation.predictionRows, noop: second.semanticNoop, maxRssKiB: process.resourceUsage().maxRSS }));`;
  const child = spawnSync(process.execPath, ["--max-old-space-size=96", "-e", code], {
    encoding: "utf8", timeout: 220000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout);
  assert.equal(result.first, expected); assert.equal(result.second, expected);
  assert.equal(result.rows, count); assert.equal(result.noop, true);
  process.stdout.write(JSON.stringify({ fixtureBytes: fs.statSync(file).size, heapMiB: 96, ...result }) + "\n");
}));
