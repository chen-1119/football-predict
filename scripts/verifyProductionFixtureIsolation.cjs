"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
// A production-shaped but deliberately unreachable DB catches accidental
// inheritance without ever giving the fixture a real database credential.
const env = {
  ...process.env,
  FOOTBALL_POSTGRES_MODE: "primary",
  FOOTBALL_POSTGRES_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  FOOTBALL_POSTGRES_SSL_MODE: "disable",
  DATASTORE_READ_SOURCE: "postgres",
};
const checks = [
  "verifyPostgresMigrationPlan.cjs",
  "verifyAccessCodeConcurrency.cjs",
  "verifySportteryRelayFullRecovery.cjs",
].map((script) => {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: rootDir, env, encoding: "utf8", windowsHide: true,
    timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
  });
  let payload = null;
  try { payload = JSON.parse(result.stdout || "null"); } catch { /* Fail closed below. */ }
  const ok = result.status === 0 && payload?.ok === true;
  return {
    script, ok, status: result.status, signal: result.signal || null,
    ...(ok ? {} : {
      error: result.error?.message || null,
      stdoutTail: result.stdout?.slice(-3000) || "",
      stderrTail: result.stderr?.slice(-3000) || "",
    }),
  };
});
const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), checks }, null, 2));
if (!ok) process.exitCode = 1;
