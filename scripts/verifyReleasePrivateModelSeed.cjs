"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { seedPrivateModelAudit, validateReusablePrivateAudit } = require("./releasePrivateModelSeed.cjs");
const { ensurePrivateModelArtifactTable, writePrivateModelArtifact, HHAD_COMPANION_AUDIT_KEY: KEY } = require("./privateModelArtifactStore.cjs");
function fixture(store) {
  fs.mkdirSync(path.join(store, "model-artifacts"), { recursive: true });
  const payload = { version: "hhad-companion-shadow-evaluation-v1", evaluatedAt: "2026-09-09T00:00:00.000Z",
    gate: { promotionAllowed: false, onlineEffect: "shadow" }, counts: { finalRevisions: 1, settlementRows: 1 },
    finalExposureRows: [{ matchId: "synthetic-only", tip: "X" }], settlementRows: [{ matchId: "synthetic-only", status: "won" }] };
  const { finalExposureRows, settlementRows, ...aggregate } = payload;
  fs.writeFileSync(path.join(store, "model-artifacts/evaluation.json"), JSON.stringify({ version: "synthetic-only",
    generatedAt: payload.evaluatedAt, hhadCompanionEvaluation: aggregate, sample: { hhadCompanion: aggregate.counts } }));
  for (const name of ["model-strategy.json", "model-artifacts/candidate-prospective-registry.json"])
    fs.writeFileSync(path.join(store, name), '{"version":"synthetic-only"}');
  const dbPath = path.join(store, "football.db"), db = new DatabaseSync(dbPath);
  ensurePrivateModelArtifactTable(db); db.close();
  writePrivateModelArtifact({ dbPath, artifactKey: KEY, payload });
  // Noncanonical JSON whitespace must survive byte-for-byte, along with the
  // original stored update clock (writePrivateModelArtifact would restamp it).
  const edit = new DatabaseSync(dbPath), raw = JSON.stringify(payload, null, 2);
  edit.prepare("UPDATE private_model_artifacts SET payload_json=?,payload_bytes=?,payload_sha256=?,updated_at=? WHERE artifact_key=?")
    .run(raw, Buffer.byteLength(raw), require("node:crypto").createHash("sha256").update(raw).digest("hex"),
      "2026-09-09T00:01:00.000Z", KEY); edit.close();
}
function run() {
  const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-private-seed-test-"));
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const live = path.join(temp, "live"); fixture(live);
  const row = store => { const db = new DatabaseSync(path.join(store, "football.db"), { readOnly: true });
    try { return db.prepare("SELECT * FROM private_model_artifacts WHERE artifact_key=?").get(KEY); } finally { db.close(); } };
  const sourceRow = row(live), sourceBytes = fs.readFileSync(path.join(live, "football.db"));
  let serial = 0;
  const candidate = () => { const dir = path.join(temp, `candidate-${++serial}`); fs.mkdirSync(path.join(dir, "model-artifacts"), { recursive: true });
    fs.copyFileSync(path.join(live, "model-artifacts/evaluation.json"), path.join(dir, "model-artifacts/evaluation.json")); return dir; };
  const mutateRow = (store, sql, ...args) => { const db = new DatabaseSync(path.join(store, "football.db"));
    try { db.prepare(sql).run(...args); } finally { db.close(); } };
  try {
    const target = candidate();
    check("exact private row including JSON whitespace and clock is seeded once", () => {
      const result = seedPrivateModelAudit({ sourceStore: live, candidateStore: target });
      assert.equal(result.seeded, true); assert.equal(result.modelPromotionAuthorized, false);
      assert.deepEqual(row(target), sourceRow);
      assert.equal(fs.existsSync(path.join(target, "model-artifacts/hhad-companion-audit.json")), false);
      if (process.platform === "linux") assert.equal(fs.statSync(path.join(target, "football.db")).mode & 0o777, 0o600);
      assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: target }), /already-exists/);
      assert.deepEqual(row(target), sourceRow);
    });
    check("actual first candidate SQLite export preserves all private audit columns", () => {
      const publicDir = path.join(temp, "public-data"); fs.mkdirSync(publicDir);
      for (const name of ["matches-current.json", "matches-history.json"]) fs.writeFileSync(path.join(publicDir, name), "[]");
      fs.writeFileSync(path.join(publicDir, "sync-meta.json"), JSON.stringify({ source: "synthetic-only", updatedAt: "2026-09-09T00:00:00.000Z" }));
      const env = {};
      for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "ProgramData"])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { SERVER_STORE_DIR: target, DATASTORE_SQLITE_PATH: path.join(target, "football.db"),
        SQLITE_EXPORT_PUBLIC_DATA_DIR: publicDir, SQLITE_EXPORT_ATTEMPTS: "1", SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE" });
      const result = spawnSync(process.execPath, [path.join(root, "scripts/exportDataStoreSqlite.cjs")],
        { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(row(target), sourceRow); assert.equal(validateReusablePrivateAudit({ storeDir: target }).payloadSha256, sourceRow.payload_sha256);
    });
    check("missing source DB returns recompute without creating candidate DB", () => {
      const missing = path.join(temp, "missing"); fs.mkdirSync(missing); const dst = candidate();
      assert.equal(seedPrivateModelAudit({ sourceStore: missing, candidateStore: dst }).mode, "recompute");
      assert.equal(fs.existsSync(path.join(dst, "football.db")), false);
    });
    for (const [name, change] of [
      ["missing row", s => mutateRow(s, "DELETE FROM private_model_artifacts")],
      ["hash tampering", s => mutateRow(s, "UPDATE private_model_artifacts SET payload_sha256=?", "0".repeat(64))],
      ["wrong artifact version", s => mutateRow(s, "UPDATE private_model_artifacts SET artifact_version='wrong-v1'")],
      ["wrong generated clock", s => mutateRow(s, "UPDATE private_model_artifacts SET generated_at='2026-09-08T00:00:00.000Z'")],
      ["unsafe schema", s => mutateRow(s, "DROP TABLE private_model_artifacts")],
    ]) check(`${name} requires recomputation before any destination write`, () => {
      const src = path.join(temp, `bad-${++serial}`); fixture(src); change(src); const dst = candidate();
      assert.equal(seedPrivateModelAudit({ sourceStore: src, candidateStore: dst }).mode, "recompute");
      assert.equal(fs.existsSync(path.join(dst, "football.db")), false);
      assert.throws(() => validateReusablePrivateAudit({ storeDir: src }));
    });
    for (const [name, change] of [
      ["aggregate", e => { e.hhadCompanionEvaluation.gate.onlineEffect = "active"; }],
      ["sample counts", e => { e.sample.hhadCompanion.settlementRows = 2; }],
      ["private rows leaked into aggregate", e => { e.hhadCompanionEvaluation.finalExposureRows = []; }],
    ]) check(`mismatched ${name} is not seedable`, () => {
      const dst = candidate(), file = path.join(dst, "model-artifacts/evaluation.json"), data = JSON.parse(fs.readFileSync(file));
      change(data); fs.writeFileSync(file, JSON.stringify(data));
      assert.equal(seedPrivateModelAudit({ sourceStore: live, candidateStore: dst }).mode, "recompute");
      assert.equal(fs.existsSync(path.join(dst, "football.db")), false);
    });
    check("source and candidate stores cannot overlap", () => {
      assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: live }), /overlap/);
      const nested = path.join(live, "nested"); fs.mkdirSync(nested);
      assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: nested }), /overlap/);
    });
    check("existing database sidecar is never overwritten", () => {
      const dst = candidate(), file = path.join(dst, "football.db-wal"); fs.writeFileSync(file, "sentinel");
      assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: dst }), /already-exists/);
      assert.equal(fs.readFileSync(file, "utf8"), "sentinel");
    });
    check("hard-linked source and destination databases fail closed", () => {
      const dst = candidate(); fs.linkSync(path.join(live, "football.db"), path.join(dst, "football.db"));
      try { assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: dst }), /unsafe/); }
      finally { fs.unlinkSync(path.join(dst, "football.db")); }
    });
    if (process.platform === "linux") check("native symlink directories files and sidecars fail closed", () => {
      const alias = path.join(temp, "alias"); fs.symlinkSync(live, alias);
      assert.throws(() => seedPrivateModelAudit({ sourceStore: alias, candidateStore: candidate() }), /unsafe/);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const dst = candidate(); fs.symlinkSync(path.join(live, "football.db"), path.join(dst, "football.db" + suffix));
        assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: dst }), /unsafe/);
      }
      const dst = candidate(), file = path.join(dst, "model-artifacts/evaluation.json"); fs.unlinkSync(file);
      fs.symlinkSync(path.join(live, "model-artifacts/evaluation.json"), file);
      assert.throws(() => seedPrivateModelAudit({ sourceStore: live, candidateStore: dst }), /unsafe/);
    });
    check("real shell snapshots audit inside barrier before first candidate export", () => {
      const shell = fs.readFileSync(path.join(root, "deploy/light-server/release-from-bundle.sh"), "utf8").replace(/\r\n?/g, "\n");
      const start = shell.indexOf("seed_candidate_model_artifacts() {"), end = shell.indexOf("\n}\n", start);
      assert.ok(shell.slice(start, end).includes('"$TRUSTED_SOURCE_DIR/scripts/releasePrivateModelSeed.cjs"'));
      const call = shell.indexOf("\nseed_candidate_model_artifacts \\");
      assert.ok(call > shell.lastIndexOf('\nstop_worker_for_release_window \\', call));
      assert.ok(shell.indexOf("\nstop_release_sync_write_barrier clean", call) > call);
      assert.ok(shell.indexOf("run_build_step candidate-datastore ", call) > call);
    });
    check("source database bytes and exact row remain unchanged", () => {
      assert.deepEqual(row(live), sourceRow); assert.deepEqual(fs.readFileSync(path.join(live, "football.db")), sourceBytes);
    });
    return { ok: true, checks, productionWrites: 0, providerRequests: 0, nativeSymlinksTested: process.platform === "linux" };
  } finally {
    const real = fs.realpathSync(temp); assert.equal(real, path.resolve(temp));
    assert.ok(real.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(real).startsWith("football-private-seed-test-"));
    fs.rmSync(real, { recursive: true, force: true });
  }
}
module.exports = { run, fixture };
if (require.main === module) { try { console.log(JSON.stringify(run(), null, 2)); } catch (e) { console.error(e); process.exitCode = 1; } }
