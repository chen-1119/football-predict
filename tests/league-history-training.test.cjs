'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHistory,url}=require('../scripts/collectLeagueTextHistory.cjs');
const {fit,projection,metrics,experiment}=require('../scripts/runLeagueBaselineExperiment.cjs');
const parse=(text,extra={})=>parseHistory(Buffer.from('= Finland Veikkausliiga 2025\n'+text),{league:'fi1',season:2025,receivedAt:'2026-10-08T12:00:00.000Z',...extra});
test('date inheritance, unicode identities and ordinary full time are retained',()=>{
  const p=parse('  Sat Apr 5 2025\n  15:00  HJK Helsinki  v SJK Seinäjoki  3-2 (1-2)\n  AC Oulu  v Vaasan PS  0-0');
  assert.equal(p.rows.length,2);assert.equal(p.rows[0].away,'SJK Seinäjoki');assert.equal(p.rows[0].homeGoals,3);
  assert.equal(p.rows[1].date,'2025-04-05');assert.equal(p.rows[0].historicalKnownAt,null);assert.equal(p.rows[0].knownAt,'2026-10-08T12:00:00.000Z');
});
test('penalties, extra time and unknown scores are quarantined',()=>{
  const p=parse('Sat Apr 5\n A  v B  1-1\n C  v D  2-1 a.e.t.\n E  v F  -\n G  v H  1-1 (4-3 pen.)');
  assert.equal(p.rows.length,1);assert.equal(p.excluded.length,3);
});
test('playoff rows cannot enter ordinary league fit',()=>{
  const p=parse('Sat Apr 5\n A  v B  1-1\n▪ ECL Playoff\nSun Apr 6\n C  v D  2-1');
  assert.equal(p.rows.length,1);assert.equal(p.excluded[0].reason,'excluded-playoff');
});
test('duplicate rows fail instead of inflating samples',()=>assert.throws(()=>parse('Sat Apr 5\n A  v B  1-1\n A  v B  1-1'),/duplicate/));
test('impossible calendar and missing date fail',()=>{
  assert.throws(()=>parse('Sat Feb 30\n A  v B  1-1'),/date/);
  assert.throws(()=>parse(' A  v B  1-1'),/date/);
});
test('invalid half time is rejected',()=>assert.throws(()=>parse('Sat Apr 5\n A  v B  1-1 (2-0)'),/score/));
test('same-day and future results cannot become training labels',()=>{
  const p=parse('Fri Apr 4\n A  v B  1-1\nSat Apr 5\n C  v D  2-1',{receivedAt:'2025-04-05T22:00:00.000Z'});
  assert.equal(p.rows.length,1);assert.equal(p.excluded[0].reason,'same-day-or-future-score');
});
test('unknown source paths and wrong season are rejected',()=>{
  assert.throws(()=>url('europe','0bf83f88e8feb22904c5f9d93c6407574c1347e0','../secrets'),/allowlisted/);
  assert.throws(()=>parse('Sat Apr 5\n A  v B  1-1',{season:2024}),/identity/);
});
function synthetic(){return [2023,2024,2025].flatMap(year=>Array.from({length:110},(_,i)=>{
  const date=new Date(Date.UTC(year,0,1+i)).toISOString().slice(0,10);
  return {id:`${year}-${i}`,league:'fi1',date,home:i%2?'A':'B',away:i%2?'B':'A',homeGoals:i%3?2:0,awayGoals:i%5?1:0};
}));}
test('probabilities normalize and cold starts stay explicit',()=>{
  const model=fit(synthetic().slice(0,110),.05),p=projection(model,'A','B',.5);
  assert.ok(Math.abs(Object.values(p.probabilities).reduce((a,b)=>a+b,0)-1)<1e-10);
  assert.ok(Object.values(p.probabilities).every(x=>x>0&&x<1));assert.equal(projection(model,'new','B',.5).coldStart,true);
  assert.throws(()=>projection(model,'A','B',2),/mixture/);
});
test('test label changes never change chosen parameters or holdout model',()=>{
  const rows=synthetic(),a=experiment(rows),b=experiment(rows.map(r=>r.date.startsWith('2025')?{...r,homeGoals:6,awayGoals:0}:r));
  assert.deepEqual(a.reports[0].selection,b.reports[0].selection);assert.deepEqual(a.reports[0].holdoutModel,b.reports[0].holdoutModel);
  assert.notDeepEqual(a.reports[0].evaluation,b.reports[0].evaluation);assert.equal(a.formalEligible,false);assert.equal(a.prospectiveValidated,false);
});
test('empty test has null metrics, not zero accuracy',()=>assert.equal(metrics([],fit(synthetic().slice(0,110),.05),.5).accuracy,null));
test('mixed leagues, duplicate input and short windows fail',()=>{
  const rows=synthetic();assert.throws(()=>fit([...rows,{...rows[0],league:'br1'}],.05),/one league/);
  assert.throws(()=>experiment([...rows,rows[0]]),/duplicate/);assert.equal(experiment(rows.slice(0,110)).reports[0].status,'blocked');
});
test('later seasons do not change held-out selection or evaluation',()=>{
  const rows=synthetic(),a=experiment(rows),later=rows.slice(0,100).map((r,i)=>({...r,id:`2026-${i}`,date:r.date.replace('2023','2026'),homeGoals:5,awayGoals:0}));
  const b=experiment([...rows,...later]);assert.deepEqual(a.reports[0].evaluation,b.reports[0].evaluation);
  assert.deepEqual(a.reports[0].selection,b.reports[0].selection);assert.notDeepEqual(a.reports[0].forwardCandidate,b.reports[0].forwardCandidate);
});
test('training is deterministic and centered without changing rate intercepts',()=>{
  const rows=synthetic().slice(0,110),a=fit(rows,.05),b=fit([...rows],.05);assert.deepEqual(a,b);
  assert.ok(Math.abs(a.poisson.attack.reduce((x,y)=>x+y,0))<1e-8);assert.ok(Math.abs(a.poisson.defense.reduce((x,y)=>x+y,0))<1e-8);
  assert.equal(a.poisson.converged,true);
});
