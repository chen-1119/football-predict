'use strict';

// Pure, opt-in research assessment. No publisher, registry, datastore or I/O.
const baseline = require('../../scripts/zeroMarketResearchBaseline.cjs');
const { epochNanoseconds: clock } = require('./prematchV3Clock.cjs');

const VERSION = 'market-separated-direction-research-v1';
const QUOTE_VERSION = 'market-separated-price-metadata-v1';
const MARKETS = Object.freeze(['HAD', 'HHAD']);
const CODES = Object.freeze(['H', 'D', 'A']);
const QUOTE_TTL_NS = 15n * 60n * 1000000000n;
const HASH = /^[a-f0-9]{64}$/;
const THRESHOLDS = Object.freeze({ probabilityTimesSpGreaterThan: 1.05,
  edgeGreaterThan: 0.05, maximumGridTailMass: 1e-6, validated: false });
const EVENT_KEYS = ['sourceEventRef', 'recordedSourceMatchId', 'eventVersion', 'sourceNominalDate',
  'cutoffAt', 'homeTeamId', 'awayTeamId', 'homeEntityRef', 'awayEntityRef', 'observedAt', 'knownAt',
  'status', 'saleStatus', 'neutral', 'integerHandicap'];
const APPROVAL_KEYS = ['version', 'approved', 'researchOnly', 'reviewId', 'reviewer', 'reviewedAt',
  'inputHash', 'sourceEventRef', 'eventVersion', 'cutoffAt', 'orderedTeamIds', 'orderedEntityRefs',
  'sourceNominalDate', 'sourceTimezoneMappingApproved', 'sourceAliasApproved', 'approvedEventHash',
  'eventEvidenceSha256'];
const QUOTE_KEYS = ['version', 'forecastContentHash', 'predictionHash', 'market', 'handicapLine',
  'sourceNamespace', 'sourceRole', 'rawEvidenceSha256', 'sourceEventRef', 'sourceMatchId',
  'eventVersion', 'sourceNominalDate', 'orderedTeamIds', 'orderedEntityRefs', 'eventEvidenceSha256',
  'observedAt', 'requestedAt', 'receivedAt', 'knownAt', 'odds', 'contentHash'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim() === v && v.length > 0;
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length
  && expected.every(k => Object.hasOwn(v, k));
const noLater = (a, b) => clock(a) !== null && clock(b) !== null && clock(a) <= clock(b);
const before = (a, b) => clock(a) !== null && clock(b) !== null && clock(a) < clock(b);
const equal = (a, b) => clock(a) !== null && clock(a) === clock(b);
const date = v => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + 'T00:00:00Z'))
  && new Date(Date.parse(v + 'T00:00:00Z')).toISOString().slice(0, 10) === v;
const actualTimestamp = v => typeof v === 'string' && clock(v) !== null
  && new Date(v).toISOString() === v;
const copy = v => structuredClone(v);
const hash = v => baseline.hash(v);
// Inspect callable source with this realm's intrinsic; never invoke input code.
const nativeSourceInspector = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function nativeSourceProbe() {}), 'toString').value;
const nativeCallableSource = value => Reflect.apply(nativeSourceInspector, value, []);

