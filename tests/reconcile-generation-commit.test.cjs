"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { reconcileFastResultGeneration } = require("../scripts/reconcileFastResultGeneration.cjs");

const inputs = {
  "matches-current.json": "[ ]",
  "matches-history.json": "[ ]",
  "post-match-reviews.json": '{"rows": []}',
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "football-generation-commit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(inputs)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const meta = path.join(dir, "sync-meta.json");
  const run = () => reconcileFastResultGeneration({
    dataDir: dir,
    quarantinePath: path.join(dir, "quarantine.json"),
    nativeSource: { receipt: { revision: 3 }, resolution: { finals: [], recoveryRows: [] } },
  });
  const verifyInputs = () => {
    for (const [name, content] of Object.entries(inputs)) {
      assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), content);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), [...Object.keys(inputs), "sync-meta.json"].sort());
  };
  return { meta, run, verifyInputs };
}

for (const [name, metadata, expectedCode] of [
  ["receipt advanced", { fastResultRevision: 4 }, "FAST_RESULT_GENERATION_RECEIPT_ADVANCED"],
  ["another writer committed the same revision", { fastResultGenerationRevision: 3 }, null],
  ["another writer committed a newer revision", { fastResultGenerationRevision: 4 }, null],
  ["another writer committed an intermediate revision", { fastResultGenerationRevision: 2 }, "FAST_RESULT_GENERATION_BASE_CHANGED"],
]) {
  test(name + " during preparation preserves the winning files", t => {
    const { meta, run, verifyInputs } = fixture(t);
    fs.writeFileSync(meta, "{}");
    const mkdir = fs.mkdirSync;
    const winner = JSON.stringify(metadata);
    t.mock.method(fs, "mkdirSync", (target, ...args) => {
      if (target === meta + ".commit.lock") fs.writeFileSync(meta, winner);
      return mkdir(target, ...args);
    });
    if (expectedCode) assert.throws(run, { code: expectedCode });
    else assert.equal(run().skipped, true);
    assert.equal(fs.readFileSync(meta, "utf8"), winner);
    verifyInputs();
  });
}

test("unreadable metadata cannot be replaced by an empty baseline", t => {
  const { meta, run, verifyInputs } = fixture(t);
  fs.writeFileSync(meta, "{");
  assert.throws(run);
  assert.equal(fs.readFileSync(meta, "utf8"), "{");
  verifyInputs();
});

test("first reconciliation supports a missing metadata file", t => {
  const { meta, run } = fixture(t);
  assert.equal(run().skipped, false);
  assert.equal(JSON.parse(fs.readFileSync(meta)).fastResultGenerationRevision, 3);
  assert.equal(run().skipped, true);
});

test("staging error leaves existing inputs and revision intact and removes partial output", t => {
  const { meta, run, verifyInputs } = fixture(t);
  fs.writeFileSync(meta, "{}");
  const write = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (typeof target === "number" && ++writes === 2) {
      write(target, "partial");
      throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" });
    }
    return write(target, ...args);
  });
  assert.throws(run, { code: "ENOSPC" });
  assert.equal(fs.readFileSync(meta, "utf8"), "{}");
  verifyInputs();
});

test("failure to acquire the commit lock preserves files and removes staged outputs", t => {
  const { meta, run, verifyInputs } = fixture(t);
  fs.writeFileSync(meta, "{}");
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (target, ...args) => {
    if (target === meta + ".commit.lock") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return mkdir(target, ...args);
  });
  assert.throws(run, { code: "EACCES" });
  verifyInputs();
});
