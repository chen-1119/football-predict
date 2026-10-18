'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {attachProspectiveForecastInputs,forecastInputFor}=require('../src/services/prospectiveForecastInput.cjs');
const {evaluateForecast}=require('../src/services/publishedForecastPolicy.cjs');
const {independentCandidate,normalizeProbabilityTriplet}=require('../scripts/independentComboSelection.cjs');
const now=Date.parse('2026-09-17T10:00:00Z'),publication={generationId:'test',manifestHash:'a'.repeat(64)};
const fresh={id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-17',status:'SCHEDULED',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',kickoffTime:'2026-09-18T03:00:00+08:00',buyEndTime:'2026-09-17 22:00:00',oddsSource:'sporttery:HAD',oddsReceivedAt:'2026-09-17T10:00:00Z',odds:{odds1:1.8,oddsX:3.2,odds2:4.5},probabilityModel:{generatedAt:'2026-09-17T10:00:00Z',oneXTwo:{final:{home:60,draw:25,away:15}}}};
const old={...fresh,probabilityModel:{...fresh.probabilityModel,generatedAt:'2026-09-16T01:00:00Z'}};
test('fresh model atom supports new publications without rewriting frozen display',()=>{const [out]=attachProspectiveForecastInputs([old],[fresh],now);assert.deepEqual(out.probabilityModel,old.probabilityModel);assert.equal(evaluateForecast(old,{now,publication}).eligible,false);assert.equal(evaluateForecast(out,{now,publication}).eligible,true);assert.ok(independentCandidate(out,now));assert.notEqual(out.prospectiveForecastInput.probabilityModel,fresh.probabilityModel);});
test('no fresh source, mismatched event or duplicate source cannot mint a model clock',()=>{for(const rows of [[],[{...fresh,homeTeamId:'other'}],[fresh,fresh]])assert.equal(attachProspectiveForecastInputs([old],rows,now)[0].prospectiveForecastInput,null);});
test('post-cutoff or future computation cannot become prospective input',()=>{assert.equal(attachProspectiveForecastInputs([old],[fresh],Date.parse('2026-09-17T14:00:00Z'))[0].prospectiveForecastInput,null);assert.equal(attachProspectiveForecastInputs([old],[fresh],now-1)[0].prospectiveForecastInput,null);});
test('current suspension or changed cutoff cannot reuse an earlier market atom',()=>{const [out]=attachProspectiveForecastInputs([old],[fresh],now);assert.equal(forecastInputFor({...out,status:'LIVE'}),null);assert.equal(forecastInputFor({...out,buyEndTime:'2026-09-17 18:00:00'}),null);});
test('quote evidence hash changes when actual observation time changes',()=>{const a=independentCandidate(fresh,now),b=independentCandidate({...fresh,oddsReceivedAt:'2026-09-17T09:59:00Z'},now);assert.notEqual(a.quoteHash,b.quoteHash);});
test('rounded combo probabilities normalize to one',()=>{const p=normalizeProbabilityTriplet({home:33.3,draw:33.3,away:33.3});assert.ok(Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)<1e-12);});
test('new sale suspension rejects a previously valid prospective atom',()=>{const [out]=attachProspectiveForecastInputs([old],[fresh],now);assert.equal(forecastInputFor({...out,isOnSale:false}),null);assert.equal(forecastInputFor({...out,resultDisposition:'VOID'}),null);});

test('an omitted current sale deadline survives raw enrichment before prospective model construction',()=>{
 const {enrichRawMatchWithPredictionSnapshot}=require('../scripts/syncData.cjs');
 const raw={...fresh,homeTeam:fresh.homeTeamName,awayTeam:fresh.awayTeamName,buyEndTime:''};
 const rawBefore=structuredClone(raw),oldBefore=structuredClone(old);
 const enriched=enrichRawMatchWithPredictionSnapshot(raw,new Map([[fresh.sourceMatchId,old]]),[]);
 assert.equal(enriched.buyEndTime,old.buyEndTime);
 const [out]=attachProspectiveForecastInputs([old],[{...fresh,buyEndTime:enriched.buyEndTime}],now);
 assert.equal(out.prospectiveForecastInput.buyEndTime,old.buyEndTime);
 assert.equal(forecastInputFor(out).buyEndTime,old.buyEndTime);
 const {quoteInput}=require('../src/services/prdPaperRecommendation.cjs');
 assert.equal(quoteInput(out).buyEndTime,old.buyEndTime);
 const missing=structuredClone(out);delete missing.prospectiveForecastInput.buyEndTime;
 assert.equal(quoteInput(missing),null,'the publisher must still reject the original outer/nested mismatch');
 assert.deepEqual(raw,rawBefore);assert.deepEqual(old,oldBefore);
 assert.equal(out.probabilityModel.generatedAt,old.probabilityModel.generatedAt);
 assert.equal(out.prospectiveForecastInput.probabilityModel.generatedAt,fresh.probabilityModel.generatedAt);
});

