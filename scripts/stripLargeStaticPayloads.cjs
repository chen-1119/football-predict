const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const disabledPayloads = [
  "matches.json",
  "odds-history.json",
  "data/matches-current.json",
  "data/matches-history.json",
  "data/odds-history.json",
  "data/post-match-reviews.json",
  "data/external-signals.json",
  "data/five-hundred-details.json",
  "data/pre-match-signals.json",
  "data/prediction-snapshots.json",
  "data/model-calibration.json",
  "data/model-strategy.json",
  "data/api-football-cache.json",
  "data/api-football-meta.json",
  "data/gpt-predictions.json",
  "data/web-consensus-signals.json",
  "data/weather-locations.json",
  "data/worldcup-kimi-dataset.json"
];

const removed = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const removeFile = (relativePath) => {
  const filePath = path.join(distDir, relativePath);
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  fs.rmSync(filePath, { force: true });
  removed.push({ path: relativePath.replace(/\\/g, "/"), bytes: stat.size });
};

const stripOnce = () => {
  for (const relativePath of disabledPayloads) {
    removeFile(relativePath);
  }

  const dataDir = path.join(distDir, "data");
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir)) {
      if (/^external-signals\.json\.tmp-/i.test(entry)) {
        removeFile(path.join("data", entry));
      }
    }
  }
};

const run = async () => {
  // Vite's public-dir copy can lag after closeBundle on Windows when very large
  // JSON files are involved. Keep scanning for a fixed window so late copies
  // cannot reintroduce protected snapshots after the build script exits.
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    stripOnce();
    await sleep(500);
  }

  stripOnce();

  console.log(JSON.stringify({
    ok: true,
    removedCount: removed.length,
    removed
  }, null, 2));
};

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
