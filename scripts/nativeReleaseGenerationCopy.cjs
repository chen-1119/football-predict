"use strict";
// Copies the exact immutable generation belonging to a held database snapshot,
// never a newly generated prediction or a SQLite export. No activation occurs.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { resolveGeneration, resolveCurrentGeneration, acquirePointerCommitLock, storePaths, MANIFEST_FILE, STORE_SCHEMA_VERSION } = require("../server/dataGenerationStore.cjs");
const { acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");
function copyNativeReleaseGeneration({ sourceStoreDir, targetStoreDir, identity }) {
  const source = fs.realpathSync(sourceStoreDir), target = path.resolve(targetStoreDir);
  assert.ok(target !== source && !target.startsWith(source + path.sep) && !source.startsWith(target + path.sep), "independent candidate store required");
  assert.equal(fs.realpathSync(path.dirname(target)), path.dirname(target), "candidate parent must be a real directory");
  assert.equal(identity?.mode, "active-generation"); assert.match(identity.generationId, /^g-[a-f0-9]{64}$/);
  assert.match(identity.manifestHash, /^[a-f0-9]{64}$/); assert.ok(identity.sourceCycleId && Number.isFinite(Date.parse(identity.committedAt)));
  const pointerLock = acquirePointerCommitLock({ lockDir: storePaths(source).pointerLockDir, timeoutMs: 120_000, staleMs: 60_000 });
  let context, lease;
  try {
    context = resolveGeneration({ storeDir: source, generationId: identity.generationId,
      manifestHash: identity.manifestHash, sourceCycleId: identity.sourceCycleId });
    lease = acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, context,
      pointerLockHandle: pointerLock, owner: "native-release-generation-copy", ttlMs: 15 * 60_000 });
  } finally { pointerLock.release(); }
  let bytes = 0;
  const directories = new Set();
  const sync = filename => { const fd = fs.openSync(filename, process.platform === "win32" ? "r+" : "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  function copy(filename, output, expectedBytes, expectedHash) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let destination;
    try {
      const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.nlink === 1); assert.equal(before.size, expectedBytes);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      for (let directory = path.dirname(output);; directory = path.dirname(directory)) {
        assert.ok(directory === target || directory.startsWith(target + path.sep)); directories.add(directory);
        if (directory === target) break;
      }
      destination = fs.openSync(output, "wx", 0o600);
      const buffer = Buffer.alloc(1024 * 1024), digest = crypto.createHash("sha256"); let copied = 0;
      for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
        copied += n; assert.ok(copied <= expectedBytes, "generation file grew"); digest.update(buffer.subarray(0, n));
        let offset = 0; while (offset < n) offset += fs.writeSync(destination, buffer, offset, n - offset);
      }
      const after = fs.fstatSync(fd), current = fs.lstatSync(filename);
      assert.equal(copied, expectedBytes); assert.equal(digest.digest("hex"), expectedHash);
      assert.ok(!current.isSymbolicLink() && current.ino === before.ino && current.dev === before.dev
        && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "generation source changed");
      fs.fsyncSync(destination); bytes += copied;
    } finally { if (destination !== undefined) fs.closeSync(destination); fs.closeSync(fd); }
  }
  try {
    fs.mkdirSync(target, { mode: 0o700 }); // Preserve an existing or failed candidate; no overwrite/retry.
    const paths = storePaths(target), generation = path.join(paths.generationsDir, identity.generationId);
    fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
    for (const file of context.manifest.files) copy(path.join(context.generationDir, file.path), path.join(generation, file.path), file.bytes, file.sha256);
    const manifest = path.join(context.generationDir, MANIFEST_FILE), manifestBytes = fs.readFileSync(manifest);
    copy(manifest, path.join(generation, MANIFEST_FILE), manifestBytes.length, crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    const pointer = { schemaVersion: STORE_SCHEMA_VERSION, generationId: identity.generationId, sourceCycleId: identity.sourceCycleId,
      manifestHash: identity.manifestHash, committedAt: identity.committedAt };
    fs.writeFileSync(paths.currentPointer, JSON.stringify(pointer) + "\n", { flag: "wx", mode: 0o600 }); sync(paths.currentPointer);
    const copied = resolveCurrentGeneration({ storeDir: target });
    assert.equal(copied.manifestHash, identity.manifestHash); assert.deepEqual(copied.pointer, pointer);
    if (process.platform === "linux") for (const directory of [...directories].sort((a, b) => b.length - a.length)) sync(directory);
    return { ok: true, identity, files: context.manifest.files.length, bytes, sqliteExports: 0, databaseWrites: 0, activated: false };
  } finally { lease.release(); }
}
module.exports = { copyNativeReleaseGeneration };
