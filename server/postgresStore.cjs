"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(__dirname, "postgres", "migrations");

const boundedInteger = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
};

const postgresConnectionString = () => String(
  process.env.FOOTBALL_POSTGRES_URL || process.env.DATABASE_URL || "",
).trim();

const postgresEnabled = () => postgresConnectionString().length > 0;

const POSTGRES_MODES = Object.freeze(["disabled", "shadow-write", "shadow-read", "primary"]);

const postgresMode = (value = process.env.FOOTBALL_POSTGRES_MODE) => {
  const normalized = String(value || "disabled").trim().toLowerCase();
  return POSTGRES_MODES.includes(normalized) ? normalized : "disabled";
};

const postgresWriteEnabled = (value) => ["shadow-write", "shadow-read", "primary"].includes(
  postgresMode(value),
);

const postgresReadEnabled = (value) => ["shadow-read", "primary"].includes(postgresMode(value));

const postgresPrimary = (value) => postgresMode(value) === "primary";

const postgresSsl = (connectionString) => {
  const mode = String(process.env.FOOTBALL_POSTGRES_SSL_MODE || "verify-full").trim().toLowerCase();
  if (mode === "disable") return false;
  const local = /^(?:postgres(?:ql)?:\/\/)?(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i
    .test(connectionString);
  if (local && !process.env.FOOTBALL_POSTGRES_SSL_MODE) return false;
  if (mode === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
};

const createPostgresPool = (options = {}) => {
  const connectionString = String(options.connectionString || postgresConnectionString()).trim();
  if (!connectionString) {
    const error = new Error("FOOTBALL_POSTGRES_URL is required for PostgreSQL shadow mode");
    error.code = "POSTGRES_URL_MISSING";
    throw error;
  }
  return new Pool({
    connectionString,
    ssl: options.ssl === undefined ? postgresSsl(connectionString) : options.ssl,
    max: boundedInteger(options.max ?? process.env.FOOTBALL_POSTGRES_POOL_MAX, 8, 1, 32),
    min: boundedInteger(options.min ?? process.env.FOOTBALL_POSTGRES_POOL_MIN, 1, 0, 8),
    connectionTimeoutMillis: boundedInteger(
      options.connectionTimeoutMillis ?? process.env.FOOTBALL_POSTGRES_CONNECT_TIMEOUT_MS,
      8_000,
      1_000,
      30_000,
    ),
    idleTimeoutMillis: boundedInteger(
      options.idleTimeoutMillis ?? process.env.FOOTBALL_POSTGRES_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
    ),
    query_timeout: boundedInteger(
      options.queryTimeoutMillis ?? process.env.FOOTBALL_POSTGRES_QUERY_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
    ),
    application_name: String(options.applicationName || "football-predict-shadow"),
  });
};

const listMigrationFiles = () => fs.readdirSync(migrationsDir)
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((left, right) => left.localeCompare(right));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const withPostgresTransaction = async (pool, callback, options = {}) => {
  const client = await pool.connect();
  const isolationLevel = String(options.isolationLevel || "SERIALIZABLE").toUpperCase();
  if (!["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].includes(isolationLevel)) {
    client.release();
    throw new Error(`unsupported PostgreSQL isolation level: ${isolationLevel}`);
  }
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
};

const runPostgresMigrations = async (pool) => withPostgresTransaction(
  pool,
  async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-schema-migrations-v1"]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS football;
      CREATE TABLE IF NOT EXISTS football.schema_migrations (
        version text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = [];
    for (const fileName of listMigrationFiles()) {
      const version = fileName.replace(/\.sql$/i, "");
      const sql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
      const digest = sha256(sql);
      const existing = await client.query(
        "SELECT sha256 FROM football.schema_migrations WHERE version = $1",
        [version],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].sha256 !== digest) {
          const error = new Error(`applied PostgreSQL migration changed: ${version}`);
          error.code = "POSTGRES_MIGRATION_HASH_MISMATCH";
          throw error;
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO football.schema_migrations(version, sha256) VALUES ($1, $2)",
        [version, digest],
      );
      applied.push({ version, sha256: digest });
    }
    return { ok: true, rootDir, applied };
  },
);

const getPostgresHealth = async (pool) => {
  const startedAt = Date.now();
  const result = await pool.query(`
    SELECT
      current_database() AS database,
      current_setting('server_version') AS server_version,
      pg_is_in_recovery() AS in_recovery,
      now() AS checked_at
  `);
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    database: result.rows[0]?.database || null,
    serverVersion: result.rows[0]?.server_version || null,
    inRecovery: result.rows[0]?.in_recovery ?? null,
    checkedAt: result.rows[0]?.checked_at || new Date().toISOString(),
  };
};

module.exports = {
  POSTGRES_MODES,
  createPostgresPool,
  getPostgresHealth,
  listMigrationFiles,
  postgresConnectionString,
  postgresEnabled,
  postgresMode,
  postgresPrimary,
  postgresReadEnabled,
  postgresSsl,
  postgresWriteEnabled,
  runPostgresMigrations,
  sha256,
  withPostgresTransaction,
};
