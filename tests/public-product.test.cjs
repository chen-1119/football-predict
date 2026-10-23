const {test}=require('node:test'),assert=require('node:assert/strict');
const {publicFixture,publicOverview}=require('../server/publicProduct.cjs');
const {publicOfficialCurrent}=require('../server/publicProduct.cjs');
const signedFixture=require('./fixtures/reviewed-official-event.cjs');
const {project}=require('../server/officialScheduleRead.cjs');
const {resolvePublicScheduleIdentity}=require('../server/publicProduct.cjs');

test('shared public detail and follow resolver keeps historical identity and prefers rescheduled signed facts',async()=>{
 const input=signedFixture.setup(),view=project(input.snapshot,input.draft.businessDate,{now:signedFixture.NOW,trustRegistry:input.trustRegistry});
 const signed=publicOfficialCurrent(view,signedFixture.NOW).rows[0],id=signed.id;
 const native={...signed,id:`sporttery_${signed.sourceMatchId}`,homeTeamId:'team_home',awayTeamId:'team_away',eventVersion:signed.kickoffTime,predictions:[{private:true}]};
 const resolve=(row,official=view,now=signedFixture.NOW)=>resolvePublicScheduleIdentity(id,{readNative:async key=>{assert.equal(key,native.id);return row;},readOfficial:async day=>{assert.equal(day,input.draft.businessDate);if(official===null)throw Error('unavailable');return official;},now});
 assert.deepEqual(await resolve(native),{...native,id});
 const historic=await resolve(native,null,signedFixture.NOW+86400000);
 assert.equal(historic.id,id);assert.equal(historic.homeTeamId,'team_home');assert(!JSON.stringify(publicFixture(historic)).includes('private'));
 for(const patch of [{businessDate:'2026-01-01'},{sourceMatchId:'999'},{eventVersion:'2026-01-01T00:00:00Z'},
  {kickoffTime:'2026-01-01T00:00:00Z',eventVersion:'2026-01-01T00:00:00Z'},
  {homeTeamName:native.awayTeamName,awayTeamName:native.homeTeamName}])assert.deepEqual(await resolve({...native,...patch}),signed);
 for(const patch of [{businessDate:'2026-01-01'},{sourceMatchId:'999'},{kickoffTime:'invalid'},{eventVersion:'2026-01-01T00:00:00Z'}])assert.equal(await resolve({...native,...patch},null),null);
 assert.equal(await resolve(null,null),null);
});

test('public fixtures use verified current-day official facts without copying paid content or inventing HHAD as HAD',()=>{
 const input=signedFixture.setup(),before=JSON.stringify(input);
 const view=project(input.snapshot,input.draft.businessDate,{now:signedFixture.NOW,trustRegistry:input.trustRegistry});
 const current=publicOfficialCurrent(view,signedFixture.NOW),output=publicOverview(current,null,signedFixture.NOW);
 assert.equal(output.stale,false);assert.equal(output.sourceUpdatedAt,view.sourceReceivedAt);
 assert.equal(output.matches.length,view.events.length);
 assert.equal(output.matches[0].id,`schedule_${view.businessDate.replaceAll('-','')}_${view.events[0].eventId}`);
 assert.equal(output.matches[0].homeTeamName,view.events[0].homeTeamName);
 assert.equal(output.matches[0].sourceUpdatedAt,view.quoteReceivedAt);
 assert.equal(output.matches[0].odds.home,1.8);
 assert.equal(output.matches[0].saleState,view.events[0].saleState);
 assert.equal(JSON.stringify(input),before);
 const onlyHandicap=structuredClone(view);onlyHandicap.events[0].markets=onlyHandicap.events[0].markets.filter(m=>m.poolCode==='HHAD');
 assert.deepEqual(publicOfficialCurrent(onlyHandicap,signedFixture.NOW).rows[0].odds,{home:null,draw:null,away:null});
 for(const key of ['predictions','scores','modelProbability','collectorAttestation','originalArchive'])assert(!JSON.stringify(output).includes(`"${key}"`));
});

test('verified stopped market remains explicitly closed even before kickoff with fresh prices',()=>{
 const input=signedFixture.setup();
 for(const endpoint of input.snapshot.endpoints){endpoint.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;signedFixture.resign(endpoint,input.pair);}
 const view=project(input.snapshot,input.draft.businessDate,{now:signedFixture.NOW,trustRegistry:input.trustRegistry});
 const row=publicOverview(publicOfficialCurrent(view,signedFixture.NOW),null,signedFixture.NOW).matches[0];
 assert.equal(row.saleState,'closed');assert.equal(row.status,'SCHEDULED');assert.equal(row.quoteStatus,'recent');
});

