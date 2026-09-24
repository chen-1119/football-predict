'use strict';

// Two independent one-unit wagers on the same event, chosen from whichever
// official HAD/HHAD markets are actually open. A model 1X2 distribution is
// never evidence that the HAD betting market itself has opened.
const { hash, time, day, probabilities, evaluateForecast } = require('../../src/services/publishedForecastPolicy.cjs');
const { buildInputEvidence, validInputEvidence } = require('../../src/services/recommendationInputEvidence.cjs');
const { buildHandicapMarginDecision, validHandicapMarginDecision, coherentHandicapDistribution } = require('../../src/services/handicapMarginDecision.cjs');
const { units } = require('./decision.cjs');
const { key, validResultEvent } = require('./results.cjs');

const VERSION = 'dual-choice-research-v2';
const CODES = ['1', 'X', '2'];
const STAKE_PER_SELECTION = 1;
const round = n => Number(n.toFixed(6));
const clone = value => value == null ? value : structuredClone(value);
const sourceId = value => String(value || '').replace(/^sporttery_/, '');
const validIdentity = value => typeof value === 'string' && value.trim().length > 0;

function snapshotFor(match) {
  if (!match || (Object.hasOwn(match, 'prospectiveForecastInput') && !match.prospectiveForecastInput)) return null;
  const input = require('../../src/services/prospectiveForecastInput.cjs').forecastInputFor(match);
  if (!input) return null;
  const model = input.probabilityModel;
  if (!model) return null;
  const evidence = model.inputEvidence || buildInputEvidence(model, input);
  if (!evidence || !validInputEvidence(evidence, model, input)) return null;
  const snapshot = {
    id: input.id, sourceMatchId: input.sourceMatchId, eventVersion: input.eventVersion,
    businessDate: input.businessDate, kickoffTime: input.kickoffTime, buyEndTime: input.buyEndTime,
    status: input.status, resultDisposition: input.resultDisposition || null,
    isOnSale: input.isOnSale ?? null, saleStatus: input.saleStatus || null,
    homeTeamId: input.homeTeamId, awayTeamId: input.awayTeamId,
    homeTeamName: input.homeTeamName, awayTeamName: input.awayTeamName,
    odds: clone(input.odds), oddsSource: input.oddsSource,
    oddsReceivedAt: input.oddsReceivedAt, oddsUpdatedAt: input.oddsUpdatedAt,
    handicapLine: input.handicapLine, handicapOdds: clone(input.handicapOdds),
    handicapOddsSource: input.handicapOddsSource,
    handicapOddsReceivedAt: input.handicapOddsReceivedAt,
    handicapOddsObservedAt: input.handicapOddsObservedAt,
    handicapOddsUpdatedAt: input.handicapOddsUpdatedAt,
    predictionMeta: { cutoffTime: input.predictionMeta?.cutoffTime || null },
    externalSignals: input.externalSignals?.bookmakerOdds
      ? { bookmakerOdds: {
        ...(input.externalSignals.bookmakerOdds.had?.lotterySpReceipt
          ? { had: clone(input.externalSignals.bookmakerOdds.had) } : {}),
        ...(input.externalSignals.bookmakerOdds.hhad
          ? { hhad: clone(input.externalSignals.bookmakerOdds.hhad) } : {}),
      } } : null,
    probabilityModel: {
      version: model.version, generatedAt: model.generatedAt,
      sourceMatchId: model.sourceMatchId, eventVersion: model.eventVersion,
      oneXTwo: { final: clone(model.oneXTwo?.final) },
      calculationTrace: {
        poisson: { lambdas: clone(model.calculationTrace?.poisson?.lambdas) },
        expectedGoals: { values: clone(model.calculationTrace?.expectedGoals?.values) },
      },
      lambdaBlend: { marketHomeLambda: model.lambdaBlend?.marketHomeLambda,
        marketAwayLambda: model.lambdaBlend?.marketAwayLambda },
      inputEvidence: clone(evidence),
    },
  };
  if (!validInputEvidence(evidence, snapshot.probabilityModel, snapshot)) return null;
  return snapshot;
}