test('deadline inheritance rejects another fixture, team order, day or invalid deadline and preserves explicit current values',()=>{
 const {enrichRawMatchWithPredictionSnapshot}=require('../scripts/syncData.cjs');
 const raw={...fresh,homeTeam:fresh.homeTeamName,awayTeam:fresh.awayTeamName,buyEndTime:''};
 for(const patch of [
  {sourceMatchId:'different'}, {homeTeamName:'Other'}, {awayTeamName:'Other'},
  {homeTeamName:fresh.awayTeamName,awayTeamName:fresh.homeTeamName},
  {businessDate:'2026-09-16'}, {businessDate:undefined},
  {kickoffTime:'2026-09-19T03:00:00+08:00'},
  {buyEndTime:'invalid'}, {buyEndTime:'2026-09-01 22:00:00'},
 ]){
  const previous={...old,...patch};
  assert.equal(enrichRawMatchWithPredictionSnapshot(raw,new Map([[fresh.sourceMatchId,previous]]),[]).buyEndTime,'');
 }
 for(const buyEndTime of ['2026-09-17 21:00:00','invalid']){
  assert.equal(enrichRawMatchWithPredictionSnapshot({...raw,buyEndTime},new Map([[fresh.sourceMatchId,old]]),[]).buyEndTime,buyEndTime);
 }
 const expired={...old,buyEndTime:'2026-09-17 17:00:00'};
 const enriched=enrichRawMatchWithPredictionSnapshot(raw,new Map([[fresh.sourceMatchId,expired]]),[]);
 assert.equal(enriched.buyEndTime,expired.buyEndTime);
 assert.equal(attachProspectiveForecastInputs([expired],[{...fresh,buyEndTime:enriched.buyEndTime}],now)[0].prospectiveForecastInput,null,
  'retaining a deadline never extends the sales window');
});

test('deadline inheritance cannot mask an earlier or invalid current or retained cutoff',()=>{
 const {enrichRawMatchWithPredictionSnapshot}=require('../scripts/syncData.cjs');
 const raw={...fresh,homeTeam:fresh.homeTeamName,awayTeam:fresh.awayTeamName,buyEndTime:''};
 for(const patch of [
  {cutoffAt:'2026-09-17T13:00:00Z'}, {cutoffTime:'2026-09-17 21:00:00'},
  {predictionMeta:{cutoffTime:'2026-09-17T13:00:00Z'}},
  {externalSignals:{buyEndTime:'2026-09-17 21:00:00'}},
  {externalSignals:{sale:{buyEndTime:'2026-09-17 21:00:00'}}},
  {externalSignals:{fiveHundred:{sale:{buyEndTime:'2026-09-17 21:00:00'}}}},
  {cutoffAt:'invalid'}, {externalSignals:{buyEndTime:'invalid'}},
 ])assert.equal(enrichRawMatchWithPredictionSnapshot({...raw,...patch},new Map([[fresh.sourceMatchId,old]]),[]).buyEndTime,'');
 for(const patch of [
  {cutoffAt:'2026-09-17T13:00:00Z'}, {cutoffTime:'invalid'},
  {predictionMeta:{cutoffTime:'2026-09-17 21:00:00'}},
  {buyEndTime:'2026-09-18 03:10:00'},
 ])assert.equal(enrichRawMatchWithPredictionSnapshot(raw,new Map([[fresh.sourceMatchId,{...old,...patch}]]),[]).buyEndTime,'');
 const later={...raw,cutoffAt:'2026-09-17T14:30:00Z',externalSignals:{buyEndTime:old.buyEndTime}};
 assert.equal(enrichRawMatchWithPredictionSnapshot(later,new Map([[fresh.sourceMatchId,old]]),[]).buyEndTime,old.buyEndTime);
});
