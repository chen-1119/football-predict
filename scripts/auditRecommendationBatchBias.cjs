"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "public", "data", "recommendation-bias-audit.json");
const VERSION = "recommendation-bias-audit-v2-production-shape";
const TERMINAL = new Set(["FINISHED", "CANCELLED", "CANCELED", "VOID", "POSTPONED", "ABANDONED"]);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
};
const selectedCode = (match) => {
  const best = (Array.isArray(match?.predictions) ? match.predictions : [])
    .find((row) => row?.marketType === "BEST" && ["1", "X", "2"].includes(row?.tipCode));
  const code = best?.tipCode;
  return ["1", "X", "2"].includes(code) ? code : null;
};
const probabilitySignature = (match) => {
  const triplet = match?.probabilityModel?.oneXTwo?.final
    || match?.probabilityModel?.unifiedPosterior?.probabilities || match?.probabilityModel?.unifiedPosterior
    || match?.predictionMeta?.featureSnapshot?.modelInputs?.oneXTwoFinal
    || match?.predictionMeta?.featureSnapshot?.modelOutputs?.probabilities
    || match?.predictionMeta?.featureSnapshot?.modelOutputs?.modelProbabilities;
  if (!triplet || typeof triplet !== "object") return null;
  const values = [triplet.home, triplet.draw, triplet.away];
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
  const total = values.reduce((a,b) => a+b,0);
  if (!(Math.abs(total-1)<=.02 || Math.abs(total-100)<=.5)) return null;
  return values.map((value) => (value/total*100).toFixed(1)).join("/");
};
const coldStart = (match) => {
  const snapshotInputs = match?.predictionMeta?.featureSnapshot?.modelInputs || {};
  const elo = match?.eloSnapshot || match?.predictionMeta?.elo || match?.probabilityModel?.elo || snapshotInputs.elo || {};
  const form = match?.formSnapshot || match?.predictionMeta?.form || match?.probabilityModel?.form || snapshotInputs.form || {};
  const freeGrade = match?.externalSignals?.freeFootball?.grade
    || match?.predictionMeta?.featureSnapshot?.externalSignals?.freeFootball?.grade;
  const eloPaired = Number(elo.homeMatches || 0) >= 3 && Number(elo.awayMatches || 0) >= 3;
  const formPaired = Number(form?.home?.sampleSize || 0) >= 3 && Number(form?.away?.sampleSize || 0) >= 3;
  return freeGrade === "D" || (!eloPaired && !formPaired);
};
const marketLeaderCode = (match) => {
  const odds = match?.odds || {};
  const rows = [["1", odds.odds1], ["X", odds.oddsX], ["2", odds.odds2]];
  if (!rows.every(([,v]) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) && Number(v)>1)) return null;
  rows.forEach(r => r[1]=Number(r[1])); rows.sort((a,b) => a[1]-b[1]);
  // Equal market leaders are not evidence of either market copying or opposition.
  return Math.abs(rows[0][1]-rows[1][1])<=1e-12 ? null : rows[0][0];
};
const auditRecommendationBias = (matches, options = {}) => {
  const minimumRows = Math.max(3, Number(options.minimumRows || 5));
  const dominanceThreshold = Math.min(1, Math.max(0.6, Number(options.dominanceThreshold || 0.8)));
  const repeatedProbabilityThreshold = Math.min(1, Math.max(0.25, Number(options.repeatedProbabilityThreshold || 0.35)));
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rows = (Array.isArray(matches) ? matches : []).filter((match) => {
    if (TERMINAL.has(String(match?.status || "").toUpperCase())) return false;
    const kickoffMs = Date.parse(match?.kickoffTime || "");
    return !Number.isFinite(kickoffMs) || (kickoffMs >= nowMs - 3 * 60 * 60_000 && kickoffMs <= nowMs + 48 * 60 * 60_000);
  }).map((match) => ({ match, code: selectedCode(match) })).filter((row) => row.code);
  const counts = { "1": 0, X: 0, "2": 0 };
  for (const row of rows) counts[row.code] += 1;
  const dominant = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];
  const dominantShare = rows.length > 0 ? dominant[1] / rows.length : 0;
  const probabilityClusters = new Map();
  for (const row of rows) {
    const signature = probabilitySignature(row.match); if (!signature) continue;
    const cluster = probabilityClusters.get(signature) || [];
    cluster.push(String(row.match?.sourceMatchId || row.match?.id || "")); probabilityClusters.set(signature, cluster);
  }
  const repeatedProbabilityClusters = [...probabilityClusters.entries()].filter(([,ids]) => ids.length>=3)
    .map(([signature,matchIds]) => ({signature,rows:matchIds.length,matchIds})).sort((a,b) => b.rows-a.rows || a.signature.localeCompare(b.signature));
  const maxRepeatedProbabilityRows = repeatedProbabilityClusters[0]?.rows || 0;
  const maxRepeatedProbabilityShare = rows.length > 0 ? maxRepeatedProbabilityRows / rows.length : 0;
  const directionTriggered = rows.length >= minimumRows && dominantShare >= dominanceThreshold;
  const repeatedProbabilityTriggered = rows.length >= minimumRows && maxRepeatedProbabilityShare >= repeatedProbabilityThreshold;
  const coldStartRows = rows.filter((row) => coldStart(row.match)).length;
  const coldStartShare = rows.length > 0 ? coldStartRows / rows.length : 0;
  const marketRows = rows.map((row) => ({ ...row, marketCode: marketLeaderCode(row.match) })).filter((row) => row.marketCode);
  const dominantMarketConflictRows = marketRows.filter((row) => row.code===dominant[0] && row.marketCode!==row.code && row.marketCode!=="X").length;
  const marketCoverageShare = rows.length > 0 ? marketRows.length / rows.length : 0;
  const dominantMarketConflictShare = rows.length > 0 ? dominantMarketConflictRows / rows.length : 0;
  const marketLeaderAgreementRows = marketRows.filter((row) => row.marketCode === row.code).length;
  const marketLeaderAgreementShare = marketRows.length > 0 ? marketLeaderAgreementRows / marketRows.length : 0;
  const marketLeaderAgreementTriggered = marketRows.length >= minimumRows && marketLeaderAgreementShare >= 0.95;
  const dominantMarketConflictTriggered = directionTriggered && marketCoverageShare >= 0.8 && dominantMarketConflictShare >= 0.2;
  // Market agreement/opposition are diagnostics, NOT proof of bad inputs.
  // Do not veto well-evidenced contrarian batches or impose outcome quotas.
  const triggered = directionTriggered || repeatedProbabilityTriggered || marketLeaderAgreementTriggered;
  const blockingReasons = [
    ...(repeatedProbabilityTriggered ? ["repeated-probability-cluster"] : []),
    ...(directionTriggered && coldStartShare >= 0.5 ? ["dominant-direction-with-cold-start-majority"] : []),
  ];
  const publicationBlocked = blockingReasons.length > 0;
  const cause = !rows.length ? 'no-exposed-best-records'
    : repeatedProbabilityTriggered && coldStartShare >= 0.5 ? "input-degeneracy-repeated-probabilities"
      : directionTriggered && coldStartShare >= 0.5 ? "input-degeneracy-cold-start"
        : marketLeaderAgreementTriggered ? "market-copy-cluster-requires-review"
          : !triggered ? "distribution-within-monitoring-band" : "model-or-market-cluster-requires-review";
  return { version: VERSION, rows: rows.length, counts,
    distribution: Object.fromEntries(Object.entries(counts).map(([code,n]) => [code,rows.length?Number((n/rows.length).toFixed(4)):0])),
    dominantCode: rows.length?dominant[0]:null, dominantShare: Number(dominantShare.toFixed(4)), directionTriggered,
    repeatedProbabilityTriggered,maxRepeatedProbabilityRows,maxRepeatedProbabilityShare:Number(maxRepeatedProbabilityShare.toFixed(4)),repeatedProbabilityClusters,
    coldStartRows,coldStartShare:Number(coldStartShare.toFixed(4)),marketRows:marketRows.length,marketCoverageShare:Number(marketCoverageShare.toFixed(4)),
    dominantMarketConflictRows,dominantMarketConflictShare:Number(dominantMarketConflictShare.toFixed(4)),dominantMarketConflictTriggered,
    marketLeaderAgreementRows,marketLeaderAgreementShare:Number(marketLeaderAgreementShare.toFixed(4)),marketLeaderAgreementTriggered,
    triggered,publicationBlocked,blockingReasons,cause,
    policy:{diagnosticOnly:false,failClosedOnInputDegeneracy:true,mutatesRecommendationDirection:false,artificialDirectionBalancingAllowed:false,
      minimumRows,dominanceThreshold,repeatedProbabilityThreshold,dominantMarketConflictThreshold:0.2,marketDisagreementDiagnosticOnly:true} };
};
const main = () => {
  const checkedAt = new Date().toISOString(), matches = readJson(CURRENT_FILE, []);
  const output = { ...auditRecommendationBias(matches), checkedAt };
  writeJsonAtomic(OUTPUT_FILE, output);
  console.log(JSON.stringify({ ok: true, ...output, output: path.relative(ROOT_DIR, OUTPUT_FILE) }, null, 2));
};
if (require.main === module) main();
module.exports = { auditRecommendationBias, probabilitySignature, selectedCode, marketLeaderCode };
