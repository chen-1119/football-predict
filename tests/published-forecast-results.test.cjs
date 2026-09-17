'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {persistPublishedForecasts}=require('../scripts/publishedForecastLedger.cjs');
const NOW=Date.parse('2026-09-17T10:00:00Z');
const fixture=()=>({id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-17',status:'SCHEDULED',kickoffTime:'2026-09-17T15:00:00Z',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',probabilityModel:{generatedAt:'2026-09-17T10:00:00Z',oneXTwo:{final:{home:60,draw:25,away:15}}},odds:{odds1:1.8,oddsX:3.3,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:'2026-09-17T10:00:00Z'});
const opts=(extra={})=>({now:NOW,current:[fixture()],history:[],publishable:true,publication:{generationId:'g',manifestHash:'a'.repeat(64)},validators:{isFinal:r=>r.official===true&&r.status==='FINISHED',isVoid:r=>r.official===true&&r.resultDisposition==='VOID'},...extra});
function memoryClient(){
 const forecasts=new Map(),results=new Map(),calls=[];
 return {calls,async query(sql,args=[]){
  calls.push([sql,args]);
  if(sql.startsWith('SELECT payload FROM football.published_forecasts'))return {rows:[...forecasts.values()].map(payload=>({payload:structuredClone(payload)}))};
  if(sql.startsWith('INSERT INTO football.published_forecasts')){if(forecasts.has(args[0]))return {rows:[]};const payload=JSON.parse(args[8]);forecasts.set(args[0],payload);return {rows:[{payload}]};}
  if(sql.startsWith('SELECT DISTINCT ON'))return {rows:[...results.entries()].map(([forecast_id,payload])=>({forecast_id,payload}))};
  if(sql.startsWith('INSERT INTO football.published_forecast_results')){results.set(args[1],JSON.parse(args[5]));return {rows:[]};}
  throw new Error('Unexpected SQL');
 }};
}
test('result returning to a previous state appends a new event rather than reusing an old id', async () => {
  const db=memoryClient(); await persistPublishedForecasts(db,opts({current:[fixture()]}));
  const final={...fixture(),status:'FINISHED',official:true,scoreHome:2,scoreAway:0};
  const base=opts({current:[],publishable:false,now:NOW+9*3600000});
  await persistPublishedForecasts(db,{...base,history:[final]});
  await persistPublishedForecasts(db,{...base,history:[final,{...final,scoreHome:0,scoreAway:2}]});
  const p=await persistPublishedForecasts(db,{...base,history:[final]});
  const ids=db.calls.filter(([s])=>s.startsWith('INSERT INTO football.published_forecast_results')).map(([,a])=>a[0]);
  assert.equal(ids.length,3); assert.equal(new Set(ids).size,3); assert.equal(p.summary.won,1);
  await persistPublishedForecasts(db,{...base,history:[final]});
  assert.equal(db.calls.filter(([s])=>s.startsWith('INSERT INTO football.published_forecast_results')).length,3);
});
