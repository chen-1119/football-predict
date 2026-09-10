"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
// A production-shaped but deliberately unreachable DB catches accidental
// inheritance without ever giving the fixture a real database credential.
const productionShapedEnvironment = {
  ...process.env,
  FOOTBALL_POSTGRES_MODE: "primary",
  FOOTBALL_POSTGRES_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  FOOTBALL_POSTGRES_SSL_MODE: "disable",
  DATASTORE_READ_SOURCE: "postgres",
  CURRENT_MATCH_SOURCE: "postgres",
  FOOTBALL_STORAGE_MODE: "postgres-only",
  PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres",
  POSTGRES_PROJECTION_SOURCE: "native-generation",
  ENABLE_SQLITE_EXPORT: "0",
};
// A fixture's own isolated backend is not the deployment's runtime backend.
// Check both production shapes; no actual production credential is inherited.
const environments = [productionShapedEnvironment, { ...productionShapedEnvironment, FOOTBALL_STORAGE_MODE: "hybrid",
  PRIVATE_MODEL_ARTIFACT_STORAGE: "sqlite", POSTGRES_PROJECTION_SOURCE: "sqlite", ENABLE_SQLITE_EXPORT: "1" }];
const checks = [
  "verifyPostgresMigrationPlan.cjs",
  "verifyAccessCodeConcurrency.cjs",
  "verifySportteryRelayFullRecovery.cjs",
].flatMap((script) => environments.map(env => {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: rootDir, env, encoding: "utf8", windowsHide: true,
    timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
  });
  let payload = null;
  try { payload = JSON.parse(result.stdout || "null"); } catch { /* Fail closed below. */ }
  const ok = result.status === 0 && payload?.ok === true;
  return {
    script, inheritedStorage: env.FOOTBALL_STORAGE_MODE, ok, status: result.status, signal: result.signal || null,
    ...(ok ? {} : {
      error: result.error?.message || null,
      stdoutTail: result.stdout?.slice(-3000) || "",
      stderrTail: result.stderr?.slice(-3000) || "",
    }),
  };
}));
const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), checks }, null, 2));
if (!ok) process.exitCode = 1;
