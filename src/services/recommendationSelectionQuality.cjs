'use strict';
const {validInputEvidence}=require('./recommendationInputEvidence.cjs');
const VERSION='recommendation-selection-quality-v1';
const CODES=['1','X','2'];
/** Admission checks model input readiness. SP and edge remain diagnostics:
 * the available frozen cohort does not validate an SP/EV exclusion rule. */
function selectionQuality(decision,selection=null){
 const model=decision?.inputEvidence?.model,e=model?.inputEvidence;
 const bound=Boolean(decision?.selectionPolicyVersion===VERSION&&e&&validInputEvidence(e,model,decision));
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
 return {version:VERSION,status:reasons.length?'watch':'reference-qualified',qualified:reasons.length===0,reasons,
  inputEvidenceHash:bound?e.contentHash:null,samples:bound?e.samples:null,weights:bound?e.weights:null,arithmeticStatus:bound?e.arithmetic.status:'unknown',
  probabilityLead:numeric?p[tip]-Math.max(...CODES.filter(c=>c!==tip).map(c=>p[c])):null,
  marketProbability:market?market[tip]:null,modelMarketGap:market?p[tip]-market[tip]:null,
  expectedValue:numeric?p[tip]*q[tip]-1:null,marketFavorite:favorite.includes(tip),marketFavoriteCodes:favorite,
  validation:'unvalidated',priceFilterApplied:false};
}
function isQualifiedSelection({decision,selection}){return selectionQuality(decision,selection).qualified;}
module.exports={VERSION,selectionQuality,isQualifiedSelection};
