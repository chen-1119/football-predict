'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeRows}=require('../collectors/market/policy.cjs');
const {projectSignalRows,readMarketSignalRows}=require('../collectors/market/signalBridge.cjs');
const {mergeMarketSignal}=require('../scripts/sync500Data.cjs');
const time='2026-09-15T02:00:00Z';
function rows(){return normalizeRows([{keys:['12','2026-09-15:周二001'],signal:{sourceMatchId:'12',fixtureId:'34',homeTeamName:'Home',awayTeamName:'Away',kickoffTime:'2026-09-15T12:00:00Z',handicapLine:'-1',bookmakerOdds:{had:{odds1:1.8,oddsX:3.4,odds2:4.2},hhad:{odds1:3.1,oddsX:3.5,odds2:1.9}}}}],time).markets.map(m=>({payload:m.payload,updated_at:time}));}
test('shared enrichment keeps exact keys, separate pools and actual observation time',()=>{
 const input=rows();input[1].updated_at='2026-09-15T01:59:00Z';const result=projectSignalRows(input)[0];
 assert.deepEqual(result.keys,['12','2026-09-15:周二001']);assert.equal(result.signal.updatedAt,'2026-09-15T02:00:00.000Z');
 assert.equal(result.signal.bookmakerOdds.hhad.updatedAt,'2026-09-15T01:59:00.000Z');assert.equal(result.signal.handicapLine,'-1');assert.equal(result.signal.externalOdds.poolCode,'HAD');
 const merged=mergeMarketSignal({fiveHundred:{result:{score:'1-0'}}},result.signal);assert.equal(merged.fiveHundred.result.score,'1-0');
});
test('older event cannot donate an HHAD quote to a rescheduled match',()=>{
 const input=rows();input[0].payload.kickoffTime='2026-09-16T12:00:00Z';input[0].updated_at='2026-09-15T02:01:00Z';
 const result=projectSignalRows(input)[0];assert.equal(result.signal.kickoffTime,'2026-09-16T12:00:00Z');assert.equal(result.signal.bookmakerOdds.hhad,undefined);
});
test('empty acquisition fails without manufacturing a fresh source snapshot',async()=>{
 await assert.rejects(readMarketSignalRows({query:async()=>({rows:[]})}),{code:'MARKET_BRIDGE_EMPTY'});
});
