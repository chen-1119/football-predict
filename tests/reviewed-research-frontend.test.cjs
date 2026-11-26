'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const fixture=require('./fixtures/reviewed-research.cjs'),policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),decision=require('../scripts/recommendationPlatform/reviewedResearchDecision.cjs');
const filename=path.resolve(__dirname,'../src/services/recommendationCenterView.ts'),loaded=new Module(filename,module);
loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const parse=body=>loaded.exports.parseReviewedAnalysis(policy.seal(body),body.businessDate,body.updatedAt);
function setup(){
 const value=fixture.setup(),draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context);
 const publication=policy.make(draft,{...value.context,evidenceByEvent:Object.fromEntries(value.packets.map(packet=>[packet.event.eventId,[packet]]))}),updatedAt=fixture.stamp(fixture.NOW+2000);
 return {version:'reviewed-analysis-view-v1',businessDate:draft.businessDate,updatedAt,createdAt:publication.createdAt,commitObservedAt:fixture.stamp(fixture.NOW+1),
  publicationHash:publication.contentHash,draftHash:publication.draftHash,records:publication.records,combos:policy.combinations(publication.records,2,updatedAt),threeCombos:policy.combinations(publication.records,3,updatedAt),formalEligible:false};
}
test('actual frontend parser retains research coverage and non-model market q with frozen combo bindings',()=>{
 const body=setup(),result=parse(body);assert.equal(result.records.length,2);assert.equal(result.records[0].research.coreComplete,true);assert.equal(result.records[0].research.lineupsConfirmed,false);
 assert.equal(result.records[0].comboEligible,true);assert.equal(result.records[0].marketBaseline.kind,'normalized-inverse-sp');assert.equal(result.combos[0].product,3.456);
});
for(const [label,change]of [
 ['missing research',body=>delete body.records[0].research],
 ['wrong source count',body=>body.records[0].research.sourceCount=1],
 ['unconfirmed core promoted',body=>body.records[0].research.coreComplete=false],
 ['availability missing but combo used',body=>body.records[0].research.availabilityComplete=false],
 ['direction after quote',body=>body.records[0].research.chosenAt=fixture.stamp(fixture.NOW+1)],
 ['model EV smuggled',body=>body.records[0].expectedValue=.5],
 ['wrong q market',body=>body.records[0].marketBaseline.market='HHAD'],
 ['bad q normalization',body=>body.records[0].marketBaseline.probabilities.h=.99],
 ['same combo without research marker',body=>delete body.combos[0].strategy],
 ['wrong frozen single hash',body=>body.combos[0].legs[0].singleHash='0'.repeat(64)],
 ['wrong frozen quote hash',body=>body.combos[0].legs[0].quoteHash='0'.repeat(64)],
 ['ineligible single used in combo',body=>body.records[0].comboEligible=false],
])test('resealed public view rejects '+label,()=>{const body=setup();change(body);assert.throws(()=>parse(body));});
