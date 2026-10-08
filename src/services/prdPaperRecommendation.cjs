'use strict';

// An isolated prospective paper ledger. It never supplies a production pick,
// trains a model, or substitutes the old mixed-model probabilities.
const baseline = require('../../scripts/zeroMarketResearchBaseline.cjs');
const research = require('./marketSeparatedDirectionResearch.cjs');
const { epochNanoseconds: clock } = require('./prematchV3Clock.cjs');
const {VERSION:OPENING_VERSION,openingAtForBusinessDate,assessOpening,assessQuoteOpening,assessPaperOpening}=require('./sportteryOpeningPolicy.cjs');
const { joinOfficialHad, signedLiveHadQuoteForMatch } = require('../../scripts/recommendationPlatform/liveOfficialHad.cjs');
const { joinOfficialHandicap } = require('../../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const { derivedTeamId } = require('../../scripts/storedResultTeamIdentity.cjs');
const { verifyCollectorAttestation, extractionFromSportteryPool, sha256CollectorJson }
  = require('./collectorAttestation.cjs');
const { expectedCollectorCommitment, officialFastEndpointUrl } = require('../../server/relayCollectorEvidence.cjs');

const VERSION = 'prd-paper-recommendation-v1';
const PUBLIC_VERSION = 'prd-paper-direction-view-v1';
const REGISTRATION = Object.freeze({ version: 'prd-paper-selection-registration-v1',
  candidateScope: 'all-single-outcomes-within-each-market',
  probabilityTimesSpGreaterThan: 1.05, sameMarketEdgeGreaterThan: 0.05,
  ranking: 'highest-same-stake-model-expected-value-after-both-gates',
  ties: 'abstain-within-1e-12', maximumGridTailMass: 1e-6, thresholdsValidated: false });
const LIMITATIONS = Object.freeze(['paper-only-no-production-admission', 'market-specific-calibration-not-measured',
  'out-of-sample-validation-not-completed', 'eight-week-paper-clv-not-completed',
  'community-ft-labels-not-confirmed-official-90-minute', 'roster-injuries-fatigue-xg-not-integrated']);
const MARKETS = ['HAD', 'HHAD'], CODES = ['H', 'D', 'A'], SOURCE_CODES = ['1', 'X', '2'];
const TTL = 15n * 60n * 1000000000n;
const copy = value => structuredClone(value), hash = baseline.hash;
const equalClock = (a, b) => clock(a) !== null && clock(a) === clock(b);
// Sporttery's documented local sale deadline has no zone in some PG inputs.
// Map only this exact local shape to Beijing; acquisition/decision clocks never
// receive such a fallback or a Date.parse normalization.
const saleClock = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  ? value.replace(' ', 'T') + '+08:00' : value;
const canonical = value => clock(value) === null ? null : new Date(Number(clock(value) / 1000000n)).toISOString();
const sourceId = value => typeof value === 'string' ? value.replace(/^sporttery_/, '') : '';
const businessDay = value => new Date(Number(clock(value) / 1000000n) + 8 * 3600000).toISOString().slice(0, 10);
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const vector = value => value && CODES.every(code => typeof value[code] === 'number' && Number.isFinite(value[code])
  && value[code] >= 0 && value[code] <= 1) && Math.abs(CODES.reduce((sum, code) => sum + value[code], 0) - 1) <= 1e-6;

// Reject getters/functions/custom prototypes before cloning, hashing or joining.
function plainData(value) {
  let count = 0, chars = 0; const seen = new Set();
  function walk(v, depth) {
    if (++count > 350000 || depth > 32) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return (chars += v.length) <= 16 * 1024 * 1024;
    if (typeof v !== 'object' || seen.has(v) || Object.getOwnPropertySymbols(v).length) return false;
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v), names = Object.keys(descriptors);
    if (array && (!Number.isSafeInteger(descriptors.length?.value) || descriptors.length.value > 20000
      || names.length !== descriptors.length.value + 1)) return false;
    seen.add(v);
    for (const name of names) {
      if (array && name === 'length') continue;
      const d = descriptors[name];
      if (!Object.hasOwn(d, 'value') || !d.enumerable || !walk(d.value, depth + 1)) return false;
    }
    seen.delete(v); return true;
  }
  try { return walk(value, 0); } catch { return false; }
}

