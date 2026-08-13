const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const syncMetaPath = path.resolve(
  process.argv[2]
  || process.env.SYNC_META_PATH
  || path.join(rootDir, "public", "data", "sync-meta.json")
);
const syncDataPath = path.join(rootDir, "scripts", "syncData.cjs");

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const isIsoTime = (value) => Number.isFinite(Date.parse(value || ""));

const maxAgeConfig = [
  ["CURRENT_LANE_MAX_AGE_MINUTES", process.env.CURRENT_LANE_MAX_AGE_MINUTES],
  ["SPORTTERY_RELAY_MAX_AGE_MINUTES", process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES],
  ["SOURCE_MAX_AGE_MINUTES", process.env.SOURCE_MAX_AGE_MINUTES],
].find(([, value]) => String(value ?? "").trim()) || ["default", "20"];
const maxAgeMinutes = Number(maxAgeConfig[1]);
const maxFutureSkewMinutes = Number(process.env.CURRENT_LANE_MAX_FUTURE_SKEW_MINUTES ?? 5);
const verifyNowInput = process.env.CURRENT_LANE_VERIFY_NOW || new Date().toISOString();
const verifyNowMs = Date.parse(verifyNowInput);
const verifiedNow = Number.isFinite(verifyNowMs) ? new Date(verifyNowMs).toISOString() : null;
const ageLimitsValid = Number.isFinite(maxAgeMinutes)
  && maxAgeMinutes > 0
  && Number.isFinite(maxFutureSkewMinutes)
  && maxFutureSkewMinutes >= 0;

const checks = [];
const pushCheck = (name, ok, details = {}) => {
  checks.push({ name, ok: Boolean(ok), ...details });
};

const syncMeta = readJson(syncMetaPath);
const syncData = readText(syncDataPath);
const api = syncMeta?.api || {};
const fallbackCoverage = api.fallbackCoverage || {};
const currentSportteryMatches = Number(
  fallbackCoverage.currentSportteryMatches
  ?? fallbackCoverage.sportteryPublishableMatches
  ?? 0
);
const currentLaneFresh = fallbackCoverage.currentLaneFresh === true || currentSportteryMatches > 0;
const currentFreshnessTime = api.currentFreshnessTime || null;
const currentFreshnessMs = Date.parse(currentFreshnessTime || "");
const currentAgeMs = Number.isFinite(verifyNowMs) && Number.isFinite(currentFreshnessMs)
  ? verifyNowMs - currentFreshnessMs
  : null;
const currentAgeSeconds = currentAgeMs === null ? null : Number((currentAgeMs / 1000).toFixed(3));
const currentTimestampFresh = ageLimitsValid
  && currentAgeMs !== null
  && currentAgeMs >= -maxFutureSkewMinutes * 60 * 1000
  && currentAgeMs <= maxAgeMinutes * 60 * 1000;
const sourceTimes = [
  api.sourceUpdatedAt,
  syncMeta?.updatedAt,
  syncMeta?.capturedAt,
  api.relaySnapshot?.capturedAt,
].filter(Boolean);

pushCheck("sync meta exists", Boolean(syncMeta), { path: syncMetaPath });
pushCheck("sync meta has current lane fields", Boolean(api.currentFreshnessTime)
  && typeof api.currentStale === "boolean"
  && Boolean(api.fallbackCoverage), {
  currentFreshnessTime: api.currentFreshnessTime || null,
  currentStale: api.currentStale ?? null,
  servingMode: fallbackCoverage.servingMode || null,
});
pushCheck("sync data separates current lane from odds lane", syncData.includes("currentLaneHasFreshSporttery")
  && syncData.includes("freshCurrentSportteryMatches")
  && syncData.includes("officialOddsStale"), {
  file: "scripts/syncData.cjs",
});
pushCheck("current freshness timestamp is parseable", isIsoTime(currentFreshnessTime), {
  currentFreshnessTime,
});
pushCheck("freshness verification time is parseable", Number.isFinite(verifyNowMs), {
  configuredNow: process.env.CURRENT_LANE_VERIFY_NOW || null,
  verifiedNow,
});
pushCheck("freshness age limits are valid", ageLimitsValid, {
  maxAgeConfigSource: maxAgeConfig[0],
  maxAgeMinutes: Number.isFinite(maxAgeMinutes) ? maxAgeMinutes : null,
  maxFutureSkewMinutes: Number.isFinite(maxFutureSkewMinutes) ? maxFutureSkewMinutes : null,
});
pushCheck("current freshness is within allowed age", currentTimestampFresh, {
  currentFreshnessTime,
  verifiedNow,
  currentAgeSeconds,
  maxAgeMinutes: Number.isFinite(maxAgeMinutes) ? maxAgeMinutes : null,
  maxFutureSkewMinutes: Number.isFinite(maxFutureSkewMinutes) ? maxFutureSkewMinutes : null,
});

if (currentLaneFresh) {
  pushCheck("fresh current lane is not marked stale", api.currentStale === false
    && fallbackCoverage.primaryStale === false
    && fallbackCoverage.servingMode === "primary"
    && currentTimestampFresh, {
    currentSportteryMatches,
    currentLaneFresh,
    currentStale: api.currentStale ?? null,
    primaryStale: fallbackCoverage.primaryStale ?? null,
    servingMode: fallbackCoverage.servingMode || null,
    currentTimestampFresh,
  });
  pushCheck("current freshness follows latest source observation", sourceTimes.includes(currentFreshnessTime), {
    currentFreshnessTime,
    sourceTimes,
  });
}

if (api.stale === true && api.currentStale === false) {
  pushCheck("partial stale marks overall degradation only", api.partialStale === true, {
    stale: api.stale,
    currentStale: api.currentStale,
    historyStale: api.historyStale ?? null,
    partialStale: api.partialStale ?? null,
  });
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  syncMetaPath,
  summary: {
    currentSportteryMatches,
    currentLaneFresh,
    currentStale: api.currentStale ?? null,
    historyStale: api.historyStale ?? null,
    stale: api.stale ?? null,
    partialStale: api.partialStale ?? null,
    servingMode: fallbackCoverage.servingMode || null,
    officialOddsStale: fallbackCoverage.officialOddsStale ?? null,
    currentFreshnessTime,
    verifiedNow,
    currentAgeSeconds,
    maxAgeConfigSource: maxAgeConfig[0],
    maxAgeMinutes: Number.isFinite(maxAgeMinutes) ? maxAgeMinutes : null,
    maxFutureSkewMinutes: Number.isFinite(maxFutureSkewMinutes) ? maxFutureSkewMinutes : null,
    currentTimestampFresh,
  },
  checks,
}, null, 2));

if (!ok) process.exitCode = 1;
