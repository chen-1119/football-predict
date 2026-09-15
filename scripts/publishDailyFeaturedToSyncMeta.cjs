"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const defaultDataDir = path.resolve(
  process.env.DATA_GENERATION_PUBLIC_DATA_DIR || path.join(rootDir, "public", "data"),
);

const readJson = (filePath, fallback) => {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
};

const atomicWriteJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temp, filePath);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
};

const publishDailyFeaturedToSyncMeta = ({
  now = new Date().toISOString(),
  dataDir = defaultDataDir,
} = {}) => {
  const resolvedDataDir = path.resolve(dataDir);
  const syncMetaPath = path.join(resolvedDataDir, "sync-meta.json");
  const featuredPath = path.join(resolvedDataDir, "daily-featured-combos.json");
  const syncMeta = readJson(syncMetaPath, null);
  const featured = readJson(featuredPath, null);
  if (!syncMeta || typeof syncMeta !== "object" || Array.isArray(syncMeta)) {
    throw new Error("daily featured publication requires readable sync-meta.json");
  }
  if (!featured || typeof featured !== "object" || Array.isArray(featured)) {
    throw new Error("daily featured publication requires daily-featured-combos.json");
  }
  const next = {
    ...syncMeta,
    dailyFeaturedCombos: featured,
    dailyFeaturedCombosPublication: {
      version: "daily-featured-sync-meta-binding-v1",
      boundAt: now,
      featuredGeneratedAt: featured.generatedAt || null,
      businessDate: featured.today?.businessDate || null,
      state: featured.today?.state || null,
    },
  };
  atomicWriteJson(syncMetaPath, next);
  return next.dailyFeaturedCombosPublication;
};

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...publishDailyFeaturedToSyncMeta() }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { publishDailyFeaturedToSyncMeta };
