"use strict";

// Opt-in only until the worker and release lifecycle have both been migrated.
// Reject partial configuration before opening a database or starting cron jobs.
const readStorageMode = (env = process.env) => {
  const mode = String(env.FOOTBALL_STORAGE_MODE || "hybrid").trim().toLowerCase();
  if (!["hybrid", "postgres-only"].includes(mode)) {
    throw new Error("unsupported FOOTBALL_STORAGE_MODE");
  }
  if (mode === "postgres-only") {
    const required = {
      FOOTBALL_POSTGRES_MODE: "primary",
      DATASTORE_READ_SOURCE: "postgres",
      CURRENT_MATCH_SOURCE: "postgres",
      ENABLE_SQLITE_EXPORT: "0",
      PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres",
      POSTGRES_PROJECTION_SOURCE: "native-generation",
    };
    for (const [name, expected] of Object.entries(required)) {
      if (String(env[name] ?? "").trim().toLowerCase() !== expected) {
        throw new Error(`postgres-only requires ${name}=${expected}`);
      }
    }
    if (!String(env.FOOTBALL_POSTGRES_URL || env.DATABASE_URL || "").trim()) {
      throw new Error("postgres-only requires a PostgreSQL connection URL");
    }
  }
  return Object.freeze({ mode, postgresOnly: mode === "postgres-only" });
};

const retiredSqliteStatus = () => ({
  available: false,
  retired: true,
  reason: "sqlite-retired-postgres-only",
  readSource: "postgres",
  counts: {},
  publication: null,
});

module.exports = { readStorageMode, retiredSqliteStatus };
