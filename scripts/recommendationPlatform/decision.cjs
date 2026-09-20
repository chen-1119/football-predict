'use strict';

const { evaluateForecast, hash, time, day } = require('../../src/services/publishedForecastPolicy.cjs');
const { buildHandicapMarginDecision, validHandicapMarginDecision } = require('../../src/services/handicapMarginDecision.cjs');
const VERSION = 'unified-decision-v1';
const COMBO_VERSION = 'unified-combo-v1';
const FLOORS = Object.freeze({ 2: 2.5, 3: 5 });
const immutable = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable); Object.freeze(value);
  }
  return value;
};
const eventKey = row => JSON.stringify([String(row.sourceMatchId || row.id || '').replace(/^sporttery_/, ''), new Date(time(row.eventVersion || row.kickoffTime)).toISOString(), row.market || 'HAD']);

/** Policy validation is shared with single publications. No second direction
 * inference, market blending, confidence gate, or BEST prerequisite exists here. */
function makeDecision(match, { now, publication }) {
  const result = evaluateForecast(match, { now, publication });
  if (!result.eligible) return { decision: null, reason: result.reason };
  const candidate = result.candidate;
  const input = require('../../src/services/prospectiveForecastInput.cjs').forecastInputFor(match);
  if (!input) return { decision:null, reason:'prospective-input-invalid' };
  if (Object.values(candidate.quoteOdds).some(value => units(value) === null)) return { decision: null, reason: 'unsupported-sp-precision' };
  const handicapAnalysis = buildHandicapMarginDecision(input, { now, cutoffTime:candidate.cutoffTime, straightTipCode:candidate.tipCode });
  const hadInputHash = candidate.inputHash;
  const inputHash = hash({ hadInputHash, handicapInputHash: handicapAnalysis?.inputHash || null });
  const identity = [VERSION, candidate.sourceMatchId, candidate.eventVersion, candidate.market, inputHash];
  const decisionId = `decision_${hash(identity)}`;
  const body = { ...candidate, hadInputHash, inputHash, handicapAnalysis, version: VERSION, policyVersion: VERSION, decisionId, id: decisionId,
    statisticsTrack: 'unified-decision', publishedAt: new Date(now).toISOString(), publicationStatus: 'PUBLISHED',
    evaluationRule: 'latest-published-input-before-cutoff-per-event', modelValidation: 'unvalidated',
    upstreamModelVersion: String(input?.probabilityModel?.version || 'unknown'),
    sourceCycleId: String(input?.sourceCycleId || publication.sourceCycleId || ''),
    inputEvidence: { model: { version: input.probabilityModel.version || null, generatedAt: candidate.modelGeneratedAt,
      oneXTwo: { final: structuredClone(input.probabilityModel.oneXTwo.final) },
      handicapMarginInputHash: handicapAnalysis?.inputHash || null },
      quoteSource: candidate.quoteSource, quoteObservedAt: candidate.quoteObservedAt } };
  return { decision: immutable({ ...body, recordHash: hash(body) }), reason: null };
}
function validDecision(row) {
  if (!row || row.version !== VERSION || row.policyVersion !== VERSION || row.market !== 'HAD' || row.handicapLine !== 0 || row.modelValidation !== 'unvalidated') return false;
  const { recordHash, ...body } = row;
  if (hash(body) !== recordHash || row.decisionId !== `decision_${hash([VERSION, row.sourceMatchId, row.eventVersion, row.market, row.inputHash])}` || row.id !== row.decisionId) return false;
  if (row.hadInputHash && row.inputHash !== hash({ hadInputHash:row.hadInputHash, handicapInputHash:row.handicapAnalysis?.inputHash || null })) return false;
  if (!validHandicapMarginDecision(row.handicapAnalysis)) return false;
  if (row.handicapAnalysis && row.handicapAnalysis.straightTipCode !== row.tipCode) return false;
  if (row.quoteSource === '500.com:jczq:HAD') {
    const proof = row.quoteProvenance;
    const bound = require('../../src/services/warehouseLotterySp.cjs').warehouseQuoteForMatch({
      ...row, id: row.matchId, externalSignals: { bookmakerOdds: { had: { ...proof?.quoteOdds, lotterySpReceipt: proof } } },
    }, time(row.publishedAt), time(row.cutoffTime));
    if (!bound || row.sourceVerification !== 'warehouse-jczq-extraction'
      || time(row.quoteObservedAt) !== time(bound.at)
      || ['1','X','2'].some((c,i) => row.quoteOdds?.[c] !== bound.odds[['odds1','oddsX','odds2'][i]])) return false;
  }
  const p = row.probabilities;
  if (!p || !['1','X','2'].includes(row.tipCode) || !['1','X','2'].every(c => typeof p[c] === 'number' && Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1)) return false;
  if (Math.abs(p['1'] + p.X + p['2'] - 1) > 1e-8 || p[row.tipCode] !== row.modelProbability) return false;
  if (!['1','X','2'].every(c => c === row.tipCode || p[row.tipCode] > p[c])) return false;
  if (!row.quoteOdds || !['1','X','2'].every(c => units(row.quoteOdds[c]) !== null) || row.quoteOdds[row.tipCode] !== row.odds) return false;
  return time(row.publishedAt) >= time(row.modelGeneratedAt) && time(row.publishedAt) >= time(row.quoteObservedAt)
    && time(row.publishedAt) < Math.min(time(row.cutoffTime), time(row.kickoffTime))
    && time(row.eventVersion) === time(row.kickoffTime);
}
function evaluateCurrent(matches, context) {
  const grouped = new Map(), issues = [], decisions = [];
  for (const match of matches) {
    const key = String(match?.sourceMatchId || match?.id || '').replace(/^sporttery_/, '');
    const group = grouped.get(key) || []; group.push(match); grouped.set(key, group);
  }
  for (const [source, group] of grouped) {
    const keys = new Set(group.map(m => JSON.stringify([m?.eventVersion || m?.kickoffTime, m?.homeTeamId, m?.awayTeamId])));
    if (keys.size !== 1) { issues.push({ sourceMatchId: source, reason: 'conflicting-event-identity' }); continue; }
    const accepted = [];
    for (const match of group) {
      try {
        const result = makeDecision(match, context);
        if (result.decision) accepted.push(result.decision);
        else issues.push({ sourceMatchId: source, reason: result.reason });
      } catch { issues.push({ sourceMatchId: source, reason: 'malformed-match' }); }
    }
    accepted.sort((a,b) => time(b.modelGeneratedAt) - time(a.modelGeneratedAt) || time(b.quoteObservedAt) - time(a.quoteObservedAt) || a.decisionId.localeCompare(b.decisionId));
    if (accepted[0]) decisions.push(accepted[0]);
  }
  return { decisions, issues };
}
function units(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1) return null;
  const s = String(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}
