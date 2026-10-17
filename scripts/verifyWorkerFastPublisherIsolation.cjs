"use strict";
// Only a disposable loopback database and synthetic signed result are used.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Pool } = require("pg");
const { runPostgresMigrations } = require("../server/postgresStore.cjs");
const { commitCurrentDataGeneration, resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
const { storePaths } = require("../server/dataGenerationStore.cjs");
const { createPostgresGenerationSource } = require("./postgresGenerationSource.cjs");
const { syncPostgresProjectionFromSource } = require("./postgresProjectionSync.cjs");
const { publisherCollector, baseCurrentMatch, relaySnapshot } = require("./nativeFastResultFixture.cjs");
const { resultFingerprint } = require("./sportteryFastResultLane.cjs");
const { readPostgresFastResultReceiptState } = require("../server/postgresProjectionStore.cjs");
const { runWorkerFastResultPublisher } = require("./workerFastResultPublisher.cjs");
const { createWorkerShutdownController, runCommand } = require("./runSyncWorker.cjs");

function rawSnapshot(snapshot) {
  const endpoints = snapshot.entries, count = values => values.reduce((sum, entry) => sum + entry.payload.value.matchInfoList.reduce((n, day) => n + day.subMatchList.length, 0), 0);
  return { ...snapshot.payload, sourceCycleKind: "upload-merge", producer: { fastResultLane: true, resultFingerprint: resultFingerprint(endpoints.find(entry => entry.method === "result")) },
    summary: { endpoints: endpoints.length, usableEndpoints: endpoints.length, rows: count(endpoints), resultRows: count(endpoints.filter(entry => entry.method === "result")), errors: 0,
      methods: [...new Set(endpoints.map(entry => entry.method))].sort(), fastResultLane: true }, endpoints, errors: [] };
}
async function verify(url) {
  const parsed = new URL(url);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
  assert(/^\/(?:recommendation_test|accounts_test|q2_evidence_[a-z0-9_]+)$/.test(parsed.pathname));
  const database = `worker_publish_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  assert(/^worker_publish_\d+_[a-f0-9]{12}$/.test(database));
  const admin = new Pool({ connectionString: parsed.href, ssl: false, max: 1 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-publish-")), storeDir = path.join(temp, "store"), publicDataDir = path.join(temp, "public"); fs.mkdirSync(publicDataDir);
  const owner = createWorkerShutdownController({ terminate: (child, signal) => child.kill(signal), terminateGraceMs: 100 });
  const options = { shutdownController: owner, timeoutMs: 30000, terminateGraceMs: 100 };
  const env = { SERVER_STORE_DIR: storeDir, DATA_STORE_DIR: storeDir, SYNC_META_PATH: path.join(publicDataDir, "sync-meta.json"), RECOMMENDATION_PUBLICATION_LEDGER_PATH: path.join(temp, "absent-ledger.json"),
    SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: path.join(temp, "fast.json"), SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH: path.join(temp, "fast.json"),
    SPORTTERY_RELAY_SNAPSHOT: path.join(temp, "missing-full.json"), SPORTTERY_RELAY_SNAPSHOT_PATH: path.join(temp, "missing-full.json"),
    SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: path.join(temp, "registry.json"), SPORTTERY_RELAY_MODE: "prefer", SPORTTERY_RELAY_MAX_AGE_MINUTES: "5", TRUSTED_MAX_FUTURE_SKEW_SECONDS: "300",
    FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary", POSTGRES_PROJECTION_SOURCE: "native-generation", FOOTBALL_POSTGRES_SSL_MODE: "disable", DATABASE_URL: "",
    DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0", PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres" };
  const savedEnv = Object.fromEntries([...Object.keys(env), "FOOTBALL_POSTGRES_URL"].map(key => [key, process.env[key]]));
  let pool, created = false; const passed = [];
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true; parsed.pathname = "/" + database;
    Object.assign(process.env, env, { FOOTBALL_POSTGRES_URL: parsed.href }); pool = new Pool({ connectionString: parsed.href, ssl: false, max: 2 }); await runPostgresMigrations(pool);
    const at = new Date().toISOString(), sourceMatchId = "owned-worker-fast-publisher";
    const payloads = { "matches-current.json": [baseCurrentMatch({ sourceMatchId })], "matches-history.json": [], "sync-meta.json": { sourceCycleId: "worker-publish-isolation", updatedAt: at },
      "external-signals.json": { matches: {} }, "odds-history.json": { rows: [] }, "prediction-snapshots.json": { rows: [] }, "model-calibration.json": { version: "test", generatedAt: at } };
    for (const [name, value] of Object.entries(payloads)) fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(value));
    const large = path.join(publicDataDir, "prediction-snapshots.json"), fd = fs.openSync(large, "w"), segment = JSON.stringify({ scalar: "x".repeat(1024), value: 123.5, literal: false });
    try { fs.writeSync(fd, '{"metadata":{"history":['); for (let i = 0; i < 65536; i++) fs.writeSync(fd, (i ? "," : "") + segment); fs.writeSync(fd, ']},"rows":[]}'); } finally { fs.closeSync(fd); }
    const committed = commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId: payloads["sync-meta.json"].sourceCycleId, committedAt: at });
    await syncPostgresProjectionFromSource(createPostgresGenerationSource({ storeDir, publicDataDir }), { pool, mode: "backfill", aiArenaPath: path.join(temp, "absent-arena.json") });
    fs.writeFileSync(env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH, JSON.stringify(publisherCollector.registry));
    fs.writeFileSync(env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT, JSON.stringify(rawSnapshot(relaySnapshot({ sourceMatchId, capturedAt: at }))));
    const state = async () => ({ matches: (await pool.query("SELECT id,dataset,payload::text AS raw FROM football.match_snapshots ORDER BY id")).rows,
      meta: (await pool.query("SELECT key,value,updated_at FROM football.projection_meta ORDER BY key")).rows });
    let ticks = 0, finished = false, commandFinishedDuringPublish = false, result;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      const work = runWorkerFastResultPublisher(options).then(value => { finished = true; return value; });
      const short = runCommand(process.execPath, ["-e", "setTimeout(()=>{},20)"], {}, { timeoutMs: 500, terminateGraceMs: 100, forceSettleMs: 100, stdio: "ignore" })
        .then(value => { commandFinishedDuringPublish = !finished; return value; });
      [result] = await Promise.all([work, short]);
    } finally { clearInterval(timer); }
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.skipped, false); assert.equal(result.publishedRows, 1); assert.equal(result.storage, "postgres");
    assert(ticks >= 3); assert(commandFinishedDuringPublish); assert.equal(owner.activeCount, 0);
    const first = await state(), final = first.matches.find(row => row.dataset === "history" && JSON.parse(row.raw).sourceMatchId === sourceMatchId);
    assert(final); assert.equal(JSON.parse(final.raw).scoreHome, 2); assert.equal(first.matches.filter(row => row.dataset === "current").length, 0);
    const receipt = await readPostgresFastResultReceiptState(pool, { publicationIdentity: resolveActivePublication({ storeDir, publicDataDir }).identity });
    assert.equal(receipt.valid, true, JSON.stringify(receipt)); assert.equal(receipt.receipt.observations[0].scoreHome, 2);
    passed.push("actual fixed child publishes signed result and original atomic receipt while parent reaps an independent short command during full 69 MB verification");
    const repeated = await runWorkerFastResultPublisher(options); assert.equal(repeated.publishedRows, 0); assert.deepEqual(await state(), first);
    passed.push("same signed original input is idempotent with all retained result and receipt bytes unchanged");
    const immutable = path.join(committed.context.generationDir, "prediction-snapshots.json"), original = fs.readFileSync(immutable), damaged = Buffer.from(original); damaged[damaged.indexOf(Buffer.from("123.5"))] = 0x39;
    fs.writeFileSync(immutable, damaged);
    try { await assert.rejects(runWorkerFastResultPublisher(options), { code: "PUBLISHER_EXIT_FAILED" }); assert.deepEqual(await state(), first); } finally { fs.writeFileSync(immutable, original); }
    passed.push("same-size immutable payload tamper is still rejected before any PostgreSQL result mutation");
    const pending = runWorkerFastResultPublisher(options); setTimeout(() => owner.requestShutdown("SIGTERM"), 20);
    await assert.rejects(pending, { code: "SYNC_WORKER_INTERRUPTED" }); assert.equal(owner.activeCount, 0); assert.deepEqual(await state(), first);
    passed.push("actual publisher child closes on worker shutdown and cannot publish a success afterward");
    return { ok: true, scope: "disposable loopback PostgreSQL and synthetic signed immutable input", passed, checks: passed.length, payloadBytes: original.length,
      payloadSha256: crypto.createHash("sha256").update(original).digest("hex"), parentTicks: ticks, commandFinishedDuringPublish, ownedChildren: owner.activeCount,
      pointerLockPresent: fs.existsSync(storePaths(storeDir).pointerLockDir), productionWrites: 0 };
  } finally {
    owner.dispose(); assert.equal(owner.activeCount, 0, "retain disposable database if actual child close is unconfirmed");
    if (pool) await pool.end(); if (created) await admin.query(`DROP DATABASE ${database}`); await admin.end();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const resolved = fs.realpathSync(temp); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert(path.basename(resolved).startsWith("football-worker-publish-")); fs.rmSync(resolved, { recursive: true });
  }
}
if (require.main === module) verify(process.env.WORKER_PUBLISH_TEST_DATABASE_URL).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verify };