function qualifiedEvidence(evidence) {
  if (evidence?.arithmetic?.status !== 'verified') return false;
  const elo = evidence.weights?.elo > 0 && evidence.samples?.elo?.home >= 6 && evidence.samples?.elo?.away >= 6;
  const form = evidence.weights?.form > 0 && evidence.weights?.poisson > 0
    && evidence.samples?.form?.home >= 8 && evidence.samples?.form?.away >= 8;
  return Boolean(elo || form);
}

function createDualResearchV2Record(match, { now, publication } = {}) {
  try {
    if (!Number.isFinite(now) || !/^[a-f0-9]{64}$/.test(publication?.manifestHash || '')
      || !validIdentity(publication?.generationId)) return null;
    const committed = time(publication.committedAt);
    // A committed model generation is not the quote clock. A fresh official
    // market observation may pair with it while the model's own age gate holds.
    if (!Number.isFinite(committed) || committed > now) return null;
    const input = snapshotFor(match);
    if (!input || input.status !== 'SCHEDULED' || input.resultDisposition === 'VOID'
      || input.isOnSale === false || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(input.saleStatus || '').toUpperCase())
      || !validIdentity(input.id) || !validIdentity(sourceId(input.sourceMatchId || input.id))
      || ![input.homeTeamId, input.awayTeamId, input.homeTeamName, input.awayTeamName].every(validIdentity)
      || input.homeTeamId === input.awayTeamId || input.businessDate !== day(now)) return null;
    const kickoff = time(input.kickoffTime), eventVersion = time(input.eventVersion || input.kickoffTime);
    if (!Number.isFinite(kickoff) || eventVersion !== kickoff || now >= kickoff) return null;
    const midnight = Date.parse(`${input.businessDate}T00:00:00+08:00`);
    const weekend = [0, 6].includes(new Date(midnight + 8 * 3600000).getUTCDay());
    const deadlines = [kickoff, midnight + (weekend ? 23 : 22) * 3600000];
    for (const value of [input.buyEndTime, input.predictionMeta?.cutoffTime]) {
      if (value == null || value === '') continue;
      const at = time(value); if (!Number.isFinite(at)) return null;
      deadlines.push(at);
    }
    const cutoff = Math.min(...deadlines);
    if (now >= cutoff) return null;
    const model = input.probabilityModel, modelAt = time(model.generatedAt);
    const ageLimit = kickoff - now <= 2 * 3600000 ? 3600000 : kickoff - now <= 6 * 3600000 ? 3 * 3600000 : 12 * 3600000;
    if (!Number.isFinite(modelAt) || modelAt > committed || modelAt > now
      || modelAt >= cutoff || now - modelAt > ageLimit
      || !qualifiedEvidence(model.inputEvidence)) return null;
    const straight = probabilities(model.oneXTwo?.final);
    if (!straight) return null;
    const rankedStraight = CODES.slice().sort((a, b) => straight[b] - straight[a] || CODES.indexOf(a) - CODES.indexOf(b));
    if (straight[rankedStraight[0]] - straight[rankedStraight[1]] <= 1e-9) return null;
    const analysis = buildHandicapMarginDecision(input, {
      now, cutoffTime: new Date(cutoff).toISOString(), straightTipCode: rankedStraight[0],
    });
    const marketRows = [];
    const had = evaluateForecast(input, { now, publication });
    // This research lane admits an explicitly official HAD pool only. The
    // warehouse copy remains available to the existing publication policy.
    if (had.eligible && /^sporttery:had(?:$|:)/i.test(had.candidate.quoteSource)) {
      const quote = had.candidate;
      if (CODES.every(c => units(quote.quoteOdds?.[c]) !== null))
        marketRows.push({ market: 'HAD', handicapLine: 0, odds: quote.quoteOdds,
          probabilities: straight, observedAt: quote.quoteObservedAt, source: quote.quoteSource });
    }
    let matrix = null;
    if (analysis && validHandicapMarginDecision(analysis) && analysis.marketReference) {
      const quote = analysis.marketReference;
      matrix = coherentHandicapDistribution(analysis.lambdas.home, analysis.lambdas.away,
        analysis.handicapLine, analysis.straightProbabilities, analysis.straightTipCode,
        analysis.historicalCalibration?.applied ? analysis.probabilities : null);
      if (!matrix || CODES.some(c => Math.abs(matrix.straightProbabilities[c] - straight[c]) > 1e-9
        || Math.abs(matrix.probabilities[c] - analysis.overallProbabilities[c]) > 1e-6)) return null;
      if (quote.source === 'sporttery:HHAD' && quote.handicapLine === analysis.handicapLine
        && CODES.every(c => units(quote.odds?.[c]) !== null))
        marketRows.push({ market: 'HHAD', handicapLine: analysis.handicapLine,
          odds: quote.odds, probabilities: matrix.probabilities,
          observedAt: quote.observedAt, source: quote.source });
    }
    if (!marketRows.length) return null;
    const inputSnapshotHash = hash(input);
    const candidates = marketRows.flatMap(quote => {
      const observed = time(quote.observedAt);
      if (!Number.isFinite(observed) || observed > now || observed >= cutoff || now - observed > 15 * 60000) return [];
      const quoteSnapshotHash = hash(quote);
      return CODES.filter(c => quote.probabilities[c] > 0).map(tipCode => {
        const body = { market: quote.market, handicapLine: quote.handicapLine, tipCode,
          odds: quote.odds[tipCode], modelProbability: quote.probabilities[tipCode],
          quoteOdds: clone(quote.odds), quoteObservedAt: quote.observedAt, quoteSource: quote.source,
          inputSnapshotHash, quoteSnapshotHash };
        return { ...body, selectionId: `selection_${hash([VERSION, body])}` };
      });
    });
    if (candidates.length < 2) return null;
    let best = null;
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.market === b.market && a.tipCode === b.tipCode) continue;
      const both = a.market === b.market ? 0
        : matrix?.jointProbabilities[a.market === 'HAD' ? a.tipCode : b.tipCode]
          ?.[a.market === 'HHAD' ? a.tipCode : b.tipCode];
      if (both === undefined || both < -1e-9 || both > 1 + 1e-9) continue;
      const union = a.modelProbability + b.modelProbability - both;
      if (union < -1e-9 || union > 1 + 1e-6) continue;
      const gross = a.modelProbability * a.odds + b.modelProbability * b.odds;
      const selections = [a, b].sort((x, y) => x.market.localeCompare(y.market)
        || CODES.indexOf(x.tipCode) - CODES.indexOf(y.tipCode));
      const pairKey = selections.map(s => s.selectionId).join('|');
      if (!best || union > best.union + 1e-12
        || (Math.abs(union - best.union) <= 1e-12 && (gross > best.gross + 1e-12
          || (Math.abs(gross - best.gross) <= 1e-12 && pairKey < best.pairKey))))
        best = { selections, union, both, gross, pairKey };
    }
    if (!best) return null;
    const selections = best.selections;
    const quoteSnapshotHash = hash(selections.map(s => s.quoteSnapshotHash));
    const body = {
      version: VERSION, cohort: 'independent-research-only', formalPromotion: false,
      id: `dual_research_v2_${hash([VERSION, sourceId(input.sourceMatchId || input.id), input.eventVersion, inputSnapshotHash, selections.map(s => s.selectionId)])}`,
      decisionId: null, sourceMatchId: sourceId(input.sourceMatchId || input.id),
      eventVersion: new Date(eventVersion).toISOString(), businessDate: input.businessDate,
      recordedAt: new Date(now).toISOString(), cutoffAt: new Date(cutoff).toISOString(),
      publication: { generationId: publication.generationId, manifestHash: publication.manifestHash,
        committedAt: new Date(committed).toISOString() },
      inputSnapshot: input, inputSnapshotHash, modelEvidenceHash: model.inputEvidence.contentHash,
      quoteSnapshotHash, selections, stakePerSelection: STAKE_PER_SELECTION, totalStake: 2,
      probabilityBasis: 'coherent-unconditional-score-matrix;market-neutral',
      rankingMethod: 'maximum-union-probability-then-expected-gross-return',
      selectionProbabilities: selections.map(s => s.modelProbability),
      bothProbability: round(best.both), unionProbability: round(best.union),
      expectedGrossReturn: round(best.gross),
    };
    return { ...body, recordHash: hash(body) };
  } catch { return null; }
}

