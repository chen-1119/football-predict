'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyView,normalizeLeagueRows,normalizeLeagueCells,collectLeague}=require('./browser.cjs');
const sample=require('./samples/logged-in-validation.json');
const historical=require('./samples/historical-lineup-sample.json');
function fixture(){return {siteMatchId:'sporttery_2041418',homeName:'阿斯顿维拉',awayName:'诺丁汉森林',kickoffUtc:'2026-09-12T14:00:00.000Z',eventVersion:'2026-09-12T14:00:00.000Z'};}
function task(){return {fixture:fixture(),providerMatchId:'4558535',kind:'injuries',sourceUrl:'https://live.leisu.com/shujufenxi-4558535'};}
function view(){return {url:task().sourceUrl,title:'阿斯顿维拉vs诺丁汉森林数据分析',home:{name:'阿斯顿维拉'},away:{name:'诺丁汉森林'},
  headerText:'英超 2026/09/12 22:00\nvs\n未开赛',loginVisible:false,errorText:'',lineups:[],lineupText:'',
  injuryTables:['home','away'].map(side=>({teamName:side==='home'?'阿斯顿维拉':'诺丁汉森林',
    rows:sample.analysisPage.domFields.injuries.filter(x=>x.side===side).map(p=>({name:p.name,href:'https://www.leisu.com/data/zuqiu/player-'+p.providerPlayerId,cells:[p.name,p.positionAsDisplayed,p.reasonAsDisplayed,'',p.returnDateAsDisplayed,'']}))}))};}
test('actual captured injury rows parse to five named players without fabricated numeric fields',()=>{
  const result=classifyView(view(),task(),200);assert.equal(result.status,'available');
  assert.deepEqual(result.data.injuries,sample.analysisPage.domFields.injuries);assert.equal(result.data.sourcePublishedAt,null);
});
test('source error pages and every non-success HTTP status fail closed',()=>{
  for(const code of [0,301,401,403,405,429,500,502])assert.notEqual(classifyView(view(),task(),code).status,'available');
  assert.equal(classifyView({...view(),url:'https://h5.leisu.com/403',title:'ERROR 403-Forbidden!'},task(),200).status,'blocked');
});
test('source match identity, kickoff and source-side tables must all agree',()=>{
  assert.equal(classifyView({...view(),home:{name:'另一支球队'}},task(),200).status,'conflict');
  assert.equal(classifyView({...view(),headerText:'2026/09/13 22:00'},task(),200).status,'conflict');
  const changed=view();changed.injuryTables[1].teamName=changed.injuryTables[0].teamName;
  assert.equal(classifyView(changed,task(),200).status,'conflict');
});
test('only explicitly verified provider aliases are normalized',()=>{
  const t=task();t.fixture.homeName='阿斯顿维拉全称';
  assert.equal(classifyView(view(),t,200).status,'conflict');
  t.providerHomeName='阿斯顿维拉';t.providerAwayName='诺丁汉森林';
  const result=classifyView(view(),t,200);assert.equal(result.status,'available');
  assert.equal(result.data.homeName,'阿斯顿维拉全称');assert.equal(result.data.sourceHomeName,'阿斯顿维拉');
});
test('empty source is distinct from failed extraction',()=>{
  const v=view();v.injuryTables.forEach(t=>t.rows=[]);
  assert.equal(classifyView(v,task(),200).status,'source_empty');
  v.injuryTables=[];assert.equal(classifyView(v,task(),200).status,'parse_error');
});
test('historical DOM roster parses but swapped or duplicate players are rejected',()=>{
  const t={fixture:{...fixture(),homeName:'布鲁日',awayName:'阿斯顿维拉',kickoffUtc:'2026-09-08T16:45:00.000Z'},
    providerMatchId:'4628409',kind:'lineup',sourceUrl:historical.sourceUrl};
  const v={...view(),url:t.sourceUrl,home:{name:'布鲁日'},away:{name:'阿斯顿维拉'},
    headerText:'欧冠 联赛阶段 第1轮\n2026/09/09 00:45vsHT 1-3',lineups:structuredClone(historical.teams)};
  assert.equal(classifyView(v,t,200).status,'available');
  v.lineups[1].starters[0].id=v.lineups[0].starters[0].id;
  assert.equal(classifyView(v,t,200).status,'parse_error');
});

