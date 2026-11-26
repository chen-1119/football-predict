"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const partition = require("../server/referenceIntegrityPartition.cjs");
const originals = require("./fixtures/public-reference-unresolved-originals.json");
const { fixture, trust } = require("../scripts/verifyPublicReferencePairs.cjs");
after(() => trust.cleanup());

test("retains every historical original beside a separately verified new pair", () => {
  const complete = fixture({ id: "991001" });
  const result = partition.partitionReferenceRecords([...originals, complete.record], [complete.entry]);
  assert.deepEqual(result.unresolved, originals);
  assert.deepEqual(result.complete, [{ record: complete.record, entry: complete.entry }]);
  assert.equal(result.historicalIntegrityAccepted, false);
  assert.equal(result.modelAdmissionGranted, false);
});

test("a new missing companion cannot enter the historical partition", () => {
  const complete = fixture({ id: "991002" });
  assert.throws(() => partition.partitionReferenceRecords([...originals, complete.record], []), /BINDING_MISSING/);
});

test("retention cannot silently remove one of the original unresolved members", () => {
  assert.throws(() => partition.partitionReferenceRecords(originals.slice(1), []), /PARTITION_MEMBERSHIP/);
});

test("changing a preserved record is rejected even if its old content hash remains", () => {
  const changed = structuredClone(originals);
  changed[0].prediction.odds = 99;
  assert.throws(() => partition.partitionReferenceRecords(changed, []), /RECORD_INVALID|ORIGINAL_CHANGED/);
});

test("duplicate records and orphan entries do not collapse into a valid partition", () => {
  assert.throws(() => partition.partitionReferenceRecords([...originals, originals[0]], []), /RECORD_INVALID/);
  const complete = fixture({ id: "991003" });
  assert.throws(() => partition.partitionReferenceRecords(originals, [complete.entry]), /ORPHAN_EVIDENCE/);
});

test("invalid evidence never downgrades a new record into the unresolved partition", () => {
  const complete = fixture({ id: "991004" });
  const entry = structuredClone(complete.entry);
  entry.evidence.probabilityModel.version = "changed";
  assert.throws(() => partition.partitionReferenceRecords([...originals, complete.record], [entry]), /BINDING_INVALID/);
});

test("the serialized partition binds exact original records and rejects forged summary fields", () => {
  const value = partition.buildReferenceIntegrity(originals);
  assert.deepEqual(partition.validateReferenceIntegrity(value), value);
  assert.throws(() => partition.validateReferenceIntegrity({ ...value, recoveredCompanions: 29 }), /PARTITION_CONTENT/);
  assert.throws(() => partition.validateReferenceIntegrity({ ...value, records: originals.slice(1) }), /PARTITION_MEMBERSHIP/);
});

test("caller-provided descriptors never grant a production writer context", () => {
  assert.throws(() => partition.originalRecordsForContext({ version: partition.VERSION, baselineHash: partition.baselineHash }), /UNTRUSTED_CONTEXT/);
  assert.throws(() => partition.assertOriginalInContext({ records: originals }, originals[0]), /UNTRUSTED_CONTEXT/);
});

test("protected originals retain every identity check across open, read and final path", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../server/referenceIntegrityPartition.cjs"), "utf8");
  const start = source.indexOf("function readProtected("), end = source.indexOf("\nfunction readPartitionInput(", start);
  assert(start >= 0 && end > start);
  const file = path.resolve("protected-original.json"), bytes = Buffer.from("{}");
  const evaluate = (changedStage, changedField) => {
    const original = { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4, nlink: 1, uid: 0, mode: 0o100440,
      isFile: () => true, isSymbolicLink: () => false };
    const stages = Array.from({ length: 4 }, () => ({ ...original }));
    if (changedStage !== undefined) stages[changedStage][changedField] += 1;
    let statCalls = 0, descriptorCalls = 0, closed = 0;
    const filesystem = {
      constants: fs.constants,
      lstatSync: target => target === file ? stages[statCalls++ === 0 ? 0 : 3]
        : { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40750 },
      openSync: () => 42,
      fstatSync: () => stages[++descriptorCalls],
      readFileSync: () => bytes,
      closeSync: () => { closed++; },
    };
    const readProtected = vm.runInNewContext("(" + source.slice(start, end) + ")", {
      fs: filesystem, path, fail: code => { throw new Error(code); },
    });
    try {
      if (changedStage === undefined) assert.equal(readProtected(file, 128), bytes);
      else assert.throws(() => readProtected(file, 128), /REFERENCE_PARTITION_CUSTODY_CHANGED/);
    } finally { assert.equal(closed, 1); }
  };
  evaluate();
  for (const stage of [1, 2, 3]) {
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]) evaluate(stage, field);
  }
});

test("root input installation requires one protected local football group before any write", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../server/referenceIntegrityPartition.cjs"), "utf8");
  const start = source.indexOf("function readLocalFootballGroup("), end = source.indexOf("\nfunction installReferenceIntegrityInputs(", start);
  const installEnd = source.indexOf("\nfunction originalRecordsForContext(", end);
  assert(start >= 0 && end > start && installEnd > end);
  const load = bytes => vm.runInNewContext("(" + source.slice(start, end) + ")", {
    TextDecoder,
    readProtected: (file, maximum) => { assert.equal(file, "/etc/group"); assert.equal(maximum, 1024 * 1024); return bytes; },
    fail: code => { throw new Error(code); },
  });
  assert.equal(load(Buffer.from("root:x:0:\nfootball:x:988:\n"))(), 988);
  const invalid = ["root:x:0:\n", "football:x:988:\nfootball:x:988:\n", "football:x:988:\nfootball:bad\n",
    "football:x:988", "football:x:988::", ...["0", "-1", "1.5", "+1", "01", "Infinity", "9007199254740992"]
      .map(group => "football:x:" + group + ":\n")];
  for (const text of invalid) assert.throws(() => load(Buffer.from(text))(), /REFERENCE_PARTITION_GROUP/);
  assert.throws(() => load(Buffer.from([0xff]))(), /encoded data/);
  let filesystemAccess = 0;
  const install = vm.runInNewContext("(" + source.slice(end, installEnd) + ")", {
    process: { platform: "linux", getuid: () => 0 }, path, ROOT: "/protected", baseline: { custodyManifestSha256: "original" },
    readPartitionInput: () => ({}), readLocalFootballGroup: () => { throw new Error("REFERENCE_PARTITION_GROUP"); },
    fs: new Proxy({}, { get: () => { filesystemAccess++; throw new Error("installation filesystem access before group validation"); } }),
  });
  assert.throws(() => install(), /REFERENCE_PARTITION_GROUP/);
  assert.equal(filesystemAccess, 0);
});
