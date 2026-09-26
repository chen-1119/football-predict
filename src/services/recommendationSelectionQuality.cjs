'use strict';
const {validInputEvidence}=require('./recommendationInputEvidence.cjs');
const LEGACY_VERSION='recommendation-selection-quality-v1';
const VERSION='recommendation-selection-quality-v2';
const CODES=['1','X','2'];
// A weak top direction or a large disagreement with the same frozen official
// market is a reason to abstain, not a reason to replace it with a long shot.
// These are prospective safety checks, not an estimated improvement in ROI.
const MIN_PROBABILITY_LEAD=0.06;
const MATERIAL_MARKET_GAP=-0.10;
const MATERIAL_MODEL_EV=-0.15;
function prospectiveRiskReasons({probabilityLead,modelMarketGap,expectedValue}){
 const reasons=[];
 if(probabilityLead===null||probabilityLead<MIN_PROBABILITY_LEAD)reasons.push('model-lead-too-thin');
 if(modelMarketGap!==null&&expectedValue!==null
   &&modelMarketGap<=MATERIAL_MARKET_GAP&&expectedValue<=MATERIAL_MODEL_EV)
  reasons.push('material-model-market-disagreement');
 return reasons;
}
/** Old decisions retain their original input-only admission policy. New
 * decisions additionally withhold thin or materially contradicted selections. */
function selectionQuality(decision,selection=null){
 const model=decision?.inputEvidence?.model,e=model?.inputEvidence;
 const policy=decision?.selectionPolicyVersion;
 const isV2=policy===VERSION;
 const bound=Boolean([LEGACY_VERSION,VERSION].includes(policy)&&e&&validInputEvidence(e,model,decision));
 const verified=bound&&e.arithmetic.status==='verified';
 const eloReady=Boolean(verified&&e.weights.elo>0&&e.samples.elo.home>=6&&e.samples.elo.away>=6);
 const formReady=Boolean(verified&&e.weights.form>0&&e.weights.poisson>0&&e.samples.form.home>=8&&e.samples.form.away>=8);
 const reasons=[];
 if(!bound)reasons.push('input-evidence-unavailable');
 else if(!verified)reasons.push('input-arithmetic-unverified');
 else if(!eloReady&&!formReady)reasons.push('team-samples-insufficient');
 const p=selection?.probabilities||decision?.probabilities,q=selection?.quoteOdds||decision?.quoteOdds,tip=selection?.tipCode||decision?.tipCode;
 const numeric=Boolean(p&&q&&CODES.includes(tip)&&CODES.every(c=>typeof p[c]==='number'&&Number.isFinite(p[c])&&p[c]>=0&&typeof q[c]==='number'&&Number.isFinite(q[c])&&q[c]>1));
 const total=numeric?CODES.reduce((s,c)=>s+1/q[c],0):null;
 const market=numeric?Object.fromEntries(CODES.map(c=>[c,(1/q[c])/total])):null;
 const favorite=market?CODES.filter(c=>CODES.every(other=>market[c]>=market[other]-1e-12)):[];
 const probabilityLead=numeric?p[tip]-Math.max(...CODES.filter(c=>c!==tip).map(c=>p[c])):null;
 const modelMarketGap=market?p[tip]-market[tip]:null;
 const expectedValue=numeric?p[tip]*q[tip]-1:null;
 if(isV2)reasons.push(...prospectiveRiskReasons({probabilityLead,modelMarketGap,expectedValue}));
 return {version:isV2?VERSION:LEGACY_VERSION,status:reasons.length?'watch':'reference-qualified',qualified:reasons.length===0,reasons,
  inputEvidenceHash:bound?e.contentHash:null,samples:bound?e.samples:null,weights:bound?e.weights:null,arithmeticStatus:bound?e.arithmetic.status:'unknown',
  probabilityLead,marketProbability:market?market[tip]:null,modelMarketGap,
  expectedValue,marketFavorite:favorite.includes(tip),marketFavoriteCodes:favorite,
  validation:'unvalidated',priceFilterApplied:isV2};
}
function isQualifiedSelection({decision,selection}){return selectionQuality(decision,selection).qualified;}
module.exports={VERSION,LEGACY_VERSION,MIN_PROBABILITY_LEAD,MATERIAL_MARKET_GAP,MATERIAL_MODEL_EV,prospectiveRiskReasons,selectionQuality,isQualifiedSelection};
