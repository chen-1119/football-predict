"use strict";
const { createHash } = require("node:crypto");
const { strictInstant } = require("./strictInstant.cjs");
const VERSION = "model-input-usage-v1";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finite = value => typeof value === "number" && Number.isFinite(value);
const triplet = value => value && [value.home, value.draw, value.away].every(finite);
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const same = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 1e-12;
// Preserve original signed clock bytes while comparing every supported fraction.
// Date.parse alone accepts calendar rollover and truncates submillisecond clocks.
const clockNs = value => {
  if (strictInstant(value) === null) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || "";
  return BigInt(Date.parse(value)) * 1000000n + BigInt(fraction.padEnd(9, "0").slice(3) || "0");
};

// These receipts are created only by the executing arithmetic functions.
// They attest arithmetic use, NOT source truth, freshness, or promotion eligibility.
function recordModelInputUsage(match, stage, computation) {
  const payload = clone({ version: VERSION, stage, recordedAt: require("./predictionExecutionClock.cjs").predictionNowIso(),
    sourceMatchId: String(match.sourceMatchId || ""), kickoffTime: match.kickoffTime || null,
    ...computation });
  return { ...payload, contentHash: digest(payload) };
}

function verifyModelInputUsage(receipt) {
  if (!receipt || receipt.version !== VERSION) return false;
  const { contentHash, ...body } = receipt;
  if (digest(body) !== contentHash || clockNs(receipt.recordedAt) === null
    || !receipt.sourceMatchId || clockNs(receipt.kickoffTime) === null) return false;
  if (receipt.stage === "base-outcome-blend") {
    const weights = receipt.weights;
    const inputs = receipt.inputs;
    if (!weights || !inputs || !triplet(receipt.output)) return false;
    if (receipt.ensemblePolicy !== undefined
      && !require('./baselineEnsemblePolicy.cjs').validEnsemblePolicy(receipt.ensemblePolicy, weights)) return false;
    const raw = { home: 0, draw: 0, away: 0 };
    for (const key of ["market", "teamStrength", "elo", "poisson", "worldCupPrior"]) {
      const weight = weights[key];
      if (!finite(weight) || weight < 0 || weight > 1 || (weight > 0 && !triplet(inputs[key]))) return false;
      for (const side of ["home", "draw", "away"]) raw[side] += (inputs[key]?.[side] || 0) * weight;
    }
    const total = raw.home + raw.draw + raw.away;
    return total > 0 && ["home", "draw", "away"].every(side => same(raw[side] / total, receipt.output[side]));
  }
  if (receipt.stage === "form-lambda-blend") {
    if (![receipt.before?.home, receipt.before?.away, receipt.weight, receipt.output?.home, receipt.output?.away].every(finite)
      || receipt.weight < 0 || receipt.weight > 1 || !Array.isArray(receipt.candidates)) return false;
    if (!receipt.candidates.length) return receipt.weight === 0 && same(receipt.before.home, receipt.output.home) && same(receipt.before.away, receipt.output.away);
    if (receipt.candidates.some(c => ![c.homeLambda, c.awayLambda, c.confidence].every(finite) || c.confidence <= 0)) return false;
    if (receipt.lambdaPolicy !== undefined && receipt.lambdaPolicy !== 'evidence-rate-support-v2') return false;
    const expanded = receipt.lambdaPolicy === 'evidence-rate-support-v2';
    const total = receipt.candidates.reduce((sum, c) => sum + c.confidence, 0);
    return ["home", "away"].every(side => {
      const form = clamp(receipt.candidates.reduce((sum, c) => sum + c[`${side}Lambda`] * c.confidence, 0) / total, 0.25, expanded ? 12 : 3.6);
      return same(clamp(receipt.before[side] * (1 - receipt.weight) + form * receipt.weight, 0.25, expanded ? 12 : 3.4), receipt.output[side]);
    });
  }
  if (receipt.stage === "joint-goal-fit") {
    const { verifyJointGoalArithmetic } = require("./jointGoalFit.cjs");
    return receipt.fit?.sourceMatchId === receipt.sourceMatchId
      && receipt.fit?.kickoffTime === receipt.kickoffTime
      && verifyJointGoalArithmetic(receipt.fit);
  }
  return false;
}

