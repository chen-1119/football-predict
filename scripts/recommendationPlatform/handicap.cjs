'use strict';
const { analyzeHandicap, integerLine, finite, settledHandicap } = require('../../src/services/handicapMargin.cjs');
const { hash, time } = require('../../src/services/publishedForecastPolicy.cjs');

/** Optional analysis on the exact current-cycle input. A missing HHAD component
 * must never suppress a valid ordinary-HAD publication or its existing combo. */
function buildHandicapAnalysis(input, decision, now) {
  const rawLine = input?.handicapLine;
  if (rawLine === undefined || rawLine === null || rawLine === '') return null;
  const unavailable = reason => ({ version: 'net-margin-hhad-v1', status: 'unavailable', reason, line: integerLine(rawLine) });
  const line = integerLine(rawLine), model = input?.probabilityModel;
  if (line === null) return unavailable('integer-handicap-required');
  const modelLine = model?.handicap?.line;
  if (modelLine != null && modelLine !== '' && integerLine(modelLine) !== line) return unavailable('handicap-line-conflict');
  const lineObservedAt = input.handicapOddsReceivedAt || input.handicapOddsUpdatedAt;
  const observed = time(lineObservedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > 15 * 60000 || observed >= time(decision.cutoffTime)) return unavailable('handicap-line-stale-or-unknown');
  const lambda = model?.calculationTrace?.poisson?.lambdas;
  const homeLambda = finite(lambda?.home), awayLambda = finite(lambda?.away);
  if (homeLambda === null || awayLambda === null) return unavailable('goal-margin-model-missing');
  if (time(model.generatedAt) !== time(decision.modelGeneratedAt)) return unavailable('goal-model-clock-mismatch');
  try {
    const values = analyzeHandicap({ line, hadProbabilities: decision.probabilities, homeLambda, awayLambda });
    const snapshot = { homeLambda, awayLambda, modelGeneratedAt: decision.modelGeneratedAt,
      modelVersion: String(model.version || 'unknown'), parameterSource: 'probabilityModel.calculationTrace.poisson.lambdas',
      lineObservedAt: new Date(observed).toISOString(), lineSource: String(input.handicapOddsSource || 'current-input-handicap'),
      sourceMatchId: decision.sourceMatchId, eventVersion: decision.eventVersion };
    const body = { ...values, status: 'ready', snapshot };
    return { ...body, evidenceHash: hash(body) };
  } catch { return unavailable('goal-margin-model-invalid'); }
}
function validHandicapAnalysis(analysis, decision) {
  if (!analysis) return true; // Legacy immutable records remain readable, never backfilled.
  if (analysis.version !== 'net-margin-hhad-v1') return false;
  if (analysis.status === 'unavailable') return typeof analysis.reason === 'string' && !analysis.tipCode && !analysis.probabilities;
  if (analysis.status !== 'ready' || analysis.market !== 'HHAD' || analysis.comboEligible !== false || analysis.odds !== null) return false;
  try {
    const { evidenceHash, ...body } = analysis, s = analysis.snapshot;
    if (hash(body) !== evidenceHash || s.sourceMatchId !== decision.sourceMatchId || s.eventVersion !== decision.eventVersion
      || s.modelGeneratedAt !== decision.modelGeneratedAt || time(s.lineObservedAt) > time(decision.publishedAt)
      || time(decision.publishedAt) - time(s.lineObservedAt) > 15 * 60000) return false;
    const values = analyzeHandicap({ line: analysis.line, hadProbabilities: decision.probabilities, homeLambda: s.homeLambda, awayLambda: s.awayLambda });
    return hash({ ...values, status: 'ready', snapshot: s }) === evidenceHash;
  } catch { return false; }
}
function settleHandicap(analysis, parentSettlement) {
  if (analysis?.status !== 'ready' || !analysis.tipCode) return null;
  const base = { line: analysis.line, tipCode: analysis.tipCode, actual: null, state: parentSettlement.state, score: parentSettlement.score || null };
  if (!['WON','LOST'].includes(base.state)) return base;
  const match = /^(\d+)-(\d+)$/.exec(base.score || '');
  const actual = match ? settledHandicap(Number(match[1]), Number(match[2]), analysis.line) : null;
  return { ...base, actual, state: actual ? actual === analysis.tipCode ? 'WON' : 'LOST' : 'DISPUTED' };
}
module.exports = { buildHandicapAnalysis, validHandicapAnalysis, settleHandicap };
