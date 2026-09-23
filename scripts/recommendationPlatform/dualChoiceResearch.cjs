'use strict';

// A separate, prospective research ledger. These two selections are two
// independent one-unit wagers on ONE event, never a two-leg accumulator or a
// published recommendation. Neither selection is chosen after the result.
const { hash, time, day } = require('../../src/services/publishedForecastPolicy.cjs');
const { coherentHandicapDistribution, DISTRIBUTION_BASIS } = require('../../src/services/handicapMarginDecision.cjs');
const { selectionFor, freshSelection } = require('./comboSelections.cjs');
const { validDecision } = require('./decision.cjs');
const { key, settleDecision, validResultEvent } = require('./results.cjs');
const { selectionQuality } = require('../../src/services/recommendationSelectionQuality.cjs');

const VERSION = 'dual-choice-research-v1';
const STAKE_PER_SELECTION = 1;
const CODES = ['1', 'X', '2'];
const round = n => Number(n.toFixed(6));

function probabilitiesFor(decision, had, hhad) {
  const h = decision.handicapAnalysis;
  if (h?.version !== 'handicap-margin-v3' || h.distributionBasis !== DISTRIBUTION_BASIS) return null;
  const matrix = coherentHandicapDistribution(h.lambdas?.home, h.lambdas?.away, h.handicapLine,
    h.straightProbabilities, h.straightTipCode, h.historicalCalibration?.applied ? h.probabilities : null);
  if (!matrix) return null;
  const hadProbability = matrix.straightProbabilities[had.tipCode];
  const hhadProbability = matrix.probabilities[hhad.tipCode];
  const bothProbability = matrix.jointProbabilities[had.tipCode][hhad.tipCode];
  const unionProbability = hadProbability + hhadProbability - bothProbability;
  if (![hadProbability, hhadProbability, bothProbability, unionProbability].every(n => Number.isFinite(n) && n >= -1e-9 && n <= 1+1e-9)
    || Math.abs(hadProbability - had.modelProbability) > 1e-9
    || Math.abs(hhadProbability - hhad.modelProbability) > 1e-6
    || CODES.some(c => Math.abs(matrix.straightProbabilities[c] - decision.probabilities[c]) > 1e-9
      || Math.abs(matrix.probabilities[c] - h.overallProbabilities[c]) > 1e-6)) return null;
  return { hadProbability: round(hadProbability), hhadProbability: round(hhadProbability),
    bothProbability: round(bothProbability), unionProbability: round(unionProbability),
    probabilityBasis: 'coherent-unconditional-joint-score-matrix',
    expectedGrossReturn: round(hadProbability * had.odds + hhadProbability * hhad.odds) };
}

function createDualResearchRecord(decision, now) {
  try {
    if (!Number.isFinite(now) || !validDecision(decision) || !selectionQuality(decision).qualified
      || decision.businessDate !== day(now)
      || now < time(decision.publishedAt) || now >= Math.min(time(decision.cutoffTime), time(decision.kickoffTime))) return null;
    const had = selectionFor(decision, 'HAD'), hhad = selectionFor(decision, 'HHAD');
    if (!had || !hhad || !freshSelection(had, decision, now) || !freshSelection(hhad, decision, now)) return null;
    const probabilities = probabilitiesFor(decision, had, hhad);
    if (!probabilities) return null;
    const body = {
      version: VERSION, cohort: 'independent-research-only', formalPromotion: false,
      id: `dual_research_${hash([VERSION, decision.decisionId, had.selectionId, hhad.selectionId])}`,
      decisionId: decision.decisionId, decisionRecordHash: decision.recordHash,
      sourceMatchId: decision.sourceMatchId, eventVersion: decision.eventVersion, businessDate: decision.businessDate,
      recordedAt: new Date(now).toISOString(), cutoffAt: decision.cutoffTime,
      selections: [structuredClone(had), structuredClone(hhad)],
      stakePerSelection: STAKE_PER_SELECTION, totalStake: 2 * STAKE_PER_SELECTION,
      ...probabilities,
    };
    return Object.freeze({ ...body, recordHash: hash(body) });
  } catch { return null; }
}

function validDualResearchRecord(record, decision) {
  try {
    if (!record || record.version !== VERSION || record.cohort !== 'independent-research-only'
      || record.formalPromotion !== false || !validDecision(decision)
      || record.decisionId !== decision.decisionId || record.decisionRecordHash !== decision.recordHash
      || record.sourceMatchId !== decision.sourceMatchId || record.eventVersion !== decision.eventVersion
      || record.businessDate !== decision.businessDate || record.cutoffAt !== decision.cutoffTime
      || record.stakePerSelection !== STAKE_PER_SELECTION || record.totalStake !== 2 * STAKE_PER_SELECTION
      || !Array.isArray(record.selections) || record.selections.length !== 2
      || record.selections[0].market !== 'HAD' || record.selections[1].market !== 'HHAD') return false;
    const at = time(record.recordedAt);
    if (!Number.isFinite(at) || at < time(decision.publishedAt)
      || at >= Math.min(time(decision.cutoffTime), time(decision.kickoffTime))
      || day(at) !== decision.businessDate) return false;
    const expected = createDualResearchRecord(decision, at);
    if (!expected) return false;
    const { recordHash, ...body } = record;
    return recordHash === hash(body) && hash(expected) === hash(record);
  } catch { return false; }
}