function product(legs) {
  const encoded = legs.map(leg => units(leg.odds));
  if (!encoded.length || encoded.some(n => n === null)) return null;
  const numerator = encoded.reduce((a,b) => a*b, 1n), denominator = 10000n ** BigInt(legs.length);
  return { value: Number(numerator) / Number(denominator), passes: floor => numerator * 100n >= BigInt(Math.round(floor * 100)) * denominator };
}
function freezeAt(date, legs) {
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  const dow = new Date(midnight + 8*3600000).getUTCDay();
  return Math.min(midnight + ([0,6].includes(dow) ? 22 : 21)*3600000, ...legs.map(l => time(l.cutoffTime) - 5*60000));
}
function chooseCombo(decisions, size, now) {
  if (!FLOORS[size] || !Number.isFinite(now)) return null;
  const candidates = decisions.filter(d => validDecision(d) && d.businessDate === day(now) && now < time(d.cutoffTime) && now >= time(d.quoteObservedAt) && now - time(d.quoteObservedAt) <= 15*60000)
    .slice().sort((a,b) => b.modelProbability - a.modelProbability || a.decisionId.localeCompare(b.decisionId));
  let best = null, score = -Infinity, bestProduct = Infinity, bestKey = '';
  function visit(start, picked, logp) {
    const need = size - picked.length;
    if (!need) {
      const quote = product(picked); if (!quote?.passes(FLOORS[size])) return;
      const key = picked.map(d => d.decisionId).sort().join('|');
      if (logp > score + 1e-12 || (Math.abs(logp-score) <= 1e-12 && (quote.value < bestProduct || (quote.value === bestProduct && key < bestKey)))) {
        best = picked.slice(); score = logp; bestProduct = quote.value; bestKey = key;
      }
      return;
    }
    if (candidates.length - start < need) return;
    const bound = candidates.slice(start,start+need).reduce((sum,d) => sum + Math.log(d.modelProbability),logp);
    if (bound < score - 1e-12) return;
    for (let i=start;i<=candidates.length-need;i++) {
      const next = candidates[i];
      if (picked.some(d => d.sourceMatchId === next.sourceMatchId || [d.homeTeamId,d.awayTeamId].some(t => [next.homeTeamId,next.awayTeamId].includes(t)))) continue;
      visit(i+1,[...picked,next],logp+Math.log(next.modelProbability));
    }
  }
  visit(0,[],0);
  if (!best) return null;
  best.sort((a,b) => time(a.kickoffTime)-time(b.kickoffTime) || a.decisionId.localeCompare(b.decisionId));
  const body = { version: COMBO_VERSION, id: `combo_${hash([COMBO_VERSION, day(now),size,best.map(d=>d.decisionId)])}`,
    businessDate: day(now), size, minimumTotalOdds: FLOORS[size], totalOdds: Number(bestProduct.toFixed(2)), rawTotalOdds: bestProduct,
    legs: best, decisionIds: best.map(d => d.decisionId), generatedAt: new Date(now).toISOString(), freezeAt: new Date(freezeAt(day(now),best)).toISOString(),
    rankingMethod: 'sum-log-unchanged-model-probability', jointProbability: null, statisticsTrack: 'unified-combo',
    calibration: 'unvalidated', overlapWarning: null };
  return immutable(body);
}
function freezeCombo(preview, now) {
  if (!preview || !FLOORS[preview.size] || preview.legs.length !== preview.size || !product(preview.legs)?.passes(FLOORS[preview.size]) || preview.decisionIds?.length !== preview.size || preview.legs.some((d,i) => d.decisionId !== preview.decisionIds[i]) || now < time(preview.freezeAt) || preview.legs.some(d => !validDecision(d) || now >= time(d.cutoffTime) || now - time(d.quoteObservedAt) > 15*60000)) return null;
  const body = { ...preview, frozenAt: new Date(now).toISOString() };
  return immutable({ ...body, recordHash: hash(body) });
}
module.exports = { VERSION, COMBO_VERSION, FLOORS, eventKey, makeDecision, validDecision, evaluateCurrent, units, product, chooseCombo, freezeCombo };