// Read descriptors before dispatching any input array methods or getters.
function nativeArrayPrototype(p) {
  if (!Array.isArray(p)) return false;
  const d = Object.getOwnPropertyDescriptor(p, 'constructor');
  if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function'
    || nativeCallableSource(d.value) !== 'function Array() { [native code] }'
    || d.value.prototype !== p) return false;
  const names = Reflect.ownKeys(p), wanted = Reflect.ownKeys(Array.prototype);
  if (names.length !== wanted.length || names.some((k, i) => k !== wanted[i])) return false;
  for (const name of names) {
    const current = Object.getOwnPropertyDescriptor(p, name), original = Object.getOwnPropertyDescriptor(Array.prototype, name);
    if (!Object.hasOwn(current, 'value') || current.enumerable !== original.enumerable
      || current.writable !== original.writable || current.configurable !== original.configurable) return false;
    if (typeof current.value === 'function') {
      const functionName = name === 'constructor' ? 'Array' : name === Symbol.iterator ? 'values' : name;
      if (nativeCallableSource(current.value) !== `function ${functionName}() { [native code] }`) return false;
    } else if (name === 'length') { if (current.value !== 0) return false; }
    else if (name === Symbol.unscopables) {
      if (!object(current.value) || Object.getPrototypeOf(current.value) !== null
        || hash(Object.getOwnPropertyDescriptors(current.value)) !== hash(Object.getOwnPropertyDescriptors(original.value))) return false;
    } else return false;
  }
  return true;
}
function plainData(value) {
  const ancestors = new Set(); let nodes = 0, characters = 0;
  function visit(v, depth) {
    if (++nodes > 350000 || depth > 32) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') { characters += v.length; return characters <= 16 * 1024 * 1024; }
    if (typeof v !== 'object' || ancestors.has(v) || Object.getOwnPropertySymbols(v).length) return false;
    const isArray = Array.isArray(v), p = Object.getPrototypeOf(v);
    if (isArray ? !nativeArrayPrototype(p) : !plainObjectPrototype(p)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v), names = Object.keys(descriptors);
    if (isArray) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 10000
        || names.length !== length + 1 || names.some((name, i) => i < length ? name !== String(i) : name !== 'length')) return false;
    } else if (names.length > 100) return false;
    ancestors.add(v);
    for (const name of names) {
      if (isArray && name === 'length') continue;
      const descriptor = descriptors[name];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(v); return true;
  }
  try { return visit(value, 0); } catch { return false; }
}
function plainObjectPrototype(p) {
  if (p === null || p === Object.prototype) return true;
  const constructor = Object.getOwnPropertyDescriptor(p, 'constructor');
  return Object.getPrototypeOf(p) === null && constructor && Object.hasOwn(constructor, 'value')
    && typeof constructor.value === 'function'
    && nativeCallableSource(constructor.value) === 'function Object() { [native code] }'
    && constructor.value.prototype === p;
}
function sealed(value) {
  if (!object(value) || !HASH.test(value.contentHash || '')) return false;
  const body = { ...value }; delete body.contentHash;
  return hash(body) === value.contentHash;
}

