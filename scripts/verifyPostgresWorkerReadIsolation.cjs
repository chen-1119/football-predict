"use strict";
// This verifier creates its own loopback test database; never reuse football.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Pool } = require("pg");
const { runPostgresMigrations } = require("../server/postgresStore.cjs");
const { commitCurrentDataGeneration } = require("../server/dataGenerationBundle.cjs");
const { storePaths } = require("../server/dataGenerationStore.cjs");
const { createPostgresGenerationSource } = require("./postgresGenerationSource.cjs");
const { syncPostgresProjectionFromSource } = require("./postgresProjectionSync.cjs");
const { readPostgresWorkerObservation, readPostgresWorkerCounts } = require("./postgresWorkerObservation.cjs");
const { readPostgresWorkerInChild } = require("./postgresWorkerReadProcess.cjs");
const { createWorkerShutdownController, runCommand } = require("./runSyncWorker.cjs");

async function verify(url) {
  const parsed = new URL(url);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
  assert(/^\/(?:recommendation_test|accounts_test|q2_evidence_[a-z0-9_]+)$/.test(parsed.pathname));
  const database = `worker_read_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  assert(/^worker_read_\d+_[a-f0-9]{12}$/.test(database));
  const admin = new Pool({ connectionString: parsed.href, ssl: false, max: 1 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-read-"));
  const storeDir = path.join(temp, "store"), publicDataDir = path.join(temp, "public"); fs.mkdirSync(publicDataDir);
  const savedEnv = Object.fromEntries(["FOOTBALL_POSTGRES_URL", "FOOTBALL_POSTGRES_SSL_MODE"].map(key => [key, process.env[key]]));
  let created = false, pool; const children = new Set();
  const owner = createWorkerShutdownController({ terminate: (child, signal) => child.kill(signal), terminateGraceMs: 100 });
  const controller = { get requested() { return owner.requested; }, interruptionError: () => owner.interruptionError(),
    register(child) { children.add(child); owner.register(child); }, unregister(child) { children.delete(child); owner.unregister(child); } };
  const options = { timeoutMs: 30000, terminateGraceMs: 100, forceSettleMs: 1000, shutdownController: controller };
  const ready = { ok: true, skipped: false }, input = { storeDir, publicDataDir, phase: "readiness", validationStep: ready, generationStep: ready, projectionStep: ready };
  const passed = [];
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    parsed.pathname = "/" + database;
    process.env.FOOTBALL_POSTGRES_URL = parsed.href; process.env.FOOTBALL_POSTGRES_SSL_MODE = "disable";
    pool = new Pool({ connectionString: parsed.href, ssl: false, max: 2 });
    await runPostgresMigrations(pool);
    const at = "2026-10-17T00:00:00.000Z";
    const payloads = { "matches-current.json": [], "matches-history.json": [], "sync-meta.json": { sourceCycleId: "worker-read-isolation", updatedAt: at },
      "external-signals.json": { matches: {} }, "odds-history.json": { rows: [] }, "prediction-snapshots.json": { rows: [] }, "model-calibration.json": { version: "test", generatedAt: at } };
    // Unknown nested metadata is fully scanned even though no rows are selected.
    // A real 64 MiB payload makes the original synchronous verification path
    // run long enough to observe parent progress, without changing its grammar.
    const segment = JSON.stringify({ scalar: "x".repeat(1024), value: 123.5, literal: false });
    for (const [name, value] of Object.entries(payloads)) fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(value));
    const large = path.join(publicDataDir, "prediction-snapshots.json"), fd = fs.openSync(large, "w");
    try {
      fs.writeSync(fd, '{"metadata":{"history":[');
      for (let i = 0; i < 65536; i++) fs.writeSync(fd, (i ? "," : "") + segment);
      fs.writeSync(fd, ']},"rows":[]}');
    } finally { fs.closeSync(fd); }
    const committed = commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId: payloads["sync-meta.json"].sourceCycleId, committedAt: at });
    await syncPostgresProjectionFromSource(createPostgresGenerationSource({ storeDir, publicDataDir }), { pool, mode: "backfill", aiArenaPath: path.join(temp, "absent.json") });
    const direct = await readPostgresWorkerObservation({ ...input, pool });
    assert.equal(direct.ready, true, JSON.stringify(direct));
    const counts = await readPostgresWorkerCounts({ storeDir, publicDataDir, pool });
    let ticks = 0, readFinished = false, commandFinishedDuringRead = false;
    const timer = setInterval(() => { ticks++; }, 5);
    let isolated;
    try {
      const reading = readPostgresWorkerInChild("observation", input, options).then(value => { readFinished = true; return value; });
      const command = runCommand(process.execPath, ["-e", "setTimeout(()=>{},20)"], {}, { timeoutMs: 500, terminateGraceMs: 100, forceSettleMs: 100, stdio: "ignore" })
        .then(value => { commandFinishedDuringRead = !readFinished; return value; });
      [isolated] = await Promise.all([reading, command]);
    } finally { clearInterval(timer); }
    assert(ticks >= 3, "parent event loop did not advance during complete verification");
    assert(commandFinishedDuringRead, "independent short command did not complete while native read ran");
    const withoutClock = value => { const copy = { ...value }; delete copy.observedAt; return copy; };
    assert.deepEqual(withoutClock(isolated), withoutClock(direct));
    assert.deepEqual(await readPostgresWorkerInChild("counts", input, options), counts);
    assert.equal(children.size, 0);
    passed.push("real native RR read, complete large-payload semantics, identity and counts match the original readers while the parent reaps an independent command");
    assert.equal((await readPostgresWorkerInChild("observation", { ...input, projectionStep: { ok: true, skipped: true } }, options)).ready, false);
    passed.push("skipped projection cannot become ready through IPC");
    await pool.query("UPDATE football.projection_meta SET value=$1 WHERE key='manifest_hash'", ["f".repeat(64)]);
    assert.equal((await readPostgresWorkerInChild("observation", input, options)).ready, false);
    await assert.rejects(readPostgresWorkerInChild("counts", input, options));
    await pool.query("UPDATE football.projection_meta SET value=$1 WHERE key='manifest_hash'", [direct.generation.manifestHash]);
    passed.push("native PostgreSQL identity mismatch refuses readiness and counts without fallback");
    const immutable = path.join(committed.context.generationDir, "prediction-snapshots.json"), original = fs.readFileSync(immutable);
    const damaged = Buffer.from(original); damaged[damaged.indexOf(Buffer.from("123.5"))] = 0x39;
    fs.writeFileSync(immutable, damaged);
    assert.equal((await readPostgresWorkerInChild("observation", input, options)).ready, false);
    fs.writeFileSync(immutable, original);
    passed.push("same-size immutable payload tampering is still rejected by complete hash validation");
    const pending = readPostgresWorkerInChild("observation", input, options);
    setTimeout(() => owner.requestShutdown("SIGTERM"), 20);
    await assert.rejects(pending, { code: "SYNC_WORKER_INTERRUPTED" }); assert.equal(children.size, 0);
    assert.equal(owner.activeCount, 0);
    passed.push("actual owned read child closes on worker shutdown and cannot return a positive observation");
    const lock = storePaths(storeDir).pointerLockDir;
    // SIGTERM may interrupt a lease holder; an owned lease is not an external
    // writer lock and must never be removed by this verifier as a repair.
    return { ok: true, scope: "disposable loopback PostgreSQL and immutable generation", checks: passed.length, passed,
      payloadBytes: original.length, parentTicks: ticks, commandFinishedDuringRead, ownedChildren: children.size,
      pointerLockPresent: fs.existsSync(lock), productionWrites: 0 };
  } finally {
    owner.dispose();
    assert.equal(children.size, 0, "retain fixture and database if owned child close is unconfirmed");
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith("football-worker-read-")); fs.rmSync(resolved, { recursive: true });
  }
}
if (require.main === module) verify(process.env.WORKER_READ_TEST_DATABASE_URL).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verify };