function quoteInput(match) {
  let value = match;
  if (Object.hasOwn(match, 'prospectiveForecastInput')) {
    const next = match.prospectiveForecastInput;
    if (!next || ['id', 'sourceMatchId', 'businessDate', 'homeTeamId', 'awayTeamId', 'status', 'buyEndTime']
      .some(key => next[key] !== match[key]) || !equalClock(next.kickoffTime, match.kickoffTime)
      || !equalClock(next.eventVersion || next.kickoffTime, match.eventVersion || match.kickoffTime)) return null;
    value = next;
  }
  if (match.status !== 'SCHEDULED' || match.resultDisposition === 'VOID' || match.isOnSale === false
    || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(match.saleStatus || '').toUpperCase())) return null;
  const keys = ['id', 'sourceMatchId', 'businessDate', 'matchNo', 'matchNumStr', 'homeTeamId', 'awayTeamId',
    'homeTeamName', 'awayTeamName', 'kickoffTime', 'eventVersion', 'status', 'isOnSale', 'saleStatus',
    'resultDisposition', 'buyEndTime', 'cutoffAt', 'cutoffTime', 'oddsReceivedAt', 'oddsUpdatedAt',
    'handicapOddsReceivedAt', 'handicapOddsObservedAt', 'homeEntityRef', 'awayEntityRef'];
  const result = Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, copy(value[key])]));
  if (value.predictionMeta) result.predictionMeta = Object.fromEntries(['cutoffTime', 'lockedAt', 'lockedReason']
    .filter(key => value.predictionMeta[key] !== undefined).map(key => [key, copy(value.predictionMeta[key])]));
  return result;
}

function bindEvent(forecast, match, at) {
  const e = forecast.event, input = quoteInput(match);
  if (!input || input.status !== 'SCHEDULED' || input.isOnSale === false || input.resultDisposition === 'VOID'
    || input.predictionMeta?.lockedAt || input.predictionMeta?.lockedReason
    || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(input.saleStatus || '').toUpperCase())
    || sourceId(input.sourceMatchId) !== e.recordedSourceMatchId
    || !equalClock(input.kickoffTime, e.eventVersion) || !equalClock(input.eventVersion || input.kickoffTime, e.eventVersion)
    || input.homeTeamId !== e.homeTeamId || input.awayTeamId !== e.awayTeamId
    || !text(input.homeTeamName) || !text(input.awayTeamName)
    || input.homeTeamId !== derivedTeamId(input.homeTeamName) || input.awayTeamId !== derivedTeamId(input.awayTeamName)
    || input.businessDate !== businessDay(at)
    || (input.homeEntityRef !== undefined && input.homeEntityRef !== e.homeEntityRef)
    || (input.awayEntityRef !== undefined && input.awayEntityRef !== e.awayEntityRef)) return null;
  const cutoffs = [e.cutoffAt, input.kickoffTime, input.buyEndTime, input.cutoffAt, input.cutoffTime,
    input.predictionMeta?.cutoffTime].filter(value => value !== undefined && value !== null && value !== '').map(saleClock);
  if (cutoffs.some(value => clock(value) === null)) return null;
  const minimum = cutoffs.reduce((a, b) => clock(a) < clock(b) ? a : b);
  if (clock(at) >= clock(minimum)) return null;
  // Both joins see the reviewed cutoff; no old quote or old probability survives.
  input.buyEndTime = canonical(minimum);
  input.predictionMeta = { ...input.predictionMeta, cutoffTime: canonical(minimum) };
  return { input, cutoffTime: canonical(minimum), event: { sourceMatchId: e.recordedSourceMatchId,
    eventVersion: canonical(e.eventVersion), businessDate: input.businessDate,
    orderedTeamIds: [e.homeTeamId, e.awayTeamId], orderedEntityRefs: [e.homeEntityRef, e.awayEntityRef],
    sourceEventRef: e.sourceEventRef, sourceNominalDate: e.sourceNominalDate,
    eventEvidenceSha256: forecast.eventApproval.eventEvidenceSha256 } };
}

