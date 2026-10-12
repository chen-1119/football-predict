'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const iconv=require('iconv-lite');
const adapter=require('../scripts/prematchAsianHandicapCollectionAdapter.cjs');
const fixture={sourceMatchId:'101',fixtureId:'201',homeTeamId:'301',awayTeamId:'401',kickoffTime:'2026-10-06T19:00:00+08:00'};
const landing=`<tr class="bet-tb-tr" data-id="101" data-fixtureid="201" data-homeid="301" data-awayid="401" data-homesxname="Synthetic Home" data-awaysxname="Synthetic Away" data-matchdate="2026-10-06" data-matchtime="19:00"><td><a href="https://odds.500.com/fenxi/yazhi-201.shtml">亚</a></td></tr>`;
const table=`<table><tr class="tr1" xls="row"><td class="tb_plgs" title="Synthetic Company">Synthetic</td><td width="58">0.91</td><td ref="0.5">半球</td><td width="58">0.97</td><td width="58">0.95</td><td ref="0.25">平手/半球</td><td width="58">0.93</td></tr></table>`;
const clock='2026-10-06T06:00:00.123456789Z';
function page(url,html,statusCode=200){
  const body=iconv.encode(html,'gbk');
  return {url,body,statusCode,startedAt:clock,receivedAt:clock,bytes:body.length,
    rawPayloadHash:createHash('sha256').update(body).digest('hex'),rawBase64:body.toString('base64')};
}
test('only exact public landing and AH paths can be requested',()=>{
  assert.equal(adapter.allowedUrl(adapter.LANDING_URL),adapter.LANDING_URL);
  for(const url of ['http://odds.500.com/fenxi/yazhi-201.shtml','https://odds.500.com/fenxi/yazhi-201.shtml?x=1',
    'https://user:password@odds.500.com/fenxi/yazhi-201.shtml','https://odds.500.com.evil/fenxi/yazhi-201.shtml',
    'https://odds.500.com/fenxi/shuju-201.shtml']) assert.throws(()=>adapter.allowedUrl(url),/AH_SOURCE_URL_REJECTED/);
});
test('linked fixture identity is parsed without replacing source identifiers',()=>{
  assert.deepEqual(adapter.parseTradeFixtures(landing),[{...fixture,infoMatchId:null,homeTeamName:'Synthetic Home',
    awayTeamName:'Synthetic Away',asianHandicapUrl:'https://odds.500.com/fenxi/yazhi-201.shtml'}]);
  assert.equal(adapter.parseTradeFixtures(landing.replace('yazhi-201','yazhi-202')).length,0);
});
test('conflicting same-ID fixtures stop collection rather than choosing a row',()=>{
  assert.throws(()=>adapter.parseTradeFixtures(landing+landing.replace('data-homeid="301"','data-homeid="302"')),/AH_FIXTURE_CONFLICT/);
});
test('a HTTP 200 challenge is blocked, never an available AH page',()=>{
  const html='<script>document.cookie="__tst_status=0";setTimeout("location.reload()",1200)</script>';
  assert.deepEqual(adapter.parseAsianHandicapFacts(html),{state:'blocked',reason:'source-security-challenge',rows:[]});
  assert.equal(adapter.captureState(page('https://odds.500.com/fenxi/yazhi-201.shtml',html),'asian').capture.state,'blocked');
});
test('current and initial water values stay partial without guessing convention or clock',()=>{
  const facts=adapter.parseAsianHandicapFacts(table);
  assert.equal(facts.state,'partial'); assert.equal(facts.rows.length,1);
  assert.equal(facts.rows[0].current.rawHomeWater,0.91);
  assert.equal(facts.rows[0].initial.pageRefValue,0.25);
  for(const field of ['oddsFormat','providerObservedAt','homeLineConvention']) assert.equal(facts.rows[0][field],null);
  assert.equal(facts.rows[0].completeTimeline,false);
});
test('kickoff mismatch cannot silently map another event',async()=>{
  let calls=0;
  const result=await adapter.collectAsianHandicapPages({input:{matches:[{...fixture,kickoffTime:'2026-10-07T19:00:00+08:00'}]},now:()=>clock,
    fetch:async url=>{calls++;return page(url,landing);}});
  assert.equal(calls,1);assert.equal(result.fixtures[0].reason,'fixture-kickoff-conflict');
  assert.deepEqual(result.asianHandicapObservations,[]);
});
test('source failure keeps raw response and reports blocked; it cannot renew evidence',async()=>{
  const challenge='<html>Security Verification captcha.eo.gtimg.com</html>';
  const result=await adapter.collectAsianHandicapPages({input:{matches:[fixture]},now:()=>clock,
    fetch:async url=>page(url,url===adapter.LANDING_URL?landing:challenge)});
  assert.equal(result.summary.matchedFixtures,1); assert.equal(result.summary.blocked,1);
  assert.equal(result.captures.length,2);assert.equal(Buffer.from(result.captures[1].rawBase64,'base64').toString(),challenge);
  assert.equal(result.summary.eligibleV3Observations,0); assert.deepEqual(result.asianHandicapObservations,[]);
  assert.equal(result.productionWrites,0); assert.equal(result.formalEligible,false);
});
test('two-state page does not become a full history or an officially timed opening',async()=>{
  const result=await adapter.collectAsianHandicapPages({input:{matches:[fixture]},now:()=>clock,
    fetch:async url=>page(url,url===adapter.LANDING_URL?landing:table)});
  assert.equal(result.summary.capturedCurrentInitial,1);assert.equal(result.completeTimeline,false);
  assert.deepEqual(result.asianHandicapObservations,[]);
  assert.equal(result.fixtures[0].rows[0].providerObservedAt,null);
});
test('PG team IDs remain separate from provider IDs until a sourced entity mapping exists',async()=>{
  const result=await adapter.collectAsianHandicapPages({input:{matches:[{...fixture,homeTeamId:'team_internal_home'}]},now:()=>clock,
    fetch:async url=>page(url,url===adapter.LANDING_URL?landing:table)});
  assert.equal(result.fixtures[0].homeTeamId,'301');
  assert.equal(result.fixtures[0].targetIdentity.homeTeamId,'team_internal_home');
  assert.equal(result.fixtures[0].eventBinding.teamIdentityVerified,false);
  assert.deepEqual(result.asianHandicapObservations,[]);
});
test('replacement characters in a fixture row are excluded; unrelated bad widgets stay partial',()=>{
  assert.equal(adapter.parseTradeFixtures(landing.replace('Synthetic Home','Synthetic\uFFFD Home')).length,0);
  assert.equal(adapter.parseTradeFixtures('<input value="bad\uFFFD widget">'+landing).length,1);
});
test('after one source block other same-host detail requests are skipped',async()=>{
  let calls=0;
  const landing2=landing.replaceAll('101','102').replaceAll('201','202');
  const result=await adapter.collectAsianHandicapPages({input:{matches:[fixture,{...fixture,sourceMatchId:'102',fixtureId:'202'}]},now:()=>clock,
    fetch:async url=>{calls++;return page(url,url===adapter.LANDING_URL?landing+landing2:'Security Verification');}});
  assert.equal(calls,2);assert.equal(result.summary.skippedAfterBlocked,1);
  assert.equal(result.fixtures[1].requestSkipped,true);
});
function transport(response, {statusCode=200,headers={},clockValues=[clock,clock]}={}){
  let destroyed=false,index=0;
  const request=(url,options,callback)=>{
    assert.equal(options.method,'GET');assert.equal(Object.hasOwn(options.headers,'Cookie'),false);
    const req=new EventEmitter();req.destroy=()=>{destroyed=true;};
    req.end=()=>queueMicrotask(()=>{
      const res=new EventEmitter();res.statusCode=statusCode;res.headers=headers;res.complete=true;res.destroy=()=>{};
      callback(res);res.emit('data',Buffer.from(response));res.emit('end');
    });return req;
  };
  return {request,now:()=>clockValues[Math.min(index++,clockValues.length-1)],destroyed:()=>destroyed};
}
test('bounded transport captures literal raw bytes and explicit nanosecond receipt clock',async()=>{
  const mocked=transport('plain response');
  const result=await adapter.fetchPage('https://odds.500.com/fenxi/yazhi-201.shtml',mocked);
  assert.equal(result.receivedAt,clock);assert.equal(result.bytes,14);
  assert.equal(result.rawPayloadHash,createHash('sha256').update('plain response').digest('hex'));
});
test('redirect responses are captured and not followed',async()=>{
  const mocked=transport('redirect',{statusCode:302,headers:{location:'https://example.org'}});
  const response=await adapter.fetchPage('https://odds.500.com/fenxi/yazhi-201.shtml',mocked);
  assert.equal(adapter.captureState(response,'asian').capture.reason,'source-http-302');
});
test('over-budget and backward receipt clocks fail closed',async()=>{
  await assert.rejects(adapter.fetchPage('https://odds.500.com/fenxi/yazhi-201.shtml',{
    ...transport('too big'),maxBytes:2}),/AH_SOURCE_TOO_LARGE/);
  await assert.rejects(adapter.fetchPage('https://odds.500.com/fenxi/yazhi-201.shtml',transport('a',{
    clockValues:[clock,'2026-10-06T06:00:00.123456788Z']})),/AH_CLOCK/);
});
