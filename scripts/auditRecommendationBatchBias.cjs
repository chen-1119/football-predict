"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "public", "data", "recommendation-bias-audit.json");
const VERSION = "recommendation-bias-audit-v2-production-shape";
const TERMINAL = new Set(["FINISHED", "CANCELLED", "CANCELED", "VOID", "POSTPONED", "ABANDONED"]);

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
  fs.renameSync(temporary, file);
};

const selectedCode = (match) => {
  const best = (Array.isArray(match?.predictions) ? match.predictions : [])
    .find((row) => row?.marketType === "BEST" && ["1", "X", "2"].includes(row?.tipCode));
  // This is a publication gate, so it must inspect only an actually exposed
  // BEST direction. A WATCH/reference row may retain the internal posterior
  // for auditability; reviving that private direction here would turn a
  // successful fail-closed downgrade into a batch-level publication failure.
  const code = best?.tipCode;
  return ["1", "X", "2"].includes(code) ? code : null;
};

const probabilitySignature = (match) => {
  const triplet = match?.probabilityModel?.oneXTwo?.final
    || match?.probabilityModel?.unifiedPosterior?.probabilities
    || match?.probabilityModel?.unifiedPosterior
    || match?.predictionMeta?.featureSnapshot?.modelInputs?.oneXTwoFinal
    || match?.predictionMeta?.featureSnapshot?.modelOutputs?.probabilities
    || match?.predictionMeta?.featureSnapshot?.modelOutputs?.modelProbabilities;
  if (!triplet || typeof triplet !== "object") return null;
  const values = [triplet.home, triplet.draw, triplet.away].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const scale = Math.max(...values) <= 1.000001 ? 100 : 1;
  return values.map((value) => (value * scale).toFixed(1)).join("/");
};

const coldStart = (match) => {
  const snapshotInputs = match?.predictionMeta?.featureSnapshot?.modelInputs || {};
  const elo = match?.eloSnapshot
    || match?.predictionMeta?.elo
    || match?.probabilityModel?.elo
    || snapshotInputs.elo
    || {};
  const form = match?.formSnapshot
    || match?.predictionMeta?.form
    || match?.probabilityModel?.form
    || snapshotInputs.form
    || {};
  const freeGrade = match?.externalSignals?.freeFootball?.grade
    || match?.predictionMeta?.featureSnapshot?.externalSignals?.freeFootball?.grade;
  const eloPaired = Number(elo.homeMatches || 0) >= 3 && Number(elo.awayMatches || 0) >= 3;
  const formPaired = Number(form?.home?.sampleSize || 0) >= 3
    && Number(form?.away?.sampleSize || 0) >= 3;
  return freeGrade === "D" || (!eloPaired && !formPaired);
};

const marketLeaderCode = (match) => {
  const odds = match?.odds || {};
  const rows = [
    ["1", Number(odds.odds1)],
    ["X", Number(odds.oddsX)],
    ["2", Number(odds.odds2)],
  ].filter(([, value]) => Number.isFinite(value) && value > 1);
  if (rows.length !== 3) return null;
  return rows.sort((left, right) => left[1] - right[1])[0][0];
};

