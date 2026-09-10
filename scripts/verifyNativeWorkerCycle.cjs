"use strict";
// Real worker CLI and child commands, synthetic signed upstream, real isolated
// PostgreSQL. No production files, network credentials or command mocks.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { Pool } = require("pg");
const root = path.resolve(__dirname, "..");
async function main() {
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.match(url.pathname, /^\/q2_evidence_native_[a-z0-9_]+$/);
  const pool = new Pool({ connectionString: url.href, ssl: false, max: 1 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-worker-cycle-"));
  const app = path.join(temp, "app"), storeDir = path.join(app, "server-data"), publicDataDir = path.join(app, "public/data");
  const report = { ok: false, scope: "actual native worker CLI; synthetic signed market; disposable PostgreSQL", productionWrites: 0 };
  let trust;
  try {
    assert.equal((await pool.query("SELECT host(inet_server_addr()) AS address")).rows[0].address, "127.0.0.1");
    assert.equal((await pool.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname='football'")).rows[0].n, 0);
    await require("../server/postgresStore.cjs").runPostgresMigrations(pool);
    fs.mkdirSync(publicDataDir, { recursive: true }); fs.mkdirSync(storeDir);
    for (const dir of ["scripts", "server", "src"]) fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(app, "package.json"));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const at = new Date(Date.now() - 5000).toISOString(), fixtureCycle = "qa-worker-initial";
    for (const [name, payload] of Object.entries({ "matches-current.json": [], "matches-history.json": [],
      "sync-meta.json": { sourceCycleId: fixtureCycle, updatedAt: at }, "external-signals.json": { updatedAt: at,
        sources: { "500.com:jczq": { rows: 1, mapped: 1 } }, matches: { "qa-native-worker-market": {
          bookmakerOdds: { had: { odds1: 1.92, oddsX: 3.35, odds2: 4.05 } }, capturedAt: at, source: "synthetic-qa" } } },
      "prediction-snapshots.json": { rows: [] }, "odds-history.json": { rows: [] }, "model-calibration.json": { version: "qa-worker", generatedAt: at } }))
      fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(payload));
    require("../server/dataGenerationBundle.cjs").commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId: fixtureCycle, committedAt: at });
    await require("./postgresProjectionSync.cjs").syncPostgresProjectionFromSource(
      require("./postgresGenerationSource.cjs").createPostgresGenerationSource({ storeDir, publicDataDir }),
      { pool, mode: "backfill", aiArenaPath: path.join(storeDir, "no-arena.json") });
    trust = require("./collectorAttestationTestFixture.cjs").createCollectorAttestationTestContext({ keyId: "qa-worker-cycle-ed25519" });
    const receivedAt = new Date(Date.now() - 1000).toISOString(), requestedAt = new Date(Date.now() - 2000).toISOString();
    const kick = new Date(Date.now() + 24 * 3600000 + 8 * 3600000).toISOString();
    const observed = new Date(Date.now() - 3000 + 8 * 3600000).toISOString();
    const payload = { success: true, value: { matchInfoList: [{ businessDate: kick.slice(0, 10), subMatchList: [{
      matchId: "qa-native-worker-market", matchDate: kick.slice(0, 10), matchTime: kick.slice(11, 19),
      homeTeamAllName: "QA Home", awayTeamAllName: "QA Away", leagueAllName: "QA League", matchStatus: "Selling",
      oddsList: [{ poolCode: "HAD", h: "1.90", d: "3.30", a: "4.10", updateDate: observed.slice(0, 10), updateTime: observed.slice(11, 19) },
        { poolCode: "HHAD", h: "2.80", d: "3.25", a: "2.10", goalLine: "-1", updateDate: observed.slice(0, 10), updateTime: observed.slice(11, 19) }],
    }] }] } };
    const clocks = [requestedAt, receivedAt], sourceCycleId = "sporttery-relay:qa-native-worker";
    const endpoint = await require("./collectSportterySnapshot.cjs").fetchEndpoint({ id: "current", method: "current", role: "current",
      url: "https://webapi.sporttery.cn/gateway/jc/football/getMatchListV1.qry", sourceCycleId,
      request: async () => ({ statusCode: 200, headers: { date: new Date(receivedAt).toUTCString(), "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(payload)), payload }),
      clock: () => clocks.shift(), attestationSigner: trust.keyPair });
    const relay = { version: 1, source: "sporttery-relay-snapshot", capturedAt: receivedAt, requestedAt, completedAt: receivedAt,
      sourceCycleId, provenanceVersion: 1, collectorProvenance: { requestedAt, receivedAt, completedAt: receivedAt, sourceCycleId },
      producer: { host: "qa-worker", transport: "local-signed-fixture" },
      summary: { endpoints: 1, usableEndpoints: 1, rows: 1, errors: 0, methods: ["current"], pageDepth: 1, resultPageDepth: 1 }, endpoints: [endpoint], errors: [] };
    const relayPath = path.join(storeDir, "sporttery-relay-snapshot.json"); fs.writeFileSync(relayPath, JSON.stringify(relay));
    const trap = path.join(temp, "native-trap.cjs"), trapLog = path.join(temp, "trap.jsonl");
    fs.writeFileSync(trap, `const fs=require('node:fs'),Module=require('node:module');
      const log=(kind)=>{fs.appendFileSync(${JSON.stringify(trapLog)},JSON.stringify({kind,pid:process.pid})+'\\n');throw Error('QA forbidden '+kind);};
      const load=Module._load;Module._load=function(name,...args){if(name==='node:sqlite'||name==='better-sqlite3'||name==='sqlite3')log('sqlite');return load.call(this,name,...args);};
      global.fetch=()=>log('external-http');for(const name of ['node:http','node:https']){const http=require(name);http.request=()=>log('external-http');http.get=()=>log('external-http');}
      process.on('exit',()=>fs.appendFileSync(${JSON.stringify(trapLog)},JSON.stringify({kind:'process-exit',pid:process.pid})+'\\n'));`);
    // Start with OS execution settings only, never inherited production flags,
    // secret URLs, API keys, collector signing paths or filesystem locations.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|userprofile|programfiles|programfiles\(x86\))$/i.test(key)));
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH";
    env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || "");
    Object.assign(env, { NODE_OPTIONS: `--require=${JSON.stringify(trap)}`, FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary",
      FOOTBALL_POSTGRES_URL: url.href, FOOTBALL_POSTGRES_SSL_MODE: "disable", DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres",
      ENABLE_SQLITE_EXPORT: "0", PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres", POSTGRES_PROJECTION_SOURCE: "native-generation",
      SERVER_STORE_DIR: storeDir, DATA_STORE_DIR: storeDir, DATA_GENERATION_PUBLIC_DATA_DIR: publicDataDir,
      DATASTORE_SQLITE_PATH: path.join(storeDir, "must-not-exist.db"), SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: trust.registryPath,
      SPORTTERY_RELAY_SNAPSHOT: relayPath, SPORTTERY_RELAY_MODE: "prefer", SKIP_SPORTTERY_DIRECT_FETCH: "1",
      WRITE_LEGACY_STATIC_PAYLOADS: "0", MIRROR_PUBLISHED_DATA_TO_DIST: "0", ENABLE_MODEL_BACKTEST_ON_SYNC: "1", MODEL_BACKTEST_ON_SYNC_FORCE: "1",
      ENABLE_MODEL_STRATEGY_ON_SYNC: "1", SYNC_WORKER_LOOP: "0", ENABLE_API_FOOTBALL_SYNC: "0" });
    for (const name of ["K_LEAGUE_OFFICIAL_STANDINGS_SYNC", "UEFA_OFFICIAL_RESULTS_SYNC", "OFFICIAL_CLUB_RESULTS_SYNC", "500_SYNC", "500_DETAILS_SYNC",
      "WEATHER_SYNC", "FOOTBALL_DATA_FIXTURES_SYNC", "FOOTBALL_DATA_RESULTS_SYNC", "OPEN_RESEARCH_SYNC", "WEB_CONSENSUS_SYNC", "OPENFOOTBALL_OBSERVATIONS",
      "FREE_FOOTBALL_SYNC", "PREMATCH_SIGNALS_SYNC", "CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE", "BENCHMARK_PROSPECTIVE_DEADLINE_CAPTURE",
      "AUTONOMOUS_MODEL_LEARNING", "MODEL_LEARNING_REGISTRY", "CAPABILITY_AUDIT"]) env["ENABLE_" + name] = "0";
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(app, "scripts/runSyncWorker.cjs")], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-2 * 1024 * 1024); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-50000); });
    // The worker owns graceful child draining; do not SIGKILL its tree and then
    // remove a directory which a surviving child may still be writing.
    const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
    report.elapsedMs = Date.now() - start; report.exit = exit;
    report.trapEvents = fs.existsSync(trapLog) ? fs.readFileSync(trapLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const statusFile = path.join(storeDir, "sync-worker-status.json");
    report.status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile)) : null;
    report.stdoutTail = stdout.slice(-16000); report.stderrTail = stderr.slice(-12000);
    fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(root, "outputs/native-worker-cycle-stdout.log"), stdout);
    assert.equal(exit.code, 0, stderr || stdout);
    assert.equal(report.trapEvents.filter(event => event.kind !== "process-exit").length, 0);
    assert.ok(report.trapEvents.length >= 8, "real child commands must run");
    assert.equal(fs.existsSync(path.join(storeDir, "must-not-exist.db")), false);
    assert.equal(report.status?.ok, true);
    const cycle = report.status?.lastCycle;
    assert.equal(cycle?.degraded, false, JSON.stringify(cycle?.warnings));
    assert.equal(cycle?.readinessSourceCycleObservation?.ready, true);
    for (const step of [cycle.officialPhase.sqliteStep, cycle.modelBacktestStep, cycle.modelStrategyStep, cycle.modelReconciledSqliteStep]) {
      assert.equal(step?.ok, true); assert.notEqual(step?.skipped, true);
    }
    assert.deepEqual(cycle.officialPhase.sqliteStep.args, ["run", "postgres:sync"]);
    assert.deepEqual(cycle.modelReconciledSqliteStep.args, ["run", "postgres:sync"]);
    assert.equal(cycle.modelBacktestStep.decision.coverage.storage, "postgres");
    report.warehouse = (await pool.query(`SELECT (SELECT count(*)::int FROM football.match_snapshots WHERE dataset='current') AS current,
      (SELECT count(*)::int FROM football.odds_snapshots) AS odds,(SELECT count(*)::int FROM football.prediction_snapshots) AS predictions`)).rows[0];
    assert.equal(report.warehouse.current, 1); assert.ok(report.warehouse.odds >= 2); assert.ok(report.warehouse.predictions >= 1);
    report.ok = true;
  } catch (error) { report.error = error.message; }
  finally {
    trust?.cleanup(); await pool.end();
    // Keep failed fixtures for diagnosis. Successful cleanup unlinks the
    // node_modules junction first, never recursively traverses shared deps.
    if (report.ok) {
      const resolved = fs.realpathSync(temp);
      assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
      assert.ok(path.basename(resolved).startsWith("football-native-worker-cycle-"));
      fs.unlinkSync(path.join(app, "node_modules")); fs.rmSync(resolved, { recursive: true, force: true }); report.cleanup = true;
    } else report.fixtureDirectory = temp;
    fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(root, "outputs/native-worker-cycle-result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, scope: report.scope, elapsedMs: report.elapsedMs, cleanup: report.cleanup,
      productionWrites: 0, sqliteAttempts: report.trapEvents?.filter(event => event.kind === "sqlite").length,
      externalRequests: report.trapEvents?.filter(event => event.kind === "external-http").length, workerProcesses: report.trapEvents?.length,
      warehouse: report.warehouse, readiness: report.status?.lastCycle?.readinessSourceCycleObservation?.ready,
      warnings: report.status?.lastCycle?.warnings, error: report.error, fixtureDirectory: report.fixtureDirectory }));
    if (!report.ok) process.exitCode = 1;
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
