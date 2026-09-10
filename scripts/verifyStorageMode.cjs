"use strict";
const assert = require("node:assert/strict");
const { readStorageMode, retiredSqliteStatus } = require("../server/storageMode.cjs");
const native = { FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary",
  DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0",
  PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres", POSTGRES_PROJECTION_SOURCE: "native-generation",
  FOOTBALL_POSTGRES_URL: "postgresql://localhost/synthetic-config-only" };
let checks = 0;
assert.deepEqual(readStorageMode({}), { mode: "hybrid", postgresOnly: false }); checks++;
assert.equal(readStorageMode(native).postgresOnly, true); checks++;
assert.throws(() => readStorageMode({ FOOTBALL_STORAGE_MODE: "typo" }), /unsupported/); checks++;
for (const key of Object.keys(native).filter(key => key !== "FOOTBALL_STORAGE_MODE")) {
  const missing = { ...native }; delete missing[key];
  assert.throws(() => readStorageMode(missing), /requires/); checks++;
}
assert.throws(() => readStorageMode({ ...native, ENABLE_SQLITE_EXPORT: "1" }), /ENABLE_SQLITE_EXPORT=0/); checks++;
assert.equal(readStorageMode({ ...native, FOOTBALL_POSTGRES_URL: "", DATABASE_URL: native.FOOTBALL_POSTGRES_URL }).postgresOnly, true); checks++;
assert.equal(retiredSqliteStatus().retired, true); checks++;
console.log(JSON.stringify({ ok: true, checks, databaseConnections: 0 }));
