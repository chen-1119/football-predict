'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {derivedTeamId} = require('../scripts/storedResultTeamIdentity.cjs');
const {SPORTTERY_CURRENT_URL, SPORTTERY_CALCULATOR_URL} = require('../scripts/sportteryEndpointContract.cjs');
const {createCollectorKeyPair, buildCollectorCommitment, signCollectorCommitment, sha256CollectorJson}
  = require('../src/services/collectorAttestation.cjs');
const {joinOfficialHad, signedLiveHadQuoteForMatch, validSignedLiveHadReceipt, validOfficialHadAudit,
  MAX_SOURCE_BYTES, MAX_RECEIPT_BYTES} = require('../scripts/recommendationPlatform/liveOfficialHad.cjs');
const NOW = Date.parse('2026-10-07T03:00:00.000Z'), stamp = n => new Date(n).toISOString();
const pair = createCollectorKeyPair({keyId: 'live-had-fixture', independenceDomain: 'synthetic-live-had-test'});
const clone = structuredClone;
function source() {
  const homeTeamName = '合成主队', awayTeamName = '合成客队';
  return {id: 'sporttery_2041823', sourceMatchId: '2041823', businessDate: '2026-10-07', matchNo: '周三001',
    homeTeamId: derivedTeamId(homeTeamName), awayTeamId: derivedTeamId(awayTeamName), homeTeamName, awayTeamName,
    kickoffTime: '2026-10-08T00:00:00+08:00', eventVersion: '2026-10-08T00:00:00+08:00', status: 'SCHEDULED',
    buyEndTime: '2026-10-07 22:00:00', odds: {odds1: 1.4, oddsX: 4, odds2: 6}, oddsSource: 'sporttery:HAD',
    oddsReceivedAt: stamp(NOW - 30 * 60000), predictionMeta: {cutoffTime: '2026-10-07T22:00:00+08:00'},
    probabilityModel: {version: 'synthetic-test', generatedAt: stamp(NOW - 5 * 60000), oneXTwo: {final: {home: 55, draw: 25, away: 20}}}};
}
function raw() {
  const m = source();
  return {matchId: 2041823, matchDate: '2026-10-08', matchTime: '00:00', businessDate: m.businessDate,
    matchNumStr: m.matchNo, homeTeamId: 999001, awayTeamId: 999002,
    homeTeamAllName: m.homeTeamName, awayTeamAllName: m.awayTeamName, matchStatus: 'Selling', sellStatus: '1',
    oddsList: [{poolCode: 'HAD', h: 1.8, d: 3.5, a: 4.5, updateDate: '2026-10-07', updateTime: '10:30:00'},
      {poolCode: 'HHAD', h: 3.2, d: 3.5, a: 1.8, goalLine: '-1'}],
    poolList: [{poolCode: 'HAD', poolStatus: 'Selling', intAllUp: 1, cbtAllUp: 1}]};
}
function resign(e, extractions) {
  e.canonicalPayloadSha256 = sha256CollectorJson(e.payload);
  const commitment = buildCollectorCommitment({endpoint: e.sourceRequest, collectorCycleId: e.sourceCycleId,
    requestedAt: e.requestedAt, receivedAt: e.receivedAt, providerObservedAt: e.providerObservedAt,
    response: {httpStatus: e.httpStatus, contentType: e.contentType, rawSha256: e.rawSha256,
      rawBytes: e.rawBytes, headersSha256: e.headersSha256}, payload: e.payload,
    canonicalPayloadSha256: e.canonicalPayloadSha256, ...(extractions ? {marketExtractions: extractions} : {})});
  e.collectorAttestation = signCollectorCommitment(commitment, {keyId: pair.keyId, privateKeyPem: pair.privateKeyPem});
  return e;
}
function snapshot(at = NOW, mutateRow = () => {}, mutateEndpoint = () => {}) {
  const row = raw(); mutateRow(row);
  const e = {method: 'current', page: null, ok: true, url: SPORTTERY_CURRENT_URL,
    sourceRequest: {url: SPORTTERY_CURRENT_URL, method: 'GET', page: null, role: 'current'},
    requestedAt: stamp(at - 1000), receivedAt: stamp(at), sourceCycleId: 'synthetic-current-cycle',
    httpStatus: 200, contentType: 'application/json;charset=utf-8', rawBytes: 1000,
    rawSha256: 'b'.repeat(64), headersSha256: 'a'.repeat(64),
    payload: {success: true, value: {matchInfoList: [{businessDate: '2026-10-07', subMatchList: [row]}]}}};
  mutateEndpoint(e); resign(e); return {endpoints: [e]};
}
function joined(m = source(), s = snapshot(), now = NOW) {
  const audit = {}, result = joinOfficialHad([m], s, {now, trustRegistry: pair.registry, audit});
  return {...result, audit, input: result.current[0].prospectiveForecastInput || result.current[0]};
}
const deadline = Date.parse('2026-10-07T14:00:00Z');
const quote = (m, now = NOW) => signedLiveHadQuoteForMatch(m, now, deadline, {trustRegistry: pair.registry});
function rehash(r) { const {receiptHash, ...body} = r; return {...body, receiptHash: sha256CollectorJson(body)}; }

