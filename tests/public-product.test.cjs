const {test}=require('node:test'),assert=require('node:assert/strict');
const {publicFixture,publicOverview}=require('../server/publicProduct.cjs');
test('public fixture allowlist excludes nested predictions, evidence and accidental new fields',()=>{
 const source={id:'sporttery_1',homeTeamName:'A',awayTeamName:'B',predictions:[{secret:'premium'}],probabilityModel:{secret:'private'},externalSignals:{cookie:'private'},unexpected:'private',odds:{home:1.8,draw:3.2,away:4.1,secret:'private'}};
 const before=JSON.stringify(source),row=publicFixture(source);
 assert.equal(row.homeTeamName,'A');assert.equal(row.odds.home,1.8);assert(!JSON.stringify(row).includes('private'));assert(!JSON.stringify(row).includes('premium'));assert.equal(JSON.stringify(source),before);
});
test('public example is the latest eligible settled record regardless of winning result',()=>{
 const record=(id,time,state)=>({decision:{decisionId:id,matchId:'sporttery_'+id,homeTeamName:'A',awayTeamName:'B',publishedAt:time,cutoffTime:'2026-09-22T12:00:00Z',tipCode:'1',inputEvidence:{secret:'private'}},settlement:{state,score:'0:1',resultEventId:id}});
 const center={review:{singles:[record('earlier','2026-09-21T12:00:00Z','WON'),record('latest','2026-09-22T11:00:00Z','LOST'),record('pending','2026-09-22T11:30:00Z','PENDING'),record('late','2026-09-22T12:01:00Z','WON')],statistics:{single:{published:4,settled:2,won:1,pending:1}}}};
 const output=publicOverview({rows:[],stale:true},center,Date.parse('2026-09-22T01:00:00Z'));
 assert.equal(output.review.example.decisionId,'latest');assert.equal(output.review.example.state,'LOST');assert.equal(output.review.summary.hitRate,0.5);assert(!JSON.stringify(output).includes('private'));assert.equal(output.businessDate,'2026-09-22');
});
test('missing summary remains unavailable rather than fabricated zero results',()=>{
 const output=publicOverview({rows:[]},null);assert.equal(output.review.summary,null);assert.equal(output.review.example,null);assert.equal(output.stale,true);
});
test('public fixture preserves native odds1 oddsX odds2 without generating missing quotes',()=>{
 const row=publicFixture({id:'sporttery_42',odds:{odds1:1.92,oddsX:3.8,odds2:null}});
 assert.deepEqual(row.odds,{home:1.92,draw:3.8,away:null});
});
