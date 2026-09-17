'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateForecast, evaluateBatch, buildRecord, verifyRecord, probabilities, dataPublishable, time, hash } = require('../src/services/publishedForecastPolicy.cjs');
const { persistPublishedForecasts, summarize, settlementFor, indexResults } = require('../scripts/publishedForecastLedger.cjs');
const { isOfficialRecommendationEligible, isServerOfficialRecommendationEligible } = require('../src/services/officialRecommendationEligibility.cjs');
const NOW = Date.parse('2026-09-17T10:00:00Z'), PUB = { generationId: 'gen-test', manifestHash: 'a'.repeat(64) };
function fixture(id = 1, changes = {}) {
  return { id: `sporttery_${id}`, sourceMatchId: String(id), businessDate: '2026-09-17', status: 'SCHEDULED', kickoffTime: '2026-09-17T15:00:00Z', eventVersion: '2026-09-17T15:00:00Z',
    homeTeamId: `h${id}`, awayTeamId: `a${id}`, homeTeamName: `主队${id}`, awayTeamName: `客队${id}`, leagueId: 'league',
    probabilityModel: { generatedAt: '2026-09-17T10:00:00Z', oneXTwo: { final: { home: 52, draw: 28, away: 20 } } },
    odds: { odds1: 1.8, oddsX: 3.5, odds2: 4.5 }, oddsSource: 'sporttery:had', oddsUpdatedAt: '2026-09-17T10:00:00Z',
    predictions: [{ marketType: 'BEST', tipCode: 'WATCH', recommendationAction: 'reference' }], ...changes };
}
const ctx = { now: NOW, publication: PUB };
const candidate = (m = fixture()) => evaluateForecast(m, ctx).candidate;
const record = () => buildRecord(candidate(), NOW);
const validators = { isFinal: r => r.official === true && r.status === 'FINISHED', isVoid: r => r.official === true && r.resultDisposition === 'VOID' };
function memoryClient() {
  const forecasts = new Map(), results = new Map(), calls = [];
  return { forecasts, results, calls, async query(sql, args = []) {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT payload FROM football.published_forecasts')) return { rows: [...forecasts.values()].map(payload => ({ payload: structuredClone(payload) })) };
    if (sql.startsWith('INSERT INTO football.published_forecasts')) {
      if (forecasts.has(args[0])) return { rows: [] };
      const payload = JSON.parse(args[8]); forecasts.set(args[0], payload); return { rows: [{ payload: structuredClone(payload) }] };
    }
    if (sql.startsWith('SELECT DISTINCT ON')) return { rows: [...results.entries()].map(([forecast_id, payload]) => ({ forecast_id, payload: structuredClone(payload) })) };
    if (sql.startsWith('INSERT INTO football.published_forecast_results')) { results.set(args[1], JSON.parse(args[5])); return { rows: [] }; }
    throw new Error(`Unrecognized SQL in test double: ${sql}`);
  } };
}
const opts = (more = {}) => ({ current: [fixture(1), fixture(2)], history: [], publication: PUB, publishable: true, now: NOW, validators, ...more });
test('all reference candidates generate publishable primary directions', () => { const r = evaluateBatch([fixture(1), fixture(2)], ctx); assert.equal(r.candidates.length, 2); assert.equal(r.candidates[0].tipCode, '1'); });
test('no BEST and no predictions array needed', () => assert.ok(candidate(fixture(1, { predictions: [] })))) ;
test('global shadow state does not stop valid prospective publication', () => assert.equal(dataPublishable({ updatedAt: '2026-09-17T10:00:00Z', publication: PUB, modelRiskStable: false, recommendationReliable: false }, PUB, NOW), true));
test('generation mismatch fails independently of global model state', () => assert.equal(dataPublishable({ updatedAt: '2026-09-17T10:00:00Z', publication: PUB }, { ...PUB, generationId: 'other' }, NOW), false));
test('stale or future data cannot get a new publication', () => { for (const updatedAt of ['2026-09-17T09:00:00Z','2026-09-17T10:00:01Z']) assert.equal(dataPublishable({ updatedAt, publication: PUB }, PUB, NOW), false); });
test('invalid timestamp and impossible calendar dates rejected', () => { for (const v of [null, '', '123456789', '2026-02-30T10:00:00Z']) assert.equal(Number.isFinite(time(v)), false); });
test('rounded percentage vector normalizes to one', () => { const p = probabilities({ home: 33.3, draw: 33.3, away: 33.3 }); assert.ok(Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)<1e-14); });
test('null, blank, boolean, zero and partial probabilities rejected', () => { for (const home of [null, '', true, NaN, -1]) assert.equal(probabilities({ home, draw: 20, away: 30 }), null); assert.equal(probabilities({home:0,draw:0,away:0}),null); });
test('probability argmax is not overwritten by lowest odds', () => { const m = fixture(); m.probabilityModel.oneXTwo.final = { home: 20, draw: 30, away: 50 }; const r = candidate(m); assert.equal(r.tipCode, '2'); assert.equal(r.odds,4.5); });
test('SP greater than 2.60 does not impose an unrelated hard ban', () => assert.ok(candidate(fixture(1,{odds:{odds1:3,oddsX:2,odds2:1.9}}))));
test('unique draw leader can be published', () => { const m=fixture();m.probabilityModel.oneXTwo.final={home:20,draw:45,away:35};assert.equal(candidate(m).tipCode,'X'); });
test('exact tie is not broken arbitrarily', () => { const m=fixture();m.probabilityModel.oneXTwo.final={home:40,draw:40,away:20};assert.equal(candidate(m),null); });
test('unknown market or outside bookmaker cannot impersonate SP', () => { for(const oddsSource of ['500.com:had','bookmaker:had','sporttery:hhad']) assert.equal(candidate(fixture(1,{oddsSource})),null); });
test('complete fallback quote travels with its own source clock', () => { const m=fixture(1,{odds:{odds1:null,oddsX:3,odds2:4},externalSignals:{bookmakerOdds:{had:{odds1:1.9,oddsX:3.1,odds2:4.2,source:'sporttery:had',updatedAt:'2026-09-17T09:59:00Z'}}}});assert.equal(candidate(m).odds,1.9); });
test('suspended market and started game are excluded', () => { for(const x of [{status:'LIVE'},{isOnSale:false},{saleStatus:'SUSPENDED'},{resultDisposition:'VOID'}])assert.equal(candidate(fixture(1,x)),null); });
test('cutoff is strict and does not reset at midnight', () => { assert.equal(candidate(fixture(1,{buyEndTime:'2026-09-17T10:00:00Z'})),null);assert.equal(evaluateForecast(fixture(),{...ctx,now:Date.parse('2026-09-17T16:00:00Z')}).eligible,false); });
test('future model, wrong event, wrong match and stale model rejected', () => { for(const x of [{generatedAt:'2026-09-17T10:00:01Z'},{eventVersion:'2026-09-17T16:00:00Z'},{sourceMatchId:'2'},{generatedAt:'2026-09-16T01:00:00Z'}]){const m=fixture();Object.assign(m.probabilityModel,x);assert.equal(candidate(m),null);} });
test('same source ID with different team/event is not silently merged', () => assert.equal(evaluateBatch([fixture(),fixture(1,{homeTeamId:'other'})],ctx).candidates.length,0));
test('repeated identical fixture produces one candidate', () => assert.equal(evaluateBatch([fixture(),fixture()],ctx).candidates.length,1));
test('record id is stable per event; changed odds never become a second slot', () => { const a=record(),b=buildRecord(candidate(fixture(1,{odds:{odds1:1.9,oddsX:3.5,odds2:4.5}})),NOW);assert.equal(a.id,b.id);assert.notEqual(a.recordHash,b.recordHash); });
test('candidate and original match are not mutated', () => { const m=fixture(),copy=structuredClone(m);const c=candidate(m);buildRecord(c,NOW);assert.deepEqual(m,copy);assert.equal(Object.isFrozen(c.probabilities),false); });
test('published record is deeply frozen', () => {const r=record();assert.throws(()=>{r.probabilities['1']=.99;},TypeError);assert.ok(verifyRecord(r));});
test('changed probability, SP or direction invalidates record hash', () => {for(const x of [{tipCode:'2'},{odds:4.5},{probabilities:{'1':.9,X:.05,'2':.05}}])assert.equal(verifyRecord({...record(),...x}),false);});
test('one transaction inserts, re-reads and exposes real record objects', async () => {const db=memoryClient();const p=await persistPublishedForecasts(db,opts());assert.equal(p.current.length,2);assert.equal(p.evaluation.newlyPublished,2);assert.equal(p.summary.pending,2);assert.equal(p.summary.hitRate,null);assert.equal(db.forecasts.size,2);});
test('repeat run cannot rewrite published odds or probabilities', async () => {const db=memoryClient();await persistPublishedForecasts(db,opts());const before=structuredClone([...db.forecasts.values()]);await persistPublishedForecasts(db,opts({current:[fixture(1,{odds:{odds1:2,oddsX:3,odds2:4}})]}));assert.deepEqual([...db.forecasts.values()],before);assert.equal(db.calls.some(([s])=>/^UPDATE|^DELETE/.test(s)),false);});
test('read-back mismatch rejects publication rather than producing a fake success', async () => {const db=memoryClient(), original=db.query;let selects=0;db.query=async(s,a)=>s.startsWith('SELECT payload FROM football.published_forecasts') && ++selects===2?{rows:[]}:original(s,a);await assert.rejects(persistPublishedForecasts(db,opts()),/read-back/);});
test('crossing cutoff before publication exposes no record', async () => {const db=memoryClient();const p=await persistPublishedForecasts(db,opts({clock:()=>Date.parse('2026-09-17T14:00:00Z')}));assert.equal(p.current.length,0);});
test('crossing cutoff after insert signals transaction rollback requirement', async () => {const db=memoryClient();let calls=0;await assert.rejects(persistPublishedForecasts(db,opts({current:[fixture()],clock:()=>++calls===1?NOW:Date.parse('2026-09-17T14:00:00Z')})),{code:'FORECAST_CUTOFF_CROSSED'});});
test('official result settles frozen forecast without editing it', async () => {const db=memoryClient();await persistPublishedForecasts(db,opts({current:[fixture()]}));const prior=structuredClone([...db.forecasts.values()]);const result={...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0};const p=await persistPublishedForecasts(db,opts({current:[],history:[result],publishable:false,now:Date.parse('2026-09-17T18:00:00Z')}));assert.equal(p.summary.won,1);assert.equal(p.summary.hitRate,1);assert.equal(p.summary.scored,1);assert.deepEqual([...db.forecasts.values()],prior);});
test('untrusted or mismatched final cannot settle record', () => {for(const x of [{official:false},{eventVersion:'2026-09-18T15:00:00Z'},{homeTeamId:'other'}]){const rows=[{...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0,...x}];assert.equal(settlementFor(record(),indexResults(rows,validators),validators,NOW+9*3600000),null);} });
test('result cannot settle before original kickoff', () => {const rows=[{...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0}];assert.equal(settlementFor(record(),indexResults(rows,validators),validators,NOW),null);});
test('conflicting same-revision official scores become disputed, not first-row wins', () => {const a={...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0},b={...a,scoreHome:0,scoreAway:2};assert.equal(settlementFor(record(),indexResults([a,b],validators),validators,NOW+9*3600000).state,'DISPUTED');});
test('explicit higher revision resolves disputed score', () => {const a={...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0},b={...a,scoreHome:0,scoreAway:2,resultRevision:2};assert.equal(settlementFor(record(),indexResults([a,b],validators),validators,NOW+9*3600000).state,'LOST');});
test('VOID excluded from hit rate; empty cohort remains null', () => {assert.equal(summarize([]).hitRate,null);const s=summarize([{forecast:record(),settlement:{state:'VOID'}}]);assert.equal(s.settled,0);assert.equal(s.void,1);assert.equal(s.hitRate,null);});
test('Brier and log loss use frozen full vector', () => {const s=summarize([{forecast:record(),settlement:{state:'WON',actual:'1'}}]);assert.ok(Math.abs(s.brier-(.48**2+.28**2+.2**2))<1e-12);assert.ok(Math.abs(s.logLoss+Math.log(.52))<1e-12);});
for(const version of ['multi-factor-market-evidence-v2','multi-factor-dynamic-evidence-v3','multi-factor-dynamic-evidence-v4'])test(`legacy validated gate accepts compatible ${version} without losing source checks`,()=>{const pred={marketType:'BEST',oddsPoolCode:'HAD',tipCode:'1',recommendationAction:'recommend',recommendationTier:'formal',multiFactorEvidence:{version,eligible:true,market:'HAD',code:'1',handicapLine:0,odds:1.8,blockers:[]}};assert.equal(isOfficialRecommendationEligible(pred,1.8,0),true);assert.equal(isServerOfficialRecommendationEligible(pred,1.8,{officialSource:true,globalRiskTier:'shadow',officialHandicapLine:0}),false);assert.equal(isOfficialRecommendationEligible({...pred,recommendationTier:'reference'},1.8,0),false);});