test('single signed current role refreshes HAD without calculator, model or frozen parent mutation', () => {
  const m = source(), parent = {...m, prospectiveForecastInput: clone(m)}, before = clone(parent);
  const result = joined(parent);
  assert.deepEqual(parent, before);
  assert.deepEqual(result.current[0].probabilityModel, parent.probabilityModel);
  assert.deepEqual(result.input.probabilityModel, m.probabilityModel);
  assert.equal(result.input.oddsReceivedAt, stamp(NOW));
  assert.deepEqual(result.input.odds, {odds1: 1.8, oddsX: 3.5, odds2: 4.5});
  assert.equal(result.audit.reasonCounts['had-applied'], 1);
  assert.equal(result.receiptHashes.size, 1);
  assert.ok(validOfficialHadAudit(result.audit, stamp(NOW)));
  assert.equal(quote(result.input).sourceVerification, 'trusted-collector-signed-live-had');
  assert.equal(result.input.officialHadQuoteReceipt.identity.teamIdentityBasis, 'syncData-name-derived-team-id-v1');
});
test('receipt independently replays exact signed payload and extraction membership', () => {
  const {input} = joined(), receipt = clone(input.officialHadQuoteReceipt);
  assert.ok(validSignedLiveHadReceipt(receipt, {match: input, now: NOW, cutoffTime: deadline, trustRegistry: pair.registry}));
  assert.equal(receipt.marketExtraction.poolCode, 'HAD');
  assert.equal(receipt.marketExtraction.handicapLine, '0');
  assert.ok(receipt.endpoint.collectorAttestation.commitment.marketExtractionHashes.includes(receipt.marketExtraction.hash));
  const wrong = {...input, officialHadQuoteReceipt: receipt};
  wrong.homeTeamId = 'team_wrong'; assert.equal(quote(wrong), null);
  assert.equal(validSignedLiveHadReceipt(receipt, {match: input, now: NOW, cutoffTime: deadline,
    trustRegistry: {version: pair.registry.version, keys: []}}), false);
});
test('receipt SP, extraction, endpoint payload, identity and sale changes fail even after ordinary receipt rehash', () => {
  const {input} = joined();
  for (const mutate of [r => r.quoteOdds.odds1 = 9, r => r.marketExtraction.odds['1'] = 9,
    r => r.endpoint.payload.value.matchInfoList[0].subMatchList[0].homeTeamAllName = '另一队',
    r => r.endpoint.payload.value.matchInfoList[0].subMatchList[0].poolList[0].poolStatus = 'SellingX',
    r => r.identity.homeTeamId = 'team_fake', r => r.identity.businessDate = '2026-10-08',
    r => r.observedAt = stamp(NOW + 1), r => r.sourceCycleId = 'replacement', r => r.rowHash = 'c'.repeat(64),
    r => r.endpoint.payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h = 9]) {
    let r = clone(input.officialHadQuoteReceipt); mutate(r); r = rehash(r);
    assert.equal(quote({...input, officialHadQuoteReceipt: r}), null);
  }
});
test('unknown signing key, corrupt signature, wrong URL/method/role and payload mutation cannot refresh', () => {
  for (const mutate of [s => s.endpoints[0].collectorAttestation.keyId = 'unknown',
    s => s.endpoints[0].collectorAttestation.signature = 'bad', s => s.endpoints[0].url = SPORTTERY_CALCULATOR_URL,
    s => s.endpoints[0].sourceRequest.method = 'POST', s => s.endpoints[0].sourceRequest.role = 'calculator',
    s => s.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].a = 9]) {
    const m = source(), s = snapshot(); mutate(s); const result = joined(m, s);
    assert.equal(result.current[0], m); assert.equal(result.receiptHashes.size, 0);
    assert.ok(validOfficialHadAudit(result.audit, stamp(NOW)));
  }
});
test('valid signature does not repair endpoint role, page, HTTP and clock contract violations', () => {
  for (const mutate of [e => e.sourceRequest.role = 'calculator', e => e.sourceRequest.method = 'POST',
    e => e.page = 1, e => e.sourceRequest.url = SPORTTERY_CALCULATOR_URL, e => e.httpStatus = 403,
    e => e.contentType = 'text/html', e => e.sourceCycleId = ' ', e => e.requestedAt = stamp(NOW + 1)]) {
    const m = source(); assert.equal(joined(m, snapshot(NOW, () => {}, mutate)).current[0], m);
  }
});
test('15 minute freshness includes original request and receipt clock; new envelope metadata does not extend it', () => {
  for (const at of [NOW - 16 * 60000, NOW + 1]) {
    const m = source(), s = snapshot(at); s.capturedAt = stamp(NOW); s.sourceCycleId = 'new-envelope';
    assert.equal(joined(m, s).current[0], m);
  }
  const m = source(), slow = snapshot(NOW, () => {}, e => {e.requestedAt = stamp(NOW - 16 * 60000);});
  assert.equal(joined(m, slow).current[0], m);
  const fresh = joined(); assert.equal(quote(fresh.input, NOW + 15 * 60000), null); // requestedAt is older
});
test('strict clock/calendar validation preserves submillisecond boundaries rather than rounding future bytes', () => {
  for (const value of ['2026-10-07T03:00:00.000000001Z', '2026-02-30T03:00:00Z', '2026-10-07T24:00:00Z']) {
    const m = source(), s = snapshot(NOW, () => {}, e => {e.receivedAt = value;});
    assert.equal(joined(m, s).current[0], m);
  }
  const m = source(); m.eventVersion = '2026-10-07T16:00:00.000000001Z';
  assert.equal(joined(m).current[0], m);
});
test('explicit provider clocks cannot be malformed or later than acquisition; old updates and unknown blank pairs stay separate', () => {
  for (const providerObservedAt of [stamp(NOW + 1), '2026-02-30T02:00:00.000Z', 'bad']) {
    const result = joined(source(), snapshot(NOW, () => {}, e => {e.providerObservedAt = providerObservedAt;}));
    assert.equal(result.receiptHashes.size, 0); assert.equal(result.audit.endpoints.current.reason, 'endpoint-clock-invalid');
  }
  for (const mutate of [p => {p.updateTime = '11:00:01';}, p => {p.updateDate = '2026-02-30';},
    p => {p.updateTime = '24:00:00';}, p => {p.updateDate = '';}, p => {delete p.updateTime;}]) {
    const result = joined(source(), snapshot(NOW, r => {mutate(r.oddsList[0]);}));
    assert.equal(result.receiptHashes.size, 0); assert.equal(result.audit.reasonCounts['had-market-invalid'], 1);
  }
  const oldProvider = joined(source(), snapshot(NOW, r => {r.oddsList[0].updateDate = '2026-10-06';
    r.oddsList[0].updateTime = '09:00:00';}, e => {e.providerObservedAt = stamp(NOW - 24 * 3600000);}));
  assert.ok(quote(oldProvider.input)); assert.equal(quote(oldProvider.input).at, stamp(NOW));
  const blankPair = joined(source(), snapshot(NOW, r => {r.oddsList[0].updateDate = ''; r.oddsList[0].updateTime = '';},
    e => {e.providerObservedAt = stamp(NOW - 30 * 60000);}));
  assert.ok(quote(blankPair.input)); assert.equal(blankPair.input.officialHadQuoteReceipt.marketExtraction.providerObservedAt, stamp(NOW - 30 * 60000));
});
test('ordered signed names and existing name derived PG IDs must both agree; raw provider IDs are another namespace', () => {
  const ok = joined(); assert.ok(quote(ok.input));
  for (const mutate of [m => m.homeTeamId = '999001', m => m.awayTeamId = m.homeTeamId,
    m => [m.homeTeamName, m.awayTeamName] = [m.awayTeamName, m.homeTeamName],
    m => m.homeTeamId = 'team_unknown', m => m.sourceMatchId = 'other_2041823', m => m.id = 'other_2041823']) {
    const m = source(); mutate(m); assert.equal(joined(m).current[0], m);
  }
  const alias = source(); alias.id = 'fivehundred_2041823'; assert.ok(quote(joined(alias).input));
});
test('reused source ID, changed kickoff, business date, match number, group date or ambiguous rows cannot bind', () => {
  for (const mutate of [r => r.matchId = 2041824, r => r.matchTime = '00:01', r => r.businessDate = '2026-10-08',
    r => r.matchNumStr = '周三002', r => r.homeTeamAllName = '异名']) {
    const m = source(); assert.equal(joined(m, snapshot(NOW, mutate)).current[0], m);
  }
  for (const mutate of [e => e.payload.value.matchInfoList[0].businessDate = '2026-10-08',
    e => e.payload.value.matchInfoList[0].subMatchList.push(raw())]) {
    const m = source(); assert.equal(joined(m, snapshot(NOW, () => {}, mutate)).current[0], m);
  }
});
test('explicit group business date binds cross midnight matches when the row field is absent', () => {
  const result = joined(source(), snapshot(NOW, r => {delete r.businessDate;}));
  assert.ok(quote(result.input)); assert.equal(result.input.officialHadQuoteReceipt.identity.businessDate, '2026-10-07');
});
test('Define/OddsIn with SP is an authoritative negative sale observation, never an open-price fallback', () => {
  const parent = source(); parent.oddsReceivedAt = stamp(NOW - 1000); parent.prospectiveForecastInput = clone(parent);
  const before = clone(parent), s = snapshot(NOW, r => {r.matchStatus = 'Define'; r.sellStatus = '';
    r.poolList[0] = {...r.poolList[0], poolStatus: 'OddsIn', intAllUp: 0, cbtAllUp: 0};});
  const result = joined(parent, s);
  assert.deepEqual(parent, before); assert.deepEqual(result.current[0].probabilityModel, parent.probabilityModel);
  assert.equal(result.input.isOnSale, false); assert.equal(result.input.saleStatus, 'SUSPENDED');
  assert.equal(result.audit.reasonCounts['event-not-selling'], 1); assert.equal(result.receiptHashes.size, 0);
});
test('pool suspended, missing or false allup flags do not infer Selling', () => {
  for (const mutate of [r => r.sellStatus = '', r => r.poolList[0].poolStatus = 'OddsIn',
    r => r.poolList[0].intAllUp = 0, r => {delete r.poolList[0].intAllUp; delete r.poolList[0].cbtAllUp;}]) {
    const result = joined(source(), snapshot(NOW, mutate));
    assert.equal(result.input.isOnSale, false); assert.equal(result.receiptHashes.size, 0);
  }
});
test('null prospective input, locked or terminal parents never borrow a model from a frozen display record', () => {
  for (const patch of [{prospectiveForecastInput: null}, {status: 'LIVE'}, {status: 'FINISHED'},
    {predictionMeta: {lockedAt: stamp(NOW)}}, {isOnSale: false}, {saleStatus: 'SUSPENDED'}]) {
    const m = {...source(), ...patch}; assert.equal(joined(m).current[0], m);
  }
});
test('newer native, external or warehouse receipt quotes cannot be overwritten by an older live observation', () => {
  for (const patch of [{oddsReceivedAt: stamp(NOW + 1)},
    {externalSignals: {bookmakerOdds: {had: {receivedAt: stamp(NOW + 1)}}}},
    {externalSignals: {bookmakerOdds: {had: {updatedAt: stamp(NOW + 1)}}}},
    {externalSignals: {bookmakerOdds: {had: {lotterySpReceipt: {observedAt: stamp(NOW + 1)}}}}}]) {
    const m = {...source(), ...patch}, result = joined(m);
    assert.equal(result.current[0], m); assert.equal(result.audit.reasonCounts['input-quote-newer-than-snapshot'], 1);
  }
});
test('sale cutoff, kickoff, real observation time and malformed stale-event sale clocks fail closed', () => {
  for (const patch of [{buyEndTime: stamp(NOW)}, {cutoffAt: stamp(NOW)},
    {kickoffTime: stamp(NOW), eventVersion: stamp(NOW)}, {buyEndTime: '2026-02-30 21:00:00'}]) {
    const m = {...source(), ...patch}; assert.equal(joined(m).current[0], m);
  }
  const stale = joined(source(), snapshot(NOW, r => {r.buyEndTime = '2026-09-01 22:00:00';}));
  assert.equal(stale.receiptHashes.size, 0);
  const {input} = joined(); assert.equal(signedLiveHadQuoteForMatch(input, NOW, NOW, {trustRegistry: pair.registry}), null);
});
test('signed extraction omission and multiple HAD pools cannot create an official receipt', () => {
  const s = snapshot(); resign(s.endpoints[0], ['f'.repeat(64)]);
  assert.equal(joined(source(), s).receiptHashes.size, 0);
  for (const mutate of [r => r.oddsList.push(clone(r.oddsList[0])), r => r.poolList.push(clone(r.poolList[0])),
    r => r.oddsList[0].h = '', r => r.oddsList[0].h = 1.00001, r => r.oddsList[0].h = true]) {
    assert.equal(joined(source(), snapshot(NOW, mutate)).receiptHashes.size, 0);
  }
});
test('two current roles are ambiguous even if each has a good signature; optional unrelated roles do not redirect HAD', () => {
  const dup = snapshot(); dup.endpoints.push(clone(dup.endpoints[0]));
  assert.equal(joined(source(), dup).receiptHashes.size, 0);
  const s = snapshot(); s.endpoints.push({method: 'result', payload: {unused: true}});
  assert.ok(quote(joined(source(), s).input));
});
test('source 4MiB/512 row and receipt 256KiB ceilings reject rather than inflate frozen records', () => {
  const tooMany = snapshot(NOW, () => {}, e => {e.payload.value.matchInfoList[0].subMatchList = Array.from({length: 513}, raw);});
  assert.equal(joined(source(), tooMany).audit.endpoints.current.reason, 'endpoint-row-limit');
  const receiptLarge = snapshot(NOW, () => {}, e => {e.payload.padding = 'x'.repeat(MAX_RECEIPT_BYTES);});
  const rejected = joined(source(), receiptLarge);
  assert.equal(rejected.audit.reasonCounts['receipt-too-large'], 1); assert.equal(rejected.receiptHashes.size, 0);
  const sourceLarge = snapshot(); sourceLarge.padding = 'x'.repeat(MAX_SOURCE_BYTES);
  const big = joined(source(), sourceLarge); assert.equal(big.audit.endpoints.current.reason, 'source-too-large');
  assert.ok(validOfficialHadAudit(big.audit, stamp(NOW)));
});
test('audit clocks, verified flags, unknown fields, samples, count and identifiers are bounded pure metadata', () => {
  const {audit} = joined(); assert.ok(validOfficialHadAudit(audit, stamp(NOW)));
  for (const mutate of [a => a.extra = 'unbound', a => a.asOf = stamp(NOW + 1), a => a.reasonCounts['had-applied'] = Infinity,
    a => a.samples = Array(33).fill(a.samples[0]), a => a.samples[0].sourceMatchId = '球'.repeat(255),
    a => a.endpoints.current.receivedAt = stamp(NOW + 1), a => a.endpoints.current.collectorSignatureVerified = false,
    a => a.endpoints.current.extra = true, a => a.status = 'admitted']) {
    const bad = clone(audit); mutate(bad); assert.equal(validOfficialHadAudit(bad, stamp(NOW)), false);
  }
  const many = Array.from({length: 40}, () => ({...source(), status: 'LIVE'})), a = {};
  joinOfficialHad(many, snapshot(), {now: NOW, trustRegistry: pair.registry, audit: a});
  assert.equal(a.samples.length, 32); assert.equal(a.reasonCounts['not-open-prospective-input'], 40);
  assert.ok(validOfficialHadAudit(a, stamp(NOW)));
});