function verifiedEndpoint(snapshot, method, at, trustRegistry) {
  const members = snapshot?.endpoints?.filter(e => e.method === method);
  if (members?.length !== 1) return null;
  const e = members[0], now = clock(at), requested = clock(e.requestedAt), received = clock(e.receivedAt);
  if (e.ok !== true || e.page !== null || !officialFastEndpointUrl(method, e.url)
    || e.sourceRequest?.method !== 'GET' || e.sourceRequest?.role !== method || e.sourceRequest?.page !== null
    || !officialFastEndpointUrl(method, e.sourceRequest?.url) || e.httpStatus !== 200
    || !/^application\/json(?:\s*;|$)/i.test(e.contentType || '') || !hex(e.rawSha256)
    || !hex(e.headersSha256) || !hex(e.canonicalPayloadSha256) || !text(e.sourceCycleId)
    || !Number.isSafeInteger(e.rawBytes) || e.rawBytes < 1 || e.rawBytes > 4 * 1024 * 1024
    || requested === null || received === null || requested > received || received > now
    || now - requested > TTL || now - received > TTL
    || (e.providerObservedAt != null && (clock(e.providerObservedAt) === null || clock(e.providerObservedAt) > received))
    || e.payload?.success !== true || !Array.isArray(e.payload?.value?.matchInfoList)) return null;
  const proof = verifyCollectorAttestation(e.collectorAttestation, { trustRegistry,
    payload: e.payload, expected: expectedCollectorCommitment(e) });
  if (!proof.eligible || e.sourceCycleId !== e.collectorAttestation.commitment.collectorCycleId) return null;
  const rows = [];
  for (const group of e.payload.value.matchInfoList) {
    if (!group || !Array.isArray(group.subMatchList)) return null;
    for (const row of group.subMatchList) rows.push({ row, group });
  }
  if (rows.length > 512) return null;
  return { entry: e, rows };
}

function emptyMarket(market, line, probabilities, reason) {
  return { market, handicapLine: line, probabilities: copy(probabilities), probabilityBasis: 'unconditional',
    calibrationStatus: 'unmeasured', quote: null, options: [], reasons: [reason] };
}

function signedEventMember(endpoint, input) {
  const matches = endpoint.rows.filter(({ row }) => String(row.matchId) === input.sourceMatchId);
  if (matches.length !== 1) return null;
  const { row, group } = matches[0], kickoff = `${row.matchDate}T${row.matchTime}+08:00`;
  if (!equalClock(kickoff, input.eventVersion || input.kickoffTime)
    || String(row.homeTeamAllName || row.homeTeamAbbName || '').trim() !== input.homeTeamName
    || String(row.awayTeamAllName || row.awayTeamAbbName || '').trim() !== input.awayTeamName
    || row.matchNumStr !== (input.matchNo || input.matchNumStr)
    || (row.businessDate || group.businessDate) !== input.businessDate
    || (row.businessDate && group.businessDate && row.businessDate !== group.businessDate)
    || row.matchStatus !== 'Selling' || Number(row.sellStatus) !== 1) return null;
  return row;
}

