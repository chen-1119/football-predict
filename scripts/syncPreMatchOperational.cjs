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
  // Featured combos are a derived publication surface. Their own failure must
  // never block core schedule/odds publication. When they succeed, bind the
  // payload into sync-meta before generation so the page and featured picks
  // share one immutable publication identity.
  const featured = runNode("scripts/buildDailyFeaturedCombos.cjs");
  if (featured.error || featured.status !== 0) {
    process.stderr.write(`[daily-featured-combos] non-blocking failure: ${featured.error?.message || `exit ${featured.status}`}\n`);
  } else {
    const binding = runNode("scripts/publishDailyFeaturedToSyncMeta.cjs");
    if (binding.error || binding.status !== 0) {
      process.stderr.write(`[daily-featured-sync-meta] non-blocking failure: ${binding.error?.message || `exit ${binding.status}`}\n`);
    }
  }
}
