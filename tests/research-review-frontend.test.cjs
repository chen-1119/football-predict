'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/signed-live-had.cjs');
function load(relative){const file=path.resolve(__dirname,'..',relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
const front=load('src/services/recommendationCenterView.ts'),pick=load('src/services/publishedMatchRecommendation.ts');
function fixture(){
 const matches=[f.source(1),f.source(2),f.source(3)],s=f.snapshot(matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;})});
 const draft={version:1,reportKind:'weekday-2000-selected-two',predictionScope:'chat-only research',businessDate:matches[0].businessDate,frozenAt:f.stamp(f.NOW-60000),singles:matches.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,market:'HAD',handicap:null,selection:'h',sp:1.8,scores:[[2,0],[3,1]],confidence:'中',reason:'Synthetic original',analysisUrl:'https://example.com/preview',teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}))};
 const publication=p.make(draft,{matches,snapshot:s.snapshot,trustRegistry:s.registry,asOf:f.stamp(f.NOW)}),records=publication.records,day=draft.businessDate,updatedAt=f.stamp(f.NOW+3000);
 const raw=p.seal({version:'reviewed-analysis-view-v1',businessDate:day,createdAt:publication.createdAt,commitObservedAt:f.stamp(f.NOW+1),updatedAt,publicationHash:publication.contentHash,records,combos:p.combinations(records,2),threeCombos:p.combinations(records,3),formalEligible:false});
 const meta={revision:1,payloadSha256:'a'.repeat(64),ackSha256:'b'.repeat(64),previousRevisionHash:null,publishedAt:f.stamp(f.NOW+1000),commitObservedAt:f.stamp(f.NOW+1001),originalSettlementPreserved:true,independentEventIncrement:0};
 const decision=r=>({...r,market:'HAD',selection:'a',sp:4.5,originalSp:4.5,scores:[[0,1],[1,2]],reason:'Synthetic new review'});
 const single={...meta,key:'reviewed-single-'+day+'-'+records[0].eventId+'-v01',eventId:records[0].eventId,originalDecisionHash:p.hash(records[0]),decision:decision(records[0]),settlement:{state:'PENDING'}};
 const ds=records.slice(0,2).map(decision),combo={...meta,key:'reviewed-combo-'+day+'-'+p.hash({size:2,band:2.5,eventIds:ds.map(d=>d.eventId).sort()})+'-v01',baseArchiveKey:'reviewed-combo-view-'+day+'-'+'c'.repeat(64),baseArchiveSha256:'d'.repeat(64),originalCombo:raw.combos[0],decisions:ds,combo:p.combinations(ds,2)[0],frozen:false,settlement:{state:'PENDING'},legSettlements:ds.map(()=>({state:'PENDING'}))};
 const body={version:'reviewed-revisions-view-v1',state:'verified',businessDate:day,updatedAt,originalPublicationHash:raw.publicationHash,singles:[single],combos:[combo],pending:[],originalSettlementPreserved:true,independentEventIncrement:0,formalEligible:false,modelAdoption:false};
 const original=front.parseReviewedAnalysis(raw,day,updatedAt);return {raw,original,body,day,updatedAt,parse:()=>front.parseReviewedRevisions(p.seal(body),raw,original,updatedAt)};
}
test('browser parser and match pick use the latest reviewed direction and retain first direction and scores',()=>{
 const f=fixture(),before=JSON.stringify(f.original),v=f.parse(),row=pick.reviewedLatestRecord(f.original.records[0],v);
 a.equal(row.selection,'a');a.deepEqual(row.scores,[[0,1],[1,2]]);a.equal(row.review.original.selection,'h');a.equal(JSON.stringify(f.original),before);
 a.equal(v.combos[0].combo.product,20.25);a.equal(f.original.combos[0].product,3.24);
});
for(const [label,change]of [
 ['changed original',f=>{f.body.singles[0].originalDecisionHash='0'.repeat(64);}],['incompatible score',f=>{f.body.singles[0].decision.scores=[[2,0],[3,1]];}],
 ['ordered teams swapped',f=>{f.body.singles[0].decision.homeTeamId=f.body.singles[0].decision.awayTeamId;}],['missing first version',f=>{f.body.singles[0].revision=2;f.body.singles[0].previousRevisionHash='f'.repeat(64);}],
 ['mutated combo SP',f=>{f.body.combos[0].combo.legs[0].sp=9;}],['wrong combo product',f=>{f.body.combos[0].combo.product=99;}],
 ['future ACK',f=>{f.body.singles[0].commitObservedAt='2099-01-01T00:00:00.000Z';}],
])test('resealed projection still refuses '+label,()=>{const f=fixture();change(f);a.throws(f.parse);});
test('rendered single shows review and original, while combo keeps independent original legs',()=>{
 const f=fixture(),revisions=f.parse(),React=require('react'),render=require('react-dom/server').renderToStaticMarkup;
 const ui=require('../scripts/lib/loadReviewTsForVerification.cjs')(ts,path.resolve(__dirname,'../src/components/recommendations/ReviewedAnalysis.tsx'));
 const singles=render(React.createElement(ui.ReviewedAnalysisPanel,{data:f.original,revisions,tab:'single',now:Date.parse(f.updatedAt),failed:false}));
 a.match(singles,/复核版 1/);a.match(singles,/首版保留/);a.match(singles,/客胜/);a.match(singles,/主胜/);a.doesNotMatch(singles,/低信心|中信心|高信心/);
 const combos=render(React.createElement(ui.ReviewedAnalysisPanel,{data:f.original,revisions,tab:'two',now:Date.parse(f.updatedAt),failed:false}));
 a.match(combos,/3.24/);a.match(combos,/20.25/);a.match(combos,/复核版 1/);
});