function verifyFrozenAt(forecast, artifact, actualClock) {
  if (!plainData({ forecast, artifact }) || !baseline.verifyResearchArtifact(artifact)
    || artifact.optimization.converged !== true || artifact.optimization.lineSearchStopped !== false
    || !sealed(forecast)) return false;
  const f = forecast, e = f.event, a = f.eventApproval;
  if (!keys(e, EVENT_KEYS) || !keys(a, APPROVAL_KEYS)
    || !actualTimestamp(f.forecastStartedAt) || !actualTimestamp(f.forecastCompletedAt)
    || !noLater(f.forecastStartedAt, f.forecastCompletedAt) || !noLater(f.forecastCompletedAt, actualClock)
    || !before(artifact.availableAt, f.forecastStartedAt)
    || !before(f.forecastCompletedAt, e.cutoffAt) || !before(f.forecastCompletedAt, e.eventVersion)
    || !noLater(e.cutoffAt, e.eventVersion) || !noLater(e.observedAt, e.knownAt)
    || !noLater(e.knownAt, f.forecastStartedAt) || !noLater(e.observedAt, a.reviewedAt)
    || !noLater(a.reviewedAt, e.knownAt) || !noLater(artifact.metadataApproval.reviewedAt, a.reviewedAt)
    || !text(e.sourceEventRef) || !e.sourceEventRef.startsWith(artifact.source.namespace + '#')
    || !text(e.recordedSourceMatchId) || !text(e.homeTeamId) || !text(e.awayTeamId)
    || e.homeTeamId === e.awayTeamId || e.homeEntityRef === e.awayEntityRef
    || !date(e.sourceNominalDate) || e.status !== 'SCHEDULED' || e.saleStatus !== 'OPEN' || e.neutral !== null
    || !Number.isSafeInteger(e.integerHandicap) || e.integerHandicap < -5 || e.integerHandicap > 5
    || a.version !== baseline.EVENT_APPROVAL_VERSION || a.approved !== true || a.researchOnly !== true
    || !text(a.reviewId) || !text(a.reviewer) || a.approvedEventHash !== hash(e)
    || !HASH.test(a.eventEvidenceSha256 || '') || a.inputHash !== artifact.inputHash
    || a.sourceEventRef !== e.sourceEventRef || !equal(a.eventVersion, e.eventVersion)
    || !equal(a.cutoffAt, e.cutoffAt) || a.sourceNominalDate !== e.sourceNominalDate
    || hash(a.orderedTeamIds) !== hash([e.homeTeamId, e.awayTeamId])
    || hash(a.orderedEntityRefs) !== hash([e.homeEntityRef, e.awayEntityRef])
    || a.sourceTimezoneMappingApproved !== true || a.sourceAliasApproved !== true) return false;
  if (artifact.trainingRows.some(row => row.sourceRecordRef === e.sourceEventRef
    || [row.sourceNominalDate, row.homeEntityRef, row.awayEntityRef].join('|')
      === [e.sourceNominalDate, e.homeEntityRef, e.awayEntityRef].join('|')
    || row.sourceNominalDate >= e.sourceNominalDate)) return false;
  const hi = artifact.entities.findIndex(x => x.entityRef === e.homeEntityRef);
  const ai = artifact.entities.findIndex(x => x.entityRef === e.awayEntityRef);
  if (hi < 0 || ai < 0) return false;
  const p = artifact.parameters;
  const lambda = { home: Math.exp(p.intercept + p.attack[hi] + p.defense[ai]),
    away: Math.exp(p.intercept + p.attack[ai] + p.defense[hi]) };
  if (!finite(lambda.home, 0.05, 12) || !finite(lambda.away, 0.05, 12)) return false;
  const grid = baseline.goalGrid(lambda.home, lambda.away, artifact.config.maxGoals, e.integerHandicap);
  const body = { version: baseline.FORECAST_VERSION, frozen: true, researchOnly: true, formalEligible: false,
    productionEligible: false, canonicalAdmission: false, trustedOfficial90Minute: false, primary: null, companion: null,
    asOf: f.forecastCompletedAt, forecastStartedAt: f.forecastStartedAt, forecastCompletedAt: f.forecastCompletedAt,
    frozenAt: f.forecastCompletedAt, actualModelAvailableAt: artifact.availableAt, trainedThrough: artifact.trainedThrough,
    artifactHash: artifact.contentHash, trainingInputHash: artifact.inputHash, event: copy(e), eventApproval: copy(a),
    venuePolicy: 'venue-agnostic', neutral: null, homeAdvantage: 0, lambda, grid,
    baselineKind: 'fitted-independent-poisson-goals-only', distributionKind: 'independent-poisson-not-dixon-coles',
    marketComparator: null, factors: { roster: null, injuries: null, fatigue: null, xg: null, restDays: null },
    sourceLabelScope: 'CC0 ordinary FT-format research;not confirmed official90-minute results',
    historicalAsOf: null, historicalBacktestAllowed: false, accuracyMeasured: false, calibrationMeasured: false, hitRate: null };
  body.predictionHash = hash(body);
  return hash(f) === hash({ ...body, contentHash: hash(body) });
}
function verifyZeroMarketFrozenForecast(forecast, artifact) {
  try { return verifyFrozenAt(forecast, artifact, new Date().toISOString()); } catch { return false; }
}