function settleDualResearch(record, decision, event) {
  if (!validDualResearchRecord(record, decision)) throw new Error('Invalid dual-choice research record');
  const selections = record.selections.map(selection => {
    const snapshot = { ...decision, market: selection.market, handicapLine: selection.handicapLine, tipCode: selection.tipCode };
    const result = settleDecision(snapshot, event);
    return { selectionId: selection.selectionId, market: selection.market, handicapLine: selection.handicapLine,
      tipCode: selection.tipCode, odds: selection.odds, ...result };
  });
  const states = new Set(selections.map(s => s.state));
  const state = states.has('DISPUTED') || (states.has('VOID') && states.size > 1) ? 'DISPUTED'
    : states.has('VOID') ? 'VOID' : states.has('PENDING') ? 'PENDING'
      : states.has('WON') ? 'WON' : 'LOST';
  const grossReturn = state === 'VOID' ? record.totalStake
    : state === 'WON' || state === 'LOST' ? round(selections.reduce((sum, s) => sum + (s.state === 'WON' ? s.odds * record.stakePerSelection : 0), 0)) : null;
  return { state, selections, grossReturn,
    netProfit: grossReturn === null ? null : round(grossReturn - record.totalStake),
    resultEventId: event?.eventId || null,
    definition: 'two-independent-one-unit-wagers; NOT an accumulator' };
}

function summarizeDualResearch(rows) {
  const counts = {version: VERSION, cohort:'independent-research-only', formalPromotion:false,
    observed: rows.length, settled:0, won:0, lost:0, pending:0, void:0, disputed:0,
    totalStakeCommitted: round(rows.length * 2 * STAKE_PER_SELECTION), settledStake:0,
    grossReturn:0, netProfit:0, voidRefund:0, pendingExposure:0,
    selectionWins:0, selectionSettled:0, hitRate:null, selectionHitRate:null, roi:null};
  for (const row of rows) {
    const state = row?.settlement?.state || 'PENDING';
    if (state === 'WON' || state === 'LOST') {
      counts.settled++; counts[state === 'WON' ? 'won' : 'lost']++;
      counts.settledStake += row.record.totalStake;
      counts.grossReturn += row.settlement.grossReturn;
      counts.selectionSettled += row.record.selections.length;
      counts.selectionWins += row.settlement.selections.filter(s => s.state === 'WON').length;
    } else if (state === 'VOID') { counts.void++; counts.voidRefund += row.record.totalStake; }
    else if (state === 'DISPUTED') counts.disputed++;
    else { counts.pending++; counts.pendingExposure += row.record.totalStake; }
  }
  counts.settledStake = round(counts.settledStake);
  counts.grossReturn = round(counts.grossReturn);
  counts.netProfit = round(counts.grossReturn - counts.settledStake);
  counts.voidRefund = round(counts.voidRefund);
  counts.pendingExposure = round(counts.pendingExposure);
  counts.hitRate = counts.settled ? counts.won / counts.settled : null;
  counts.selectionHitRate = counts.selectionSettled ? counts.selectionWins / counts.selectionSettled : null;
  counts.roi = counts.settledStake ? counts.netProfit / counts.settledStake : null;
  return counts;
}

function buildDualResearchReport(records, decisions, events, asOf=Date.now()) {
  const bound = new Map(decisions.map(d => [d.decisionId, d]));
  const validEvents=events.filter(validResultEvent);
  const heads = new Map(validEvents.map(e => [e.eventKey, e]));
  const rows = [], invalid = [];
  for (const record of records) {
    const decision = bound.get(record?.decisionId);
    if (!validDualResearchRecord(record, decision)) { invalid.push(record?.id || null); continue; }
    rows.push({ record, settlement:settleDualResearch(record, decision, heads.get(key(decision))) });
  }
  const businessDay = day(asOf);
  const window = n => rows.filter(row => {
    const difference = Math.round((Date.parse(`${businessDay}T00:00:00Z`) - Date.parse(`${row.record.businessDate}T00:00:00Z`)) / 86400000);
    return difference >= 0 && difference < n;
  });
  const independentDays = new Set(rows.filter(r => ['WON','LOST'].includes(r.settlement.state)).map(r => r.record.businessDate)).size;
  const all = summarizeDualResearch(rows);
  return { version:VERSION, generatedAt:new Date(asOf).toISOString(), researchOnly:true,
    all, last7:summarizeDualResearch(window(7)), last30:summarizeDualResearch(window(30)),
    independentDays, invalidRecords:invalid.length, invalidResultHeads:events.length-validEvents.length,
    validation: { formalPromotion:false, readyForIndependentReview:invalid.length===0 && events.length===validEvents.length && all.settled>=100 && independentDays>=7,
      minimumSettled:100, minimumIndependentDays:7,
      note:'Passing sample gates permits a separate pre-registered holdout review; it never auto-publishes.' } };
}

module.exports = { VERSION, STAKE_PER_SELECTION, createDualResearchRecord, validDualResearchRecord,
  settleDualResearch, summarizeDualResearch, buildDualResearchReport };