const leagueUrl='https://www.leisu.com/data/zuqiu/comp-82';
function leagueRow(date='26/09/12',time='22:00') {return {href:'https://live.leisu.com/shujufenxi-4558535',text:[date,time,'阿斯顿维拉','vs','诺丁汉森林','-','分析','直播','历史'].join('\n\n')};}
test('actual league tr shape normalizes valid Beijing dates without changing original team names',()=>{
  const raw=leagueRow();const original=structuredClone(raw);
  const result=normalizeLeagueRows([raw],leagueUrl);
  assert.deepEqual(result,[{providerMatchId:'4558535',homeName:'阿斯顿维拉',awayName:'诺丁汉森林',kickoffUtc:'2026-09-12T14:00:00.000Z',sourceUrl:leagueUrl}]);
  assert.deepEqual(raw,original);
  const ranked={...raw,text:raw.text.replace('阿斯顿维拉','[17]\n\n阿斯顿维拉').replace('诺丁汉森林','诺丁汉森林\n\n[16]')};
  assert.deepEqual(normalizeLeagueRows([ranked],leagueUrl),result);
  assert.equal(normalizeLeagueRows([leagueRow('28/02/29')],leagueUrl)[0].kickoffUtc,'2028-02-29T14:00:00.000Z');
});
test('invalid league dates and malformed rows cannot be normalized into valid candidates',()=>{
  for(const row of [leagueRow('26/02/30'),leagueRow('26/02/29'),leagueRow('26/04/31'),leagueRow('26/13/12'),leagueRow('26/09/12','24:00'),leagueRow('26/09/12','22:60'),{...leagueRow(),href:leagueRow().href+'\n'},{...leagueRow(),text:leagueRow().text.replace('\n\n-\n\n','\n\n0-0\n\n')},null,{text:123,href:leagueRow().href}]) {
    assert.deepEqual(normalizeLeagueRows([row],leagueUrl),[]);
  }
  assert.equal(normalizeLeagueRows([leagueRow('26/02/30'),leagueRow()],leagueUrl).length,1);
});
test('collectLeague reports parse_error when every rendered row has an invalid date',async()=>{
  let closed=false;
  const page={goto:async()=>({status:()=>200,text:async()=>''}),title:async()=>'英超赛程',url:()=>leagueUrl,
    locator:()=>({first:()=>({waitFor:async()=>{}})}),evaluate:async()=>[leagueRow('26/02/30')],close:async()=>{closed=true;}};
  const result=await collectLeague({newPage:async()=>page},leagueUrl);
  assert.equal(result.status,'parse_error');assert.deepEqual(result.candidates,[]);
  assert.equal(result.reason,'invalid-league-rows');assert.equal(result.httpStatus,200);
  assert.ok(Number.isFinite(Date.parse(result.receivedAt)));assert.equal(closed,true);
});
test('league failures retain explicit HTTP and transport metadata for the source pause policy',async()=>{
  const {shouldPauseSource}=require('./failure-policy.cjs');
  for(const spec of [
    {httpStatus:503,status:'parse_error',reason:'non-success-http-status',paused:false},
    {httpStatus:403,status:'blocked',reason:'source-block-page',paused:true},
    {httpStatus:405,status:'blocked',reason:'source-block-page',paused:true},
    {httpStatus:200,title:'登录',status:'login_required',reason:'source-login-page',paused:true},
    {httpStatus:200,url:'https://www.leisu.com/other',status:'conflict',reason:'unexpected-source-url',paused:true},
    {httpStatus:200,rows:[],status:'parse_error',reason:'league-rows-missing',paused:true},
    {httpStatus:0,error:Object.assign(new Error('simulated timeout'),{name:'TimeoutError'}),status:'parse_error',reason:'page-timeout',paused:false},
    {httpStatus:0,error:new Error('simulated page read failure'),status:'parse_error',reason:'page-read-failed',paused:false}
  ]){
    let closed=0;
    const page={goto:async()=>{if(spec.error)throw spec.error;return {status:()=>spec.httpStatus,text:async()=>''};},
      title:async()=>{assert.equal(spec.httpStatus,200,'non-success HTTP must be classified before reading an error document');return spec.title||'英超赛程';},url:()=>spec.url||leagueUrl,
      locator:()=>({first:()=>({waitFor:async()=>{}})}),evaluate:async()=>spec.rows||[leagueRow()],close:async()=>{closed++;}};
    const result=await collectLeague({newPage:async()=>page},leagueUrl);
    assert.equal(result.status,spec.status);assert.equal(result.reason,spec.reason);
    assert.equal(result.httpStatus,spec.httpStatus);assert.deepEqual(result.candidates,[]);
    assert.ok(Number.isFinite(Date.parse(result.receivedAt)));assert.equal(shouldPauseSource(result),spec.paused);
    assert.equal(closed,1);
  }
});
test('confirmed upcoming lineup empty text is source_empty while missing extraction remains parse_error',()=>{
  const t={...task(),kind:'lineup',sourceUrl:'https://live.leisu.com/detail-4558535'};
  const v={...view(),url:t.sourceUrl,lineups:[],lineupText:'暂无数据'};
  assert.deepEqual(classifyView(v,t,200),{status:'source_empty',data:null,reason:'source-lineup-empty'});
  assert.equal(classifyView({...v,lineupText:'\n 暂无数据 \n'},t,200).status,'source_empty');
  assert.equal(classifyView({...v,lineupText:''},t,200).status,'parse_error');
  assert.equal(classifyView({...v,lineups:undefined},t,200).status,'parse_error');
  assert.equal(classifyView(v,t,405).status,'blocked');
});
test('malformed page shapes, URLs and impossible header dates return classifications without throwing',()=>{
  for(const v of [null,{}, {...view(),url:'not a URL'}, {...view(),home:null}, {...view(),injuryTables:null},
    {...view(),injuryTables:[null,null]}, {...view(),injuryTables:[{teamName:'阿斯顿维拉',rows:[null]},{teamName:'诺丁汉森林',rows:[]}]},
    ...['2026/02/30 22:00','2026/13/12 22:00','2026/09/12 24:00'].map(headerText=>({...view(),headerText}))]) {
    let result;assert.doesNotThrow(()=>{result=classifyView(v,task(),200);});assert.equal(result.data,null);assert.notEqual(result.status,'available');
  }
  assert.equal(classifyView(view(),null,200).status,'parse_error');
  assert.equal(classifyView(view(),{...task(),kind:'odds'},200).status,'parse_error');
  const t={...task(),kind:'lineup',sourceUrl:'https://live.leisu.com/detail-4558535'};
  assert.equal(classifyView({...view(),url:t.sourceUrl,lineups:[null,null]},t,200).status,'parse_error');
});

test('real public HTML fixture cells retain exact names and kickoff and reject changed layout',()=>{
  const url='https://www.leisu.com/data/zuqiu/comp-82';
  const row={cells:['26/09/1300:30','[18] 热刺','vs','埃弗顿 [8]','-','分析 直播  历史'],href:'https://live.leisu.com/shujufenxi-4558551'};
  const result=normalizeLeagueCells([row],url);assert.equal(result.length,1);assert.equal(result[0].homeName,'热刺');assert.equal(result[0].awayName,'埃弗顿');assert.equal(result[0].kickoffUtc,'2026-09-12T16:30:00.000Z');assert.equal(result[0].providerMatchId,'4558551');
  assert.deepEqual(normalizeLeagueCells([{...row,cells:row.cells.map((v,i)=>i===2?'2-1':v)}],url),[]);
  assert.deepEqual(normalizeLeagueCells([{...row,cells:row.cells.slice(1)}],url),[]);
});
