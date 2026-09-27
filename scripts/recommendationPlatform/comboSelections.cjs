'use strict';
const {hash,time,day}=require('../../src/services/publishedForecastPolicy.cjs');
const {validHandicapMarginDecision,marginDistribution}=require('../../src/services/handicapMarginDecision.cjs');
const {applyResidual}=require('../../src/services/handicapCalibration.cjs');
const VERSION='combo-selection-v1',COMBO_VERSION='unified-combo-v3',PREVIOUS_COMBO_VERSION='unified-combo-v2',LEGACY_COMBO_VERSION='unified-combo-v1';
const hasSelections=combo=>[COMBO_VERSION,PREVIOUS_COMBO_VERSION].includes(combo?.version);
const CODES=['1','X','2'];
const same=(a,b)=>hash(a)===hash(b);
const vector=p=>p&&CODES.every(c=>typeof p[c]==='number'&&Number.isFinite(p[c])&&p[c]>=0&&p[c]<=1)&&Math.abs(CODES.reduce((s,c)=>s+p[c],0)-1)<=1e-6;
const top=p=>vector(p)?CODES.find(c=>CODES.every(other=>other===c||p[c]>p[other]+1e-12)):null;
function standaloneHandicap(h){
  if(!h||!validHandicapMarginDecision(h))return null;
  if(h.version==='handicap-margin-v3')return vector(h.overallProbabilities)?h.overallProbabilities:null;
  const raw=marginDistribution(h.lambdas?.home,h.lambdas?.away,h.handicapLine)?.probabilities;
  if(!raw)return null;
  if(h.version==='handicap-margin-v2')return vector(h.overallProbabilities)&&CODES.every(c=>Math.abs(h.overallProbabilities[c]-raw[c])<=1e-6)?h.overallProbabilities:null;
  if(h.version!=='handicap-margin-v1'||h.probabilityBasis==='conditional-on-straight-primary')return null;
  if(!vector(h.rawProbabilities||h.probabilities)||CODES.some(c=>Math.abs((h.rawProbabilities||h.probabilities)[c]-raw[c])>1e-6))return null;
  const hc=h.historicalCalibration;
  const expected=hc?.applied?applyResidual(raw,hc.residual,hc.weight,false):raw;
  return vector(h.probabilities)&&expected&&CODES.every(c=>Math.abs(h.probabilities[c]-expected[c])<=1e-6)?h.probabilities:null;
}
function selectionFor(decision,market){
  const {validDecision,units}=require('./decision.cjs');
  if(!validDecision(decision)||!['HAD','HHAD'].includes(market))return null;
  const h=decision.handicapAnalysis;
  const probabilities=market==='HAD'?decision.probabilities:standaloneHandicap(h);
  const tipCode=market==='HAD'?decision.tipCode:top(probabilities);if(!tipCode)return null;
  const quote=market==='HAD'?{odds:decision.quoteOdds,source:decision.quoteSource,observedAt:decision.quoteObservedAt}:h?.marketReference;
  const line=market==='HAD'?0:h?.handicapLine;
  if(!quote||!CODES.every(c=>units(quote.odds?.[c])!==null)||!Number.isSafeInteger(line)
    ||(market==='HHAD'&&(line===0||quote.source!=='sporttery:HHAD'||(quote.handicapLine!==undefined&&quote.handicapLine!==line))))return null;
  const quoted=time(quote.observedAt),published=time(decision.publishedAt);
  if(!Number.isFinite(quoted)||quoted>published||quoted>=time(decision.cutoffTime)||published-quoted>15*60000)return null;
  const evidence={version:VERSION,decisionId:decision.decisionId,decisionRecordHash:decision.recordHash,market,handicapLine:line,
    tipCode,odds:quote.odds[tipCode],modelProbability:probabilities[tipCode],probabilityBasis:'unconditional',
    probabilities:structuredClone(probabilities),quoteOdds:structuredClone(quote.odds),quoteObservedAt:quote.observedAt,quoteSource:quote.source};
  const body={...evidence,selectionId:`selection_${hash(evidence)}`};
  return {...body,recordHash:hash(body)};
}
function validSelection(selection,decision){
  try{const expected=selectionFor(decision,selection?.market);return Boolean(expected&&same(expected,selection));}catch{return false;}
}
function freshSelection(s,d,now){return Number.isFinite(now)&&d.businessDate===day(now)&&now>=time(d.publishedAt)&&now<Math.min(time(d.cutoffTime),time(d.kickoffTime))&&now>=time(s.quoteObservedAt)&&now-time(s.quoteObservedAt)<=15*60000;}
function candidatesFor(decision,now){return ['HAD','HHAD'].map(m=>{try{return selectionFor(decision,m);}catch{return null;}}).filter(s=>s&&freshSelection(s,decision,now)).map(selection=>({decision,selection}));}
function comboSelections(combo){
  if(hasSelections(combo))return combo.selections;
  if(combo?.version===LEGACY_COMBO_VERSION)return combo.legs;
  return null;
}
function validCombo(combo,{frozen=false,now=null}={}){
  try{
    const {validDecision,product,FLOORS}=require('./decision.cjs');
    if(![COMBO_VERSION,PREVIOUS_COMBO_VERSION,LEGACY_COMBO_VERSION].includes(combo?.version)||!FLOORS[combo.size]||!Array.isArray(combo.legs)||combo.legs.length!==combo.size
      ||!Array.isArray(combo.decisionIds)||combo.decisionIds.length!==combo.size||combo.legs.some((d,i)=>!validDecision(d)||d.decisionId!==combo.decisionIds[i]||d.businessDate!==combo.businessDate))return false;
    if(new Set(combo.legs.map(d=>d.sourceMatchId)).size!==combo.size||new Set(combo.legs.flatMap(d=>[d.homeTeamId,d.awayTeamId])).size!==combo.size*2)return false;
    const selections=comboSelections(combo);
    if(hasSelections(combo)&&(!Array.isArray(selections)||selections.length!==combo.size||!Array.isArray(combo.selectionIds)||combo.selectionIds.length!==combo.size
      ||selections.some((s,i)=>!validSelection(s,combo.legs[i])||s.selectionId!==combo.selectionIds[i])))return false;
    const quote=product(selections);
    if(!quote?.passes(FLOORS[combo.size])||combo.minimumTotalOdds!==FLOORS[combo.size]||quote.value!==combo.rawTotalOdds||Number(quote.value.toFixed(2))!==combo.totalOdds)return false;
    const identity=hasSelections(combo)?combo.selectionIds:combo.decisionIds;
    if(combo.id!==`combo_${hash([combo.version,combo.businessDate,combo.size,identity])}`)return false;
    const generated=time(combo.generatedAt),freeze=time(combo.freezeAt);
    if(!Number.isFinite(generated)||!Number.isFinite(freeze)||day(generated)!==combo.businessDate)return false;
    const midnight=Date.parse(`${combo.businessDate}T00:00:00+08:00`),dow=new Date(midnight+8*3600000).getUTCDay();
    if(freeze!==Math.min(midnight+([0,6].includes(dow)?22:21)*3600000,...combo.legs.map(d=>time(d.cutoffTime)-5*60000)))return false;
    if(hasSelections(combo)&&(combo.jointProbability!==null||combo.calibration!=='unvalidated'
      ||combo.rankingMethod!==(combo.version===COMBO_VERSION?'sum-log-unconditional-model-probability':'sum-log-unconditional-market-probability')))return false;
    if(combo.legs.some((d,i)=>!freshSelection(selections[i],d,generated)))return false;
    if(now!==null&&combo.legs.some((d,i)=>!freshSelection(selections[i],d,now)))return false;
    if(frozen){const {recordHash,...body}=combo;const at=time(combo.frozenAt);if(hash(body)!==recordHash||!Number.isFinite(at)||at<generated||at<freeze||combo.legs.some((d,i)=>!freshSelection(selections[i],d,at)))return false;}
    return true;
  }catch{return false;}
}
module.exports={VERSION,COMBO_VERSION,PREVIOUS_COMBO_VERSION,LEGACY_COMBO_VERSION,hasSelections,selectionFor,validSelection,freshSelection,candidatesFor,comboSelections,validCombo,standaloneHandicap};
