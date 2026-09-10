"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { nativeStorageReadiness } = require("./nativeStorageReadiness.cjs");
const health = { data: { currentRead: { source: "postgres" } }, storage: { primary: "postgres",
  sqlite: { retired: true, available: false, readSource: "postgres" },
  postgres: { available: true, baseReady: true, publication: { mode: "active-generation", generationId: "g-" + "a".repeat(64),
    manifestHash: "b".repeat(64), sourceCycleId: "synthetic", committedAt: "2026-09-10T00:00:00.000Z" } }, fastResultIntegrity: { valid: true } } };
assert.equal(nativeStorageReadiness(health).ok, true);
let checks = 1;
for (const mutate of [h => { h.storage.primary = "sqlite"; }, h => { h.data.currentRead.source = "json"; },
  h => { h.storage.sqlite.retired = false; }, h => { h.storage.sqlite.available = true; },
  h => { h.storage.postgres.available = false; }, h => { h.storage.postgres.baseReady = false; },
  h => { delete h.storage.postgres.baseReady; },
  h => { h.storage.postgres.baseBlockedReason = "mismatch"; }, h => { h.storage.postgres.publication.manifestHash = ""; },
  h => { h.storage.postgres.publication.sourceCycleId = null; }, h => { h.storage.fastResultIntegrity.valid = false; }]) {
  const changed = structuredClone(health); mutate(changed); assert.equal(nativeStorageReadiness(changed).ok, false); checks++;
}
const env = { ...process.env, FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary", DATASTORE_READ_SOURCE: "postgres",
  CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0", PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres",
  POSTGRES_PROJECTION_SOURCE: "native-generation", FOOTBALL_POSTGRES_URL: "postgresql://127.0.0.1/never_connected" };
for (const [file, flags] of [
  ["verifyProductionReadiness.cjs", { VERIFY_REQUIRE_SQLITE: "1" }],
  ["verifyRemotePublicReadiness.cjs", { REMOTE_REQUIRE_POSTGRES_ONLY: "1", REMOTE_REQUIRE_SQLITE: "1" }],
  ["verifyCloudSyncFreshness.cjs", { CLOUD_SYNC_REQUIRE_POSTGRES_ONLY: "1", CLOUD_SYNC_REQUIRE_SQLITE_PARITY: "1" }],
]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env: { ...env, ...flags }, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /native .*cannot require/); checks++;
}
console.log(JSON.stringify({ ok: true, checks, productionWrites: 0, databaseConnections: 0 }));
