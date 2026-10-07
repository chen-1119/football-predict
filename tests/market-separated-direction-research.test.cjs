'use strict';
// Synthetic labels and event/price metadata only. No real277 or online inputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const baseline = require('../scripts/zeroMarketResearchBaseline.cjs');
const research = require('../src/services/marketSeparatedDirectionResearch.cjs');
const hash = baseline.hash;
const copy = v => structuredClone(v);
const pause = () => new Promise(resolve => setTimeout(resolve, 4));
const ago = ms => new Date(Date.now() - ms).toISOString();
const ns = 'synthetic/market-separated-season-2000';
const digest = 'b'.repeat(64);
const seal = body => ({ ...body, contentHash: hash(body) });
function reseal(value) { delete value.contentHash; value.contentHash = hash(value); return value; }
function refitInput(maxGoals = 16, symmetric = false) {
  const entities = ['alpha', 'bravo', 'charlie', 'delta'].map((literalName, i) => ({
    entityRef: ns + '#research-entity/' + (i + 1), literalName, namespace: ns }));
  const rows = [], attacks = [3, 2, 1, 1], defenses = [1, 0, 0, -1]; let k = 0;
  for (let round = 0; round < 6; round++) for (let h = 0; h < 4; h++) for (let a = 0; a < 4; a++) {
    if (h === a) continue;
    const sourceNominalDate = new Date(Date.UTC(2000, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    rows.push({ sourceRecordRef: ns + '#row/' + (++k), sourceNominalDate,
      homeEntityRef: entities[h].entityRef, awayEntityRef: entities[a].entityRef,
      homeGoals: symmetric ? 2 : Math.max(0, attacks[h] - defenses[a] + round % 3 - 1),
      awayGoals: symmetric ? 2 : Math.max(0, attacks[a] - defenses[h] - round % 3 + 1),
      sourceFormat: 'ordinary-ft', knownAt: ago(3000), neutral: null, historicalAsOf: null, actualEndedAt: null });
  }
  const value = { version: baseline.INPUT_VERSION, researchOnly: true,
    source: { namespace: ns, rawSha256: digest, license: 'CC0-1.0', licenseRawSha256: digest,
      formatEvidenceSha256: digest, observedAt: ago(6000), formatKnownAt: ago(5000),
      coverageThrough: '2000-03-12', completeCompetitionHistory: false }, entities, rows,
    approval: { version: baseline.APPROVAL_VERSION, approved: true, researchOnly: true,
      reviewId: 'synthetic-metadata-approval', reviewer: 'synthetic-only', reviewedAt: ago(4000),
      scope: 'future-only-source-format-ft', venuePolicy: 'venue-agnostic', sourceNamespace: ns,
      approvedInputHash: null, sourceEntityMapApproved: true, partialCoverageAccepted: true },
    config: { maxGoals, iterations: 800 } };
  value.approval.approvedInputHash = baseline.researchInputHash(value);
  return value;
}
async function fixture(handicap = -1, maxGoals = 16, symmetric = false) {
  const fit = baseline.fitZeroMarketResearch(refitInput(maxGoals, symmetric));
  assert.equal(fit.status, 'research-fitted'); assert.equal(fit.artifact.optimization.converged, true);
  await pause(); const artifact = fit.artifact;
  const event = { sourceEventRef: ns + '#future/alpha-bravo', recordedSourceMatchId: 'synthetic-provider-event-1',
    eventVersion: new Date(Date.now() + 86400000).toISOString(), sourceNominalDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    cutoffAt: new Date(Date.now() + 82800000).toISOString(), homeTeamId: 'provider-alpha', awayTeamId: 'provider-bravo',
    homeEntityRef: artifact.entities[0].entityRef, awayEntityRef: artifact.entities[1].entityRef,
    observedAt: ago(1000), knownAt: ago(500), status: 'SCHEDULED', saleStatus: 'OPEN', neutral: null,
    integerHandicap: handicap };
  const approval = { version: baseline.EVENT_APPROVAL_VERSION, approved: true, researchOnly: true,
    reviewId: 'synthetic-target-approval', reviewer: 'synthetic-only', reviewedAt: ago(700),
    inputHash: artifact.inputHash, sourceEventRef: event.sourceEventRef, eventVersion: event.eventVersion,
    cutoffAt: event.cutoffAt, orderedTeamIds: [event.homeTeamId, event.awayTeamId],
    orderedEntityRefs: [event.homeEntityRef, event.awayEntityRef], sourceNominalDate: event.sourceNominalDate,
    sourceTimezoneMappingApproved: true, sourceAliasApproved: true, approvedEventHash: hash(event), eventEvidenceSha256: digest };
  const out = baseline.forecastZeroMarketResearch({ artifact, event, approval });
  assert.equal(out.status, 'research-frozen', JSON.stringify(out.reasons)); await pause();
  return { artifact, forecast: out.forecast, quotes: { HAD: null, HHAD: null } };
}
function quote(request, market, odds = { H: 2.2, D: 3.4, A: 3.7 }) {
  const f = request.forecast, e = f.event, now = ago(1);
  return seal({ version: research.QUOTE_VERSION, forecastContentHash: f.contentHash, predictionHash: f.predictionHash,
    market, handicapLine: market === 'HAD' ? 0 : e.integerHandicap, sourceNamespace: 'sporttery:' + market,
    sourceRole: 'official-jc-market-price-metadata', rawEvidenceSha256: digest, sourceEventRef: e.sourceEventRef,
    sourceMatchId: e.recordedSourceMatchId, eventVersion: e.eventVersion, sourceNominalDate: e.sourceNominalDate,
    orderedTeamIds: [e.homeTeamId, e.awayTeamId], orderedEntityRefs: [e.homeEntityRef, e.awayEntityRef],
    eventEvidenceSha256: f.eventApproval.eventEvidenceSha256, observedAt: ago(3600000),
    requestedAt: now, receivedAt: now, knownAt: now, odds });
}
function assessed(request) {
  const out = research.assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.status, 'research-market-assessment', JSON.stringify(out.reasons)); return out;
}
function atModule(time) {
  const filename = require.resolve('../src/services/marketSeparatedDirectionResearch.cjs');
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...args) { super(...(args.length ? args : [time])); } }
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Date: FixedDate, structuredClone,
    Object, Array, Reflect, Set, Math, Number, String, RegExp, BigInt };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

test('verifies actual synthetic fit replay, complete forecast hashes and one global score grid', async () => {
  const request = await fixture(), before = copy(request);
  assert.equal(research.verifyZeroMarketFrozenForecast(request.forecast, request.artifact), true);
  const out = assessed(request);
  assert.deepEqual(out.markets.HAD.probabilities, request.forecast.grid.had);
  assert.deepEqual(out.markets.HHAD.probabilities, request.forecast.grid.hhad.probabilities);
  assert.equal(out.artifactHash, request.artifact.contentHash); assert.equal(out.predictionHash, request.forecast.predictionHash);
  assert.deepEqual(request, before); assert.equal(out.invariants.publisherWrites, 0);
});

test('a wide HHAD event can have larger probability without taking over HAD team tilt', async () => {
  const request = await fixture(-5), out = assessed(request);
  assert.equal(out.teamBaselineTilt.code, out.markets.HAD.withinMarketLeader.code);
  assert.ok(out.markets.HHAD.probabilities.A > Math.max(...Object.values(out.markets.HAD.probabilities)));
  assert.equal(out.crossMarketRanking, 'not-performed-no-raw-probability-comparison');
  assert.equal(out.primary, null); assert.equal(out.companion, null); assert.equal(out.formalEligible, false);
});

test('a tied HAD baseline has no forced direction even when HHAD has a unique broader event', async () => {
  const out = assessed(await fixture(-1, 16, true));
  assert.equal(out.teamBaselineTilt.code, null); assert.deepEqual(out.teamBaselineTilt.codes, ['H', 'A']);
  assert.equal(out.markets.HHAD.withinMarketLeader.code, 'A'); assert.equal(out.primary, null);
});

test('all integer handicap signs and zero retain mathematically valid same-grid marginals', async () => {
  for (const line of [-2, 0, 2]) {
    const request = await fixture(line), out = assessed(request), direct = { H: 0, D: 0, A: 0 };
    for (const cell of request.forecast.grid.cells) {
      const difference = cell.home + line - cell.away;
      direct[difference > 0 ? 'H' : difference < 0 ? 'A' : 'D'] += cell.probability;
    }
    assert.deepEqual(out.markets.HHAD.probabilities, direct); assert.equal(out.markets.HHAD.handicapLine, line);
  }
});

test('changing SP only changes price diagnostics and never changes frozen probabilities or team tilt', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD'); request.quotes.HHAD = quote(request, 'HHAD');
  const original = copy(request), a = assessed(request);
  const changed = copy(request); changed.quotes.HAD.odds = { H: 7, D: 1.4, A: 8 }; reseal(changed.quotes.HAD);
  const b = assessed(changed);
  assert.deepEqual(a.teamBaselineTilt, b.teamBaselineTilt);
  assert.deepEqual(a.markets.HAD.probabilities, b.markets.HAD.probabilities);
  assert.deepEqual(a.markets.HHAD.probabilities, b.markets.HHAD.probabilities);
  assert.notDeepEqual(a.markets.HAD.options, b.markets.HAD.options);
  assert.deepEqual(request, original); assert.equal(a.predictionHash, b.predictionHash);
});

test('own-market HAD and HHAD SP remain separate; missing HAD cannot borrow HHAD prices', async () => {
  const request = await fixture(); request.quotes.HHAD = quote(request, 'HHAD', { H: 4.8, D: 4.2, A: 1.6 });
  const out = assessed(request);
  assert.equal(out.markets.HAD.quote.odds, null); assert.equal(out.markets.HAD.options[0].sp, null);
  assert.equal(out.markets.HHAD.options[0].sp, 4.8); assert.notEqual(out.teamBaselineTilt, null);
});

test('later price time is distinct from prediction time and an old provider update may remain unchanged', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD');
  const out = assessed(request), q = out.markets.HAD.quote;
  assert.equal(q.status, 'content-bound-metadata'); assert.equal(q.sourceVerified, false);
  assert.ok(Date.parse(q.asOfPrice) > Date.parse(out.predictionAsOf));
  assert.equal(q.observedAt, request.quotes.HAD.observedAt);
  assert.equal(out.priceUse, 'post-freeze-diagnostic-only-not-an-as-of-forecast-ev');
});

test('strict PRD diagnostic requires both p*SP>1.05 and edge>0.05, never grants signed-price eligibility', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD', { H: 100, D: 100, A: 100 });
  const out = assessed(request), option = out.markets.HAD.options.find(x => x.code === out.teamBaselineTilt.code);
  assert.equal(option.thresholdScreenPassed, true);
  assert.ok(option.probabilityTimesSp > 1.05 && option.edgeDiagnostic > 0.05);
  for (const market of Object.values(out.markets)) for (const v of market.options) {
    assert.equal(v.researchValueEligible, false); assert.equal(v.formalEligible, false); assert.equal(v.calibratedProbability, null);
  }
  assert.deepEqual(out.thresholds, research.THRESHOLDS); assert.equal(out.formalAdmission.gateSatisfied, false);
});

test('positive EV with inadequate edge, or large edge with inadequate EV, does not pass the diagnostic screen', async () => {
  const request = await fixture(), p = request.forecast.grid.had;
  // q=p makes edge zero while scaling all prices can make expected value positive.
  request.quotes.HAD = quote(request, 'HAD', Object.fromEntries(['H', 'D', 'A'].map(c => [c, 2 / p[c]])));
  const noEdge = assessed(request); assert.ok(noEdge.markets.HAD.options.every(x => !x.thresholdScreenPassed));
  const weak = copy(request), leader = noEdge.teamBaselineTilt.code;
  weak.quotes.HAD.odds = { H: 1.01, D: 1.01, A: 1.01 }; reseal(weak.quotes.HAD);
  const noEv = assessed(weak).markets.HAD.options.find(x => x.code === leader);
  assert.equal(noEv.thresholdScreenPassed, false); assert.ok(noEv.probabilityTimesSp <= 1.05); assert.ok(noEv.edgeDiagnostic > 0.05);
});

test('price metadata tampering requires a new content hash and still cannot claim a provider signature', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD');
  request.quotes.HAD.odds.H += 1;
  assert.equal(assessed(request).markets.HAD.quote.status, 'unverified');
  reseal(request.quotes.HAD); const q = assessed(request).markets.HAD.quote;
  assert.equal(q.status, 'content-bound-metadata'); assert.equal(q.sourceVerified, false);
  assert.equal(q.evidenceScope, 'metadata-only-not-provider-signature');
});

test('wrong event, swapped ordered teams, source label, price line and forecast anchor fail independently', async () => {
  const request = await fixture();
  const changes = [q => { q.sourceMatchId += '-other'; }, q => { q.orderedTeamIds.reverse(); },
    q => { q.orderedEntityRefs.reverse(); }, q => { q.sourceNamespace = '500:HAD'; },
    q => { q.market = 'HHAD'; }, q => { q.handicapLine = -1; }, q => { q.eventVersion = new Date(Date.now() + 10000).toISOString(); },
    q => { q.rawEvidenceSha256 = 'bad'; }, q => { q.eventEvidenceSha256 = 'c'.repeat(64); },
    q => { q.predictionHash = 'c'.repeat(64); }, q => { q.forecastContentHash = 'c'.repeat(64); }];
  for (const change of changes) {
    const r = copy(request); r.quotes.HAD = quote(r, 'HAD'); change(r.quotes.HAD); reseal(r.quotes.HAD);
    const out = assessed(r); assert.equal(out.markets.HAD.quote.status, 'unverified'); assert.equal(out.markets.HAD.quote.odds, null);
  }
});

test('quote clocks must be ordered, known before evaluation and acquired after prediction freeze', async () => {
  const request = await fixture();
  for (const change of [q => { q.requestedAt = ago(60000); }, q => { q.receivedAt = ago(60000); },
    q => { q.knownAt = new Date(Date.now() + 10000).toISOString(); },
    q => { q.observedAt = new Date(Date.now() + 10000).toISOString(); }, q => { q.requestedAt = 'invalid'; }]) {
    const r = copy(request); r.quotes.HAD = quote(r, 'HAD'); change(r.quotes.HAD); reseal(r.quotes.HAD);
    assert.equal(assessed(r).markets.HAD.quote.status, 'unverified');
  }
});

test('both collection clocks have a 15-minute budget and do not use provider update as collection TTL', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD');
  const later = Date.now() + 16 * 60000, out = atModule(later).assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.status, 'research-market-assessment');
  assert.equal(out.markets.HAD.quote.reasons.length, 1); assert.equal(out.markets.HAD.quote.reasons[0], 'market-price-collection-stale');
  assert.equal(out.markets.HAD.quote.odds, null);
});

test('one nanosecond after actual evaluation is not rounded into available price knowledge', async () => {
  const request = await fixture(), boundary = Date.now(); request.quotes.HAD = quote(request, 'HAD');
  const utc = new Date(boundary).toISOString();
  request.quotes.HAD.knownAt = utc.replace(/\.([0-9]{3})Z$/, '.$1000001Z'); reseal(request.quotes.HAD);
  const out = atModule(boundary).assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.markets.HAD.quote.status, 'unverified');
});

test('complete own-market numeric SP is required; zero, string, missing, infinity and extra outcomes cannot pass', async () => {
  const request = await fixture();
  for (const odds of [{ H: 0, D: 3, A: 4 }, { H: '2', D: 3, A: 4 }, { H: 2, D: 3 },
    { H: Infinity, D: 3, A: 4 }, { H: 2, D: 3, A: 4, X: 3 }]) {
    const r = copy(request); r.quotes.HAD = quote(r, 'HAD', odds);
    const out = research.assessMarketSeparatedDirectionResearch(r);
    assert.ok(out.status === 'blocked' || out.markets.HAD.quote.odds === null);
  }
});

test('re-sealed forecast grid, lambda, weights, trained flags and artifact binding cannot forge a forecast', async () => {
  const request = await fixture();
  for (const change of [f => { f.grid.had.H += 0.01; }, f => { f.lambda.home += 0.1; },
    f => { f.factors.roster = 0.1; }, f => { f.calibrationMeasured = true; }, f => { f.formalEligible = true; },
    f => { f.artifactHash = 'c'.repeat(64); }, f => { f.primary = { market: 'HHAD' }; },
    f => { f.unknownWeights = { strength: 0.4, poisson: 0.35, market: 0.25 }; }]) {
    const r = copy(request); change(r.forecast); delete r.forecast.contentHash; delete r.forecast.predictionHash;
    r.forecast.predictionHash = hash(r.forecast); reseal(r.forecast);
    assert.equal(research.verifyZeroMarketFrozenForecast(r.forecast, r.artifact), false);
    assert.equal(research.assessMarketSeparatedDirectionResearch(r).status, 'blocked');
  }
});

test('forged fit and caller-supplied calibration claims are blocked rather than giving a primary', async () => {
  const request = await fixture();
  for (const extra of [{ calibrated: true }, { calibrationEvidence: { passed: true, sameEventPairedRows: 500,
    independentWindows: 6, residualFolds: 3 } }, { asOf: ago(1000) }]) {
    assert.equal(research.assessMarketSeparatedDirectionResearch({ ...request, ...extra }).status, 'blocked');
  }
  const forged = copy(request); forged.artifact.parameters.attack[0] += 0.1; forged.artifact.parameters.attack[1] -= 0.1;
  forged.artifact.parametersHash = hash(forged.artifact.parameters); reseal(forged.artifact);
  assert.equal(research.assessMarketSeparatedDirectionResearch(forged).status, 'blocked');
});

test('forecast event approval, source clock and cutoff are replayed after outer resealing', async () => {
  const request = await fixture();
  for (const change of [f => { f.eventApproval.sourceAliasApproved = false; },
    f => { f.eventApproval.orderedTeamIds.reverse(); }, f => { f.event.saleStatus = 'UNKNOWN'; },
    f => { f.event.knownAt = new Date(Date.now() + 10000).toISOString(); },
    f => { f.forecastStartedAt = request.artifact.availableAt; }, f => { f.frozenAt = ago(10000); }]) {
    const r = copy(request); change(r.forecast); r.forecast.eventApproval.approvedEventHash = hash(r.forecast.event);
    delete r.forecast.predictionHash; delete r.forecast.contentHash; r.forecast.predictionHash = hash(r.forecast); reseal(r.forecast);
    assert.equal(research.assessMarketSeparatedDirectionResearch(r).status, 'blocked');
  }
});

test('closed sale at evaluation remains blocked even though immutable old forecast is valid', async () => {
  const request = await fixture(), after = Date.parse(request.forecast.event.cutoffAt);
  assert.equal(atModule(after).verifyZeroMarketFrozenForecast(request.forecast, request.artifact), true);
  const out = atModule(after).assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.status, 'blocked'); assert.equal(out.primary, null);
  assert.ok(out.reasons.includes('assessment-clock-regressed-or-at-after-cutoff'));
});

test('the final actual assessment clock rechecks cutoff after an expensive replay', async () => {
  const request = await fixture(), start = Date.now(), finish = Date.parse(request.forecast.event.cutoffAt);
  const filename = require.resolve('../src/services/marketSeparatedDirectionResearch.cjs'), RealDate = Date; let calls = 0;
  class SequentialDate extends RealDate { constructor(...args) { super(...(args.length ? args : [calls++ === 0 ? start : finish])); } }
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Date: SequentialDate, structuredClone,
    Object, Array, Reflect, Set, Math, Number, String, RegExp, BigInt };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const out = sandbox.module.exports.assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.status, 'blocked'); assert.ok(out.reasons.includes('assessment-clock-regressed-or-at-after-cutoff'));
});

test('cutoff crossed during price metadata validation also blocks at the final clock', async () => {
  const request = await fixture(); request.quotes.HAD = quote(request, 'HAD');
  const start = Date.now(), finish = Date.parse(request.forecast.event.cutoffAt);
  const filename = require.resolve('../src/services/marketSeparatedDirectionResearch.cjs'), RealDate = Date; let calls = 0;
  class SequentialDate extends RealDate { constructor(...args) { super(...(args.length ? args : [calls++ < 2 ? start : finish])); } }
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Date: SequentialDate, structuredClone,
    Object, Array, Reflect, Set, Math, Number, String, RegExp, BigInt };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const out = sandbox.module.exports.assessMarketSeparatedDirectionResearch(request);
  assert.equal(out.status, 'blocked'); assert.ok(out.reasons.includes('assessment-clock-regressed-or-at-after-cutoff'));
});

test('material finite-grid tail is displayed and prevents a diagnostic threshold pass', async () => {
  const request = await fixture(-1, 4); request.quotes.HAD = quote(request, 'HAD', { H: 100, D: 100, A: 100 });
  const out = assessed(request); assert.ok(out.grid.tailMass > research.THRESHOLDS.maximumGridTailMass);
  assert.equal(out.grid.probabilityBasis, 'conditional-on-finite-grid-support');
  assert.ok(out.markets.HAD.options.every(x => !x.thresholdScreenPassed));
});

test('cyclic, getter, sparse, subclass, missing and malformed requests fail closed without invoking getters', async () => {
  const request = await fixture(); let calls = 0;
  const getter = copy(request); Object.defineProperty(getter, 'calibrated', { enumerable: true, get() { calls++; throw Error('must-not-run'); } });
  const cycle = copy(request); cycle.cycle = cycle;
  const sparse = copy(request); delete sparse.forecast.grid.cells[0];
  class MaliciousArray extends Array { some() { calls++; throw Error('must-not-run'); } }
  const subclass = copy(request); subclass.artifact.trainingRows = MaliciousArray.from(subclass.artifact.trainingRows);
  for (const value of [null, {}, getter, cycle, sparse, subclass]) {
    assert.doesNotThrow(() => research.assessMarketSeparatedDirectionResearch(value));
    assert.equal(research.assessMarketSeparatedDirectionResearch(value).status, 'blocked');
  }
  assert.equal(calls, 0);
});

test('missing prices retain the baseline direction while fixed formal requirements stay unmet', async () => {
  const request = await fixture(); request.quotes = null; const out = assessed(request);
  assert.notEqual(out.teamBaselineTilt, null); assert.equal(out.markets.HAD.quote.odds, null);
  assert.equal(out.formalAdmission.sameEventPairedRows, null);
  assert.deepEqual(out.formalAdmission.existingMinimums, { sameEventPairedRows: 500, independentWindows: 6, residualFolds: 3 });
  assert.equal(out.invariants.kellyStake, null); assert.equal(out.invariants.automaticOrders, 0);
  assert.equal(out.accuracyMeasured, false); assert.equal(out.calibrationMeasured, false); assert.equal(out.hitRate, null);
});

test('genuine parsed cross-realm JSON is accepted while array prototype method overrides are refused', async () => {
  const request = await fixture();
  const normal = vm.runInNewContext('JSON.parse(text)', { text: JSON.stringify(request) });
  assert.equal(research.assessMarketSeparatedDirectionResearch(normal).status, 'research-market-assessment');
  const modified = vm.runInNewContext('const value=JSON.parse(text); Array.prototype.some=function some(){throw Error("must-not-dispatch");}; value',
    { text: JSON.stringify(request) });
  assert.equal(research.assessMarketSeparatedDirectionResearch(modified).status, 'blocked');
});
