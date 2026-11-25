'use strict';
const policy=require('./reviewedAnalysis.cjs');
const {VERSION}=require('./reviewedResearchDecision.cjs');
const check=(value,code)=>{if(!value)throw Object.assign(Error('RESEARCH_COMBO_'+code),{code:'RESEARCH_COMBO_'+code});};
function coreHash(record){
 const {publicationCreatedAt,publicationCommitObservedAt,...core}=record;void publicationCreatedAt;void publicationCommitObservedAt;
 return policy.hash(core);
}
function combinations(records,size=2,asOf){
 check(Array.isArray(records)&&records.length<=32&&(size===2||size===3)&&Number.isFinite(Date.parse(asOf)),'INPUT');
 check(new Set(records.map(record=>record.eventId)).size===records.length,'DUPLICATE_EVENT');
 const eligible=records.filter(record=>record.strategy===VERSION&&record.comboEligible===true&&record.confidence!=='低'
  &&record.modelProbability===null&&record.expectedValue===null&&record.formalEligible===false
  &&record.research?.version===VERSION&&record.research.coreComplete===true&&record.research.availabilityComplete===true
  &&record.research.comboPolicy==='dual-core-current-availability-v1'
  &&Date.parse(asOf)<Date.parse(record.cutoffAt)&&Date.parse(asOf)<Date.parse(record.eventVersion));
 for(const record of eligible){
  check(['h','d','a'].includes(record.selection)&&['HAD','HHAD'].includes(record.market)
   &&(record.market==='HHAD'?Number.isSafeInteger(record.handicap)&&record.handicap!==0&&Math.abs(record.handicap)<=12:record.handicap===undefined||record.handicap===null),'MARKET');
  check(Array.isArray(record.scores)&&record.scores.length===2&&record.scores.every(score=>Array.isArray(score)&&score.length===2&&score.every(goal=>Number.isInteger(goal)&&goal>=0&&goal<=15)
   &&(score[0]+(record.handicap||0)===score[1]?'d':score[0]+(record.handicap||0)>score[1]?'h':'a')===record.selection),'SCORE');
  check(typeof record.quoteHash==='string'&&/^[a-f0-9]{64}$/.test(record.quoteHash)&&Number.isFinite(Date.parse(record.quoteObservedAt))&&Date.parse(record.quoteObservedAt)<=Date.parse(asOf),'FROZEN_QUOTE');
 }
 const legacy=eligible.map(({research,strategy,...record})=>{void research;void strategy;return record;});
 return policy.combinations(legacy,size).map(combo=>({...combo,strategy:VERSION,source:'frozen-reviewed-singles',modelProbability:null,expectedValue:null,formalEligible:false,
  legs:combo.legs.map(leg=>({...leg,singleHash:coreHash(records.find(record=>record.eventId===leg.eventId)),quoteHash:records.find(record=>record.eventId===leg.eventId).quoteHash})),
  limitations:['组合SP不是命中概率或预期收益',...(combo.legs.length?[]:['没有满足证据与质量策略的组合；不改方向凑档'])]}));
}
module.exports={combinations,coreHash};
