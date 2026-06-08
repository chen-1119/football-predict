const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");

const externalSignalsPath = path.join(dataDir, "external-signals.json");
const currentMatchesPath = path.join(dataDir, "matches-current.json");
const syncMetaPath = path.join(dataDir, "sync-meta.json");

const maxAgeMinutes = Math.max(1, Number(process.env.SOURCE_MAX_AGE_MINUTES || 20));
const minExternalRows = Math.max(0, Number(process.env.SOURCE_MIN_500_ROWS || 1));
const minExternalMapped = Math.max(0, Number(process.env.SOURCE_MIN_500_MAPPED || 1));
const minCurrentMatches = Math.max(0, Number(process.env.SOURCE_MIN_CURRENT_MATCHES || 1));
const minCurrentCoverage = Math.max(0, Math.min(1, Number(process.env.SOURCE_MIN_EXTERNAL_COVERAGE || 0.5)));
const requireExternalSignals = process.env.REQUIRE_EXTERNAL_SIGNALS !== "0";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function ageMinutes(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / 60000;
}

function matchHasExternalSignal(match) {
  const signals = match?.externalSignals;
  if (!signals || typeof signals !== "object") return false;
  const had = signals.bookmakerOdds?.had;
  const hhad = signals.bookmakerOdds?.hhad;
  const apiFootball = signals.bookmakerOdds?.apiFootball || signals.apiFootball;
  const external = signals.externalOdds;
  return Boolean(had || hhad || apiFootball || external || signals.injuries || signals.lineups);
}

const errors = [];
const warnings = [];
const external = readJson(externalSignalsPath, null);
const current = readJson(currentMatchesPath, []);
const syncMeta = readJson(syncMetaPath, null);

const externalMatches = external?.matches && typeof external.matches === "object" && !Array.isArray(external.matches)
  ? external.matches
  : {};
const externalCount = Object.keys(externalMatches).length;
const source500 = external?.sources?.["500.com:jczq"] || {};
const sourceApiFootball = external?.sources?.["api-football"] || {};
const externalAge = ageMinutes(external?.updatedAt);
const currentCount = Array.isArray(current) ? current.length : 0;
const currentWithExternal = Array.isArray(current) ? current.filter(matchHasExternalSignal).length : 0;
const currentCoverage = currentCount > 0 ? currentWithExternal / currentCount : 0;

if (requireExternalSignals) {
  if (!external) errors.push("external-signals.json is missing or invalid.");
  if (external && externalAge > maxAgeMinutes) {
    errors.push(`external-signals.json is stale: ${externalAge.toFixed(1)} minutes old, max ${maxAgeMinutes}.`);
  }
  if ((source500.rows || 0) < minExternalRows) {
    errors.push(`500.com rows too low: ${source500.rows || 0}, min ${minExternalRows}.`);
  }
  if ((source500.mapped || 0) < minExternalMapped) {
    errors.push(`500.com mapped keys too low: ${source500.mapped || 0}, min ${minExternalMapped}.`);
  }
  if (externalCount < minExternalMapped) {
    errors.push(`external signal match map too small: ${externalCount}, min ${minExternalMapped}.`);
  }
}

if (!Array.isArray(current)) {
  errors.push("matches-current.json is not an array.");
} else if (currentCount < minCurrentMatches) {
  errors.push(`current matches too low: ${currentCount}, min ${minCurrentMatches}.`);
}

if (currentCount > 0 && requireExternalSignals && currentCoverage < minCurrentCoverage) {
  errors.push(`current external coverage too low: ${(currentCoverage * 100).toFixed(1)}%, min ${(minCurrentCoverage * 100).toFixed(1)}%.`);
}

const metaExternalCount = syncMeta?.sources?.externalSignals?.matches ?? syncMeta?.externalSignals?.matches ?? null;
if (metaExternalCount !== null && Number(metaExternalCount) !== externalCount) {
  warnings.push(`sync-meta external count ${metaExternalCount} differs from external-signals map ${externalCount}.`);
}

const payload = {
  ok: errors.length === 0,
  checkedAt: new Date().toISOString(),
  thresholds: {
    maxAgeMinutes,
    minExternalRows,
    minExternalMapped,
    minCurrentMatches,
    minCurrentCoverage,
    requireExternalSignals,
  },
  externalSignals: {
    exists: Boolean(external),
    updatedAt: external?.updatedAt || null,
    ageMinutes: Number.isFinite(externalAge) ? Number(externalAge.toFixed(2)) : null,
    source: external?.source || null,
    matchKeys: externalCount,
    fiveHundredRows: source500.rows || 0,
    fiveHundredMapped: source500.mapped || 0,
    fiveHundredUrl: source500.url || null,
    apiFootballUpdatedAt: sourceApiFootball.updatedAt || null,
    apiFootballMappedSignals: sourceApiFootball.mappedSignals || 0,
    apiFootballCallsThisSync: sourceApiFootball.callsThisSync || 0,
  },
  currentMatches: {
    count: currentCount,
    withExternalSignals: currentWithExternal,
    externalCoverage: Number(currentCoverage.toFixed(4)),
  },
  warnings,
  errors,
};

console.log(JSON.stringify(payload, null, 2));

if (errors.length > 0) {
  process.exit(1);
}