function validDualResearchV2Record(record, match) {
  try {
    if (record?.version !== VERSION || record.cohort !== 'independent-research-only'
      || record.formalPromotion !== false || record.decisionId !== null
      || !Array.isArray(record.selections) || record.selections.length !== 2
      || record.selections.some(s => !['HAD', 'HHAD'].includes(s.market))
      || (record.selections[0].market === record.selections[1].market
        && record.selections[0].tipCode === record.selections[1].tipCode)
      || record.selections.filter(s => s.market === 'HHAD').some(s =>
        !Number.isSafeInteger(s.handicapLine) || s.handicapLine === 0)
      || record.selections.filter(s => s.market === 'HAD').some(s => s.handicapLine !== 0)) return false;
    const at = time(record.recordedAt);
    if (!Number.isFinite(at)) return false;
    const expected = createDualResearchV2Record(match || record.inputSnapshot, { now: at, publication: record.publication });
    if (!expected) return false;
    const { recordHash, ...body } = record;
    return recordHash === hash(body) && hash(expected) === hash(record);
  } catch { return false; }
}

function settleDualResearchV2(record, event) {
  if (!validDualResearchV2Record(record, record?.inputSnapshot)) throw new Error('Invalid dual-choice research record');
  const terminal = (state, resultEventId = null, reason = null) => ({
    state, selections: record.selections.map(s => ({ selectionId: s.selectionId, market: s.market,
      handicapLine: s.handicapLine, tipCode: s.tipCode, odds: s.odds, state })),
    grossReturn: state === 'VOID' ? record.totalStake : null,
    netProfit: state === 'VOID' ? 0 : null, resultEventId, ...(reason ? { reason } : {}),
    definition: 'two-independent-one-unit-wagers;NOT-an-accumulator',
  });
  if (!event) return terminal('PENDING');
  if (!validResultEvent(event)) return terminal('DISPUTED', null, 'result-event-invalid');
  if (key(record) !== key(event)
    || (event.homeTeamId && event.homeTeamId !== record.inputSnapshot.homeTeamId)
    || (event.awayTeamId && event.awayTeamId !== record.inputSnapshot.awayTeamId))
    return terminal('DISPUTED', event.eventId, 'event-identity-conflict');
  if (event.state === 'DISPUTED') return terminal('DISPUTED', event.eventId);
  if (event.state === 'VOID') return terminal('VOID', event.eventId);
  if (event.state !== 'FINAL' || ![event.scoreHome, event.scoreAway].every(n => Number.isSafeInteger(n) && n >= 0))
    return terminal('DISPUTED', event.eventId, 'result-score-invalid');
  const selections = record.selections.map(s => {
    const adjusted = event.scoreHome + s.handicapLine;
    const actual = adjusted > event.scoreAway ? '1' : adjusted < event.scoreAway ? '2' : 'X';
    return { selectionId: s.selectionId, market: s.market,
      handicapLine: s.handicapLine, tipCode: s.tipCode, odds: s.odds,
      state: s.tipCode === actual ? 'WON' : 'LOST', actual,
      score: `${event.scoreHome}-${event.scoreAway}` };
  });
  const grossReturn = round(selections.reduce((sum, s) => sum + (s.state === 'WON' ? s.odds : 0), 0));
  return { state: selections.some(s => s.state === 'WON') ? 'WON' : 'LOST', selections,
    grossReturn, netProfit: round(grossReturn - record.totalStake), resultEventId: event.eventId,
    definition: 'two-independent-one-unit-wagers;NOT-an-accumulator' };
}

module.exports = { VERSION, createDualResearchV2Record, validDualResearchV2Record, settleDualResearchV2 };