function pricesFor(inputs, bound, at, trustRegistry) {
  const { forecast, quoteSnapshot } = inputs, now = Number(clock(at) / 1000000n);
  const projected=Object.hasOwn(inputs,'openingProjection');
  if(projected){
    const marker=inputs.openingProjection;
    if(!marker||Object.keys(marker).length!==3||!['version','businessDate','openingAt'].every(k=>Object.hasOwn(marker,k))
      ||marker.version!==OPENING_VERSION||marker.businessDate!==bound.event.businessDate
      ||marker.openingAt!==openingAtForBusinessDate(bound.event.businessDate)
      ||!assessOpening({businessDate:marker.businessDate,asOf:at}).eligible)throw new Error('Invalid paper opening projection');
  }
  // The pure author API receives the trusted registry from its caller; it must
  // never load a path/environment registry or persist caller trust claims.
  const registry = trustRegistry && typeof trustRegistry === 'object' && !Array.isArray(trustRegistry) && plainData(trustRegistry)
    ? trustRegistry : { version: 'unavailable', keys: [] };
  const probabilities = { HAD: forecast.grid.had, HHAD: forecast.grid.hhad.probabilities }, markets = {};
  const current = verifiedEndpoint(quoteSnapshot, 'current', at, registry);
  const calculator = verifiedEndpoint(quoteSnapshot, 'calculator', at, registry);
  for (const market of MARKETS) {
    const line = market === 'HAD' ? 0 : forecast.event.integerHandicap, p = probabilities[market];
    markets[market] = emptyMarket(market, line, p, 'signed-market-quote-unavailable');
    if (!current || !signedEventMember(current, bound.input) || (market === 'HHAD' && (!calculator || line === 0
      || calculator.entry.sourceCycleId !== current.entry.sourceCycleId))) continue;
    if(projected){
      const sources=market==='HAD'?[current]:[current,calculator];
      const gate=sources.map(source=>assessQuoteOpening({businessDate:bound.event.businessDate,asOf:at,
        requestedAt:source.entry.requestedAt,receivedAt:source.entry.receivedAt})).find(result=>!result.eligible);
      if(gate){markets[market].reasons=[gate.reason];continue;}
    }
    let quote = null;
    if (market === 'HAD') {
      const audit = {}, result = joinOfficialHad([bound.input], quoteSnapshot, { now, trustRegistry: registry, audit });
      if (audit.reasonCounts['had-applied'] !== 1) continue;
      const extracted = signedLiveHadQuoteForMatch(result.current[0], now, Date.parse(bound.cutoffTime), { trustRegistry: registry });
      if (!extracted) continue;
      quote = { odds: Object.fromEntries(CODES.map((code, i) => [code, extracted.odds[['odds1', 'oddsX', 'odds2'][i]]])),
        requestedAt: extracted.receipt.requestedAt, receivedAt: extracted.receipt.observedAt,
        providerObservedAt: extracted.receipt.marketExtraction.providerObservedAt,
        source: extracted.source, sourceCycleId: extracted.receipt.sourceCycleId,
        cutoffTime: new Date(extracted.cutoffMs).toISOString(), receiptHash: extracted.receipt.receiptHash,
        payloadHash: sha256CollectorJson(current.entry.payload), rowHash: extracted.receipt.rowHash,
        marketExtractionHash: extracted.receipt.marketExtraction.hash };
    } else {
      const audit = {}, joined = joinOfficialHandicap([bound.input], quoteSnapshot, { now, trustRegistry: registry, audit });
      if (audit.reasonCounts['hhad-applied'] !== 1) continue;
      const input = joined[0], row = signedEventMember(calculator, bound.input);
      if (!row || Number(input.handicapLine) !== line) continue;
      const pools = row.oddsList.filter(pool => pool.poolCode === 'HHAD');
      if (pools.length !== 1) continue;
      const pool = pools[0], extraction = extractionFromSportteryPool({ row, poolRow: pool, poolCode: 'HHAD',
        fallbackProviderObservedAt: calculator.entry.providerObservedAt });
      const sale = row.poolList.filter(item => item.poolCode === 'HHAD')[0];
      if (['cbtValue', 'cbtAllUp'].some(key => sale[key] !== undefined && Number(sale[key]) !== 1)) continue;
      const proof = verifyCollectorAttestation(calculator.entry.collectorAttestation, { trustRegistry: registry,
        payload: calculator.entry.payload, expected: { ...expectedCollectorCommitment(calculator.entry), marketExtractionHash: extraction.hash } });
      if (!proof.eligible || [pool.h, pool.d, pool.a].some(v => v == null || v === '' || typeof v === 'boolean')) continue;
      const clocksPresent = [pool.updateDate, pool.updateTime].some(v => v != null && v !== '');
      const providerAt = clocksPresent ? `${pool.updateDate}T${pool.updateTime}+08:00` : calculator.entry.providerObservedAt ?? null;
      if (providerAt !== null && (clock(providerAt) === null || clock(providerAt) > clock(calculator.entry.receivedAt))) continue;
      const officialCutoffs = [bound.cutoffTime];
      let invalid = false;
      for (const { row: r } of [...current.rows, ...calculator.rows].filter(({ row: r }) => String(r.matchId) === bound.event.sourceMatchId)) {
        for (const key of ['buyEndTime', 'matchEndTime', 'sellEndTime', 'stopSaleTime', 'endTime']) {
          if (r[key] == null || r[key] === '') continue;
          const deadline = saleClock(r[key]);
          if (clock(deadline) === null) invalid = true; else officialCutoffs.push(deadline);
        }
      }
      const cutoff = officialCutoffs.reduce((a, b) => clock(a) < clock(b) ? a : b);
      if (invalid || clock(at) >= clock(cutoff) || clock(calculator.entry.receivedAt) >= clock(cutoff)) continue;
      quote = { odds: Object.fromEntries(CODES.map((code, i) => [code, input.handicapOdds[['odds1', 'oddsX', 'odds2'][i]]])),
        requestedAt: calculator.entry.requestedAt, receivedAt: calculator.entry.receivedAt, providerObservedAt: providerAt,
        source: 'sporttery:HHAD', sourceCycleId: calculator.entry.sourceCycleId, cutoffTime: canonical(cutoff),
        receiptHash: hash(input.handicapQuoteProvenance), payloadHash: sha256CollectorJson(calculator.entry.payload),
        rowHash: sha256CollectorJson(row), marketExtractionHash: extraction.hash };
    }
    if (!quote || CODES.some(code => !Number.isFinite(quote.odds[code]) || quote.odds[code] <= 1
      || !/^\d+(?:\.\d{1,4})?$/.test(String(quote.odds[code])))) continue;
    const total = CODES.reduce((sum, code) => sum + 1 / quote.odds[code], 0);
    const marketP = Object.fromEntries(CODES.map(code => [code, (1 / quote.odds[code]) / total]));
    const options = CODES.map((code, index) => {
      const pSp = p[code] * quote.odds[code], edge = p[code] - marketP[code];
      const passed = pSp > REGISTRATION.probabilityTimesSpGreaterThan && edge > REGISTRATION.sameMarketEdgeGreaterThan
        && forecast.grid.tailMass <= REGISTRATION.maximumGridTailMass;
      return { market, handicapLine: line, code, tipCode: SOURCE_CODES[index], probability: p[code], sp: quote.odds[code],
        sameMarketProbability: marketP[code], probabilityTimesSp: pSp, modelExpectedValue: pSp - 1, sameMarketEdge: edge,
        thresholdScreenPassed: passed, paperEligible: passed, formalEligible: false,
        calibrationStatus: 'unmeasured', reasons: passed ? [] : ['both-prd-price-gates-not-passed'] };
    });
    markets[market] = { market, handicapLine: line, probabilities: copy(p), probabilityBasis: 'unconditional',
      calibrationStatus: 'unmeasured', quote: { ...quote, knowledgeAt: quote.receivedAt,
        priceRelationToForecast: clock(quote.receivedAt) > clock(forecast.asOf) ? 'acquired-after-team-forecast' : 'acquired-no-later-than-team-forecast',
        verification: 'trusted-collector-signature-and-full-payload-membership-not-provider-signature' }, options, reasons: [] };
  }
  return markets;
}

