"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { commitDataGeneration, resolveCurrentGeneration, readGenerationFile, storePaths } = require("../server/dataGenerationStore.cjs");
const { copyNativeReleaseGeneration } = require("./nativeReleaseGenerationCopy.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-generation-copy-")), source = path.join(root, "source");
const checks = [];
try {
  const raw = Buffer.from(JSON.stringify({ rows: [{ tipCode: "X", note: "原始冻结推荐\n保留空格", padding: "a".repeat(2 * 1024 * 1024) }] }) + "\n");
  const original = commitDataGeneration({ storeDir: source, sourceCycleId: "native-copy-original", files: { "original.json": { bytes: raw, rows: 1 },
    "nested/evidence.json": { bytes: '{"original":"X"}\n', rows: 1 } }, coreFiles: ["original.json"], committedAt: "2026-09-11T00:00:00.000Z" });
  const identity = { mode: "active-generation", ...original.pointer }; delete identity.schemaVersion;
  commitDataGeneration({ storeDir: source, sourceCycleId: "native-copy-advanced", files: { "original.json": { bytes: '{"newGeneration":true}\n', rows: 1 } }, coreFiles: ["original.json"], committedAt: "2026-09-11T01:00:00.000Z" });
  const pointerBefore = fs.readFileSync(storePaths(source).currentPointer), target = path.join(root, "candidate");
  const copied = copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: target, identity });
  assert.equal(copied.ok, true); assert.equal(copied.sqliteExports, 0); assert.equal(copied.activated, false);
  const candidate = resolveCurrentGeneration({ storeDir: target }); assert.equal(candidate.generationId, original.pointer.generationId);
  assert.deepEqual(readGenerationFile(candidate, "original.json"), raw); assert.deepEqual(fs.readFileSync(storePaths(source).currentPointer), pointerBefore);
  assert.equal(readGenerationFile(candidate, "nested/evidence.json", { encoding: "utf8" }), '{"original":"X"}\n');
  assert.equal(fs.existsSync(path.join(target, "football.db")), false);
  checks.push("copies exact database-bound generation even when the production pointer has advanced");
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: target, identity }), { code: "EEXIST" });
  assert.deepEqual(readGenerationFile(candidate, "original.json"), raw);
  checks.push("existing candidate is retained rather than overwritten");
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(source, "candidate"), identity }), /independent/);
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "mismatch"), identity: { ...identity, manifestHash: "0".repeat(64) } }));
  assert.equal(fs.existsSync(path.join(root, "mismatch")), false);
  checks.push("source-contained destination and mismatched publication fail before copying");
  const { acquirePointerCommitLock, inspectPointerCommitLockActivity } = require("../server/dataGenerationStore.cjs");
  const { acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");
  const lockDir = storePaths(source).pointerLockDir, held = acquirePointerCommitLock({ lockDir });
  try {
    const lease = acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, context: original.context, pointerLockHandle: held });
    assert.equal(inspectPointerCommitLockActivity({ lockDir }).owner.token, held.owner.token);
    lease.release(); assert.equal(inspectPointerCommitLockActivity({ lockDir }).active, true);
    assert.throws(() => acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId,
      pointerLockHandle: { owner: { token: "wrong" }, release() {} } }), /actual held pointer lock/);
    assert.equal(inspectPointerCommitLockActivity({ lockDir }).owner.token, held.owner.token);
  } finally { held.release(); }
  assert.throws(() => acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, pointerLockHandle: held }), /actual held pointer lock/);
  checks.push("retirement read lease reuses only the actual caller-held barrier without releasing it");
  const ready = path.join(root, "writer-ready"), released = path.join(root, "writer-released");
  const writerSource = "const fs=require('fs');const {acquirePointerCommitLock}=require(" + JSON.stringify(require.resolve("../server/dataGenerationStore.cjs")) + ");const lock=acquirePointerCommitLock({lockDir:" + JSON.stringify(lockDir) + "});fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');setTimeout(()=>{lock.release();fs.writeFileSync(" + JSON.stringify(released) + ",'released');},11000);";
  const writer = require("node:child_process").spawn(process.execPath, ["-e", writerSource], { windowsHide: true, stdio: "ignore" });
  writer.unref();
  const waitStarted = Date.now();
  while (!fs.existsSync(ready)) { assert.ok(Date.now()-waitStarted < 5000); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }
  const waitedCopy = copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "after-writer"), identity });
  assert.equal(waitedCopy.ok, true); assert.ok(fs.existsSync(released));
  assert.ok(Date.now()-waitStarted >= 11000); assert.equal(inspectPointerCommitLockActivity({lockDir}).active,false);
  assert.deepEqual(readGenerationFile(resolveCurrentGeneration({ storeDir: path.join(root, "after-writer") }), "original.json"), raw);
  checks.push("actual concurrent writer longer than 10 seconds releases before the authenticated copy without lock bypass");
  const originalFile = path.join(original.context.generationDir, "original.json");
  fs.writeFileSync(originalFile, Buffer.alloc(raw.length, 32));
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "tampered"), identity }));
  assert.equal(fs.existsSync(path.join(root, "tampered")), false);
  checks.push("same-size changed generation bytes are refused before candidate creation");
  console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks, productionWrites: 0, sqliteExports: 0 }));
} finally {
  const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-native-generation-copy-")); fs.rmSync(resolved, { recursive: true });
}
