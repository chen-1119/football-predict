"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const runNode = (script) => spawnSync(process.execPath, [path.join(rootDir, script)], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
});

const preMatch = runNode("scripts/syncPreMatchSignals.cjs");
if (preMatch.error || preMatch.status !== 0) {
  if (preMatch.error) process.stderr.write(`[prematch] ${preMatch.error.message || preMatch.error}\n`);
  process.exitCode = Number.isInteger(preMatch.status) ? preMatch.status : 1;
} else {
  // Featured combos are a derived publication surface. A combo-selection bug
  // must never prevent the core schedule/odds generation from being published.
  // Its own CLI writes a failure status file so monitoring can alert separately.
  const featured = runNode("scripts/buildDailyFeaturedCombos.cjs");
  if (featured.error || featured.status !== 0) {
    process.stderr.write(`[daily-featured-combos] non-blocking failure: ${featured.error?.message || `exit ${featured.status}`}\n`);
  }
}