function derive(inputs, at, trustRegistry) {
  if (!research.verifyZeroMarketFrozenForecast(inputs.forecast, inputs.artifact)) return { reason: 'zero-market-frozen-forecast-invalid' };
  if (!vector(inputs.forecast.grid.had) || !vector(inputs.forecast.grid.hhad?.probabilities)) return { reason: 'zero-market-probabilities-invalid' };
  const bound = bindEvent(inputs.forecast, inputs.match, at);
  if (!bound || clock(inputs.forecast.asOf) > clock(at)) return { reason: 'reviewed-forecast-match-identity-or-current-sale-clock-invalid' };
  const markets = pricesFor(inputs, bound, at, trustRegistry);
  // No verified price is an unavailable input, not the first paper sample.
  // Let the approved task wait for a normal later snapshot. A genuine quoted
  // decision that fails both value gates is still an immutable watch sample.
  if (!MARKETS.some(market => markets[market].quote)) return { reason: Object.hasOwn(inputs,'openingProjection')
    && MARKETS.some(market=>markets[market].reasons.includes('quote-acquired-before-opening'))
    ? 'quote-acquired-before-opening' : 'signed-market-quote-unavailable' };
  const eligible = MARKETS.flatMap(market => markets[market].options.filter(option => option.paperEligible))
    .sort((a, b) => b.modelExpectedValue - a.modelExpectedValue);
  const tied = eligible.length > 1 && Math.abs(eligible[0].modelExpectedValue - eligible[1].modelExpectedValue) <= 1e-12;
  const paperPrimary = eligible.length && !tied ? copy(eligible[0]) : null;
  const prices = MARKETS.map(market => markets[market].quote).filter(Boolean);
  const priceAsOf = prices.length ? prices.reduce((a, b) => clock(a.receivedAt) > clock(b.receivedAt) ? a : b).receivedAt : null;
  const cutoffTime = paperPrimary ? markets[paperPrimary.market].quote.cutoffTime : bound.cutoffTime;
  return { event: bound.event, businessDate: bound.event.businessDate, cutoffTime, kickoffTime: bound.event.eventVersion,
    modelArtifactHash: inputs.artifact.contentHash, forecastContentHash: inputs.forecast.contentHash,
    predictionHash: inputs.forecast.predictionHash, forecastAsOf: inputs.forecast.asOf,
    modelAvailableAt: inputs.artifact.availableAt, decisionPriceAsOf: priceAsOf, markets, paperPrimary,
    selectionStatus: paperPrimary ? 'paper-primary' : tied ? 'watch-ev-tie' : 'watch-no-eligible-option',
    probabilitySource: 'verified-zero-market-frozen-independent-poisson-grid-only',
    marketPriorUsed: false, priceUse: 'new-current-paper-decision-price-not-retrospective-forecast-price',
    crossMarketRanking: 'pre-registered-common-same-stake-ev-not-raw-marginal-probability', registration: copy(REGISTRATION),
    formalEligible: false, productionEligible: false, primary: null, companion: null,
    calibrationMeasured: false, outOfSampleValidated: false, accuracyMeasured: false, hitRate: null,
    limitations: [...LIMITATIONS] };
}

