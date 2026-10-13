'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const f=require('./fixtures/coverageFixtures.cjs'),{client}=require('./fixtures/coverageClient.cjs');
const adapter=require('../scripts/recommendationPlatform/publishedReviewCoverageRepository.cjs');
const helper=require('../server/matchDetailPublication.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const compiled=new Map();
function frontend(file){
 if(compiled.has(file))return compiled.get(file);
 const module={exports:{}},source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 compiled.set(file,module.exports);
 const from=require('node:module').createRequire(file);
 const load=id=>{if(id.startsWith('.')){const absolute=path.resolve(path.dirname(file),id);if(!path.extname(absolute))return frontend(absolute+'.ts');return require(absolute);}return from(id);};
 vm.runInNewContext(source,{module,exports:module.exports,require:load,Date,Intl,Set,Map,URL,TextEncoder,Uint8Array,BigInt,structuredClone});return module.exports;
}
const view=frontend(path.resolve(__dirname,'../src/services/matchDetailPublication.ts'));
const Evidence=frontend(path.resolve(__dirname,'../src/components/recommendations/DetailPublicationEvidence.tsx')).DetailPublicationEvidence;
const words=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(words).join(''):typeof n==='object'?words(n.props?.children):String(n);
async function setup(options={}){
 const v=f.setup(options),match={...v.matches[0],eventVersion:v.matches[0].kickoffTime,status:'FINISHED'},target=helper.identityFor(match),db=client({pairs:[v.manual,...(options.trained?[f.trained(v)]:[])]});
 const loaded=await adapter.loadVerifiedPublicationForIdentity(db,{asOf:v.asOf,targetIdentity:target,trustRegistry:v.trustRegistry});
 const wire=helper.projectVerifiedPublication(match,loaded),parsed=view.detailPublishedRecommendation(wire,match,Date.parse(v.asOf));
 return {v,match,db,loaded,wire,parsed};
}
test('same-RR real signed original manual+ACK reaches completed detail with original price and evidence',async()=>{
 const {v,match,wire,parsed,db}=await setup();a.ok(parsed);a.equal(parsed.reviewed.sp,v.record.records[0].sp);a.deepEqual(wire.reviewed.records[0],v.record.records[0]);
 a.equal(parsed.receipts[0].recordHash,v.record.contentHash);a.equal(parsed.trained,null);a.deepEqual(wire.reviewed.combos,[]);
 const html=words(Evidence({data:parsed,language:'zh'}));a.match(html,/原赛前发布记录与依据/);a.match(html,/原记录缺项/);a.match(html,/没有可核验的独立模型概率/);a.doesNotMatch(html,/信心/);
 a.ok(view.detailPublishedRecommendation(wire,{...match,odds:{odds1:9,oddsX:9,odds2:9}},Date.parse(v.asOf)));a.equal(db.log.some(q=>/INSERT|UPDATE|DELETE/.test(q.sql)),false);
});
test('HHAD original line and score semantics are retained, not relabelled as HAD',async()=>{const {parsed}=await setup({hhad:true});a.ok(parsed);a.equal(parsed.reviewed.market,'HHAD');a.equal(parsed.reviewed.handicap,-1);a.equal(parsed.reviewed.selection,'d');});
test('league model original forecast and model hashes survive detail display projection',async()=>{const {parsed,loaded}=await setup({trained:true});a.ok(parsed);a.equal(parsed.trained.modelHash,loaded.publications.find(x=>x.track==='trained').record.modelHash);a.equal(parsed.trained.scoreTop3.length,3);});
test('wrong business day, rescheduled event, reversed teams, names and source never inherit detail pick',async()=>{
 const {match,wire,v}=await setup();for(const patch of [{businessDate:'2026-09-18'},{kickoffTime:'2026-09-18T15:00:00Z'},{eventVersion:'2026-09-18T15:00:00Z'},{eventVersion:undefined},{homeTeamId:match.awayTeamId,awayTeamId:match.homeTeamId},{homeTeamName:'Other'},{sourceMatchId:'fivehundred_'+match.sourceMatchId}])a.equal(view.detailPublishedRecommendation(wire,{...match,...patch},Date.parse(v.asOf)),null);
 a.throws(()=>helper.identityFor({...match,eventVersion:'2026-09-18T15:00:00Z'}),/PUBLICATION_EVENT/);
});
test('unavailable/absent and duplicate or mismatched ACK metadata do not mint a visible pick',async()=>{
 const {match,wire,v}=await setup();for(const change of [x=>x.status='unavailable',x=>x.status='absent',x=>x.receipts.push(x.receipts[0]),x=>x.receipts[0].recordHash='0'.repeat(64),x=>x.receipts[0].ackAt=x.reviewed.records[0].cutoffAt,x=>x.observedAt='2099-01-01T00:00:00Z']){const changed=structuredClone(wire);change(changed);a.equal(view.detailPublishedRecommendation(changed,match,Date.parse(v.asOf)),null);}
});
test('finished and live lineup absence never carry a future publication-window exemption',()=>{
 for(const status of ['FINISHED','LIVE','PENDING_RESULT']){const value=view.detailLineupAvailability({status,kickoffTime:'2026-10-12T18:45:00Z',now:Date.parse('2026-10-13T04:00:00Z'),ready:false,projected:false,notYetPublishable:true});a.equal(value.notYetPublishable,false);a.equal(value.stopped,true);a.equal(value.missing,true);}
 const future=view.detailLineupAvailability({status:'SCHEDULED',kickoffTime:'2026-10-13T10:00:00Z',now:Date.parse('2026-10-13T04:00:00Z'),ready:false,projected:false,notYetPublishable:true});a.equal(future.notYetPublishable,true);
});
test('actual Dijon original public record restores draw 3.15 and frozen analysis without changing it to draft 3.22',()=>{
 const actual=require('./fixtures/detail-published-dijon-20261012.json'),wire=helper.projectVerifiedPublication(actual.match,actual.loaded);
 const parsed=view.detailPublishedRecommendation(wire,actual.match,Date.parse('2026-10-13T04:00:00Z'));
 a.ok(parsed);a.equal(parsed.reviewed.sp,3.15);a.equal(parsed.reviewed.originalSp,3.22);a.equal(parsed.reviewed.selection,'d');a.deepEqual(JSON.parse(JSON.stringify(parsed.reviewed.scores)),[[1,1],[0,0]]);
 a.equal(parsed.reviewed.reason,actual.loaded.publications[0].record.reason);a.match(words(Evidence({data:parsed,language:'zh'})),/第戎10月11日官网确认/);
 a.equal(view.detailPublishedRecommendation(wire,{...actual.match,businessDate:'2026-10-13'},Date.parse('2026-10-13T04:00:00Z')),null);
});
test('real detail PG route attaches replayed history inside its existing snapshot and discards injected JSON',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const v=f.setup(),match={...v.matches[0],eventVersion:v.matches[0].kickoffTime,publishedDetail:{status:'verified',fake:true}},db=client({pairs:[v.manual]});
 const publication={mode:'active-generation',generationId:'g-detail-publication-test',manifestHash:'a'.repeat(64),sourceCycleId:'test-detail-cycle',committedAt:'2026-09-17T10:00:00Z'};
 let active=false;const log=[],session={async query(sql,args=[]){log.push(sql);
  if(sql.startsWith('BEGIN')){a.match(sql,/REPEATABLE READ READ ONLY/);active=true;return {rows:[]};}a.equal(active,true);
  if(sql==='COMMIT'||sql==='ROLLBACK'){active=false;return {rows:[]};}
  if(sql.startsWith('SET LOCAL'))return {rows:[]};
  if(sql.includes('projection_meta'))return {rows:Object.entries({data_publication_mode:publication.mode,data_generation_id:publication.generationId,manifest_hash:publication.manifestHash,data_generation_source_cycle_id:publication.sourceCycleId,committed_at:publication.committedAt}).map(([key,value])=>({key,value}))};
  if(sql.includes('match_snapshots'))return {rows:[{payload:match,dataset:'history',match_id:match.id,source_match_id:match.sourceMatchId,kickoff_time:match.kickoffTime}]};
  if(sql.includes('clock_timestamp'))return {rows:[{observed_at:v.asOf}]};
  return db.query(sql,args);
 },release(){a.equal(active,false);}};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'detail-publication-test-')),file=path.join(dir,'trust.json'),prior=process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;
 try{fs.writeFileSync(file,JSON.stringify(v.trustRegistry),{flag:'wx'});process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=file;
  const {readPostgresMatchDetailById}=require('../server/postgresProjectionStore.cjs');
  const actual=await readPostgresMatchDetailById({async connect(){return session;}},match.id,{publicationIdentity:publication,includePublishedDetail:true});
  a.equal(actual.publishedDetail.status,'verified');a.equal(Object.hasOwn(actual.publishedDetail,'fake'),false);
  const parsed=view.detailPublishedRecommendation(actual.publishedDetail,actual,Date.parse(v.asOf));a.ok(parsed);a.equal(parsed.reviewed.sp,v.record.records[0].sp);
  a.equal(log.filter(s=>s.startsWith('BEGIN')).length,1);a.equal(log.filter(s=>s==='COMMIT').length,1);a.equal(log.some(s=>/INSERT|UPDATE|DELETE/.test(s)),false);
 }finally{if(prior===undefined)delete process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;else process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=prior;fs.unlinkSync(file);fs.rmdirSync(dir);}
});
