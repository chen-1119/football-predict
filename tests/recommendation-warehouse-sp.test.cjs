'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRows, hash, SOURCE } = require('../collectors/market/policy.cjs');
const { projectSignalRows, readMarketSignalRows } = require('../collectors/market/signalBridge.cjs');
const { CONTRACT, COPY_SOURCE, buildWarehouseSpReceipt, validReceipt, warehouseQuoteForMatch } = require('../src/services/warehouseLotterySp.cjs');
const { evaluateForecast } = require('../src/services/publishedForecastPolicy.cjs');
const { attachProspectiveForecastInputs, forecastInputFor } = require('../src/services/prospectiveForecastInput.cjs');
const { makeDecision, validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { createRuntime } = require('../scripts/recommendationPlatform/runtime.cjs');
const { NOW, match, publication, validators, memoryPorts } = require('./recommendationFixture.cjs');
const stamp = ms => new Date(ms).toISOString();
function acquiredRow(id = 1, clock = NOW, market = 'had') {
  const m = match(id, clock);
  const signal = { source: SOURCE, sourceMatchId: String(id), fixtureId: `fixture-${id}`, matchNo: String(id),
    homeTeamName: m.homeTeamName, awayTeamName: m.awayTeamName, kickoffTime: m.kickoffTime,
    buyEndTime: '2026-09-17 22:00:00', bookmakerOdds: { [market]: { ...m.odds, ...(market === 'hhad' ? { handicapLine: -2 } : {}) } } };
  const normalized = normalizeRows([{ keys: [String(id)], signal }], stamp(clock)).markets[0];
  return { payload: normalized.payload, content_hash: normalized.contentHash, latest_content_hash: normalized.contentHash,
    observation_id: `observation-${id}`, first_seen_at: stamp(clock), last_seen_at: stamp(clock), updated_at: stamp(clock),
    acquisition: { run_id: `run-${id}`, source: SOURCE, status: 'completed', started_at: stamp(clock - 1000), finished_at: stamp(clock + 1000),
      source_sha256: 'b'.repeat(64), payload: { url: 'https://trade.500.com/jczq/?playid=312&g=2', predictionEligible: false } } };
}
function fallbackMatch(id = 1, clock = NOW, row = acquiredRow(id, clock)) {
  return match(id, clock, { oddsSource: '500.com:HAD', externalSignals: projectSignalRows([row])[0].signal });
}
const evaluate = m => evaluateForecast(m, { now: NOW, publication: publication(NOW) });

test('new native HAD extraction is explicitly marked, HHAD is not', () => {
  assert.equal(acquiredRow().payload.lotterySpContract, CONTRACT);
  assert.equal(acquiredRow(1, NOW, 'hhad').payload.lotterySpContract, undefined);
});
test('unchanged prices keep their content hash across collector receipt times', () => {
  assert.equal(acquiredRow(1).content_hash, acquiredRow(1, NOW + 1000).content_hash);
});
test('proof traces successful acquisition URL, raw body hash and observed identity', () => {
  const r = buildWarehouseSpReceipt(acquiredRow()); assert.ok(validReceipt(r));
  assert.equal(r.officialDirect, false); assert.equal(r.source, COPY_SOURCE); assert.equal(r.acquisitionBodySha256, 'b'.repeat(64));
});
test('legacy unmarked warehouse snapshots are not retroactively promoted', () => {
  const row = acquiredRow(); delete row.payload.lotterySpContract; row.content_hash = row.latest_content_hash = hash(row.payload);
  assert.equal(buildWarehouseSpReceipt(row), null); assert.equal(evaluate(fallbackMatch(1, NOW, row)).eligible, false);
});
test('wrong source, pool or bookmaker cannot become lottery SP', () => {
  for (const change of [{ source: 'odds-average' }, { pool: 'hhad' }, { bookmaker: 'european-average' }]) {
    const row = acquiredRow(); Object.assign(row.payload, change); row.content_hash = row.latest_content_hash = hash(row.payload);
    assert.equal(buildWarehouseSpReceipt(row), null);
  }
});
test('missing or unsuccessful acquisition is not sufficient', () => {
  for (const change of [null, { status: 'failed' }, { source: 'other' }, { payload: null }]) {
    const row = acquiredRow(); row.acquisition = change === null ? null : { ...row.acquisition, ...change };
    assert.equal(buildWarehouseSpReceipt(row), null);
  }
});
test('wrong path, hostname, credentials or unencrypted source URL is rejected', () => {
  for (const url of ['https://trade.500.com/oz/','https://trade.500.com.attacker.test/jczq/','http://trade.500.com/jczq/','https://a:b@trade.500.com/jczq/']) {
    const row=acquiredRow();row.acquisition.payload.url=url;assert.equal(buildWarehouseSpReceipt(row),null);
  }
});
test('tampered normalized quote or mismatched latest pointer is rejected', () => {
  const a=acquiredRow();a.payload.odds1=2;assert.equal(buildWarehouseSpReceipt(a),null);
  const b=acquiredRow();b.latest_content_hash='c'.repeat(64);assert.equal(buildWarehouseSpReceipt(b),null);
});
test('unbound first/last observation times are rejected', () => {
  for(const change of [{first_seen_at:stamp(NOW-10000)},{updated_at:stamp(NOW+1000)},{last_seen_at:stamp(NOW-1)}]) assert.equal(buildWarehouseSpReceipt({...acquiredRow(),...change}),null);
});
test('pg Date values and timezone-equivalent event clocks are accepted', () => {
  const row=acquiredRow();for(const k of ['updated_at','first_seen_at','last_seen_at'])row[k]=new Date(row[k]);
  const m=fallbackMatch(1,NOW,row);m.kickoffTime='2026-09-17T23:00:00+08:00'; assert.equal(evaluate(m).eligible,true);
});
test('native bridge keeps copied price data and provenance together', () => {
  const had=projectSignalRows([acquiredRow()])[0].signal.bookmakerOdds.had;
  assert.equal(had.odds1,had.lotterySpReceipt.quoteOdds.odds1);assert.equal(had.updatedAt,had.lotterySpReceipt.observedAt);
});
test('missing source metadata leaves reference output, not a falsely certified quote', () => {
  const row=acquiredRow();delete row.acquisition;
  const had=projectSignalRows([row])[0].signal.bookmakerOdds.had;
  assert.equal(had.lotterySpReceipt,undefined);assert.equal(had.odds1,1.8);
});
test('bridge read joins the acquisition record rather than guessing provenance', async () => {
  let sql='';const rows=await readMarketSignalRows({query:async text=>{sql=text;return {rows:[acquiredRow()]};}});
  assert.match(sql,/JOIN football.market_collector_runs acquisition/);assert.ok(rows[0].signal.bookmakerOdds.had.lotterySpReceipt);
});
test('bare 500 or generic externalOdds still cannot create a recommendation', () => {
  const m=match(1,NOW,{oddsSource:'500.com:HAD',externalSignals:{externalOdds:{...match().odds,source:'500.com'},bookmakerOdds:{had:{...match().odds,source:'500.com',updatedAt:stamp(NOW)}}}});
  assert.equal(evaluate(m).eligible,false);
});
test('valid copied SP can create a unified decision with explicit non-direct source', () => {
  const {decision:d}=makeDecision(fallbackMatch(),{now:NOW,publication:publication(NOW)});
  assert.ok(validDecision(d));assert.equal(d.tipCode,'1');assert.equal(d.quoteSource,COPY_SOURCE);
  assert.equal(d.quoteProvenance.officialDirect,false);assert.equal(d.modelValidation,'unvalidated');
});
test('source transport does not change the model direction', () => {
  const m=fallbackMatch();m.probabilityModel.oneXTwo.final={home:20,draw:25,away:55};
  const r=evaluate(m);assert.equal(r.candidate.tipCode,'2');assert.equal(r.candidate.odds,4.5);
});
test('equally fresh direct official quote is preferred and not relabeled', () => {
  const m=fallbackMatch();m.oddsSource='sporttery:HAD';const r=evaluate(m);
  assert.equal(r.candidate.quoteSource,'sporttery:HAD');assert.equal(r.candidate.quoteProvenance,undefined);
});
test('stale direct quote can fall back to a fresh identity-bound copy', () => {
  const m=fallbackMatch();m.oddsSource='sporttery:HAD';m.oddsUpdatedAt=stamp(NOW-16*60000);
  assert.equal(evaluate(m).candidate.quoteSource,COPY_SOURCE);
});
test('source ID reuse, opposite teams and shifted kickoffs are rejected', () => {
  for(const patch of [{sourceMatchId:'2'},{homeTeamName:'客队1',awayTeamName:'主队1'},{eventVersion:'2026-09-18T15:00:00Z'}]) {
    const m={...fallbackMatch(),...patch};assert.equal(evaluate(m).eligible,false);
  }
});
test('receipt hashes cannot be reused after changing prices', () => {
  const m=fallbackMatch();m.externalSignals.bookmakerOdds.had.lotterySpReceipt.quoteOdds.odds1=2;
  assert.equal(evaluate(m).eligible,false);
});
test('receipt and quote triplet must agree even if only generic had data changed', () => {
  const m=fallbackMatch();m.externalSignals.bookmakerOdds.had.odds1=2;assert.equal(evaluate(m).eligible,false);
});
test('metadata refresh cannot make a stale copied SP current', () => {
  const m=fallbackMatch(1,NOW,acquiredRow(1,NOW-16*60000));m.externalSignals.updatedAt=stamp(NOW);m.externalSignals.bookmakerOdds.had.updatedAt=stamp(NOW);
  assert.equal(evaluate(m).eligible,false);
});
test('future copied price is rejected', () => {
  const m=fallbackMatch(1,NOW,acquiredRow(1,NOW+1000));assert.equal(evaluate(m).eligible,false);
});
test('sale cutoff carried by the source can shorten a generic match cutoff', () => {
  const row=acquiredRow();row.payload.buyEndTime='2026-09-17 18:10:00';row.content_hash=row.latest_content_hash=hash(row.payload);
  const m=fallbackMatch(1,NOW,row),r=evaluate(m);assert.equal(r.candidate.cutoffTime,'2026-09-17T10:10:00.000Z');
  assert.equal(warehouseQuoteForMatch(m,NOW+10*60000,Date.parse(m.kickoffTime)),null);
});
test('suspension and already-started games remain rejected with valid receipts', () => {
  for(const p of [{isOnSale:false},{status:'LIVE'},{saleStatus:'SUSPENDED'}])assert.equal(evaluate({...fallbackMatch(),...p}).eligible,false);
});
test('receipt survives current-cycle input attachment without overwriting old frozen decisions', () => {
  const fresh=fallbackMatch(),old={...match(),odds:{odds1:1.5,oddsX:3,odds2:4}};
  const copy=structuredClone(old);const [attached]=attachProspectiveForecastInputs([old],[fresh],NOW);
  assert.deepEqual(old,copy);assert.deepEqual(attached.odds,copy.odds);
  assert.equal(evaluate(attached).candidate.quoteSource,COPY_SOURCE);assert.equal(forecastInputFor(attached).externalSignals.bookmakerOdds.had.odds1,1.8);
});
test('current-cycle input never borrows a receipt from the frozen parent', () => {
  const old=fallbackMatch(),fresh=match(1,NOW,{oddsSource:'500.com:HAD'});
  const [attached]=attachProspectiveForecastInputs([old],[fresh],NOW);assert.equal(evaluate(attached).eligible,false);
});
test('0 direct official odds, 3 audited copied SPs produce both combinations', async () => {
  const ports=memoryPorts();ports.current=[1,2,3].map(i=>fallbackMatch(i));
  const runtime=createRuntime(ports,{validators});const result=await runtime.publishingCycle();
  assert.equal(result.combinations.ok,true);assert.equal(ports.state.view.previews.length,2);
  assert.deepEqual(ports.state.view.previews.map(c=>c.size),[2,3]);
  assert.ok(ports.state.view.previews.every(c=>c.rawTotalOdds>=(c.size===2?2.5:5)&&c.legs.every(d=>d.quoteSource===COPY_SOURCE)));
});
test('all-reference copied-source combinations freeze and retain provenance immutably', async () => {
  const ports=memoryPorts();ports.now=Date.parse('2026-09-17T13:00:00Z');ports.current=[1,2,3].map(i=>fallbackMatch(i,ports.now));
  const runtime=createRuntime(ports,{validators});await runtime.publishingCycle();assert.equal(ports.state.combos.length,2);
  const before=structuredClone(ports.state.combos);ports.now+=1000;ports.current=[1,2,3].map(i=>fallbackMatch(i,ports.now));
  await runtime.publishingCycle();assert.deepEqual(ports.state.combos,before);
});
test('500 observed final is not promoted to official settlement by a price receipt', async () => {
  const ports=memoryPorts();ports.current=[1,2,3].map(i=>fallbackMatch(i));const runtime=createRuntime(ports,{validators});await runtime.publishingCycle();
  ports.now=Date.parse('2026-09-17T18:00:00Z');ports.history=[{...fallbackMatch(),status:'FINISHED',resultSource:'500.com:result',scoreHome:2,scoreAway:0}];
  await runtime.settlementCycle();assert.equal(ports.state.view.review.statistics.single.settled,0);
});

 test('frozen source receipt must agree with the complete saved quote and observed clock', () => {
  const d=makeDecision(fallbackMatch(),{now:NOW,publication:publication(NOW)}).decision;
  for(const patch of [{quoteObservedAt:stamp(NOW-1000)},{quoteOdds:{...d.quoteOdds,X:9}}]) {
    const body={...d,...patch};delete body.recordHash;assert.equal(validDecision({...body,recordHash:hash(body)}),false);
  }
});