function quoteDiagnostic(quote, market, forecast, at) {
  const missing = { status: 'unavailable', odds: null, normalizedImpliedProbabilities: null,
    sourceVerified: false, evidenceScope: 'metadata-only-not-provider-signature', quoteContentHash: null,
    predictionAsOf: forecast.asOf, asOfPrice: null, observedAt: null, requestedAt: null, receivedAt: null,
    knownAt: null, rawEvidenceSha256: null, reasons: ['market-price-metadata-missing'] };
  if (quote === null) return missing;
  const fail = reason => ({ ...missing, status: 'unverified', reasons: [reason] });
  if (!plainData(quote) || !keys(quote, QUOTE_KEYS) || !sealed(quote)
    || quote.version !== QUOTE_VERSION) return fail('market-price-metadata-schema-or-hash-invalid');
  const e = forecast.event;
  if (quote.forecastContentHash !== forecast.contentHash || quote.predictionHash !== forecast.predictionHash
    || quote.market !== market || quote.handicapLine !== (market === 'HAD' ? 0 : e.integerHandicap)
    || quote.sourceNamespace !== 'sporttery:' + market || quote.sourceRole !== 'official-jc-market-price-metadata'
    || !HASH.test(quote.rawEvidenceSha256 || '') || quote.sourceEventRef !== e.sourceEventRef
    || quote.sourceMatchId !== e.recordedSourceMatchId || !equal(quote.eventVersion, e.eventVersion)
    || quote.sourceNominalDate !== e.sourceNominalDate
    || quote.eventEvidenceSha256 !== forecast.eventApproval.eventEvidenceSha256
    || hash(quote.orderedTeamIds) !== hash([e.homeTeamId, e.awayTeamId])
    || hash(quote.orderedEntityRefs) !== hash([e.homeEntityRef, e.awayEntityRef])) return fail('market-price-identity-source-line-or-forecast-mismatch');
  if (!noLater(forecast.frozenAt, quote.requestedAt) || !noLater(quote.requestedAt, quote.receivedAt)
    || !noLater(quote.receivedAt, quote.knownAt) || !noLater(quote.observedAt, quote.receivedAt)
    || !noLater(quote.knownAt, at) || !before(quote.knownAt, e.cutoffAt)
    || !before(quote.knownAt, e.eventVersion)) return fail('market-price-clock-invalid-or-not-post-freeze');
  if (clock(at) - clock(quote.requestedAt) > QUOTE_TTL_NS
    || clock(at) - clock(quote.receivedAt) > QUOTE_TTL_NS) return fail('market-price-collection-stale');
  if (!keys(quote.odds, CODES) || !CODES.every(code => finite(quote.odds[code], 1.000000001, 1000)))
    return fail('complete-own-market-sp-required');
  const total = CODES.reduce((sum, code) => sum + 1 / quote.odds[code], 0);
  return { ...missing, status: 'content-bound-metadata', odds: copy(quote.odds),
    normalizedImpliedProbabilities: Object.fromEntries(CODES.map(code => [code, (1 / quote.odds[code]) / total])),
    quoteContentHash: quote.contentHash, asOfPrice: quote.knownAt, observedAt: quote.observedAt,
    requestedAt: quote.requestedAt, receivedAt: quote.receivedAt, knownAt: quote.knownAt,
    rawEvidenceSha256: quote.rawEvidenceSha256, reasons: ['price-original-signature-and-derivation-not-verified'] };
}
function leadership(probabilities) {
  const codes = CODES.filter(code => CODES.every(other => probabilities[code] >= probabilities[other] - 1e-12));
  return { code: codes.length === 1 ? codes[0] : null, codes, probability: codes.length === 1 ? probabilities[codes[0]] : null };
}
function blocked(reason, at) {
  const body = { version: VERSION, status: 'blocked', scope: 'research-only', assessedAt: at,
    formalEligible: false, productionEligible: false, primary: null, companion: null,
    teamBaselineTilt: null, markets: null, reasons: [reason], calibrationMeasured: false,
    productionWrites: 0, registryWrites: 0, publisherWrites: 0 };
  return { ...body, contentHash: hash(body) };
}
function assessMarketSeparatedDirectionResearch(request) {
  const startedAt = new Date().toISOString();
  try {
    if (!plainData(request) || !keys(request, ['artifact', 'forecast', 'quotes'])
      || (request.quotes !== null && !keys(request.quotes, MARKETS))) return blocked('assessment-schema-invalid', startedAt);
    const { forecast: f, artifact } = request;
    if (!verifyFrozenAt(f, artifact, startedAt)) return blocked('zero-market-frozen-forecast-invalid', startedAt);
    const priceCheckedAt = new Date().toISOString();
    const quoteByMarket = Object.fromEntries(MARKETS.map(market => [market,
      quoteDiagnostic(request.quotes?.[market] ?? null, market, f, priceCheckedAt)]));
    const finishedAt = new Date().toISOString();
    if (!noLater(startedAt, priceCheckedAt) || !noLater(priceCheckedAt, finishedAt)
      || !before(finishedAt, f.event.cutoffAt) || !before(finishedAt, f.event.eventVersion))
      return blocked('assessment-clock-regressed-or-at-after-cutoff', finishedAt);
    const markets = {};
    for (const market of MARKETS) {
      const probabilities = copy(market === 'HAD' ? f.grid.had : f.grid.hhad.probabilities);
      let quote = quoteByMarket[market];
      if (quote.status === 'content-bound-metadata'
        && (clock(finishedAt) - clock(quote.requestedAt) > QUOTE_TTL_NS
          || clock(finishedAt) - clock(quote.receivedAt) > QUOTE_TTL_NS))
        quote = quoteDiagnostic(request.quotes[market], market, f, finishedAt);
      const options = CODES.map(code => {
        const sp = quote.odds?.[code] ?? null, implied = quote.normalizedImpliedProbabilities?.[code] ?? null;
        const probability = probabilities[code], probabilityTimesSp = sp === null ? null : probability * sp;
        const edge = implied === null ? null : probability - implied;
        const screen = probabilityTimesSp !== null && probabilityTimesSp > THRESHOLDS.probabilityTimesSpGreaterThan
          && edge > THRESHOLDS.edgeGreaterThan && f.grid.tailMass <= THRESHOLDS.maximumGridTailMass;
        return { code, baselineProbability: probability, calibratedProbability: null, sp,
          normalizedImpliedProbability: implied, probabilityTimesSp,
          expectedValueDiagnostic: probabilityTimesSp === null ? null : probabilityTimesSp - 1,
          edgeDiagnostic: edge, thresholdScreenPassed: screen, thresholdsValidated: false,
          researchValueEligible: false, formalEligible: false,
          reasons: ['uncalibrated-market-specific-probability', 'signed-price-original-adapter-not-integrated'] };
      });
      markets[market] = { market, handicapLine: market === 'HAD' ? 0 : f.event.integerHandicap,
        probabilities, probabilityBasis: f.grid.probabilityBasis, marginalTailErrorBound: f.grid.marginalTailErrorBound,
        withinMarketLeader: leadership(probabilities), calibratedProbabilities: null,
        calibrationStatus: 'not-measured-no-authority-adapter', quote, options };
    }
    const body = { version: VERSION, status: 'research-market-assessment', scope: 'research-only',
      assessmentStartedAt: startedAt, priceMetadataCheckedAt: priceCheckedAt, assessedAt: finishedAt, predictionAsOf: f.asOf,
      forecastContentHash: f.contentHash, predictionHash: f.predictionHash, artifactHash: artifact.contentHash,
      trainingInputHash: artifact.inputHash, modelAvailableAt: artifact.availableAt, event: copy(f.event),
      teamBaselineTilt: { ...leadership(f.grid.had), market: 'HAD', meaning: 'goals-only-team-baseline-tilt',
        calibrated: false, formalRecommendation: false }, markets,
      grid: { rawMass: f.grid.rawMass, tailMass: f.grid.tailMass, probabilityBasis: f.grid.probabilityBasis,
        marginalTailErrorBound: f.grid.marginalTailErrorBound, top3: copy(f.grid.top3) },
      priceUse: 'post-freeze-diagnostic-only-not-an-as-of-forecast-ev', thresholds: THRESHOLDS,
      crossMarketRanking: 'not-performed-no-raw-probability-comparison',
      formalAdmission: { status: 'unavailable', adapter: 'not-integrated', modelMarketBinding: null,
        sameEventPairedRows: null, independentWindows: null, residualFolds: null,
        existingMinimums: { sameEventPairedRows: 500, independentWindows: 6, residualFolds: 3 },
        gateSatisfied: false, calibratedProbabilityLowerBound: null },
      formalEligible: false, productionEligible: false, primary: null, companion: null,
      calibrationMeasured: false, accuracyMeasured: false, hitRate: null,
      reasons: ['market-specific-calibration-and-prospective-validation-required', 'formal-authority-adapter-not-integrated'],
      invariants: { predictionChangedByPrices: false, productionWrites: 0, registryWrites: 0,
        publisherWrites: 0, automaticOrders: 0, kellyStake: null } };
    return { ...body, contentHash: hash(body) };
  } catch { return blocked('assessment-input-or-replay-invalid', startedAt); }
}

module.exports = { VERSION, QUOTE_VERSION, THRESHOLDS, verifyZeroMarketFrozenForecast,
  assessMarketSeparatedDirectionResearch };
