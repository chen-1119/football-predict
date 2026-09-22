'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseRows}=require('../scripts/sync500Data.cjs');
const {normalizeRows,config}=require('../collectors/market/policy.cjs');
const {collectOnce}=require('../scripts/runMarketCollector.cjs');
const {projectSignalRows}=require('../collectors/market/signalBridge.cjs');
const {joinCurrentMarket}=require('../scripts/recommendationPlatform/currentInputs.cjs');
const {evaluateCurrent}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const stamp=value=>new Date(value).toISOString();
function page({home='米尔顿',away='格里姆',homeTitle='米尔顿凯恩斯',awayTitle='格里姆斯比',extra=''}={}){
 return `<tr class="bet-tb-tr" data-id="1" data-matchdate="2026-09-17" data-matchtime="23:00" data-homesxname="${home}" data-awaysxname="${away}">
 <td><a title="联赛名字">英锦标赛</a></td><td class="td-team">
 <span class="team-l"><i title="排名第1"></i><a class="team-l" title="${homeTitle}">${home}</a></span>
 <span class="team-r"><a title="${awayTitle}" class="team-r">${away}</a><i title="排名第2"></i></span>${extra}</td>
 <td><p data-type="nspf" data-value="3" data-sp="1.80"></p><p data-type="nspf" data-value="1" data-sp="3.50"></p><p data-type="nspf" data-value="0" data-sp="4.50"></p></td></tr>`;
}
test('source team link titles retain complete names while identity keys and prices remain source values',()=>{
 const parsed=parseRows(page(),stamp(NOW))[0];
 assert.equal(parsed.signal.homeTeamName,'米尔顿凯恩斯');assert.equal(parsed.signal.awayTeamName,'格里姆斯比');
 assert.deepEqual(parsed.signal.bookmakerOdds.had,{odds1:1.8,oddsX:3.5,odds2:4.5});
 assert.equal(parsed.signal.updatedAt,stamp(NOW));assert.equal(parsed.signal.sourceMatchId,'1');
 assert.ok(parsed.keys.includes('2026-09-17:米尔顿:格里姆'));
 const wigan=parseRows(page({home:'维冈',homeTitle:'维冈竞技'}),stamp(NOW))[0];
 assert.equal(wigan.signal.homeTeamName,'维冈竞技');
});
test('unrelated, conflicting or unbound source titles cannot replace a team identity',()=>{
 const missing=page({homeTitle:''});assert.equal(parseRows(missing,stamp(NOW))[0].signal.homeTeamName,'米尔顿');
 const conflict=page({extra:'<a class="team-l" title="另一队">米尔顿</a>'});
 assert.equal(parseRows(conflict,stamp(NOW))[0].signal.homeTeamName,'米尔顿');
 const wrongLabel=page().replace('>米尔顿</a>','>另一队</a>');
 assert.equal(parseRows(wrongLabel,stamp(NOW))[0].signal.homeTeamName,'米尔顿');
});
function warehouse(){
 const runs=new Map(),observations=new Map();let latest=null,releaseCount=0;
 const client={on(){},removeListener(){},release(){releaseCount++;},async query(sql,v=[]){
  const q=sql.replace(/\s+/g,' ').trim();
  if(q.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(q.includes('pg_advisory_unlock')||['BEGIN','COMMIT','ROLLBACK'].includes(q))return {rows:[]};
  if(q.startsWith('SELECT finished_at'))return {rows:[...runs.values()].filter(r=>r.finished_at).sort((a,b)=>Date.parse(b.finished_at)-Date.parse(a.finished_at)).slice(0,1)};
  if(q.startsWith('INSERT INTO football.market_collector_runs')){runs.set(v[0],{run_id:v[0],source:v[1],started_at:v[2],status:'running'});return {rows:[]};}
  if(q.startsWith('SELECT status,source_sha256'))return {rows:[runs.get(v[0])]};
  if(q.startsWith('SELECT observation_id'))return {rows:latest?[latest]:[]};
  if(q.startsWith('INSERT INTO football.market_observations')){observations.set(v[0],{observation_id:v[0],run_id:v[1],first_seen_at:v[10],last_seen_at:v[10],seen_count:1,content_hash:v[11],payload:JSON.parse(v[12])});return {rowCount:1};}
  if(q.startsWith('INSERT INTO football.market_latest')){latest={observation_id:v[4],content_hash:v[5],updated_at:v[6]};return {rowCount:1};}
  if(q.startsWith('UPDATE football.market_observations')){const row=observations.get(v[0]);row.last_seen_at=v[1];row.seen_count++;return {rowCount:1};}
  if(q.startsWith('UPDATE football.market_latest')){latest.updated_at=v[4];return {rowCount:1};}
  if(q.startsWith('UPDATE football.market_collector_runs')){Object.assign(runs.get(v[0]),{finished_at:v[1],status:v[2],rows_seen:v[3],rows_changed:v[4],rows_unchanged:v[5],source_sha256:v[6],next_poll_seconds:v[8],payload:JSON.parse(v[11])});return {rowCount:1};}
  throw Error('Unexpected test query: '+q);
 }};
 return {pool:{connect:async()=>client},runs,observations,signals(){if(!latest)return [];const o=observations.get(latest.observation_id);return projectSignalRows([{...o,updated_at:latest.updated_at,latest_content_hash:latest.content_hash,acquisition:runs.get(o.run_id)}]);},get released(){return releaseCount;}};
}
test('two successful unchanged page receipts renew quotes; empty pages, cooldown and failed fetches never do',async()=>{
 const db=warehouse();let now=NOW,requests=0,body=Buffer.from(page());
 const fetchPage=async()=>{requests++;return {body,statusCode:200};};
 const opts={config:config({}),now:()=>now,random:()=>1,fetchPage,parseRows:(bytes,observedAt)=>parseRows(bytes.toString('utf8'),observedAt),refreshFeature:async()=>{}};
 const first=await collectOnce(db.pool,opts);assert.equal(first.changed,1);assert.equal(requests,1);
 const old=db.signals(),oldReceipt=structuredClone(old[0].signal.bookmakerOdds.had.lotterySpReceipt);
 now+=10*60000;const second=await collectOnce(db.pool,opts);
 // Maximum jitter legitimately keeps the first cycle cooling for 11.5 min.
 assert.equal(second.skipped,'not-due');assert.equal(requests,1);assert.deepEqual(db.signals(),old);
 now=NOW+12*60000;const renewed=await collectOnce(db.pool,opts);assert.equal(renewed.unchanged,1);assert.equal(requests,2);
 assert.equal(db.observations.size,1);const fresh=db.signals(),receipt=fresh[0].signal.bookmakerOdds.had.lotterySpReceipt;
 assert.equal(receipt.observationContentHash,oldReceipt.observationContentHash);
 assert.equal(receipt.firstObservedAt,oldReceipt.observedAt);assert.equal(receipt.observedAt,stamp(now));
 assert.deepEqual(old[0].signal.bookmakerOdds.had.lotterySpReceipt,oldReceipt);
 const current=[match(1,NOW,{homeTeamName:'米尔顿凯恩斯',awayTeamName:'格里姆斯比'})],before=structuredClone(current),later=NOW+20*60000;
 assert.equal(evaluateCurrent(joinCurrentMarket(current,old,later).current,{now:later,publication:publication(NOW)}).decisions.length,0);
 const joined=joinCurrentMarket(current,fresh,later),assessed=evaluateCurrent(joined.current,{now:later,publication:publication(NOW)});
 assert.equal(assessed.decisions.length,1);assert.equal(assessed.decisions[0].quoteObservedAt,stamp(now));
 assert.equal(assessed.decisions[0].modelGeneratedAt,stamp(NOW));assert.deepEqual(current,before);
 assert.equal(joinCurrentMarket([{...current[0],homeTeamName:'另一队'}],fresh,later).receiptHashes.size,0);
 now=NOW+24*60000;body=require('iconv-lite').encode('<p class="nodata-txt">暂无赛事信息</p>','gbk');
 const empty=await collectOnce(db.pool,opts);assert.equal(empty.sourceState,'no-events');assert.ok(empty.nextPollSeconds<=300);assert.deepEqual(db.signals(),fresh);
 now+=5*60000;const failed=await collectOnce(db.pool,{...opts,fetchPage:async()=>{throw Object.assign(Error('blocked'),{code:'SOURCE_BLOCKED'});}});
 assert.equal(failed.ok,false);assert.ok(failed.nextPollSeconds>=6*3600);assert.deepEqual(db.signals(),fresh);
 assert.equal(joinCurrentMarket(current,db.signals(),now).receiptHashes.size,0);
 assert.equal(db.released,5);
});