function blocked(reason, at) {
  return { version: VERSION, status: 'blocked', scope: 'prospective-paper-only', decisionAt: at,
    formalEligible: false, productionEligible: false, primary: null, companion: null, paperPrimary: null, reasons: [reason] };
}

function createPrdPaperRecommendation(request) {
  const startedAt = new Date().toISOString();
  try {
    if (!request || typeof request !== 'object' || ['artifact', 'forecast', 'match', 'quoteSnapshot', 'trustRegistry']
      .some(key => { const descriptor = Object.getOwnPropertyDescriptor(request, key); return descriptor && !Object.hasOwn(descriptor, 'value'); })
      || !plainData({ artifact: request.artifact, forecast: request.forecast,
      match: request.match, quoteSnapshot: request.quoteSnapshot })) return blocked('paper-input-not-bounded-plain-json', startedAt);
    const privateInputs = copy({ artifact: request.artifact, forecast: request.forecast, match: request.match, quoteSnapshot: request.quoteSnapshot });
    const opening=assessOpening({businessDate:privateInputs.match?.businessDate,asOf:startedAt});
    if(!opening.eligible)return blocked(opening.reason,startedAt);
    privateInputs.openingProjection={version:OPENING_VERSION,businessDate:privateInputs.match.businessDate,openingAt:opening.openingAt};
    const derived = derive(privateInputs, startedAt, request.trustRegistry);
    if (derived.reason) return blocked(derived.reason, startedAt);
    const createdAt = new Date().toISOString();
    const acquired=assessPaperOpening({...derived,decisionAt:startedAt,privateInputs},createdAt);
    if(!acquired.eligible)return blocked(acquired.reason,createdAt);
    if (clock(createdAt) < clock(startedAt) || clock(createdAt) >= clock(derived.cutoffTime)
      || clock(createdAt) >= clock(derived.kickoffTime)
      || MARKETS.some(market => derived.markets[market].quote
        && (clock(createdAt) - clock(derived.markets[market].quote.requestedAt) > TTL
          || clock(createdAt) >= clock(derived.markets[market].quote.cutoffTime)))) return blocked('paper-clock-regressed-expired-or-cutoff-crossed', createdAt);
    const body = { version: VERSION, status: 'paper-screened', scope: 'prospective-paper-only',
      decisionAt: startedAt, createdAt, ...derived, privateInputs };
    const id = `prd_paper_${hash(body)}`;
    return { ...body, id, contentHash: hash({ ...body, id }) };
  } catch { return blocked('paper-input-or-signature-replay-failed', startedAt); }
}

