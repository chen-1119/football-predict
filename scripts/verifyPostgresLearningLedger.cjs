"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const common = require("./modelLearningLedger.cjs");
const native = require("./postgresLearningLedger.cjs");
const migration = require("./importPostgresLearningLedger.cjs");
const { runAutonomousModelCyclePostgres } = require("./autonomousModelCycle.cjs");

async function verifyPostgresLearningLedger(pool) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-learning-")), checks = [];
  let repository;
  try {
    await assert.rejects(native.openPostgresLearningLedger({ pool }), /requires verified import/);
    const fixtureCode = `const c=require('./scripts/modelLearningLedger.cjs'),m=require('./scripts/importPostgresLearningLedger.cjs');
      const {db}=c.openLearningLedger(process.argv[1]);
      c.commitModelArtifact(db,{bytes:Buffer.from(' { "方向": "平局" } '),artifactType:'qa-original',createdAt:'2026-01-01T00:00:00.000Z'});
      c.appendLearningEvent(db,{cycleId:c.sha256('qa-legacy-cycle'),eventKey:c.sha256('qa-legacy-event'),eventType:'DATASET_DISCOVERED',state:'DATASET_DISCOVERED',occurredAt:'2026-01-01T00:00:00.000Z',actor:{type:'service',id:'qa-import'},payload:{original:'平局'}});
      c.acquireLearningLease(db,{holderId:'old-owner',now:'2026-01-01T00:00:00.000Z'});db.close();
      console.log(JSON.stringify(m.readSqliteLearningLedgerSnapshot(process.argv[1])));`;
    const fixture = spawnSync(process.execPath, ["-e", fixtureCode, path.join(temp, "legacy.db")], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    assert.equal(fixture.status, 0, fixture.stderr);
    const snapshot = JSON.parse(fixture.stdout);
    snapshot.artifacts.forEach(row => { row.artifact_bytes = Buffer.from(row.artifact_bytes); });
    const imported = await migration.importPostgresLearningLedger({ pool, snapshot });
    assert.equal(imported.ok, true); assert.equal(imported.idempotent, false);
    assert.equal((await migration.importPostgresLearningLedger({ pool, snapshot })).idempotent, true);
    const actual = await migration.readPostgresLearningLedgerSnapshot(pool);
    assert.equal(migration.fingerprint(actual), migration.fingerprint(snapshot));
    await assert.rejects(native.initializeEmptyLearningLedger({ pool, createdAt: "2026-02-01T00:00:00.000Z" }), /nonempty/);
    checks.push({ name: "real SQLite learning audit imports byte-for-byte once and refuses empty reset", ok: true });
    repository = await native.openPostgresLearningLedger({ pool });
    assert.equal((await repository.verifyLearningLedger()).valid, true);
    const { evaluateResidualMarketWalkForward } = require("./residualMarketWalkForward.cjs");
    const { FEATURE_SCHEMA_VERSION } = require("./residualMarketModel.cjs");
    const outcomes = ["1", "X", "2"], start = Date.parse("2025-01-01T00:00:00.000Z");
    const rows = Array.from({ length: 42 }, (_, i) => {
      const actual = outcomes[i % 3], forecastTime = new Date(start + i * 86400000).toISOString();
      return { sourceMatchId: "qa-native-learning-" + i, forecastTime, resultObservedAt: new Date(start + i * 86400000 + 3600000).toISOString(),
        resultObservedAtFallback: false, actual, marketProbabilities: { "1": .5, X: .3, "2": .2 },
        currentModelProbabilities: Object.fromEntries(outcomes.map(code => [code, code === actual ? .86 : .07])), currentModelObservedAt: forecastTime };
    });
    const evaluation = { version: "qa-native-learning", generatedAt: "2026-01-01T00:00:00.000Z",
      residualMarketWalkForward: evaluateResidualMarketWalkForward(rows, { minTrainingRows: 12, holdoutRows: 6, minFolds: 3, iterations: 80, learningRate: .05 }),
      inputAudit: { ok: true, promotionEligible: false }, promotionEvidenceAudit: { manifest: { promotionEligible: false, eligibleRows: 0, conflictingDuplicateKeys: 0, manifestHash: common.sha256("qa-no-promotion") } },
      recommendationSelection: { gate: { eligible: false } }, riskTiers: { overall: { tier: "research" } } };
    const at = "2026-02-01T00:00:00.000Z";
    const options = { repository, anchorFile: path.join(temp, "native-head.json"), evaluation,
      contract: { inferenceImplementationHash: common.sha256(fs.readFileSync(path.join(__dirname, "residualMarketModel.cjs"))), featureSchemaVersion: FEATURE_SCHEMA_VERSION, policyVersion: "multi-factor-market-evidence-v2" },
      runAt: at, clock: () => at, holderId: "qa-native-learning" };
    const before = await repository.activeModelPointer();
    const result = await runAutonomousModelCyclePostgres(options);
    assert.equal(result.ok, true); assert.equal(result.status, "registered-shadow"); assert.equal(result.leaseReleased, true);
    assert.deepEqual(await repository.activeModelPointer(), before);
    const repeated = await runAutonomousModelCyclePostgres(options);
    assert.equal(repeated.ledger.events, result.ledger.events); assert.equal(repeated.anchor.headEventHash, result.anchor.headEventHash);
    await assert.rejects(migration.importPostgresLearningLedger({ pool, snapshot }), /nonidentical/);
    checks.push({ name: "native autonomous cycle registers a real shadow candidate idempotently without activating or overwriting imported audit", ok: true });
    await assert.rejects(repository.appendLearningEvent({ cycleId: common.sha256("x"), eventKey: common.sha256("p"), state: "PROMOTED", eventType: "PROMOTED" }), error => error.code === "PRIVILEGED_EVENT_REQUIRED");
    const lease = await repository.acquireLearningLease({ leaseName: "qa-fence", holderId: "first", now: at });
    assert.equal((await repository.acquireLearningLease({ leaseName: "qa-fence", holderId: "second", now: at })).acquired, false);
    await assert.rejects(repository.appendLearningEvent({ cycleId: common.sha256("fence"), eventKey: common.sha256("fence-event"), state: "DATASET_DISCOVERED", eventType: "DATASET_DISCOVERED",
      occurredAt: at, actor: { type: "service", id: "second" }, lease: { ...lease, holderId: "second", checkedAt: at } }), error => error.code === "LEASE_FENCE_MISMATCH");
    assert.equal((await repository.releaseLearningLease(lease)).released, true);
    checks.push({ name: "native shadow repository refuses privileged promotion and stale lease ownership", ok: true });
    const event = (await pool.query("SELECT sequence,payload_json FROM football.learning_events ORDER BY sequence LIMIT 1")).rows[0];
    try {
      await pool.query("UPDATE football.learning_events SET payload_json='{}' WHERE sequence=$1", [event.sequence]);
      const countBefore = (await pool.query("SELECT count(*) n FROM football.learning_events")).rows[0].n;
      await assert.rejects(runAutonomousModelCyclePostgres(options), /preflight verification/);
      assert.equal((await pool.query("SELECT count(*) n FROM football.learning_events")).rows[0].n, countBefore);
    } finally { await pool.query("UPDATE football.learning_events SET payload_json=$1 WHERE sequence=$2", [event.payload_json, event.sequence]); }
    checks.push({ name: "corrupt prior learning audit is rejected before any new event is appended", ok: true });
    return { ok: true, checks, legacyFixtureSqliteProcesses: 1, nativeRuntimeSqliteAccess: 0 };
  } finally {
    await repository?.close();
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-native-learning-")); fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyPostgresLearningLedger };
