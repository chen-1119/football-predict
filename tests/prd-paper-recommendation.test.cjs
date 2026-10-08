'use strict';
// Synthetic signed collector payloads and synthetic FT labels only.
const test = require('node:test'), assert = require('node:assert/strict');
const baseline = require('../scripts/zeroMarketResearchBaseline.cjs');
const paper = require('../src/services/prdPaperRecommendation.cjs');
const { derivedTeamId } = require('../scripts/storedResultTeamIdentity.cjs');
const { SPORTTERY_CURRENT_URL, SPORTTERY_CALCULATOR_URL } = require('../scripts/sportteryEndpointContract.cjs');
const { createCollectorKeyPair, buildCollectorCommitment, signCollectorCommitment, sha256CollectorJson }
  = require('../src/services/collectorAttestation.cjs');
const RealDate = Date, NOW = RealDate.parse('2030-10-07T03:00:00.000Z'), stamp = n => new RealDate(n).toISOString();
let tick = NOW;
class FixedDate extends RealDate { constructor(...args) { super(...(args.length ? args : [tick])); } static now() { return tick; } }
function controlled(run) { const previous = global.Date; global.Date = FixedDate; tick = NOW;
  try { return run(); } finally { global.Date = previous; } }
const pair = createCollectorKeyPair({ keyId: 'synthetic-prd-paper', independenceDomain: 'synthetic-paper-only' });
const digest = 'b'.repeat(64), ns = 'synthetic/prd-paper-season-2000';
const rehash = value => { const { contentHash, id, ...body } = value; const nextId = `prd_paper_${baseline.hash(body)}`;
  return { ...body, id: nextId, contentHash: baseline.hash({ ...body, id: nextId }) }; };
let artifact;
function fit(symmetric = false) {
  tick = NOW - 4000;
  const entities = ['alpha', 'bravo', 'charlie', 'delta'].map((literalName, i) => ({ entityRef: ns + '#research-entity/' + (i + 1), literalName, namespace: ns }));
  const rows = [], attacks = [3, 2, 1, 1], defenses = [1, 0, 0, -1]; let k = 0;
  for (let round = 0; round < 6; round++) for (let h = 0; h < 4; h++) for (let a = 0; a < 4; a++) {
    if (h === a) continue;
    rows.push({ sourceRecordRef: ns + '#row/' + (++k), sourceNominalDate: stamp(RealDate.UTC(2000, 0, 1) + (k - 1) * 86400000).slice(0, 10),
      homeEntityRef: entities[h].entityRef, awayEntityRef: entities[a].entityRef,
      homeGoals: symmetric ? 2 : Math.max(0, attacks[h] - defenses[a] + round % 3 - 1), awayGoals: symmetric ? 2 : Math.max(0, attacks[a] - defenses[h] - round % 3 + 1),
      sourceFormat: 'ordinary-ft', knownAt: stamp(NOW - 5000), neutral: null, historicalAsOf: null, actualEndedAt: null });
  }
  const input = { version: baseline.INPUT_VERSION, researchOnly: true,
    source: { namespace: ns, rawSha256: digest, license: 'CC0-1.0', licenseRawSha256: digest, formatEvidenceSha256: digest,
      observedAt: stamp(NOW - 8000), formatKnownAt: stamp(NOW - 7000), coverageThrough: '2000-03-12', completeCompetitionHistory: false },
    entities, rows, approval: { version: baseline.APPROVAL_VERSION, approved: true, researchOnly: true,
      reviewId: 'synthetic-paper-metadata', reviewer: 'synthetic-only', reviewedAt: stamp(NOW - 6000), scope: 'future-only-source-format-ft',
      venuePolicy: 'venue-agnostic', sourceNamespace: ns, approvedInputHash: null, sourceEntityMapApproved: true, partialCoverageAccepted: true },
    config: { maxGoals: 16, iterations: 800 } };
  input.approval.approvedInputHash = baseline.researchInputHash(input);
  const out = baseline.fitZeroMarketResearch(input); assert.equal(out.status, 'research-fitted', JSON.stringify(out.reasons));
  artifact = out.artifact; assert.equal(artifact.optimization.converged, true); tick = NOW;
}
function fixture({ markets = ['HAD', 'HHAD'], line = -1, had = { H: 10, D: 10, A: 10 }, hhad = { H: 10, D: 10, A: 10 }, symmetric = false } = {}) {
  if (!artifact || symmetric) fit(symmetric);
  const homeTeamName = '合成主队', awayTeamName = '合成客队', kickoff = stamp(NOW + 13 * 3600000), cutoff = stamp(NOW + 11 * 3600000);
  const match = { id: 'sporttery_2041823', sourceMatchId: '2041823', businessDate: '2030-10-07', matchNo: '周一001',
    homeTeamName, awayTeamName, homeTeamId: derivedTeamId(homeTeamName), awayTeamId: derivedTeamId(awayTeamName),
    kickoffTime: kickoff, eventVersion: kickoff, status: 'SCHEDULED', saleStatus: 'OPEN', buyEndTime: cutoff,
    probabilityModel: { version: 'old-mixed-model-must-not-enter', oneXTwo: { final: { home: 0, draw: 0, away: 100 } } } };
  const event = { sourceEventRef: ns + '#future/2041823', recordedSourceMatchId: match.sourceMatchId, eventVersion: kickoff,
    sourceNominalDate: '2030-10-08', cutoffAt: cutoff, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    homeEntityRef: artifact.entities[0].entityRef, awayEntityRef: artifact.entities[1].entityRef,
    observedAt: stamp(NOW - 2000), knownAt: stamp(NOW - 1500), status: 'SCHEDULED', saleStatus: 'OPEN', neutral: null, integerHandicap: line };
  const approval = { version: baseline.EVENT_APPROVAL_VERSION, approved: true, researchOnly: true,
    reviewId: 'synthetic-paper-event', reviewer: 'synthetic-only', reviewedAt: stamp(NOW - 1800), inputHash: artifact.inputHash,
    sourceEventRef: event.sourceEventRef, eventVersion: kickoff, cutoffAt: cutoff, orderedTeamIds: [match.homeTeamId, match.awayTeamId],
    orderedEntityRefs: [event.homeEntityRef, event.awayEntityRef], sourceNominalDate: event.sourceNominalDate,
    sourceTimezoneMappingApproved: true, sourceAliasApproved: true, approvedEventHash: baseline.hash(event), eventEvidenceSha256: digest };
  tick = NOW - 1000;
  const out = baseline.forecastZeroMarketResearch({ artifact, event, approval });
  assert.equal(out.status, 'research-frozen', JSON.stringify(out.reasons)); tick = NOW;
  const raw = { matchId: 2041823, matchDate: '2030-10-08', matchTime: '00:00:00', businessDate: match.businessDate,
    matchNumStr: match.matchNo, homeTeamAllName: homeTeamName, awayTeamAllName: awayTeamName, matchStatus: 'Selling', sellStatus: 1,
    oddsList: markets.map(market => ({ poolCode: market, h: (market === 'HAD' ? had : hhad).H,
      d: (market === 'HAD' ? had : hhad).D, a: (market === 'HAD' ? had : hhad).A,
      ...(market === 'HHAD' ? { goalLine: String(line) } : {}) })),
    poolList: markets.map(poolCode => ({ poolCode, poolStatus: 'Selling', cbtValue: 1, cbtAllUp: 1, bettingAllup: 1 })) };
  const quoteSnapshot = { endpoints: ['current', 'calculator'].map(method => {
    const url = method === 'current' ? SPORTTERY_CURRENT_URL : SPORTTERY_CALCULATOR_URL;
    return resign({ method, page: null, ok: true, url, sourceRequest: { url, method: 'GET', page: null, role: method },
      requestedAt: stamp(NOW), receivedAt: stamp(NOW), sourceCycleId: 'synthetic-paper-price-cycle',
      httpStatus: 200, contentType: 'application/json;charset=utf-8', rawBytes: 1000, rawSha256: digest, headersSha256: 'a'.repeat(64),
      payload: { success: true, value: { matchInfoList: [{ businessDate: match.businessDate, subMatchList: [structuredClone(raw)] }] } } });
  }) };
  return { artifact: structuredClone(artifact), forecast: out.forecast, match, quoteSnapshot, trustRegistry: pair.registry };
}
function resign(e) {
  e.canonicalPayloadSha256 = sha256CollectorJson(e.payload);
  const commitment = buildCollectorCommitment({ endpoint: e.sourceRequest, collectorCycleId: e.sourceCycleId,
    requestedAt: e.requestedAt, receivedAt: e.receivedAt, response: { httpStatus: e.httpStatus, contentType: e.contentType,
      rawSha256: e.rawSha256, rawBytes: e.rawBytes, headersSha256: e.headersSha256 }, payload: e.payload,
    canonicalPayloadSha256: e.canonicalPayloadSha256 });
  e.collectorAttestation = signCollectorCommitment(commitment, { keyId: pair.keyId, privateKeyPem: pair.privateKeyPem }); return e;
}
const make = input => paper.createPrdPaperRecommendation(input);
const verify = record => paper.verifyPrdPaperRecommendation(record, { trustRegistry: pair.registry });
function ready(input) { const record = make(input); assert.equal(record.status, 'paper-screened', JSON.stringify(record.reasons));
  assert.equal(verify(record), true); return record; }

test('signed complete snapshot plus fully replayed zero-market fit creates only an uncalibrated paper record', () => controlled(() => {
  const input = fixture(), before = structuredClone(input), record = ready(input);
  assert.deepEqual(input, before); assert.equal(record.formalEligible, false); assert.equal(record.productionEligible, false);
  assert.equal(record.primary, null); assert.equal(record.companion, null); assert(record.paperPrimary);
  assert.deepEqual(record.markets.HAD.probabilities, input.forecast.grid.had);
  assert.deepEqual(record.markets.HHAD.probabilities, input.forecast.grid.hhad.probabilities);
  assert.equal(record.markets.HAD.quote.priceRelationToForecast, 'acquired-after-team-forecast');
  assert.equal(record.forecastAsOf, stamp(NOW - 1000)); assert.equal(record.decisionAt, stamp(NOW));
  assert.equal(record.decisionPriceAsOf, stamp(NOW)); assert.equal(record.marketPriorUsed, false);
  const ev = Object.values(record.markets).flatMap(m => m.options).filter(o => o.paperEligible).map(o => o.modelExpectedValue);
  assert.equal(record.paperPrimary.modelExpectedValue, Math.max(...ev));
}));

test('each market may be available alone; an unknown other market never borrows its odds or direction', () => controlled(() => {
  for (const market of ['HAD', 'HHAD']) {
    const input = fixture({ markets: [market] }); if (market === 'HAD') input.quoteSnapshot.endpoints.pop();
    const record = ready(input), other = market === 'HAD' ? 'HHAD' : 'HAD';
    assert(record.markets[market].quote); assert.equal(record.markets[other].quote, null);
    assert.equal(record.markets[other].options.length, 0); assert.equal(record.paperPrimary.market, market);
  }
}));

test('old mixed-model p and caller clocks/sourceVerified cannot supply probabilities or price authority', () => controlled(() => {
  const input = fixture({ markets: ['HAD'] }), a = ready(input);
  input.match.probabilityModel = { oneXTwo: { final: { home: 100, draw: 0, away: 0 } } };
  input.asOf = stamp(NOW - 86400000); input.now = NOW - 86400000; input.sourceVerified = true;
  const b = ready(input); assert.deepEqual(a.markets, b.markets); assert.deepEqual(a.paperPrimary, b.paperPrimary);
  input.quoteSnapshot = null; input.match.odds = { odds1: 100, oddsX: 100, odds2: 100 };
  const unknown = make(input); assert.equal(unknown.status, 'blocked'); assert.equal(unknown.paperPrimary, null);
  assert.deepEqual(unknown.reasons, ['signed-market-quote-unavailable']);
}));

test('both PRD gates are AND, with same-market devig; failed gates produce watch instead of a fallback', () => controlled(() => {
  const low = ready(fixture({ had: { H: 1.01, D: 1.01, A: 1.01 }, hhad: { H: 1.01, D: 1.01, A: 1.01 } }));
  assert.equal(low.paperPrimary, null); assert.equal(low.selectionStatus, 'watch-no-eligible-option');
  assert(Object.values(low.markets).every(m => m.options.every(o => o.probabilityTimesSp <= 1.05)));
  const input = fixture({ markets: ['HAD'] }), p = input.forecast.grid.had;
  const leader = ['H', 'D', 'A'].reduce((a, b) => p[a] >= p[b] ? a : b);
  const odds = { H: 10000, D: 10000, A: 10000 }; odds[leader] = Math.ceil((1.06 / p[leader]) * 10000) / 10000;
  for (const e of input.quoteSnapshot.endpoints) {
    const pool = e.payload.value.matchInfoList[0].subMatchList[0].oddsList[0];
    [pool.h, pool.d, pool.a] = [odds.H, odds.D, odds.A]; resign(e);
  }
  const record = ready(input), candidate = record.markets.HAD.options.find(o => o.code === leader);
  assert(candidate.probabilityTimesSp > 1.05); assert(candidate.sameMarketEdge < 0.05); assert.equal(candidate.paperEligible, false);
  for (const o of record.markets.HAD.options) assert.equal(o.paperEligible, o.probabilityTimesSp > 1.05 && o.sameMarketEdge > 0.05);
}));

test('bad signatures, unknown signing keys, role/URL changes and unsigned payload edits cannot become paper quotes', () => controlled(() => {
  for (const change of [e => { e.collectorAttestation.signature = 'bad'; }, e => { e.collectorAttestation.keyId = 'unknown'; },
    e => { e.sourceRequest.role = 'calculator'; }, e => { e.url = 'https://example.org/odds'; },
    e => { e.payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h = 99; }]) {
    const input = fixture({ markets: ['HAD'] }); input.quoteSnapshot.endpoints.pop(); change(input.quoteSnapshot.endpoints[0]);
    const record = make(input); assert.equal(record.status, 'blocked'); assert.equal(record.paperPrimary, null);
  }
}));

test('full member identity, sale, numeric line and extraction signature bind HHAD without HAD fallback', () => controlled(() => {
  const changes = [r => { r.matchNumStr = 'other'; }, r => { r.awayTeamAllName = 'other'; }, r => { r.matchTime = '00:01:00'; },
    r => { r.businessDate = '2030-10-06'; }, r => { r.sellStatus = 0; }, r => { r.oddsList[0].goalLine = '-2'; },
    r => { r.poolList[0].cbtAllUp = 0; }, r => { r.oddsList.push(structuredClone(r.oddsList[0])); }];
  for (const change of changes) {
    const input = fixture({ markets: ['HHAD'] }); change(input.quoteSnapshot.endpoints[1].payload.value.matchInfoList[0].subMatchList[0]);
    resign(input.quoteSnapshot.endpoints[1]); const record = make(input); assert.equal(record.status, 'blocked');
    assert.equal(record.paperPrimary, null);
  }
}));

test('signed quote knowledge must predate current decision and both request/response remain within TTL', () => controlled(() => {
  for (const change of [e => { e.requestedAt = stamp(NOW + 1); e.receivedAt = stamp(NOW + 2); },
    e => { e.requestedAt = stamp(NOW - 16 * 60000); e.receivedAt = stamp(NOW - 16 * 60000 + 1); },
    e => { e.requestedAt = '2030-10-07T03:00:00.000000001Z'; e.receivedAt = e.requestedAt; }]) {
    const input = fixture({ markets: ['HAD'] }); input.quoteSnapshot.endpoints.pop(); change(input.quoteSnapshot.endpoints[0]);
    resign(input.quoteSnapshot.endpoints[0]); const record = make(input); assert.equal(record.status, 'blocked'); assert.equal(record.paperPrimary, null);
  }
}));

test('wrong approved event, source entities, team order or forecast grid resealed by caller are rejected', () => controlled(() => {
  for (const change of [r => { r.match.sourceMatchId = '999'; }, r => { [r.match.homeTeamId, r.match.awayTeamId] = [r.match.awayTeamId, r.match.homeTeamId]; },
    r => { r.match.homeEntityRef = 'other'; }, r => { r.forecast.grid.had.H += 0.1; },
    r => { r.forecast.eventApproval.orderedEntityRefs.reverse(); }]) {
    const input = fixture(); change(input);
    const { contentHash, ...body } = input.forecast; input.forecast = { ...body, contentHash: baseline.hash(body) };
    assert.equal(make(input).status, 'blocked');
  }
}));

test('current actual decision cannot be backdated past sale cutoff and historical replay remains valid after TTL/cutoff', () => controlled(() => {
  const input = fixture(), record = ready(input); tick = NOW + 16 * 60000; assert.equal(verify(record), true);
  tick = NOW + 12 * 3600000; assert.equal(verify(record), true);
  input.asOf = stamp(NOW); input.now = NOW; assert.equal(make(input).status, 'blocked');
}));

test('hash-only tampering of private snapshots, frozen probabilities, selected option and clocks fails full replay', () => controlled(() => {
  const record = ready(fixture());
  for (const change of [r => { r.paperPrimary.sp += 1; }, r => { r.markets.HAD.probabilities.H += 0.01; },
    r => { r.privateInputs.forecast.grid.had.H += 0.01; }, r => { r.privateInputs.quoteSnapshot.endpoints[0].payload.success = false; },
    r => { r.decisionAt = stamp(NOW - 800); }, r => { r.createdAt = stamp(NOW + 1); }, r => { r.registration.probabilityTimesSpGreaterThan = 1; }]) {
    const altered = structuredClone(record); change(altered); assert.equal(verify(rehash(altered)), false);
  }
  assert.equal(paper.verifyPrdPaperRecommendation(record, { trustRegistry: { version: 'bad', keys: [] } }), false);
}));

test('public projection is compact, separately sealed and arithmetically validated, never private training or quote payload', () => controlled(() => {
  const record = ready(fixture()), view = paper.publicPrdPaperProjection(record, { trustRegistry: pair.registry });
  assert.equal(paper.validPublicPrdPaperProjection(view), true); assert.equal(view.version, 'prd-paper-direction-view-v1');
  assert.equal(view.id, record.id); assert.equal(view.recordHash, record.contentHash);
  const serialized = JSON.stringify(view); for (const name of ['privateInputs', 'trainingRows', 'collectorAttestation', 'payload', 'probabilityModel']) assert(!serialized.includes(name));
  const altered = structuredClone(view); altered.paperPrimary.edge += 0.01;
  const { contentHash, ...body } = altered; altered.contentHash = baseline.hash(body);
  assert.equal(paper.validPublicPrdPaperProjection(altered), false);
  assert.equal(paper.publicPrdPaperProjection(record, { trustRegistry: { version: 'bad', keys: [] } }), null);
}));

test('input getters are rejected without invocation and malformed shapes do not escape as trusted records', () => controlled(() => {
  const input = fixture(); let called = 0;
  Object.defineProperty(input.match, 'odds', { enumerable: true, get() { called++; return {}; } });
  assert.equal(make(input).status, 'blocked'); assert.equal(called, 0);
  const accessor = fixture(); Object.defineProperty(accessor, 'artifact', { enumerable: true, get() { called++; return artifact; } });
  assert.equal(make(accessor).status, 'blocked'); assert.equal(called, 0);
  for (const value of [null, {}, { artifact: {}, forecast: {}, match: {}, quoteSnapshot: null }]) assert.equal(make(value).status, 'blocked');
}));

test('explicit Beijing local sale cutoff is mapped while malformed calendars and hidden registry paths cannot supply quotes', () => controlled(() => {
  const input = fixture(); input.match.buyEndTime = '2030-10-07 22:00:00';
  assert.equal(ready(input).cutoffTime, stamp(NOW + 11 * 3600000));
  input.match.buyEndTime = '2030-02-30 22:00:00'; assert.equal(make(input).status, 'blocked');
  input.match.buyEndTime = '2030-10-07 22:00:00'; input.trustRegistry = 'must-not-open-any-file';
  const unknown = make(input); assert.equal(unknown.status, 'blocked'); assert.equal(unknown.paperPrimary, null);
}));

test('no signature-qualified market blocks without consuming an input; a later valid price creates the first paper sample', () => controlled(() => {
  const input = fixture({ markets: ['HAD'] }), later = structuredClone(input.quoteSnapshot);
  input.quoteSnapshot = null;
  assert.equal(make(input).status, 'blocked');
  input.quoteSnapshot = later; tick = NOW + 1;
  const record = ready(input); assert(record.paperPrimary); assert.equal(record.decisionAt, stamp(NOW + 1));
}));

test('public storage acknowledgement is sealed with exact nanosecond and thirty-second/cutoff boundaries', () => controlled(() => {
  const record = ready(fixture()), storageCommit = { paperArtifactHash: 'c'.repeat(64), acknowledgementHash: 'd'.repeat(64),
    paperCommitObservedAt: '2030-10-07T03:00:00.000000001Z' };
  const view = paper.publicPrdPaperProjection(record, { trustRegistry: pair.registry, storageCommit });
  assert(view); assert.equal(paper.validPublicPrdPaperProjection(view), true);
  const replaced = { ...view, acknowledgementHash: 'e'.repeat(64) }; assert.equal(paper.validPublicPrdPaperProjection(replaced), false);
  for (const value of ['2030-10-07T02:59:59.999999999Z', '2030-10-07T03:00:30.000000001Z', record.cutoffTime])
    assert.equal(paper.publicPrdPaperProjection(record, { trustRegistry: pair.registry,
      storageCommit: { ...storageCommit, paperCommitObservedAt: value } }), null);
  const diagnostic = paper.publicPrdPaperProjection(record, { trustRegistry: pair.registry });
  assert.equal(diagnostic.paperArtifactHash, null); assert.equal(diagnostic.acknowledgementHash, null);
}));

test('new paper waits before Beijing 11 even when valid prices and a frozen model already exist',()=>controlled(()=>{
  const input=fixture();tick=NOW-1;
  const record=make(input);assert.equal(record.status,'blocked');assert.deepEqual(record.reasons,['opening-not-reached']);
  assert.equal(record.formalEligible,false);assert.equal(record.paperPrimary,null);
}));
test('new paper does not reuse a signed early cache or a request spanning the opening boundary',()=>controlled(()=>{
  for(const receivedAt of [stamp(NOW-1),stamp(NOW)]){
    const input=fixture();for(const e of input.quoteSnapshot.endpoints){e.requestedAt=stamp(NOW-2);e.receivedAt=receivedAt;resign(e);}
    const record=make(input);assert.equal(record.status,'blocked');assert.deepEqual(record.reasons,['quote-acquired-before-opening']);
  }
}));
test('HHAD cannot use a fresh calculator price with an early current sale-state source',()=>controlled(()=>{
  const input=fixture({markets:['HHAD']});
  const current=input.quoteSnapshot.endpoints.find(e=>e.method==='current');
  current.requestedAt=stamp(NOW-2);current.receivedAt=stamp(NOW-1);resign(current);
  const record=make(input);assert.equal(record.status,'blocked');assert.deepEqual(record.reasons,['quote-acquired-before-opening']);
}));
test('a historical pre-opening signed paper original still passes exact mathematical and signature replay',()=>controlled(()=>{
  const fs=require('node:fs'),Module=require('node:module'),{createRequire}=Module;
  const filename=require.resolve('../src/services/prdPaperRecommendation.cjs'),native=createRequire(filename);
  const legacy=new Module(filename,module);legacy.filename=filename;legacy.paths=module.paths;
  // Only the newly added creation boundary is absent in this old-producer
  // boundary double. The real derive/identity/signature/math and seal run.
  legacy.require=id=>id==='./sportteryOpeningPolicy.cjs'?{...native(id),assessOpening:()=>({eligible:true}),assessPaperOpening:()=>({eligible:true})}:native(id);
  const source=fs.readFileSync(filename,'utf8'),markerLine='    privateInputs.openingProjection={version:OPENING_VERSION,businessDate:privateInputs.match.businessDate,openingAt:opening.openingAt};';
  assert.equal(source.split(markerLine).length,2);
  legacy._compile(source.replace(markerLine,''),filename);
  const input=fixture();for(const e of input.quoteSnapshot.endpoints){e.requestedAt=stamp(NOW-800);e.receivedAt=stamp(NOW-500);resign(e);}
  tick=NOW-1;const old=legacy.exports.createPrdPaperRecommendation(input);
  assert.equal(old.status,'paper-screened',JSON.stringify(old.reasons));assert.equal(old.decisionAt,stamp(NOW-1));assert.equal(verify(old),true);
  tick=NOW+86400000;assert.equal(verify(old),true);assert.equal(old.formalEligible,false);
}));
test('new paper retains valid HAD when only calculator acquisition predates opening and preserves both raw signed originals',()=>controlled(()=>{
  const input=fixture(),calculator=input.quoteSnapshot.endpoints.find(e=>e.method==='calculator');
  calculator.requestedAt=stamp(NOW-2);calculator.receivedAt=stamp(NOW-1);resign(calculator);
  const raw=baseline.hash(input.quoteSnapshot),record=ready(input);
  assert(record.markets.HAD.quote);assert.equal(record.markets.HHAD.quote,null);
  assert.deepEqual(record.markets.HHAD.reasons,['quote-acquired-before-opening']);
  assert.equal(record.paperPrimary.market,'HAD');assert.equal(baseline.hash(record.privateInputs.quoteSnapshot),raw);
  assert.equal(baseline.hash(input.quoteSnapshot),raw);assert.deepEqual(record.privateInputs.openingProjection,
    {version:'sporttery-eleven-opening-v1',businessDate:'2030-10-07',openingAt:stamp(NOW)});
  tick=NOW+86400000;assert.equal(verify(record),true);
}));
test('opening projections cannot authorize another date, earlier hour, market mask or caller-supplied marker',()=>controlled(()=>{
  const input=fixture();input.openingProjection={version:'caller-mask',businessDate:'other',openingAt:stamp(NOW-1),markets:['HAD']};
  const record=ready(input);assert.equal(record.privateInputs.openingProjection.version,'sporttery-eleven-opening-v1');
  for(const patch of [{version:'caller-mask'},{businessDate:'2030-10-06'},{openingAt:stamp(NOW-1)},{markets:['HAD']}]){
    const altered=structuredClone(record);Object.assign(altered.privateInputs.openingProjection,patch);assert.equal(verify(rehash(altered)),false);
  }
}));

test('pre-registered common EV tie abstains instead of a market, favorite or outcome-code fallback', () => controlled(() => {
  const record = ready(fixture({ markets: ['HAD'], symmetric: true }));
  assert.equal(record.selectionStatus, 'watch-ev-tie'); assert.equal(record.paperPrimary, null);
  const eligible = record.markets.HAD.options.filter(o => o.paperEligible).sort((a, b) => b.modelExpectedValue - a.modelExpectedValue);
  assert(eligible.length >= 2); assert(Math.abs(eligible[0].modelExpectedValue - eligible[1].modelExpectedValue) <= 1e-12);
  const view = paper.publicPrdPaperProjection(record, { trustRegistry: pair.registry });
  assert.equal(view.paperPrimary, null); assert.equal(paper.validPublicPrdPaperProjection(view), true);
}));