function verifyPrdPaperRecommendation(record, { trustRegistry } = {}) {
  try {
    if (!plainData(record) || record.version !== VERSION || record.status !== 'paper-screened'
      || record.scope !== 'prospective-paper-only' || !hex(record.contentHash)
      || clock(record.decisionAt) === null || clock(record.createdAt) === null
      || clock(record.decisionAt) > clock(record.createdAt) || clock(record.createdAt) > clock(new Date().toISOString())) return false;
    const derived = derive(record.privateInputs, record.decisionAt, trustRegistry);
    if (derived.reason || clock(record.createdAt) >= clock(derived.cutoffTime) || clock(record.createdAt) >= clock(derived.kickoffTime)
      || MARKETS.some(market => derived.markets[market].quote
        && (clock(record.createdAt) - clock(derived.markets[market].quote.requestedAt) > TTL
          || clock(record.createdAt) >= clock(derived.markets[market].quote.cutoffTime)))) return false;
    const body = { version: VERSION, status: 'paper-screened', scope: 'prospective-paper-only',
      decisionAt: record.decisionAt, createdAt: record.createdAt, ...derived, privateInputs: copy(record.privateInputs) };
    const id = `prd_paper_${hash(body)}`;
    return hash(record) === hash({ ...body, id, contentHash: hash({ ...body, id }) });
  } catch { return false; }
}

function publicPrdPaperProjection(record, options) {
  if (!verifyPrdPaperRecommendation(record, options)) return null;
  const pick = record.paperPrimary, input = quoteInput(record.privateInputs.match), quote = pick ? record.markets[pick.market].quote : null;
  const storageCommit = options?.storageCommit ?? null;
  const body = { version: PUBLIC_VERSION, id: record.id, recordHash: record.contentHash,
    businessDate: record.businessDate, sourceMatchId: record.event.sourceMatchId, eventVersion: record.event.eventVersion,
    homeTeamId: record.event.orderedTeamIds[0], awayTeamId: record.event.orderedTeamIds[1],
    homeTeamName: input.homeTeamName, awayTeamName: input.awayTeamName,
    decidedAt: record.decisionAt, createdAt: record.createdAt, cutoffAt: record.cutoffTime,
    forecastAsOf: record.forecastAsOf, decisionPriceAsOf: record.decisionPriceAsOf,
    modelHash: record.modelArtifactHash, forecastHash: record.forecastContentHash,
    selectionStatus: record.selectionStatus,
    paperPrimary: pick ? { market: pick.market, handicapLine: pick.handicapLine, tipCode: pick.tipCode,
      sp: pick.sp, probability: pick.probability, marketProbability: pick.sameMarketProbability,
      edge: pick.sameMarketEdge, expectedValue: pick.modelExpectedValue,
      quoteReceivedAt: quote.receivedAt, quoteRequestedAt: quote.requestedAt, quoteHash: quote.receiptHash } : null,
    formalEligible: false, productionEligible: false, primary: null, companion: null, modelValidation: 'uncalibrated',
    reasons: [...LIMITATIONS, ...(pick ? [] : [record.selectionStatus])],
    paperArtifactHash: storageCommit?.paperArtifactHash ?? null,
    acknowledgementHash: storageCommit?.acknowledgementHash ?? null,
    paperCommitObservedAt: storageCommit?.paperCommitObservedAt ?? null };
  const result = { ...body, contentHash: hash(body) };
  return validPublicPrdPaperProjection(result) ? result : null;
}

