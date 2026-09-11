'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'verifyRecommendationEligibility.cjs'),'utf8'),start=source.indexOf('const productionReplayStateConsistent ='),end=source.indexOf('\nconst replayStateConsistent =',start);assert.ok(start>0&&end>start);
const consistent=vm.runInNewContext(source.slice(start,end)+'\nproductionReplayStateConsistent;');let cases=0;
for(const had of [false,true])for(const hhad of [false,true])for(const same of [false,true]){
 const validatedMarkets=[...(had?['HAD']:[]),...(hhad?['HHAD']:[])],eligible=same&&had&&hhad;
 const validation={eligible,samePolicyImplementation:same,validatedMarkets,perMarket:{HAD:{productionPolicyReplay:had},HHAD:{productionPolicyReplay:hhad}}};
 const gate={eligible:false,action:'shadow-only',productionPolicyValidated:eligible,validatedMarkets,blockers:[...(!same?['production-multi-factor-policy-not-replayed']:[]),...(!had?['HAD-production-policy-unvalidated']:[]),...(!hhad?['HHAD-production-policy-unvalidated']:[])]};
 assert.equal(consistent(validation,gate),true);cases++;
 for(const bad of [{...gate,productionPolicyValidated:!eligible},{...gate,validatedMarkets:['UNKNOWN']},{...gate,validatedMarkets:[...validatedMarkets,...validatedMarkets,'HAD']}]){assert.equal(consistent(validation,bad),false);cases++;}
 if(!eligible){assert.equal(consistent(validation,{...gate,eligible:true,action:'activate-multi-factor-evidence'}),false);assert.equal(consistent(validation,{...gate,blockers:[]}),false);cases+=2;}
}
assert.equal(consistent({},{}),false);cases++;
console.log(JSON.stringify({ok:true,checks:cases,scope:'actual eligibility verifier predicate; all market subsets, policy identity, false promotion and missing blockers',productionWrites:0,modelPromotionAllowed:false}));
