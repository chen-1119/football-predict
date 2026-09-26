'use strict';
const { test, after } = require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-sp-view-'));
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=fs.readFileSync(path.join(__dirname,'../src/services/recommendationCenterView.ts'),'utf8');
fs.writeFileSync(path.join(dir,'view.cjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
fs.copyFileSync(path.join(__dirname,'../src/services/publishedRecommendationStatus.cjs'),path.join(dir,'publishedRecommendationStatus.cjs'));
const {parseRecommendationCenter,quoteSourceLabel}=require(path.join(dir,'view.cjs'));
const {normalizeRows,hash,SOURCE}=require('../collectors/market/policy.cjs');
const {projectSignalRows}=require('../collectors/market/signalBridge.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {NOW,match,validators,memoryPorts}=require('./recommendationFixture.cjs');
async function input(){
 const ports=memoryPorts();
 ports.current=[1,2,3].map(id=>{
  const m=match(id),signal={source:SOURCE,sourceMatchId:String(id),homeTeamName:m.homeTeamName,awayTeamName:m.awayTeamName,kickoffTime:m.kickoffTime,bookmakerOdds:{had:m.odds}};
  const p=normalizeRows([{keys:[String(id)],signal}],new Date(NOW).toISOString()).markets[0];
  const stamp=new Date(NOW).toISOString();
  const row={payload:p.payload,observation_id:'obs-'+id,content_hash:p.contentHash,latest_content_hash:p.contentHash,first_seen_at:stamp,last_seen_at:stamp,updated_at:stamp,
   acquisition:{run_id:'run-1',source:SOURCE,status:'completed',source_sha256:'a'.repeat(64),started_at:stamp,finished_at:stamp,payload:{url:'https://trade.500.com/jczq/'}}};
  return {...m,oddsSource:'500.com:HAD',externalSignals:projectSignalRows([row])[0].signal};
 });
 const runtime=createRuntime(ports,{validators});await runtime.publishingCycle();
 return {recommendationCenter:ports.state.view};
}
test('both copied-SP combinations survive real API-shape frontend parsing',async()=>{
 const p=parseRecommendationCenter(await input());assert.equal(p.previews.length,2);
 assert.ok(p.previews.every(c=>c.legs.every(d=>quoteSourceLabel(d,'zh')==='500竞彩页面转录')));
});
test('source labels do not call a copied quote an official direct response',()=>{
 assert.equal(quoteSourceLabel({quoteSource:'500.com:jczq:HAD'},'en'),'500 JCZQ SP copy');
 assert.equal(quoteSourceLabel({quoteSource:'sporttery:HAD'},'zh'),'竞彩网来源SP');
});
test('missing source in old records is explicit rather than invented',()=>assert.match(quoteSourceLabel({},'zh'),/来源见原记录/));
test('copied quote with missing receipt is rejected by frontend normalization',async()=>{
 const p=await input();delete p.recommendationCenter.current[0].decision.quoteProvenance;assert.throws(()=>parseRecommendationCenter(p));
});
test('a copied receipt cannot claim officialDirect or a different price',async()=>{
 for(const change of [{officialDirect:true},{quoteOdds:{odds1:9,oddsX:3,odds2:4}}]){
  const p=await input();Object.assign(p.recommendationCenter.current[0].decision.quoteProvenance,change);assert.throws(()=>parseRecommendationCenter(p));
 }
});
test('source evidence and source timestamps remain bound after serialization',async()=>{
 const inputData=await input(),copy=JSON.parse(JSON.stringify(inputData));const p=parseRecommendationCenter(copy);
 assert.equal(p.current[0].decision.quoteObservedAt,new Date(NOW).toISOString());assert.equal(p.current[0].decision.quoteSource,'500.com:jczq:HAD');
 assert.equal(hash(inputData),hash(copy));
});