// This compact seal checks semantic consistency, not the source signature or
// model admission. The server calls the private replay before projection.
function validPublicPrdPaperProjection(value) {
  try {
    if (!plainData(value)) return false;
    const keys = ['version', 'id', 'recordHash', 'businessDate', 'sourceMatchId', 'eventVersion', 'homeTeamId', 'awayTeamId',
      'homeTeamName', 'awayTeamName', 'decidedAt', 'createdAt', 'cutoffAt', 'forecastAsOf', 'decisionPriceAsOf',
      'modelHash', 'forecastHash', 'selectionStatus', 'paperPrimary', 'formalEligible', 'productionEligible', 'primary',
      'companion', 'modelValidation', 'reasons', 'paperArtifactHash', 'acknowledgementHash', 'paperCommitObservedAt', 'contentHash'];
    if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
      || value.version !== PUBLIC_VERSION || !/^prd_paper_[a-f0-9]{64}$/.test(value.id)
      || ![value.recordHash, value.modelHash, value.forecastHash, value.contentHash].every(hex)
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.businessDate) || !/^[1-9]\d{0,19}$/.test(value.sourceMatchId)
      || ![value.homeTeamId, value.awayTeamId, value.homeTeamName, value.awayTeamName].every(text)
      || value.homeTeamId === value.awayTeamId || value.homeTeamName === value.awayTeamName
      || value.homeTeamId !== derivedTeamId(value.homeTeamName) || value.awayTeamId !== derivedTeamId(value.awayTeamName)
      || ['eventVersion', 'decidedAt', 'createdAt', 'cutoffAt', 'forecastAsOf'].some(key => clock(value[key]) === null)
      || clock(value.forecastAsOf) > clock(value.decidedAt) || clock(value.decidedAt) > clock(value.createdAt)
      || clock(value.createdAt) >= clock(value.cutoffAt) || clock(value.cutoffAt) > clock(value.eventVersion)
      || value.formalEligible !== false || value.productionEligible !== false || value.primary !== null || value.companion !== null
      || value.modelValidation !== 'uncalibrated' || !Array.isArray(value.reasons) || !value.reasons.length
      || !value.reasons.every(text) || !['paper-primary', 'watch-ev-tie', 'watch-no-eligible-option'].includes(value.selectionStatus)
      || (value.decisionPriceAsOf !== null && (clock(value.decisionPriceAsOf) === null
        || clock(value.decisionPriceAsOf) > clock(value.decidedAt)))) return false;
    const stored = [value.paperArtifactHash, value.acknowledgementHash, value.paperCommitObservedAt];
    if (!stored.every(item => item === null) && (!hex(value.paperArtifactHash) || !hex(value.acknowledgementHash)
      || clock(value.paperCommitObservedAt) === null || clock(value.paperCommitObservedAt) < clock(value.createdAt)
      || clock(value.paperCommitObservedAt) >= clock(value.cutoffAt)
      || clock(value.paperCommitObservedAt) - clock(value.decidedAt) > 30n * 1000000000n)) return false;
    const p = value.paperPrimary;
    if (!p ? value.selectionStatus === 'paper-primary' : value.selectionStatus !== 'paper-primary') return false;
    if (p) {
      const pickKeys = ['market', 'handicapLine', 'tipCode', 'sp', 'probability', 'marketProbability', 'edge', 'expectedValue',
        'quoteReceivedAt', 'quoteRequestedAt', 'quoteHash'];
      if (Object.keys(p).length !== pickKeys.length || !pickKeys.every(key => Object.hasOwn(p, key))
        || !MARKETS.includes(p.market) || !SOURCE_CODES.includes(p.tipCode) || !Number.isSafeInteger(p.handicapLine)
        || (p.market === 'HAD' ? p.handicapLine !== 0 : p.handicapLine === 0 || Math.abs(p.handicapLine) > 5)
        || !Number.isFinite(p.sp) || p.sp <= 1 || !/^\d+(?:\.\d{1,4})?$/.test(String(p.sp))
        || !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1
        || !Number.isFinite(p.marketProbability) || p.marketProbability <= 0 || p.marketProbability >= 1
        || !Number.isFinite(p.edge) || !Number.isFinite(p.expectedValue)
        || Math.abs(p.expectedValue - (p.probability * p.sp - 1)) > 1e-12
        || Math.abs(p.edge - (p.probability - p.marketProbability)) > 1e-12
        || !(p.probability * p.sp > 1.05) || !(p.edge > 0.05) || !hex(p.quoteHash)
        || clock(p.quoteRequestedAt) === null || clock(p.quoteReceivedAt) === null
        || clock(p.quoteRequestedAt) > clock(p.quoteReceivedAt) || clock(p.quoteReceivedAt) > clock(value.decidedAt)
        || clock(value.createdAt) - clock(p.quoteRequestedAt) > TTL
        || value.decisionPriceAsOf === null || clock(p.quoteReceivedAt) > clock(value.decisionPriceAsOf)) return false;
    }
    const { contentHash, ...body } = value;
    return contentHash === hash(body);
  } catch { return false; }
}

module.exports = { VERSION, PUBLIC_VERSION, REGISTRATION, createPrdPaperRecommendation,
  verifyPrdPaperRecommendation, publicPrdPaperProjection, validPublicPrdPaperProjection };
