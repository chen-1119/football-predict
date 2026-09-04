"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  externalSignalMatchesEvent,
  stampSignalEvent,
} = require("./externalSignalEventIdentity.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "public", "data");
const CURRENT_FILE = path.join(DATA_DIR, "matches-current.json");
const EXTERNAL_FILE = path.join(DATA_DIR, "external-signals.json");
const OUTPUT_FILE = path.join(DATA_DIR, "free-football-signals.json");
const VERSION = "free-football-signals-v1";

const norm = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
    void error;
  }
};

const parseInstant = (value) => {
  const text = norm(value);
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(" ", "T")}${text.length === 16 ? ":00" : ""}+08:00`
    : text;
  return Date.parse(normalized);
};

const isoOrNull = (value) => {
  const instant = parseInstant(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
};

const cutoffFor = (match) => (
  match?.buyEndTime
  || match?.predictionMeta?.cutoffTime
  || match?.externalSignals?.buyEndTime
  || match?.kickoffTime
  || null
);

const sourceMatchId = (match) => norm(
  match?.sourceMatchId
  || match?.externalSignals?.sourceMatchId
  || norm(match?.id).replace(/^(sporttery|fivehundred)_/, "")
);

const teamDateKey = (match) => [
  norm(match?.homeTeamName || match?.homeTeamNameEn).toLowerCase(),
  norm(match?.awayTeamName || match?.awayTeamNameEn).toLowerCase(),
  norm(match?.kickoffTime).slice(0, 10),
].filter(Boolean).join("__");

const matchKeys = (match) => Array.from(new Set([
  sourceMatchId(match),
  norm(match?.id),
  norm(match?.matchNo),
  teamDateKey(match),
].filter(Boolean)));

const findSignal = (externalMatches, match) => {
  let reusableKey = null;
  for (const key of matchKeys(match)) {
    if (!externalMatches[key]) continue;
    reusableKey ||= key;
    if (externalSignalMatchesEvent(externalMatches[key], match)) {
      return { key, signal: externalMatches[key] };
    }
  }
  return { key: reusableKey || sourceMatchId(match) || norm(match?.id), signal: {} };
};

const validTriplet = (odds) => [odds?.odds1, odds?.oddsX, odds?.odds2]
  .every((value) => Number.isFinite(Number(value)) && Number(value) > 1);

const componentObservedAt = (value, fallback = null) => (
  value?.sourceObservedAt
  || value?.observedAt
  || value?.updatedAt
  || fallback
  || null
);

const componentUsableBeforeCutoff = (component, cutoff, fallbackObservedAt = null) => {
  if (!component || typeof component !== "object") return false;
  if (component.usableForPreMatch === false || component.observationPhase === "post-cutoff") return false;
  const cutoffMs = parseInstant(cutoff);
  const observedMs = parseInstant(componentObservedAt(component, fallbackObservedAt));
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(observedMs)) return false;
  return observedMs <= cutoffMs;
};

const sampleSize = (value) => Math.max(0, Number(value || 0));

const localStrengthEvidence = (match) => {
  const elo = match?.predictionMeta?.elo || match?.probabilityModel?.elo || {};
  const homeMatches = sampleSize(elo.homeMatches);
  const awayMatches = sampleSize(elo.awayMatches);
  const homeRating = Number(elo.homeRating);
  const awayRating = Number(elo.awayRating);
  const available = Number.isFinite(homeRating) && Number.isFinite(awayRating);
  return {
    available,
    verifiedHistory: available && homeMatches > 0 && awayMatches > 0,
    homeRating: available ? homeRating : null,
    awayRating: available ? awayRating : null,
    homeMatches,
    awayMatches,
    source: elo?.historicalSource?.source || "local-elo-history",
  };
};

const localFormEvidence = (match) => {
  // The live model publishes the as-of form snapshot under probabilityModel.
  // predictionMeta.form is retained only for older payload compatibility.
  // Reading predictionMeta alone made a fully populated signed-history form
  // look missing to the downstream quality layer.
  const form = match?.predictionMeta?.form || match?.probabilityModel?.form || {};
  const home = form.home || {};
  const away = form.away || {};
  const homeSample = sampleSize(home.sampleSize);
  const awaySample = sampleSize(away.sampleSize);
  return {
    available: homeSample > 0 || awaySample > 0,
    balanced: homeSample > 0 && awaySample > 0,
    homeSample,
    awaySample,
    homePointsPerMatch: Number.isFinite(Number(home.pointsPerMatch)) ? Number(home.pointsPerMatch) : null,
    awayPointsPerMatch: Number.isFinite(Number(away.pointsPerMatch)) ? Number(away.pointsPerMatch) : null,
    homeGoalsForAvg: Number.isFinite(Number(home.goalsForAvg)) ? Number(home.goalsForAvg) : null,
    awayGoalsForAvg: Number.isFinite(Number(away.goalsForAvg)) ? Number(away.goalsForAvg) : null,
    source: form?.historicalSource?.source || "local-rolling-form",
  };
};

const poissonEvidence = (match) => {
  const probability = match?.probabilityModel || match?.predictionMeta?.oneXTwo || {};
  const oneXTwo = probability?.oneXTwo?.final || probability?.oneXTwo?.poisson || probability?.final || probability?.poisson || {};
  const values = [oneXTwo.home, oneXTwo.draw, oneXTwo.away].map(Number);
  const available = values.every(Number.isFinite) && values.reduce((sum, value) => sum + value, 0) > 0;
  return {
    available,
    home: available ? values[0] : null,
    draw: available ? values[1] : null,
    away: available ? values[2] : null,
    source: "local-poisson-ensemble",
  };
};

const buildFreeFootballSignal = (match, externalSignal = {}, generatedAt = new Date().toISOString()) => {
  const cutoff = cutoffFor(match);
  const sourceObservedAt = externalSignal?.sourceObservedAt || externalSignal?.updatedAt || null;
  const officialHad = validTriplet(match?.odds);
  const officialHhad = validTriplet(match?.handicapOdds) && Number.isFinite(Number(match?.handicapLine));
  const fiveHundred = externalSignal?.fiveHundred || {};
  const fiveHundredHad = externalSignal?.bookmakerOdds?.had || fiveHundred?.bookmakerOdds?.had;
  const fiveHundredMarket = validTriplet(fiveHundredHad)
    && componentUsableBeforeCutoff(fiveHundredHad, cutoff, sourceObservedAt);
  const fiveHundredDetails = [
    fiveHundred?.recentForm,
    fiveHundred?.futureSchedule,
    fiveHundred?.rank,
    fiveHundred?.europeOdds,
    fiveHundred?.asianHandicap,
    externalSignal?.confirmedLineup,
    externalSignal?.projectedRoster,
    externalSignal?.lineups,
    externalSignal?.injuries,
  ].some((component) => componentUsableBeforeCutoff(component, cutoff, sourceObservedAt));
  const weather = externalSignal?.weather || null;
  const weatherAvailable = componentUsableBeforeCutoff(weather, cutoff, weather?.updatedAt);
  const webConsensus = externalSignal?.webConsensus || null;
  const webAdvisory = Boolean(
    webConsensus
    && webConsensus.eligibleForRiskDisplay === true
    && webConsensus.eligibleForNumericModel !== true
  );
  const strength = localStrengthEvidence(match);
  const form = localFormEvidence(match);
  const poisson = poissonEvidence(match);
  const marketAvailable = officialHad || officialHhad || fiveHundredMarket;
  const localModelAvailable = strength.available || form.available || poisson.available;
  const baselineAvailable = localModelAvailable || Boolean(match?.predictionMeta?.leaguePrior);
  const recommendationReady = marketAvailable || baselineAvailable;
  const grade = marketAvailable && strength.verifiedHistory && form.balanced && fiveHundredDetails
    ? "A"
    : marketAvailable && (strength.available || form.available || poisson.available)
      ? "B"
      : recommendationReady
        ? "C"
        : "D";
  const sources = [
    officialHad || officialHhad ? "sporttery-official" : null,
    fiveHundredMarket || fiveHundredDetails ? "500-public-web" : null,
    strength.available || form.available || poisson.available ? "local-history-model" : null,
    weatherAvailable ? "open-meteo" : null,
    webAdvisory ? "public-web-advisory" : null,
  ].filter(Boolean);

  return {
    version: VERSION,
    source: "free-public-football-layer",
    zeroKeyRequired: true,
    generatedAt,
    sourceMatchId: sourceMatchId(match),
    matchId: match?.id || null,
    cutoffTime: isoOrNull(cutoff),
    grade,
    recommendationReady,
    analysisComplete: grade === "A",
    market: {
      available: marketAvailable,
      officialHad,
      officialHhad,
      fiveHundredHad: fiveHundredMarket,
    },
    strength,
    form,
    poisson,
    supplements: {
      fiveHundredDetails,
      weather: weatherAvailable,
      webAdvisory,
    },
    sources,
    policy: {
      directionAuthority: "local-independent-model",
      officialOddsRole: "market-validation-only",
      publicWebRole: "supplement-and-risk-only",
      settlementEligible: false,
      postCutoffMutationAllowed: false,
      missingSupplementBlocksRecommendation: false,
    },
  };
};

const main = () => {
  const generatedAt = new Date().toISOString();
  const matches = readJson(CURRENT_FILE, []);
  const external = readJson(EXTERNAL_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const externalMatches = { ...(external.matches || {}) };
  const rows = {};
  const grades = { A: 0, B: 0, C: 0, D: 0 };
  let recommendationReady = 0;

  for (const match of Array.isArray(matches) ? matches : []) {
    const { key, signal } = findSignal(externalMatches, match);
    const freeFootball = buildFreeFootballSignal(match, signal, generatedAt);
    const rowKey = freeFootball.sourceMatchId || match.id;
    rows[rowKey] = freeFootball;
    grades[freeFootball.grade] += 1;
    if (freeFootball.recommendationReady) recommendationReady += 1;
    const nextSignal = stampSignalEvent({
      ...(signal || {}),
      source: Array.from(new Set(String(signal?.source || "external-signals").split("+").concat("free-public-football")))
        .filter(Boolean).join("+"),
      freeFootball,
    }, match);
    externalMatches[key] = nextSignal;
    for (const alias of matchKeys(match)) {
      externalMatches[alias] = nextSignal;
    }
  }

  const count = Object.keys(rows).length;
  const summary = {
    rows: count,
    recommendationReady,
    recommendationCoverage: count > 0 ? Number((recommendationReady / count).toFixed(4)) : 0,
    analysisComplete: grades.A,
    grades,
    apiFootballRequired: false,
    keyRequired: false,
  };
  const output = {
    version: VERSION,
    source: "free-public-football-layer",
    updatedAt: generatedAt,
    summary,
    matches: rows,
  };
  const nextExternal = {
    ...external,
    updatedAt: generatedAt,
    source: Array.from(new Set(String(external.source || "external-signals").split("+").concat("free-public-football")))
      .filter(Boolean).join("+"),
    matches: externalMatches,
    sources: {
      ...(external.sources || {}),
      "free-public-football": {
        updatedAt: generatedAt,
        ...summary,
      },
    },
  };

  writeJsonAtomic(OUTPUT_FILE, output);
  writeJsonAtomic(EXTERNAL_FILE, nextExternal);
  console.log(JSON.stringify({ ok: count > 0 && recommendationReady === count, ...summary, output: path.relative(ROOT_DIR, OUTPUT_FILE) }, null, 2));
  if (count > 0 && recommendationReady !== count) process.exitCode = 1;
};

if (require.main === module) main();

module.exports = {
  VERSION,
  buildFreeFootballSignal,
  componentUsableBeforeCutoff,
  matchKeys,
};
