"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { spawn } = require("node:child_process");
const monitor = require("./checkServerRuntime.cjs");
const settings = { FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary", FOOTBALL_POSTGRES_URL: "postgresql://127.0.0.1/never_connected",
  DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0",
  PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres", POSTGRES_PROJECTION_SOURCE: "native-generation" };
async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-monitor-")), checks = [];
  let server, child;
  try {
    assert.equal(monitor.resolveMonitorStorageMode(settings).postgresOnly, true);
    assert.throws(() => monitor.runSqliteRepairCommands({ env: settings, commandRunner: () => { throw Error("must not run"); } }), /retired SQLite repair is forbidden/);
    checks.push({ name: "native configuration refuses direct legacy repair before starting a subprocess", ok: true });
    const auth = path.join(temp, "env"), preload = path.join(temp, "preload.cjs"), probe = path.join(temp, "probe.json");
    fs.writeFileSync(auth, Object.entries({ ...settings, ADMIN_TOKEN: "synthetic-never-log-this-admin" }).map(([k, v]) => `${k}=${v}`).join("\n"));
    fs.writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs'),load=Module._load;let sqlite=0,commands=0;
      Module._load=function(name,...args){if(name==='node:sqlite'){sqlite++;throw Error('retired SQLite forbidden');}
      const value=load.call(this,name,...args);if(name==='node:child_process')return {...value,spawnSync(){commands++;throw Error('monitor rebuild forbidden');}};return value;};
      process.on('exit',()=>fs.writeFileSync(process.env.QA_MONITOR_PROBE,JSON.stringify({sqlite,commands})));`);
    let scenario = "healthy";
    server = http.createServer((req, res) => {
      const health = { apiVersion: "v1", status: { serviceOk: true, dataFresh: true, sourceHealthOk: true, sourceDataFresh: true,
        primarySourceFresh: true, servingMode: "primary", recommendationReliable: false, officialSourceSinglePoint: false },
        sync: { running: true }, data: { currentRead: { source: "postgres" } }, storage: { primary: "postgres",
          sqlite: { retired: scenario !== "legacy-returned", available: scenario === "legacy-returned", readSource: "postgres" },
          postgres: { available: true, baseReady: true, publication: { mode: "active-generation", generationId: "g-" + "a".repeat(64),
            manifestHash: "b".repeat(64), sourceCycleId: "synthetic-monitor", committedAt: "2026-09-10T00:00:00.000Z" } },
          fastResultIntegrity: { valid: scenario !== "corrupt-receipt" } } };
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/api/v1/health" ? health : { ok: true, sources: {} }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    for (scenario of ["healthy", "corrupt-receipt", "legacy-returned"]) {
      const env = { ...process.env, RUNTIME_MONITOR_AUTH_FILE: auth, SERVER_STORE_DIR: temp, RUNTIME_MONITOR_STATUS_PATH: path.join(temp, "status.json"),
        RUNTIME_MONITOR_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNTIME_MONITOR_REQUIRE_SQLITE: "1", RUNTIME_MONITOR_AUTO_REPAIR_SQLITE: "1",
        RUNTIME_MONITOR_CHECK_SYSTEMD: "0", RUNTIME_MONITOR_CHECK_DISK: "0", RUNTIME_MONITOR_CHECK_CLEANUP: "0", RUNTIME_MONITOR_CHECK_MODEL_EVALUATION: "0",
        RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT: "0", QA_MONITOR_PROBE: probe, NODE_OPTIONS: "" };
      for (const key of Object.keys(settings)) delete env[key];
      child = spawn(process.execPath, ["--require", preload, path.join(__dirname, "checkServerRuntime.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      const timer = setTimeout(() => child?.kill("SIGKILL"), 15000);
      await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
      child = null;
      assert.equal(stderr, ""); const result = JSON.parse(stdout);
      const proof = result.checks.find(row => row.name === "PostgreSQL-only primary read");
      assert.equal(proof.status, scenario === "healthy" ? "ok" : "failed");
      assert.equal(result.checks.find(row => row.name === "native projection reconciliation owner").monitorDatabaseWrites, 0);
      assert.equal(result.checks.some(row => row.name === "sqlite primary read"), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(probe)), { sqlite: 0, commands: 0 });
      assert.equal(stdout.includes("synthetic-never-log-this-admin"), false);
      checks.push({ name: `actual native monitor ${scenario} reports storage state without SQLite, subprocess rebuild or credential exposure`, ok: true });
    }
    return { ok: true, checks, productionWrites: 0 };
  } finally {
    if (child) child.kill("SIGKILL");
    if (server) await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-native-monitor-")); fs.rmSync(resolved, { recursive: true, force: true });
  }
}
run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
