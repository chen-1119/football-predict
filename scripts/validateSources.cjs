const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");

const externalSignalsPath = path.join(dataDir, "external-signals.json");
const preMatchSignalsPath = path.join(dataDir, "pre-match-signals.json");
const currentMatchesPath = path.join(dataDir, "matches-current.json");
const syncMetaPath = path.join(dataDir, "sync-meta.json");

const maxAgeMinutes = Math.max(1, Number(process.env.SOURCE_MAX_AGE_MINUTES || 20));
const minExternalRows = Math.max(0, Number(process.env.SOURCE_MIN_500_ROWS || 1));
const minExternalMapped = Math.max(0, Number(process.env.SOURCE_MIN_500_MAPPED || 1));
const minCurrentMatches = Math.max(0, Number(process.env.SOURCE_MIN_CURRENT_MATCHES || 1));
const minCurrentCoverage = Math.max(0, Math.min(1, Number(process.env.SOURCE_MIN_EXTERNAL_COVERAGE || 0.5)));
const requireExternalSignals = process.env.REQUIRE_EXTERNAL_SIGNALS !== "0";
const requirePreMatchSignals = process.env.REQUIRE_PREMATCH_SIGNALS === "1";
const minPreMatchRows = Math.max(0, Number(process.env.SOURCE_MIN_PREMATCH_ROWS || minCurrentMatches));

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
  const preMatch = signals.preMatch?.quality || signals.preMatch;
  return Boolean(had || hhad || apiFootball || external || signals.injuries || signals.lineups || preMatch || signals.webConsensus);
}

const errors = [];
const warnings = [];
const external = readJson(externalSignalsPath, null);
const preMatch = readJson(preMatchSignalsPath, null);
const current = readJson(currentMatchesPath, []);
const syncMeta = readJson(syncMetaPath, null);

const externalMatches = external?.matches && typeof external.matches === "object" && !Array.isArray(external.matches)
  ? external.matches
  : {};
const externalCount = Object.keys(externalMatches).length;
const source500 = external?.sources?.["500.com:jczq"] || {};
const sourceApiFootball = external?.sources?.["api-football"] || {};
const sourceWebConsensus = external?.sources?.webConsensus || {};
const externalAge = ageMinutes(external?.updatedAt);
const preMatchAge = ageMinutes(preMatch?.updatedAt);
const preMatchMatches = preMatch?.matches && typeof preMatch.matches === "object" && !Array.isArray(preMatch.matches)
  ? preMatch.matches
  : {};
const preMatchCount = Object.keys(preMatchMatches).length;
const preMatchSummary = preMatch?.summary || {};
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

if (!preMatch) {
  const message = "pre-match-signals.json is missing or invalid; run npm run sync:prematch.";
  if (requirePreMatchSignals) errors.push(message);
  else warnings.push(message);
} else {
  if (preMatchAge > maxAgeMinutes) {
    const message = `pre-match-signals.json is stale: ${preMatchAge.toFixed(1)} minutes old, max ${maxAgeMinutes}.`;
    if (requirePreMatchSignals) errors.push(message);
    else warnings.push(message);
  }
  if (preMatchCount < minPreMatchRows) {
    const message = `pre-match signal rows too low: ${preMatchCount}, min ${minPreMatchRows}.`;
    if (requirePreMatchSignals) errors.push(message);
    else warnings.push(message);
  }
}

if (!Array.isArray(current)) {
  errors.push("matches-current.json is not an array.");
} else if (currentCount < minCurrentMatches) {
  errors.push(`current matches too low: ${currentCount}, min ${minCurrentMatches}.`);
}

if (currentCount > 0 && requireExternalSignals && currentCoverage < minCurrentCoverage) {
  warnings.push(`current external coverage low: ${(currentCoverage * 100).toFixed(1)}%, target ${(minCurrentCoverage * 100).toFixed(1)}%.`);
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
    requirePreMatchSignals,
    minPreMatchRows,
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
    webConsensusRows: sourceWebConsensus.rows || 0,
    webConsensusUsable: sourceWebConsensus.usable || 0,
  },
  preMatchSignals: {
    exists: Boolean(preMatch),
    updatedAt: preMatch?.updatedAt || null,
    ageMinutes: Number.isFinite(preMatchAge) ? Number(preMatchAge.toFixed(2)) : null,
    matchKeys: preMatchCount,
    high: preMatchSummary.high || 0,
    medium: preMatchSummary.medium || 0,
    low: preMatchSummary.low || 0,
    warningCount: Array.isArray(preMatchSummary.warnings) ? preMatchSummary.warnings.length : 0,
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
