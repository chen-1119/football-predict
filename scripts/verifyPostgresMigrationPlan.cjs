"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  listMigrationFiles,
  migrationSha256,
  postgresSsl,
  sha256,
} = require("../server/postgresStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const migrationPath = path.join(rootDir, "server", "postgres", "migrations", "001_core.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
const projectionMigrationPath = path.join(rootDir, "server", "postgres", "migrations", "002_projection_runtime.sql");
const projectionSql = fs.readFileSync(projectionMigrationPath, "utf8");
const orderPreservingMigrationPath = path.join(rootDir, "server", "postgres", "migrations", "003_order_preserving_payloads.sql");
const orderPreservingSql = fs.readFileSync(orderPreservingMigrationPath, "utf8");
const freeSourceMigrationPath = path.join(rootDir, "server", "postgres", "migrations", "004_free_source_warehouse.sql");
const freeSourceSql = fs.readFileSync(freeSourceMigrationPath, "utf8");
const nativeTableGroups = {
  "005_learning_ledger.sql": ["learning_ledger_meta", "learning_model_artifacts", "learning_events", "learning_active_model_pointer", "learning_leases"],
  "006_research_observations.sql": ["research_observation_meta", "research_source_contents", "research_observations"],
};
for (const [file, tables] of Object.entries(nativeTableGroups)) {
  const nativeSql = fs.readFileSync(path.join(rootDir, "server", "postgres", "migrations", file), "utf8");
  for (const table of tables) assert.match(nativeSql, new RegExp(`CREATE TABLE football\\.${table}\\s*\\(`));
  assert.doesNotMatch(nativeSql, /\b(?:DROP|TRUNCATE)\b/i);
}
const projectionStore = fs.readFileSync(path.join(rootDir, "server", "postgresProjectionStore.cjs"), "utf8");
const projectionSync = fs.readFileSync(path.join(rootDir, "scripts", "postgresProjectionSync.cjs"), "utf8");
const server = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
const signedRelease = fs.readFileSync(path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh"), "utf8");
const legacyRelease = fs.readFileSync(path.join(rootDir, "deploy", "light-server", "release.sh"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const {
  dedupeSemanticReviews,
  normalizeAiDecisionTimestamps,
} = require("./postgresProjectionSync.cjs");
const requiredTables = [
  "publications",
  "source_snapshots",
  "match_snapshots",
  "odds_snapshots",
  "prediction_snapshots",
  "frozen_recommendations",
  "result_observations",
  "post_match_reviews",
  "formal_review_daily",
  "ai_competitors",
  "ai_decisions",
  "ai_score_ledger",
];

assert.deepEqual(listMigrationFiles(), [
  "001_core.sql",
  "002_projection_runtime.sql",
  "003_order_preserving_payloads.sql",
  "004_free_source_warehouse.sql",
  "005_learning_ledger.sql",
  "006_research_observations.sql",
]);
for (const table of requiredTables) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS football\\.${table}\\s*\\(`));
}
assert.match(sql, /publications_single_current/);
assert.match(sql, /decision_hash text NOT NULL UNIQUE/);
assert.match(sql, /UNIQUE \(competition_id, competitor_id, match_id\)/);
assert.match(sql, /idempotency_key text NOT NULL UNIQUE/);
assert.match(sql, /risk_tier = 'skip' AND stake = 0/);
assert.match(sql, /settled integer GENERATED ALWAYS AS \(won \+ lost\) STORED/);
// Test each policy explicitly instead of inheriting the deployment host's
// local-PostgreSQL TLS setting. Restore it before any later verifier work.
const priorSslMode = process.env.FOOTBALL_POSTGRES_SSL_MODE;
try {
  delete process.env.FOOTBALL_POSTGRES_SSL_MODE;
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(postgresSsl(`postgresql://${host}/football`), false);
  }
  assert.deepEqual(postgresSsl("postgresql://db.example.com/football"), { rejectUnauthorized: true });
  for (const [mode, expected] of [
    ["disable", false],
    ["require", { rejectUnauthorized: false }],
    ["verify-full", { rejectUnauthorized: true }],
  ]) {
    process.env.FOOTBALL_POSTGRES_SSL_MODE = mode;
    for (const host of ["localhost", "db.example.com"]) {
      assert.deepEqual(postgresSsl(`postgresql://${host}/football`), expected);
    }
  }
} finally {
  if (priorSslMode === undefined) delete process.env.FOOTBALL_POSTGRES_SSL_MODE;
  else process.env.FOOTBALL_POSTGRES_SSL_MODE = priorSslMode;
}
assert.equal(sha256("football").length, 64);
const appliedMigrationHashes = Object.freeze({
  "001_core.sql": "3580fecee8d500cb0851899c858cd1aaf90c321978cba1c8bbfc224c5f6e8b7c",
  "002_projection_runtime.sql": "519987f10bd74c4a6c89ec6c639cd65af3040d7ae0159ede9b20abad9e47849b",
  "003_order_preserving_payloads.sql": "bae14fe5304c7730629122070f737b61facda435ad5e31cfbc3961da30d319ec",
  "004_free_source_warehouse.sql": "1497ac6ef7fec4f4b291ce3c211375bbb9f08d9d905e1a3abdaf994a3f83a37f",
});
for (const [fileName, expectedHash] of Object.entries(appliedMigrationHashes)) {
  const migrationSql = fs.readFileSync(path.join(rootDir, "server", "postgres", "migrations", fileName), "utf8");
  assert.equal(migrationSha256(migrationSql), expectedHash, `${fileName} must remain immutable`);
  assert.equal(
    migrationSha256(migrationSql.replace(/\r?\n/g, "\r\n")),
    expectedHash,
    `${fileName} hash must be stable across LF and CRLF release worktrees`,
  );
}
assert.notEqual(
  migrationSha256("SELECT 'line one\rline two';\n"),
  migrationSha256("SELECT 'line one\nline two';\n"),
  "a lone CR must remain a migration-integrity-significant byte",
);
for (const table of ["projection_meta", "projection_runs", "private_model_artifacts"]) {
  assert.match(projectionSql, new RegExp(`CREATE TABLE IF NOT EXISTS football\\.${table}\\s*\\(`));
}
for (const table of [
  "publications",
  "source_snapshots",
  "match_snapshots",
  "odds_snapshots",
  "prediction_snapshots",
  "frozen_recommendations",
  "result_observations",
  "post_match_reviews",
  "ai_decisions",
  "ai_score_ledger",
  "private_model_artifacts",
]) {
  assert.match(orderPreservingSql, new RegExp(`ALTER TABLE football\\.${table}\\s`));
}
assert.doesNotMatch(orderPreservingSql, /TYPE jsonb/);
for (const table of [
  "data_sources",
  "data_ingest_runs",
  "historical_teams",
  "historical_team_aliases",
  "historical_competitions",
  "historical_matches",
  "historical_source_events",
  "historical_result_observations",
  "historical_odds_observations",
  "historical_feature_snapshots",
  "data_source_conflicts",
]) {
  assert.match(freeSourceSql, new RegExp(`CREATE TABLE IF NOT EXISTS football\\.${table}\\s*\\(`));
}
assert.match(freeSourceSql, /CREATE OR REPLACE VIEW football\.historical_resolved_results/);
assert.match(projectionSync, /jsonColumns\.map\(\(column\) => \[column, "json"\]\)/);
assert.match(projectionSync, /\$5::json, \$6/);
assert.match(projectionSync, /BEGIN/);
assert.match(projectionSync, /pg_advisory_xact_lock/);
assert.match(projectionSync, /source-fingerprint-unchanged/);
assert.match(projectionSync, /persistSemanticRows/);
assert.match(projectionSync, /persistAiArena/);
assert.match(projectionSync, /ON CONFLICT \(match_id, decision_id\) DO UPDATE SET/);
assert.match(projectionSync, /review_id = EXCLUDED\.review_id/);
const semanticReviewRows = dedupeSemanticReviews([
  {
    review_id: "review:old",
    match_id: "match:1",
    decision_id: "decision:1",
    settled_at: "2026-08-20T01:00:00.000Z",
    payload: JSON.stringify({ generatedAt: "2026-08-20T01:00:00.000Z" }),
  },
  {
    review_id: "review:new",
    match_id: "match:1",
    decision_id: "decision:1",
    settled_at: "2026-08-20T01:00:00.000Z",
    payload: JSON.stringify({ generatedAt: "2026-08-20T02:00:00.000Z" }),
  },
]);
assert.equal(semanticReviewRows.length, 1);
assert.equal(semanticReviewRows[0].review_id, "review:new");
const lockedDecisionTimes = normalizeAiDecisionTimestamps({
  forecast: {},
  agent: { submittedAt: "2026-08-21T05:37:51.130Z" },
  arena: {
    lockedAt: "2026-08-21T05:37:51.130Z",
    generatedAt: "2026-08-21T05:47:24.866Z",
  },
});
assert.equal(lockedDecisionTimes.decidedAt, "2026-08-21T05:37:51.130Z");
assert.equal(lockedDecisionTimes.lockedAt, "2026-08-21T05:37:51.130Z");
const clampedDecisionTimes = normalizeAiDecisionTimestamps({
  forecast: { decidedAt: "2026-08-21T05:50:00.000Z" },
  agent: {},
  arena: { lockedAt: "2026-08-21T05:37:51.130Z" },
});
assert.equal(clampedDecisionTimes.decidedAt, clampedDecisionTimes.lockedAt);
assert.match(projectionSync, /SET active = FALSE/);
assert.match(projectionSync, /NOT \(competitor_id = ANY\(\$1::text\[\]\)\)/);
assert.match(projectionSync, /if \(activeIds\.length === 0\) return 0/);
assert.match(projectionStore, /readPostgresCurrentMatches/);
assert.match(projectionStore, /readPostgresHistoryMatchesPage/);
assert.match(projectionStore, /readPostgresFastResultReceiptState/);
assert.match(server, /shouldPreferPostgresRead/);
assert.match(
  server,
  /const serveInitialFromPublication = !includeTransitionRows\s*&& Boolean\(basePublication\.context\)\s*&& !shouldPreferSqliteRead\(\)\s*&& !shouldPreferPostgresRead\(\)/,
);
assert.match(server, /postgres-primary-sqlite-fallback/);
assert.match(server, /ensurePostgresRuntime/);
for (const releaseSource of [signedRelease, legacyRelease]) {
  assert.match(releaseSource, /persisted_postgres_mode/);
  assert.match(releaseSource, /if \[ "\$persisted_postgres_mode" = "primary" \]/);
  assert.match(releaseSource, /set_env_value "\$env_file" "CURRENT_MATCH_SOURCE" "\$PRIMARY_READ_SOURCE"/);
  assert.match(releaseSource, /set_env_value "\$env_file" "DATASTORE_READ_SOURCE" "\$PRIMARY_READ_SOURCE"/);
  assert.match(releaseSource, /"\$NODE_HOME\/bin\/npm" run postgres:migrate-schema/);
  assert.match(releaseSource, /FOOTBALL_POSTGRES_QUERY_TIMEOUT_MS=300000/);
  assert.match(releaseSource, /"\$NODE_HOME\/bin\/npm" run postgres:backfill/);
  assert.match(releaseSource, /VERIFY_REQUIRED_READ_SOURCE="\$PRIMARY_READ_SOURCE"/);
  assert.match(releaseSource, /REMOTE_REQUIRED_READ_SOURCE="\$PRIMARY_READ_SOURCE"/);
}
assert.equal(packageJson.scripts["postgres:backfill"], "node scripts/syncPostgresProjection.cjs --backfill");
assert.equal(packageJson.scripts["postgres:sync"], "node scripts/syncPostgresProjection.cjs --mode=incremental");
assert.match(packageJson.scripts["datastore:sqlite"], /syncPostgresProjection\.cjs --if-enabled/);

console.log(JSON.stringify({
  ok: true,
  verifier: "postgres-migration-plan",
  migrations: listMigrationFiles().map(file => `server/postgres/migrations/${file}`),
  tables: requiredTables.length + 14 + Object.values(nativeTableGroups).flat().length,
  guarantees: [
    "single-current-publication",
    "immutable-decision-hash",
    "one-ai-decision-per-match",
    "idempotent-score-ledger",
    "zero-stake-skip-supported",
    "strict-formal-hit-rate-denominator",
    "verified-tls-default",
    "transactional-sqlite-to-postgres-projection",
    "generation-affinity-read-gate",
    "postgres-primary-sqlite-fallback",
    "postgres-primary-current-list-read-source",
    "semantic-review-and-ai-ledger-backfill",
    "semantic-review-idempotence-by-match-and-decision",
    "ai-decision-time-never-after-lock",
    "order-preserving-hash-bound-json-payloads",
    "postgres-primary-release-read-source-preserved",
    "postgres-primary-release-migrated-and-backfilled-before-readiness",
    "free-source-observations-retain-source-authority-and-conflicts",
  ],
}, null, 2));