function summarizeModelInputUsage(model, match) {
  const receipts = model?.inputUsage;
  if (!Array.isArray(receipts) || !receipts.length) return null;
  const modelClock = clockNs(model.generatedAt), eventClock = clockNs(match?.kickoffTime);
  if (modelClock === null || eventClock === null) return null;
  const valid = receipts.filter(r => verifyModelInputUsage(r)
    && r.sourceMatchId === String(match?.sourceMatchId || "")
    && clockNs(r.kickoffTime) === eventClock && clockNs(r.recordedAt) <= modelClock);
  if (valid.length !== receipts.length || new Set(valid.map(r => r.stage)).size !== valid.length) return null;
  const blend = valid.find(r => r.stage === "base-outcome-blend");
  const form = valid.find(r => r.stage === "form-lambda-blend");
  const joint = valid.find(r => r.stage === "joint-goal-fit");
  const rows = [];
  if (blend) {
    // Bind to the actual pre-calibration base result, not a later public direction.
    const before = model.calibrationAdjustment?.oneXTwo?.before;
    if (!triplet(before) || !["home", "draw", "away"].every(side => Math.abs(before[side] - Number((clamp(blend.output[side], 0, 1) * 100).toFixed(1))) < 1e-9)) return null;
    rows.push({ key: "elo", stage: blend.stage, used: blend.weights.elo > 0, weight: blend.weights.elo, receiptHash: blend.contentHash });
    const official = /^sporttery:(HAD|HHAD)$/.test(blend.marketSource || "");
    rows.push({ key: !blend.marketPool ? "syntheticAnchor" : official ? "officialOdds" : blend.marketSource ? "externalMarket" : "unknownMarketAnchor", stage: blend.stage, used: blend.weights.market > 0,
      weight: blend.weights.market, receiptHash: blend.contentHash, poolCode: blend.marketPool, source: blend.marketSource || null });
  }
  if (form) {
    if (!finite(model.lambdaBlend?.formWeight) || Math.abs(model.lambdaBlend.formWeight - Number(form.weight.toFixed(3))) > 1e-12) return null;
    rows.push({ key: "form", stage: form.stage, used: form.weight > 0, weight: form.weight, receiptHash: form.contentHash,
      sources: form.candidates.map(c => c.source),
      fallbackMetrics: form.candidates.reduce((n, c) => n + (c.fallbackMetrics?.length || 0), 0) });
  }
  if (joint) {
    const fit = joint.fit;
    if (model.lambdaBlend?.jointGoalFit && model.lambdaBlend.jointGoalFit.contentHash !== fit.contentHash) return null;
    if (model.calculationTrace?.poisson?.lambdas
      && (Math.abs(model.calculationTrace.poisson.lambdas.home - fit.output.home) > 1e-12
        || Math.abs(model.calculationTrace.poisson.lambdas.away - fit.output.away) > 1e-12)) return null;
    if (match?.externalSignals?.goalFitEvidence
      && !require("./jointGoalFit.cjs").verifyJointGoalFit(fit, match, model.generatedAt)) return null;
    rows.push({ key: "observedXg", stage: joint.stage, used: true, weight: fit.weights.xgTotal,
      receiptHash: joint.contentHash, evidenceHash: fit.evidenceHash, samples: fit.inputs.samples });
    rows.push({ key: "historicalOver25", stage: joint.stage, used: true, weight: fit.weights.over25Total,
      receiptHash: joint.contentHash, evidenceHash: fit.evidenceHash, samples: fit.inputs.samples });
  }
  return { version: VERSION, scope: "base-calculation-only", sourceVerified: false, rows };
}
module.exports = { VERSION, recordModelInputUsage, verifyModelInputUsage, summarizeModelInputUsage };
