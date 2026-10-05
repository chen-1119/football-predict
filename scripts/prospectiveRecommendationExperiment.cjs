"use strict";

// Read-only post-hoc diagnostics. The existing prospective registry owns
// activation, immutable future capture, trial comparisons and promotion.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { OUTCOMES, score, summarizePublishedHistory, pairedDayBootstrap } = require("./historyRegressionReplay.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { fixedGateSpec } = require("./candidateProspectiveLedger.cjs");
const VERSION = "recommendation-selection-diagnostic-v1";
const GROUPS = ["agreement", "modelDirection", "modelProbability", "marketFavoriteSp", "league"];
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const hash = value => sha256(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const argmax = probability => OUTCOMES.reduce((best, key) => probability[key] > probability[best] ? key : best, "home");
const instantNs = value => {
  if (strictInstant(value) === null) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || "";
  return BigInt(Date.parse(value)) * 1000000n + BigInt((fraction.padEnd(9, "0").slice(3)) || "0");
};

function validateSpec(spec) {
  assert(spec?.version === "recommendation-selection-diagnostic-spec-v1", "unsupported specification");
  assert(spec.mode === "historical-diagnostic-only" && spec.source?.alreadyInspected === true, "historical data must remain diagnostic-only");
  assert(spec.timeZone === "Asia/Shanghai", "explicit Asia/Shanghai calendar required");
  assert(/^[a-f0-9]{64}$/.test(spec.source.evidenceSha256 || ""), "pinned evidence hash required");
  assert(Number.isSafeInteger(spec.source.expectedRows) && spec.source.expectedRows > 0 && spec.source.expectedRows <= 500, "invalid source row count");
  assert(Number.isSafeInteger(spec.source.expectedPairedRows) && spec.source.expectedPairedRows >= 0 && spec.source.expectedPairedRows <= spec.source.expectedRows, "invalid paired row count");
  assert(JSON.stringify(spec.groups) === JSON.stringify(GROUPS), "fixed diagnostic groups required");
  for (const name of ["modelProbabilityEdges", "marketFavoriteSpEdges"]) {
    const edges = spec[name];
    assert(Array.isArray(edges) && edges.length >= 2, `${name}: edges required`);
    assert(edges.every((value, index) => (typeof value === "number" && Number.isFinite(value)) || (name === "marketFavoriteSpEdges" && value === null && index === edges.length - 1)), `${name}: invalid edge`);
    const numbers = edges.map(value => value === null ? Infinity : value);
    assert(numbers.every((value, index) => index === 0 || value > numbers[index - 1]), `${name}: ascending unique edges required`);
  }
  assert(spec.modelProbabilityEdges[0] === 0 && spec.modelProbabilityEdges.at(-1) === 1, "probability bins must cover [0,1]");
  assert(spec.marketFavoriteSpEdges[0] === 1 && spec.marketFavoriteSpEdges.at(-1) === null, "SP bins must cover [1,infinity)");
  assert(spec.futureExecution?.status === "pending-existing-registry-activation-receipt"
    && spec.futureExecution.registeredAt === null && spec.futureExecution.activationReceipt === null
    && spec.futureExecution.autoPromotion === false && spec.futureExecution.backfillHistoricalRows === false
    && Array.isArray(spec.futureExecution.newCandidateDefinitions) && spec.futureExecution.newCandidateDefinitions.length === 0,
  "this diagnostic cannot register, activate, backfill or promote a trial");
}

function intervalLabel(value, edges) {
  for (let index = 0; index < edges.length - 1; index += 1) {
    const end = edges[index + 1] ?? Infinity;
    const lastProbability = index === edges.length - 2 && end === 1;
    if (value >= edges[index] && (value < end || lastProbability && value === end)) {
      return `[${edges[index]},${Number.isFinite(end) ? end : "infinity"}${lastProbability ? "]" : ")"}`;
    }
  }
  throw new Error("value outside fixed bins");
}

// No result fields enter this projection or determine diagnostic membership.
function prematchGroupKeys(row, spec) {
  const model = row.predictions.publishedModel;
  const market = row.predictions.sameDecisionMarket;
  const pick = argmax(model);
  return {
    agreement: pick === argmax(market) ? "agree" : "disagree",
    modelDirection: pick,
    modelProbability: intervalLabel(model[pick], spec.modelProbabilityEdges),
    marketFavoriteSp: intervalLabel(row.favoriteSp, spec.marketFavoriteSpEdges),
    league: row.league || "unknown",
  };
}

function aggregate(rows, denominator, originalDenominator, spec) {
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const models = {};
  for (const name of ["publishedModel", "sameDecisionMarket"]) {
    const scores = rows.map(row => score(row.predictions[name], row.actual));
    models[name] = { rows: rows.length, hits: scores.reduce((sum, item) => sum + item.accuracy, 0),
      hitRate: mean(scores.map(item => item.accuracy)), brier: mean(scores.map(item => item.brier)), logLoss: mean(scores.map(item => item.logLoss)) };
  }
  // Compare both probability sources for the SAME model-selected binary event.
  // This is an argmax diagnostic, not a replay of the production betting policy.
  const selectedEvents = rows.map(row => {
    const pick = argmax(row.predictions.publishedModel);
    return { target: Number(pick === row.actual), model: row.predictions.publishedModel[pick], market: row.predictions.sameDecisionMarket[pick] };
  });
  const binary = key => ({ brier: mean(selectedEvents.map(row => (row[key] - row.target) ** 2)),
    logLoss: mean(selectedEvents.map(row => { const p = Math.min(1 - 1e-15, Math.max(1e-15, row[key])); return -row.target * Math.log(p) - (1 - row.target) * Math.log(1 - p); })) });
  const eventIds = rows.map(row => `${row.matchId}:${row.market}:${row.decisionId}`).sort();
  return {
    rows: rows.length, commonCohortDenominator: denominator, coverageOfPaired: denominator ? rows.length / denominator : null,
    sourceDenominator: originalDenominator, coverageOfSource: originalDenominator ? rows.length / originalDenominator : null,
    matchDays: new Set(rows.map(row => row.matchDay)).size, commonEventSetHash: hash(eventIds), eventIds,
    models, pairedDifference: pairedDayBootstrap(rows, "publishedModel", "sameDecisionMarket", spec.bootstrap),
    sameModelSelectedEvent: { eventRule: "frozen-model-argmax; not formal recommendation replay", rows: rows.length,
      hits: selectedEvents.reduce((sum, row) => sum + row.target, 0), model: binary("model"), market: binary("market") },
    promotionEligible: false,
  };
}

function buildDiagnostic(inputBytes, spec) {
  validateSpec(spec);
  assert(Buffer.isBuffer(inputBytes) && inputBytes.length <= 16 * 1024 * 1024, "bounded evidence bytes required");
  assert(sha256(inputBytes) === spec.source.evidenceSha256, "evidence hash mismatch");
  const evidence = inputBytes.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert(evidence.length === spec.source.expectedRows, "source row count mismatch");
  const seen = new Set();
  for (const item of evidence) {
    const key = `${item.record?.matchId}:${item.record?.market}`;
    assert(item.record?.matchId && item.record.market === "HAD" && !seen.has(key), "duplicate or invalid source identity");
    seen.add(key);
  }
  const paired = evidence.filter(item => item.pairedEligible === true);
  assert(paired.length === spec.source.expectedPairedRows, "paired row count mismatch");
  for (const item of paired) {
    assert(item.originalEligible === true && item.primaryReason === "paired-accepted"
      && ["reasons", "clockBlockers", "providerBlockers"].every(name => Array.isArray(item[name]) && item[name].length === 0), "paired admission receipt inconsistent");
    const row = item.record;
    const clocks = [row.officialOdds?.providerObservedAt, row.officialOdds?.receivedAt, row.decision?.capturedAt, row.decision?.at, row.cutoffAt, row.kickoffAt];
    assert(clocks.every(clock => instantNs(clock) !== null), "invalid paired source clock");
    // capturedAt is the frozen model capture, not an assertion that the quote
    // arrived before that capture. Both must be available by decision.at.
    const [observed, received, captured, decision, cutoff, kickoff] = clocks.map(instantNs);
    assert(observed <= received && received <= decision && captured <= decision && decision <= cutoff && cutoff <= kickoff, "paired source clock ordering invalid");
    assert(row.officialOdds.sourceCycleId && row.officialOdds.sourceCycleId === row.decision.sourceCycleId
      && /^[a-f0-9]{64}$/.test(row.officialOdds.provenanceHash || ""), "same-decision source evidence missing");
  }
  // Shared baseline scorer also validates dates, uniqueness, probability triplets
  // and settled result clocks. Upstream source authority is pinned by the receipt.
  const baseline = summarizePublishedHistory(paired.map(item => item.record), { timeZone: spec.timeZone, bootstrap: spec.bootstrap });
  const recordsByMatch = new Map(paired.map(item => [item.record.matchId, item.record]));
  const oddsByMatch = new Map(paired.map(item => [item.record.matchId, item.record.officialOdds.sp]));
  const rows = baseline.perMatch.map(row => ({ ...row, favoriteSp: Math.min(...Object.values(oddsByMatch.get(row.matchId))) }));
  const grouped = Object.fromEntries(GROUPS.map(name => [name, new Map()]));
  for (const key of ["agree", "disagree"]) grouped.agreement.set(key, []);
  for (const key of OUTCOMES) grouped.modelDirection.set(key, []);
  for (const [name, edges] of [["modelProbability", spec.modelProbabilityEdges], ["marketFavoriteSp", spec.marketFavoriteSpEdges]]) {
    for (let index = 0; index < edges.length - 1; index += 1) grouped[name].set(intervalLabel(edges[index], edges), []);
  }
  for (const row of rows) {
    const keys = prematchGroupKeys(row, spec);
    for (const name of GROUPS) {
      if (!grouped[name].has(keys[name])) grouped[name].set(keys[name], []);
      grouped[name].get(keys[name]).push(row);
    }
  }
  const groups = Object.fromEntries(GROUPS.map(name => [name, [...grouped[name]].sort(([a], [b]) => a.localeCompare(b)).map(([value, members]) => ({
    value, ...aggregate(members, rows.length, evidence.length, spec),
  }))]));
  const exclusions = {};
  for (const item of evidence.filter(item => item.pairedEligible !== true)) exclusions[item.primaryReason || "unknown"] = (exclusions[item.primaryReason || "unknown"] || 0) + 1;
  const existingGateSpec = fixedGateSpec();
  const report = {
    version: VERSION, mode: "historical-diagnostic-only", productionEligible: false, improvementProven: false,
    source: { ...spec.source, inputBytes: inputBytes.length }, specificationHash: hash(spec),
    coverage: { sourceRows: evidence.length, pairedRows: rows.length, pairedCoverage: rows.length / evidence.length, exclusions },
    overall: aggregate(rows, rows.length, evidence.length, spec), groups,
    disagreementAppendix: rows.filter(row => prematchGroupKeys(row, spec).agreement === "disagree")
      .sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) || a.matchId.localeCompare(b.matchId))
      .map(row => {
        const source = recordsByMatch.get(row.matchId);
        return { matchId: row.matchId, market: row.market, league: row.league, kickoffAt: row.kickoffAt, matchDay: row.matchDay,
          decisionId: row.decisionId, decisionAt: row.decisionAt, cutoffAt: source.cutoffAt, modelVersion: row.originalModelVersion,
          frozenModelProbabilities: { ...source.decision.probabilities }, scoredModelProbabilities: { ...row.predictions.publishedModel },
          sameDecisionMarketProbabilities: { ...row.predictions.sameDecisionMarket }, officialSp: { ...source.officialOdds.sp },
          modelDirection: argmax(row.predictions.publishedModel), marketDirection: argmax(row.predictions.sameDecisionMarket),
          outcome: row.actual, resultObservedAt: row.resultObservedAt, sourceCycleId: source.decision.sourceCycleId,
          sourceRecordHash: row.inputRecordHash, sourceRecordHashMethod: "SHA-256 of JSON.stringify(original parsed record); full file SHA-256 also pinned",
          officialOddsProvenanceHash: source.officialOdds.provenanceHash };
      }),
    futureExecution: { ...spec.futureExecution, started: false, decision: "reuse existing registry; no candidate nomination from this diagnostic",
      existingGateSpec, existingGateSpecHash: hash(existingGateSpec),
      prerequisites: ["fresh healthy official data and immutable pre-cutoff captures", "existing ledger/suite verified and activation receipt retained", "new future rows only; this inspected September cohort is excluded", "all existing registry and selected-suite gates; this report grants no eligibility"],
      owners: ["scripts/candidateProspectiveLedger.cjs", "scripts/candidateCommonCohortShadowG2.cjs", "scripts/recommendationCandidateProtocol.cjs"] },
    limitations: ["Inspected historical data: groups are post-hoc diagnostics, not untouched holdout evidence.", "Groups are fixed in the configuration; outcome fields never select members; no best group is promoted.", "Each group uses one shared event set for model and market; groups within one dimension partition the paired cohort.", "Argmax hit rates are not the site's selected recommendation hit rate and cannot establish profitability.", "Group intervals are exploratory and not adjusted for multiple comparisons; small groups have no interval.", "Pinned hashes protect this known upstream-admitted export, not authenticity of arbitrary caller-supplied datasets.", "No training, threshold changes, online writes, future registration, activation, or promotion occurred."],
  };
  return { ...report, reportHash: hash(report) };
}

function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--input", "--config", "--output"].includes(argv[i]) && argv[i + 1] && !args[argv[i]], "usage: --input evidence.jsonl --config spec.json --output new-report.json");
    args[argv[i]] = path.resolve(argv[i + 1]);
  }
  assert(Object.keys(args).length === 3 && new Set(Object.values(args)).size === 3, "three distinct input/config/output paths required");
  assert(fs.statSync(args["--input"]).size <= 16 * 1024 * 1024 && fs.statSync(args["--config"]).size <= 65536, "input size exceeds bound");
  const inputBytes = fs.readFileSync(args["--input"]);
  const spec = JSON.parse(fs.readFileSync(args["--config"], "utf8"));
  const report = buildDiagnostic(inputBytes, spec);
  fs.mkdirSync(path.dirname(args["--output"]), { recursive: true });
  fs.writeFileSync(args["--output"], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output: args["--output"], reportHash: report.reportHash, pairedRows: report.coverage.pairedRows, productionEligible: false })}\n`);
}
if (require.main === module) { try { cli(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { buildDiagnostic, prematchGroupKeys, validateSpec, sha256 };
