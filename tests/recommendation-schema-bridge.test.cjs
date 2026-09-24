"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const bridge = require("../deploy/light-server/recommendation-schema-bridge.cjs");

const root = path.resolve(__dirname, "..");
// Inspect only the pure SQL builder: importing cold recovery would execute its
// production root guard in ordinary, unprivileged CI.
const recoverySource = fs.readFileSync(path.join(root, "deploy/light-server/football-release-recovery.cjs"), "utf8");
const builderStart = recoverySource.indexOf("const buildDualResearchRollbackSql =");
const builderEnd = recoverySource.indexOf("const rollbackDualResearchSchemaIfNeeded =", builderStart);
assert(builderStart >= 0 && builderEnd > builderStart);
assert(recoverySource.includes("const sql = buildDualResearchRollbackSql(intent.migrationSha256, intent.migrationVersion);"));
const buildDualResearchRollbackSql = vm.runInNewContext(
  `${recoverySource.slice(builderStart, builderEnd)}\nbuildDualResearchRollbackSql;`,
  { fail(message) { throw new Error(message); } },
  { timeout: 1000 },
);
const signed = bridge.readSignedMigration();
const baseline = bridge.expectedBaseline();

function fixture({ rows = baseline, table = null, failAt = "" } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (failAt && sql.includes(failAt)) throw new Error("injected PostgreSQL failure");
      if (sql.startsWith("SELECT version,sha256")) return { rows };
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ name: table }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { pool: { async connect() { return client; } }, calls, get released() { return released; } };
}

test("014 applies only after the signed 001–013 baseline and commits table plus metadata", async () => {
  assert.equal(baseline.length, 13);
  assert.equal(baseline.at(-1).version, "013_dual_choice_research");
  const f = fixture();
  const result = await bridge.applyToPool(f.pool, signed, baseline);
  assert.equal(result.applied, true);
  assert.equal(result.sha256, signed.hash);
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert(f.calls.some(call => call.sql.includes("CREATE TABLE football.recommendation_dual_research_v2_records")));
  assert(f.calls.some(call => call.sql === "ALTER TABLE football.recommendation_dual_research_v2_records OWNER TO football"));
  assert.deepEqual(f.calls.find(call => call.sql.startsWith("INSERT INTO football.schema_migrations"))?.values,
    ["014_dual_choice_market_neutral", signed.hash]);
  assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.equal(f.released, true);
});

test("already-applied matching 014 is idempotent; partial or mismatched schemas fail closed", async () => {
  const installed = [...baseline, { version: bridge.VERSION, sha256: signed.hash }];
  const existing = fixture({ rows: installed, table: "football.recommendation_dual_research_v2_records" });
  assert.equal((await bridge.applyToPool(existing.pool, signed, baseline)).applied, false);
  assert(!existing.calls.some(call => call.sql.includes("CREATE TABLE")));
  for (const bad of [
    { rows: [...baseline.slice(0, -1), { ...baseline.at(-1), sha256: "0".repeat(64) }] },
    { table: "football.recommendation_dual_research_v2_records" },
    { rows: [...baseline, { version: bridge.VERSION, sha256: "0".repeat(64) }],
      table: "football.recommendation_dual_research_v2_records" },
  ]) {
    const f = fixture(bad);
    await assert.rejects(bridge.applyToPool(f.pool, signed, baseline));
    assert.equal(f.calls.at(-1).sql, "ROLLBACK");
    assert.equal(f.released, true);
  }
});

test("failed DDL rolls back and recovery drops only an empty v2 research table with its row", async () => {
  const f = fixture({ failAt: "CREATE TABLE football.recommendation_dual_research_v2_records" });
  await assert.rejects(bridge.applyToPool(f.pool, signed, baseline), /injected PostgreSQL failure/);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  const rollback = buildDualResearchRollbackSql(signed.hash);
  assert.match(rollback, /IF EXISTS \(SELECT 1 FROM football\.recommendation_dual_research_v2_records LIMIT 1\)/);
  assert(rollback.indexOf("DROP TABLE football.recommendation_dual_research_v2_records")
    < rollback.indexOf("DELETE FROM football.schema_migrations"));
  assert.doesNotMatch(rollback, /DROP TABLE football\.recommendation_dual_research_records;/);
  assert.match(rollback, /COMMIT;$/);
  assert.throws(() => buildDualResearchRollbackSql("wrong"));
  assert.throws(() => buildDualResearchRollbackSql(signed.hash, "015_untrusted"));
  const legacy = buildDualResearchRollbackSql("a".repeat(64), "013_dual_choice_research");
  assert.match(legacy, /DROP TABLE football\.recommendation_dual_research_records;/);
  assert.doesNotMatch(legacy, /DROP TABLE football\.recommendation_dual_research_v2_records;/);
  assert(recoverySource.includes("old app migration digest differs from rollback intent"));
});

test("signed native lane migrates candidate before reconciliation and live after stopping writers", () => {
  const lane = fs.readFileSync(path.join(root, "deploy/light-server/release-native.sh"), "utf8");
  const candidate = lane.indexOf('recommendation-schema-bridge.cjs" candidate "$BUNDLE_SHA256"');
  const live = lane.indexOf('recommendation-schema-bridge.cjs" live "$BUNDLE_SHA256"');
  assert(candidate > lane.indexOf("native_data seed"));
  assert(candidate < lane.indexOf("native_data build-access"));
  assert(candidate < lane.indexOf("run_candidate_model_artifact_catchup"));
  assert(live > lane.indexOf("stop_worker_for_release_window", lane.indexOf("release_stage_observe begin stopped-window") - 800));
  assert(live > lane.indexOf("stop_service_for_release_window"));
  assert(live < lane.indexOf("native_data final"));
  for (const file of ["scripts/createReleaseBundle.cjs", "scripts/verifyReleaseBundleSafety.cjs"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert(source.includes('"deploy/light-server/recommendation-schema-bridge.cjs"'));
    assert(source.includes('"server/postgres/migrations/013_dual_choice_research.sql"'));
    assert(source.includes('"server/postgres/migrations/014_dual_choice_market_neutral.sql"'));
  }
});