test('official public adapter refuses expired, wrong-day and unverified views; an empty verified day stays empty',()=>{
 const input=signedFixture.setup(),view=project(input.snapshot,input.draft.businessDate,{now:signedFixture.NOW,trustRegistry:input.trustRegistry});
 assert.throws(()=>publicOfficialCurrent(view,signedFixture.NOW+900001));
 for(const patch of [{businessDate:'2026-01-01'},{sourceSignatureVerified:false},{recommendationEligibilityVerified:true}])assert.throws(()=>publicOfficialCurrent({...view,...patch},signedFixture.NOW));
 assert.deepEqual(publicOfficialCurrent({...view,events:[]},signedFixture.NOW).rows,[]);
});

test('old fixture snapshot cannot borrow fresh review or quote clocks to remain healthy',()=>{
 const now=Date.parse('2026-10-22T18:03:13.526Z');
 const current={stale:false,sourceUpdatedAt:'2026-10-18T09:52:59.055Z',rows:[{id:'sporttery_saved',businessDate:'2026-10-18',odds:{home:1.8,draw:3.2,away:4},oddsUpdatedAt:new Date(now).toISOString()}]};
 const payload={resultAsOf:new Date(now).toISOString(),review:{singles:[],statistics:{}}};
 const before=JSON.stringify({current,payload}),output=publicOverview(current,payload,now);
 assert.equal(output.stale,true);
 assert.equal(output.sourceUpdatedAt,current.sourceUpdatedAt);
 assert.equal(output.businessDate,'2026-10-23');
 assert.equal(output.matches[0].businessDate,'2026-10-18');
 assert.equal(JSON.stringify({current,payload}),before);
});

test('fixture freshness needs a valid source clock and cannot clear an upstream stale flag',()=>{
 const now=Date.parse('2026-10-23T01:00:00Z');
 const overview=(clock,stale=false,limit)=>publicOverview({sourceUpdatedAt:clock,stale,rows:[]},null,now,limit);
 for(const clock of [undefined,null,'invalid','',new Date(now+1).toISOString()])assert.equal(overview(clock).stale,true);
 assert.equal(overview(new Date(now-20*60000).toISOString()).stale,false);
 assert.equal(overview(new Date(now-20*60000-1).toISOString()).stale,true);
 assert.equal(overview(new Date(now).toISOString(),true).stale,true);
 assert.equal(overview(new Date(now).toISOString(),null).stale,true);
 assert.equal(overview(new Date(now-60001).toISOString(),false,60000).stale,true);
 assert.equal(overview(new Date(now-60000).toISOString(),false,60000).stale,false);
 for(const limit of [NaN,Infinity,0,-1])assert.equal(overview(new Date(now).toISOString(),false,limit).stale,true);
});
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
 assert.equal(row.quoteStatus,'missing');
});
test('complete fixture prices without their own clock are available but time-unverified',()=>{
 const row=publicFixture({id:'sporttery_43',odds:{odds1:1.92,oddsX:3.8,odds2:4.4},sourceObservedAt:'2026-09-23T05:59:00Z',predictionMeta:{updatedAt:'2026-09-23T05:58:00Z'}});
 assert.deepEqual(row.odds,{home:1.92,draw:3.8,away:4.4});
 assert.equal(row.sourceUpdatedAt,null);
 assert.equal(row.quoteStatus,'unverified');
 assert.equal(row.predictionMeta,undefined);
});
test('fixture quote timestamp never borrows the fixture scrape clock or frozen recommendation price',()=>{
 const now=Date.parse('2026-09-23T06:00:00Z');
 const match={id:'sporttery_2041645',status:'SCHEDULED',kickoffTime:'2026-09-23T07:00:00Z',odds:{odds1:1.85,oddsX:3.4,odds2:4.5},oddsUpdatedAt:'2026-09-20T10:00:00Z',sourceObservedAt:'2026-09-23T05:59:00Z'};
 const center={current:[{decision:{matchId:match.id,quoteOdds:{'1':1.92,X:3.3,'2':4.2},quoteObservedAt:'2026-09-23T05:29:00Z'}}],review:{singles:[],statistics:{}}};
 const row=publicOverview({rows:[match],stale:false},{recommendationCenter:center},now).matches[0];
 assert.deepEqual(row.odds,{home:1.85,draw:3.4,away:4.5});
 assert.equal(row.sourceUpdatedAt,match.oddsUpdatedAt);
 assert.equal(row.quoteStatus,'expired');
 assert.equal(row.decisionId,undefined);
 assert.equal(publicFixture(match,Date.parse(match.kickoffTime)).quoteStatus,'archived');
});
