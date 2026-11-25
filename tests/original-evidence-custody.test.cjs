"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createOriginalEvidenceCustody, verifyOriginalEvidenceCustody } = require("../server/originalEvidenceCustody.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-original-custody-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destinationRoot = path.join(root, "custody");
  fs.mkdirSync(destinationRoot, { mode: 0o700 });
  const bytes = Buffer.from('{"original":"原件","missingCompanion":true}\n');
  const source = path.join(root, "current.json");
  fs.writeFileSync(source, bytes);
  return { root, bytes, options: { destinationRoot, runtimeSha256: "a".repeat(64),
    sources: [{ name: "current.json", path: source, bytes: bytes.length, sha256: sha(bytes) }] } };
}

test("preserves original bytes with an independently verified seal and no recovery authority", context => {
  const setup = fixture(context);
  const result = createOriginalEvidenceCustody(setup.options);
  assert.deepEqual(fs.readFileSync(path.join(result.directory, "current.json")), setup.bytes);
  assert.deepEqual(verifyOriginalEvidenceCustody(result.directory), result);
  assert.equal(result.manifest.databaseSnapshotIncluded, false);
  assert.equal(result.manifest.evidenceRecoveryGranted, false);
  assert.equal(result.manifest.collectionAdmissionGranted, false);
});

test("wrong expected hash never exposes a committed custody directory", context => {
  const setup = fixture(context);
  setup.options.sources[0].sha256 = "b".repeat(64);
  assert.throws(() => createOriginalEvidenceCustody(setup.options), /SOURCE_HASH/);
  const entries = fs.readdirSync(setup.options.destinationRoot);
  assert.ok(entries.length > 0 && entries.every(name => name.startsWith(".pending-")));
  assert.throws(() => verifyOriginalEvidenceCustody(path.join(setup.options.destinationRoot, entries[0])), /UNCOMMITTED/);
  assert.deepEqual(fs.readFileSync(setup.options.sources[0].path), setup.bytes);
});

test("tampered sealed body is rejected", context => {
  const setup = fixture(context);
  const result = createOriginalEvidenceCustody(setup.options);
  fs.writeFileSync(path.join(result.directory, "current.json"), Buffer.alloc(setup.bytes.length, 65));
  assert.throws(() => verifyOriginalEvidenceCustody(result.directory), /COPY_HASH/);
});

test("unlisted files invalidate a sealed custody directory", context => {
  const setup = fixture(context);
  const result = createOriginalEvidenceCustody(setup.options);
  fs.writeFileSync(path.join(result.directory, "unexpected.json"), "{}");
  assert.throws(() => verifyOriginalEvidenceCustody(result.directory), /MEMBERSHIP_INVALID/);
});

test("hard-linked source originals are rejected before copying", context => {
  const setup = fixture(context);
  fs.linkSync(setup.options.sources[0].path, path.join(setup.root, "alias.json"));
  assert.throws(() => createOriginalEvidenceCustody(setup.options), /UNSAFE_FILE/);
  assert.deepEqual(fs.readdirSync(setup.options.destinationRoot), []);
});

test("duplicate source names and parent traversal are rejected", context => {
  const setup = fixture(context);
  setup.options.sources.push({ ...setup.options.sources[0] });
  assert.throws(() => createOriginalEvidenceCustody(setup.options), /SOURCE_INVALID/);
  setup.options.sources.pop();
  setup.options.sources[0].name = "../current.json";
  assert.throws(() => createOriginalEvidenceCustody(setup.options), /SOURCE_INVALID/);
});

test("separate preservation does not overwrite an existing committed copy", context => {
  const setup = fixture(context);
  const first = createOriginalEvidenceCustody(setup.options);
  const manifest = fs.readFileSync(path.join(first.directory, "manifest.json"));
  try { createOriginalEvidenceCustody(setup.options); }
  catch (error) { assert.equal(error.code, "ORIGINAL_CUSTODY_DESTINATION_EXISTS"); }
  assert.deepEqual(fs.readFileSync(path.join(first.directory, "manifest.json")), manifest);
  assert.equal(verifyOriginalEvidenceCustody(first.directory).verified, true);
});

test("copies a multi-chunk original without changing its bytes", context => {
  const setup = fixture(context);
  const bytes = Buffer.from(JSON.stringify({ original: "x".repeat(3 * 1024 * 1024) }));
  fs.writeFileSync(setup.options.sources[0].path, bytes);
  setup.options.sources[0].bytes = bytes.length;
  setup.options.sources[0].sha256 = sha(bytes);
  const result = createOriginalEvidenceCustody(setup.options);
  assert.equal(sha(fs.readFileSync(path.join(result.directory, "current.json"))), sha(bytes));
});
