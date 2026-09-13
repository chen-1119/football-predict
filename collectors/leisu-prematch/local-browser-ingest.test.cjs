const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {prepareBatch:prepareOfficialBatch,ingest}=require('./local-browser-ingest.cjs');
const now=Date.parse('2026-09-13T15:52:00.000Z');
function rawBatch(){return {version:'leisu-local-browser-v1',runId:'95c811bc-447e-4fa0-a1f5-265a5940c9cc',startedAt:'2026-09-13T15:51:00.000Z',outcome:'completed',leaguePages:['https://www.leisu.com/data/zuqiu/comp-120'],entries:[{fixture:{providerMatchId:'4565389',homeName:'主队',awayName:'客队',kickoffUtc:'2026-09-13T16:30:00.000Z',sourceUrl:'https://www.leisu.com/data/zuqiu/comp-120'},kind:'injuries',observedAt:'2026-09-13T15:51:30.000Z',view:{url:'https://live.leisu.com/shujufenxi-4565389',title:'主队vs客队',home:{name:'主队'},away:{name:'客队'},headerText:'2026/09/14 00:30 未开赛',injuryTables:[{teamName:'主队',rows:[{name:'球员',href:'https://www.leisu.com/data/zuqiu/player-123',cells:['球员','后卫','受伤','','-','']}]},{teamName:'客队',rows:[]}],errorText:'',lineups:[]}}]};}
test('rendered evidence retains actual receipt and unknown HTTP status',()=>{const p=prepareBatch(batch(),now);assert.equal(p.summary.available,1);assert.equal(p.summary.injuries,1);assert.equal(p.summary.httpStatus,null);assert.equal(p.rows[0].observedAt,'2026-09-13T15:51:30.000Z');assert.equal(p.summary.predictionEligible,false);});
test('blocked pages never yield injury payloads',()=>{const b=batch();b.entries[0].view.title='405 访问被阻断';const p=prepareBatch(b,now);assert.equal(p.summary.available,0);assert.equal(p.rows[0].status,'blocked');assert.equal(p.rows[0].data,null);});
test('changed teams and kickoff cannot be admitted',()=>{for(const field of ['home','headerText']){const b=batch();if(field==='home')b.entries[0].view.home.name='错误球队';else b.entries[0].view.headerText='2026/09/14 01:30';const p=prepareBatch(b,now);assert.equal(p.rows[0].status,'conflict');assert.equal(p.rows[0].data,null);}});
test('after-kickoff and stale receipts cannot become new available evidence',()=>{const b=batch();b.startedAt='2026-09-13T16:30:30.000Z';b.entries[0].observedAt='2026-09-13T16:30:40.000Z';const p=prepareBatch(b,Date.parse('2026-09-13T16:31:00Z'));assert.equal(p.rows[0].status,'ineligible');assert.equal(p.rows[0].data,null);assert.throws(()=>prepareBatch(batch(),now+3600000),/stale/);});
test('duplicate match/kind and unapproved discovery links are rejected',()=>{const b=batch();b.entries.push(structuredClone(b.entries[0]));assert.throws(()=>prepareBatch(b,now),/Duplicate/);const other=batch();other.leaguePages=['https://example.com'];assert.throws(()=>prepareBatch(other,now),/league/);});
test('acknowledgement loss replays an existing batch after cutoff without reinsertion',async()=>{const b=batch(),hash=crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex'),queries=[];const client={query:async sql=>{queries.push(sql);return {rows:sql.startsWith('SELECT content_hash')?[{content_hash:hash,summary:{available:1}}]:[]};},release(){}};const result=await ingest({connect:async()=>client},b);assert.equal(result.replayed,true);assert.equal(queries.some(sql=>sql.startsWith('INSERT')),false);});

const {VERSION}=require('./local-jingcai-scope.cjs');
const roster={version:VERSION,businessDate:'2026-09-13',fixtureInput:{state:'fresh'},matches:[{id:'sporttery_100',sourceMatchId:'100',businessDate:'2026-09-13',matchNo:'周日001',homeTeamName:'主队',awayTeamName:'客队',kickoffTime:'2026-09-13T16:30:00.000Z',status:'SCHEDULED'}]};
function batch(){const b=rawBatch();b.version=VERSION;b.businessDate='2026-09-13';b.cycleId=b.runId;b.cycleStartedAt=b.startedAt;b.entries[0].fixture={...b.entries[0].fixture,siteMatchId:'sporttery_100',businessDate:b.businessDate};return b;}
function prepareBatch(b,clock){return prepareOfficialBatch(b,clock,roster);}
test('server binds source evidence to the official business day, ID, teams and kickoff',()=>{
 for(const change of [{siteMatchId:'sporttery_999'},{businessDate:'2026-09-14'},{homeName:'别的主队'},{kickoffUtc:'2026-09-13T17:30:00.000Z'}]){
  const b=batch();Object.assign(b.entries[0].fixture,change);assert.throws(()=>prepareBatch(b,now),/official business-day roster/);
 }
 const p=prepareBatch(batch(),now);assert.equal(p.rows[0].data.siteMatchId,'sporttery_100');assert.equal(p.rows[0].data.businessDate,'2026-09-13');
});
test('an overnight chunk keeps the cycle business day while legacy unscoped new batches are rejected',()=>{
 const b=batch();b.startedAt='2026-09-13T16:01:00.000Z';b.entries[0].observedAt='2026-09-13T16:01:30.000Z';
 assert.equal(prepareBatch(b,Date.parse('2026-09-13T16:02:00Z')).summary.available,1);
 b.businessDate='2026-09-14';assert.throws(()=>prepareBatch(b,Date.parse('2026-09-13T16:02:00Z')),/business date/);
 assert.throws(()=>prepareBatch(rawBatch(),now),/scope is required/);
});