const auditRecommendationBias = (matches, options = {}) => {
  const minimumRows = Math.max(3, Number(options.minimumRows || 5));
  const dominanceThreshold = Math.min(1, Math.max(0.6, Number(options.dominanceThreshold || 0.8)));
  const repeatedProbabilityThreshold = Math.min(
    1,
    Math.max(0.25, Number(options.repeatedProbabilityThreshold || 0.35)),
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rows = (Array.isArray(matches) ? matches : [])
    .filter((match) => {
      if (TERMINAL.has(String(match?.status || "").toUpperCase())) return false;
      const kickoffMs = Date.parse(match?.kickoffTime || "");
      return !Number.isFinite(kickoffMs)
        || (kickoffMs >= nowMs - 3 * 60 * 60_000 && kickoffMs <= nowMs + 48 * 60 * 60_000);
    })
    .map((match) => ({ match, code: selectedCode(match) }))
    .filter((row) => row.code);
  const counts = { "1": 0, X: 0, "2": 0 };
  for (const row of rows) counts[row.code] += 1;
  const dominant = Object.entries(counts).sort((left, right) => right[1] - left[1])[0];
  const dominantShare = rows.length > 0 ? dominant[1] / rows.length : 0;
  const probabilityClusters = new Map();
  for (const row of rows) {
    const signature = probabilitySignature(row.match);
    if (!signature) continue;
    const cluster = probabilityClusters.get(signature) || [];
    cluster.push(String(row.match?.sourceMatchId || row.match?.id || ""));
    probabilityClusters.set(signature, cluster);
  }
  const repeatedProbabilityClusters = [...probabilityClusters.entries()]
    .filter(([, matchIds]) => matchIds.length >= 3)
    .map(([signature, matchIds]) => ({ signature, rows: matchIds.length, matchIds }))
    .sort((left, right) => right.rows - left.rows || left.signature.localeCompare(right.signature));
  const maxRepeatedProbabilityRows = repeatedProbabilityClusters[0]?.rows || 0;
  const maxRepeatedProbabilityShare = rows.length > 0 ? maxRepeatedProbabilityRows / rows.length : 0;
  const directionTriggered = rows.length >= minimumRows && dominantShare >= dominanceThreshold;
  const repeatedProbabilityTriggered = rows.length >= minimumRows
    && maxRepeatedProbabilityShare >= repeatedProbabilityThreshold;
  const triggered = directionTriggered || repeatedProbabilityTriggered;
  const coldStartRows = rows.filter((row) => coldStart(row.match)).length;
  const coldStartShare = rows.length > 0 ? coldStartRows / rows.length : 0;
  const marketRows = rows
    .map((row) => ({ ...row, marketCode: marketLeaderCode(row.match) }))
    .filter((row) => row.marketCode);
  const dominantMarketConflictRows = marketRows.filter((row) => (
    row.code === dominant[0]
    && row.marketCode !== row.code
    && row.marketCode !== "X"
  )).length;
  const marketCoverageShare = rows.length > 0 ? marketRows.length / rows.length : 0;
  const dominantMarketConflictShare = rows.length > 0 ? dominantMarketConflictRows / rows.length : 0;
  const marketLeaderAgreementRows = marketRows.filter((row) => row.marketCode === row.code).length;
  const marketLeaderAgreementShare = marketRows.length > 0
    ? marketLeaderAgreementRows / marketRows.length
    : 0;
  const marketLeaderAgreementTriggered = marketRows.length >= minimumRows
    && marketLeaderAgreementShare >= 0.95;
  const dominantMarketConflictTriggered = directionTriggered
    && marketCoverageShare >= 0.8
    && dominantMarketConflictShare >= 0.2;
  // A lopsided slate is not automatically wrong: a real fixture list can be
  // home-heavy. Publication is blocked only when the distribution also proves
  // an input-degeneracy pattern (cold-start majority or repeated probabilities).
  // This prevents artificial direction balancing while failing closed on the
  // exact default-home-prior failure mode this audit is intended to catch.
  const blockingReasons = [
    ...(repeatedProbabilityTriggered ? ["repeated-probability-cluster"] : []),
    ...(directionTriggered && coldStartShare >= 0.5 ? ["dominant-direction-with-cold-start-majority"] : []),
    ...(dominantMarketConflictTriggered ? ["dominant-direction-opposes-market-cluster"] : []),
  ];
  const publicationBlocked = blockingReasons.length > 0;
  const cause = !triggered
    ? "distribution-within-monitoring-band"
    : repeatedProbabilityTriggered && coldStartRows / rows.length >= 0.5
      ? "input-degeneracy-repeated-probabilities"
    : coldStartRows / rows.length >= 0.5
      ? "input-degeneracy-cold-start"
      : marketLeaderAgreementTriggered
        ? "market-copy-cluster-requires-review"
      : "model-or-market-cluster-requires-review";
  return {
    version: VERSION,
    rows: rows.length,
    counts,
    distribution: Object.fromEntries(Object.entries(counts).map(([code, count]) => [
      code,
      rows.length > 0 ? Number((count / rows.length).toFixed(4)) : 0,
    ])),
    dominantCode: dominant[0],
    dominantShare: Number(dominantShare.toFixed(4)),
    directionTriggered,
    repeatedProbabilityTriggered,
    maxRepeatedProbabilityRows,
    maxRepeatedProbabilityShare: Number(maxRepeatedProbabilityShare.toFixed(4)),
    repeatedProbabilityClusters,
    coldStartRows,
    coldStartShare: Number(coldStartShare.toFixed(4)),
    marketRows: marketRows.length,
    marketCoverageShare: Number(marketCoverageShare.toFixed(4)),
    dominantMarketConflictRows,
    dominantMarketConflictShare: Number(dominantMarketConflictShare.toFixed(4)),
    dominantMarketConflictTriggered,
    marketLeaderAgreementRows,
    marketLeaderAgreementShare: Number(marketLeaderAgreementShare.toFixed(4)),
    marketLeaderAgreementTriggered,
    triggered,
    publicationBlocked,
    blockingReasons,
    cause,
    policy: {
      diagnosticOnly: false,
      failClosedOnInputDegeneracy: true,
      mutatesRecommendationDirection: false,
      artificialDirectionBalancingAllowed: false,
      minimumRows,
      dominanceThreshold,
      repeatedProbabilityThreshold,
      dominantMarketConflictThreshold: 0.2,
    },
  };
};

const main = () => {
  const checkedAt = new Date().toISOString();
  const matches = readJson(CURRENT_FILE, []);
  const audit = auditRecommendationBias(matches);
  const output = { ...audit, checkedAt };
  writeJsonAtomic(OUTPUT_FILE, output);
  console.log(JSON.stringify({ ok: true, ...output, output: path.relative(ROOT_DIR, OUTPUT_FILE) }, null, 2));
};

if (require.main === module) main();

module.exports = {
  auditRecommendationBias,
  probabilitySignature,
  selectedCode,
  marketLeaderCode,
};
