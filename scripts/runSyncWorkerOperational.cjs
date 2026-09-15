"use strict";

const path = require("node:path");
const childProcess = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const originalSpawn = childProcess.spawn.bind(childProcess);
const REPLACEMENTS = new Map([
  ["reconcile:fast-results-generation", "scripts/reconcileFastResultGenerationCompat.cjs"],
  ["sync:prematch", "scripts/syncPreMatchOperational.cjs"],
]);
const PROJECTION_SCRIPTS = new Set(["postgres:sync", "postgres:sync-fast", "datastore:sqlite"]);

const npmScriptName = (command, args) => {
  const executable = path.basename(String(command || "")).toLowerCase();
  if (!executable.startsWith("npm") || !Array.isArray(args) || args[0] !== "run") return null;
  return String(args[1] || "").trim() || null;
};

childProcess.spawn = function operationalSpawn(command, args = [], options = {}) {
  const script = npmScriptName(command, args);
  const replacement = script ? REPLACEMENTS.get(script) : null;
  const child = replacement
    ? originalSpawn(process.execPath, [path.join(rootDir, replacement)], {
        ...options,
        cwd: options.cwd || rootDir,
      })
    : originalSpawn(command, args, options);

  if (script && PROJECTION_SCRIPTS.has(script)) {
    child.once("close", (code) => {
      if (code !== 0) return;
      const completedAt = new Date().toISOString();
      const env = {
        ...process.env,
        ...(options.env || {}),
        REALTIME_PROJECTION_COMPLETED_AT: completedAt,
      };
      const health = originalSpawn(
        process.execPath,
        [path.join(rootDir, "scripts", "writeRealtimePublicationHealth.cjs")],
        { cwd: rootDir, env, stdio: "ignore" },
      );
      health.unref?.();
    });
  }
  return child;
};

const { main } = require("./runSyncWorker.cjs");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
