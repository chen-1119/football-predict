'use strict';

const VERSION='had-value-selection-v1';
const CODES=Object.freeze(['1','X','2']);
const THRESHOLDS=Object.freeze({
  draw:Object.freeze({minProbability:.28,minMarketEdge:.045,minExpectedValue:.06,maxGapToModelLeader:.14}),
  underdog:Object.freeze({minProbability:.24,minMarketEdge:.055,minExpectedValue:.08,maxGapToModelLeader:.15}),
});
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const vector=p=>p&&CODES.every(c=>number(p[c])!==null&&p[c]>=0&&p[c]<=1)
  &&Math.abs(CODES.reduce((s,c)=>s+p[c],0)-1)<=1e-6;
const oddsVector=o=>o&&CODES.every(c=>number(o[c])!==null&&o[c]>1);
function uniqueTop(p){
  if(!vector(p))return null;
  const ranked=CODES.slice().sort((a,b)=>p[b]-p[a]||CODES.indexOf(a)-CODES.indexOf(b));
  return p[ranked[0]]-p[ranked[1]]>1e-12?ranked[0]:null;
}
function marketProbabilities(odds){
  if(!oddsVector(odds))return null;
  const inv=Object.fromEntries(CODES.map(c=>[c,1/odds[c]]));
  const total=CODES.reduce((s,c)=>s+inv[c],0);
  return Object.fromEntries(CODES.map(c=>[c,inv[c]/total]));
}
function candidateStats(code,p,odds,market,modelLeader,marketLeader){
  const probability=p[code],marketProbability=market[code],marketEdge=probability-marketProbability;
  const expectedValue=probability*odds[code]-1;
  const gapToModelLeader=p[modelLeader]-probability;
  const kind=code==='X'?'draw':'underdog';
  const t=THRESHOLDS[kind];
  const qualifies=code!==marketLeader
    && probability>=t.minProbability
    && marketEdge>=t.minMarketEdge
    && expectedValue>=t.minExpectedValue
    && gapToModelLeader<=t.maxGapToModelLeader;
  return {code,kind,probability,marketProbability,marketEdge,expectedValue,gapToModelLeader,qualifies,thresholds:t};
}
function selectionClass(code,marketLeader,mode){
  if(mode==='market-dislocation')return code==='X'?'draw-value':'underdog-value';
  if(code==='X')return 'model-draw';
  if(marketLeader&&code!==marketLeader)return 'model-underdog';
  return 'market-favorite';
}
/**
 * The selector never creates a quota for draws/upsets. It only permits a
 * non-market-favourite to replace the model leader when the same frozen model
 * gives that outcome a material positive edge versus the same frozen SP.
 */
function chooseHadSelection(probabilities,quoteOdds){
  if(!vector(probabilities)||!oddsVector(quoteOdds))return null;
  const modelLeader=uniqueTop(probabilities),market=marketProbabilities(quoteOdds),marketLeader=uniqueTop(market);
  if(!modelLeader||!market)return null;
  let tipCode=modelLeader,mode='model-leader',promoted=null;
  const considered=[];
  if(marketLeader&&modelLeader===marketLeader){
    for(const code of CODES){
      if(code===marketLeader)continue;
      const row=candidateStats(code,probabilities,quoteOdds,market,modelLeader,marketLeader);
      considered.push(row);
    }
    const qualified=considered.filter(row=>row.qualifies).sort((a,b)=>
      b.marketEdge-a.marketEdge || b.expectedValue-a.expectedValue || b.probability-a.probability || CODES.indexOf(a.code)-CODES.indexOf(b.code));
    if(qualified[0]){
      tipCode=qualified[0].code;
      mode='market-dislocation';
      promoted=qualified[0];
    }
  }
  const evidence={
    version:VERSION,
    mode,
    selectionClass:selectionClass(tipCode,marketLeader,mode),
    tipCode,
    modelLeader,
    marketLeader,
    probabilities:structuredClone(probabilities),
    marketProbabilities:market,
    quoteOdds:structuredClone(quoteOdds),
    selectedProbability:probabilities[tipCode],
    selectedMarketProbability:market[tipCode],
    selectedMarketEdge:probabilities[tipCode]-market[tipCode],
    selectedExpectedValue:probabilities[tipCode]*quoteOdds[tipCode]-1,
    gapToModelLeader:probabilities[modelLeader]-probabilities[tipCode],
    promoted:promoted?{
      kind:promoted.kind,
      probability:promoted.probability,
      marketProbability:promoted.marketProbability,
      marketEdge:promoted.marketEdge,
      expectedValue:promoted.expectedValue,
      gapToModelLeader:promoted.gapToModelLeader,
      thresholds:structuredClone(promoted.thresholds),
    }:null,
    considered:considered.map(row=>({
      code:row.code,kind:row.kind,probability:row.probability,marketProbability:row.marketProbability,
      marketEdge:row.marketEdge,expectedValue:row.expectedValue,gapToModelLeader:row.gapToModelLeader,qualifies:row.qualifies,
    })),
    artificialDirectionQuota:false,
    validation:'unvalidated',
  };
  return evidence;
}
function sameNumber(a,b){return typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<=1e-12;}
function validHadSelection(value,probabilities,quoteOdds){
  const expected=chooseHadSelection(probabilities,quoteOdds);
  if(!expected||!value||value.version!==VERSION)return false;
  try{
    if(value.mode!==expected.mode||value.selectionClass!==expected.selectionClass||value.tipCode!==expected.tipCode
      ||value.modelLeader!==expected.modelLeader||value.marketLeader!==expected.marketLeader
      ||value.artificialDirectionQuota!==false||value.validation!=='unvalidated')return false;
    for(const c of CODES){
      if(!sameNumber(value.probabilities?.[c],expected.probabilities[c])
        ||!sameNumber(value.marketProbabilities?.[c],expected.marketProbabilities[c])
        ||!sameNumber(value.quoteOdds?.[c],expected.quoteOdds[c]))return false;
    }
    for(const k of ['selectedProbability','selectedMarketProbability','selectedMarketEdge','selectedExpectedValue','gapToModelLeader'])
      if(!sameNumber(value[k],expected[k]))return false;
    if(Boolean(value.promoted)!==Boolean(expected.promoted))return false;
    if(value.promoted){
      for(const k of ['kind'])if(value.promoted[k]!==expected.promoted[k])return false;
      for(const k of ['probability','marketProbability','marketEdge','expectedValue','gapToModelLeader'])
        if(!sameNumber(value.promoted[k],expected.promoted[k]))return false;
      for(const k of Object.keys(expected.promoted.thresholds))
        if(!sameNumber(value.promoted.thresholds?.[k],expected.promoted.thresholds[k]))return false;
    }
    return true;
  }catch{return false;}
}
module.exports={VERSION,CODES,THRESHOLDS,uniqueTop,marketProbabilities,chooseHadSelection,validHadSelection};
