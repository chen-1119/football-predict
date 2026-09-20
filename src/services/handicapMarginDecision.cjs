'use strict';

const VERSION = 'handicap-margin-v2';
const LEGACY_VERSION = 'handicap-margin-v1';
const { calibrateHandicapProbabilities, applyResidual } = require('./handicapCalibration.cjs');
const CODES = Object.freeze(['1','X','2']);
const MAX_QUOTE_AGE_MS = 15 * 60_000;
const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())))
  && Number.isFinite(Number(value)) ? Number(value) : null;
const instant = value => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const round = (value, digits=6) => Number(value.toFixed(digits));

function parseLine(value) {
  const n = finite(value);
  return n !== null && Number.isSafeInteger(n) && n !== 0 ? n : null;
}
function completeOdds(value) {
  if (!value || typeof value !== 'object') return null;
  const odds = {'1':finite(value['1'] ?? value.odds1), X:finite(value.X ?? value.oddsX), '2':finite(value['2'] ?? value.odds2)};
  return CODES.every(code => odds[code] !== null && odds[code] > 1) ? odds : null;
}
function devig(odds) {
  if (!odds) return null;
  const inv = Object.fromEntries(CODES.map(code => [code, 1 / odds[code]]));
  const total = CODES.reduce((sum, code) => sum + inv[code], 0);
  return Object.fromEntries(CODES.map(code => [code, round(inv[code] / total)]));
}
function topCode(probabilities) {
  if (!probabilities) return null;
  const ranked=CODES.map((code,index)=>({code,index,p:probabilities[code]})).sort((a,b)=>b.p-a.p||a.index-b.index);
  return Math.abs(ranked[0].p-ranked[1].p)<=1e-12 ? null : ranked[0].code;
}
function poisson(lambda) {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 12) return null;
  const target = 1 - 1e-12, max = Math.min(36, Math.max(12, Math.ceil(lambda + 10 * Math.sqrt(lambda + 1))));
  const values=[Math.exp(-lambda)]; let sum=values[0];
  for(let k=1;k<=max;k++){values.push(values[k-1]*lambda/k);sum+=values[k];if(k>=10&&sum>=target)break;}
  return {values,mass:sum};
}
function lambdasFor(model) {
  const options=[
    ['calculationTrace.poisson.lambdas',model?.calculationTrace?.poisson?.lambdas?.home,model?.calculationTrace?.poisson?.lambdas?.away],
    ['calculationTrace.expectedGoals.final',model?.calculationTrace?.expectedGoals?.values?.finalHome,model?.calculationTrace?.expectedGoals?.values?.finalAway],
    ['lambdaBlend.market',model?.lambdaBlend?.marketHomeLambda,model?.lambdaBlend?.marketAwayLambda],
  ];
  for(const [source,h,a] of options){
    const home=finite(h),away=finite(a);
    if(home!==null&&away!==null&&home>=0&&away>=0&&home<=12&&away<=12)return {home,away,source};
  }
  return null;
}
function marginDistribution(homeLambda, awayLambda, line) {
  if (parseLine(line) === null) return null;
  const home=poisson(homeLambda),away=poisson(awayLambda);
  if(!home||!away)return null;
  const probabilities={'1':0,X:0,'2':0}, margins=new Map(); let captured=0;
  for(let h=0;h<home.values.length;h++)for(let a=0;a<away.values.length;a++){
    const p=home.values[h]*away.values[a]; captured+=p;
    const margin=h-a; margins.set(margin,(margins.get(margin)||0)+p);
    const adjusted=margin+line;
    probabilities[adjusted>0?'1':adjusted<0?'2':'X']+=p;
  }
  if(captured<=0)return null;
  for(const code of CODES)probabilities[code]=round(probabilities[code]/captured);
  const normalization=CODES.reduce((sum,code)=>sum+probabilities[code],0);
  probabilities['2']=round(probabilities['2']+(1-normalization));
  const exactMargin=-line;
  return {probabilities,exactMargin,exactMarginProbability:round((margins.get(exactMargin)||0)/captured),
    capturedMass:round(captured,12),tailMass:round(Math.max(0,1-captured),12)};
}
function straightMatches(margin,straightTipCode){
  return straightTipCode==='1'?margin>0:straightTipCode==='2'?margin<0:straightTipCode==='X'?margin===0:false;
}
function conditionalHandicapDistribution(homeLambda,awayLambda,line,straightTipCode){
  if(parseLine(line)===null||!CODES.includes(straightTipCode))return null;
  const home=poisson(homeLambda),away=poisson(awayLambda);if(!home||!away)return null;
  const probabilities={'1':0,X:0,'2':0};let conditionedMass=0,captured=0;
  for(let h=0;h<home.values.length;h++)for(let a=0;a<away.values.length;a++){
    const p=home.values[h]*away.values[a];captured+=p;const margin=h-a;
    if(!straightMatches(margin,straightTipCode))continue;
    conditionedMass+=p;const adjusted=margin+line;probabilities[adjusted>0?'1':adjusted<0?'2':'X']+=p;
  }
  if(conditionedMass<=0)return null;
  for(const code of CODES)probabilities[code]=round(probabilities[code]/conditionedMass);
  const sum=CODES.reduce((total,code)=>total+probabilities[code],0);
  const supported=CODES.filter(code=>probabilities[code]>0);
  if(supported.length)probabilities[supported[supported.length-1]]=round(probabilities[supported[supported.length-1]]+(1-sum));
  return {probabilities,conditionedMass:round(conditionedMass/captured,12),structuralSupport:Object.fromEntries(CODES.map(code=>[code,probabilities[code]>0]))};
}
function marketFor(match, line, now, cutoff) {
  const external=match?.externalSignals?.bookmakerOdds?.hhad;
  const candidates=[
    {odds:match?.handicapOdds,line:match?.handicapLine,source:match?.handicapOddsSource,at:match?.handicapOddsReceivedAt||match?.handicapOddsObservedAt||match?.handicapOddsUpdatedAt},
    {odds:external,line:external?.handicapLine??match?.handicapLine,source:external?.source,at:external?.receivedAt||external?.observedAt||external?.updatedAt},
  ];
  for(const row of candidates){
    const rowLine=parseLine(row.line),odds=completeOdds(row.odds),at=instant(row.at);
    if(rowLine!==line||!odds||!Number.isFinite(at)||at>now||at>=cutoff||now-at>MAX_QUOTE_AGE_MS)continue;
    if(!/^(?:sporttery:HHAD|500\.com:HHAD)$/i.test(String(row.source||'')))continue;
    return {source:String(row.source),observedAt:new Date(at).toISOString(),odds,probabilities:devig(odds)};
  }
  return null;
}
function relation(straightTipCode, line, handicapTipCode) {
  if(straightTipCode==='1'&&line<0)return handicapTipCode==='1'?'home-cover':handicapTipCode==='X'?'home-land-on-line':'home-not-cover';
  if(straightTipCode==='2'&&line>0)return handicapTipCode==='2'?'away-cover':handicapTipCode==='X'?'away-land-on-line':'away-not-cover';
  if(straightTipCode==='X')return 'straight-draw-shifted-by-handicap';
  return 'handicap-independent';
}
function buildHandicapMarginDecision(match, {now,cutoffTime,straightTipCode,calibrationProfile=null}={}) {
  const line=parseLine(match?.handicapLine ?? match?.externalSignals?.bookmakerOdds?.hhad?.handicapLine);
  const cutoff=Date.parse(cutoffTime||'');
  const lambda=lambdasFor(match?.probabilityModel);
  if(line===null||!lambda||!Number.isFinite(now)||!Number.isFinite(cutoff)||now>=cutoff)return null;
  const dist=marginDistribution(lambda.home,lambda.away,line);
  const companion=conditionalHandicapDistribution(lambda.home,lambda.away,line,straightTipCode);
  if(!dist||!companion)return null;
  const calibration=calibrateHandicapProbabilities(companion.probabilities,line,straightTipCode,calibrationProfile);
  const probabilities=calibration?.probabilities||companion.probabilities;
  const tipCode=topCode(probabilities);
  const overallTipCode=topCode(dist.probabilities);
  if(!tipCode||!overallTipCode)return null;
  const favoriteCode=line<0?'1':'2',failCode=line<0?'2':'1';
  const market=marketFor(match,line,now,cutoff);
  const inputHash=require('./publishedForecastPolicy.cjs').hash({
    version:VERSION,line,lambdaHome:lambda.home,lambdaAway:lambda.away,lambdaSource:lambda.source,
    market:market?{source:market.source,observedAt:market.observedAt,odds:market.odds}:null,
    companion:{policy:'straight-conditioned-margin-v1',straightTipCode,rawProbabilities:companion.probabilities},
    calibration:calibration?{profileHash:calibration.applied?calibration.profileHash:null,key:calibration.key,applied:calibration.applied,weight:calibration.weight||null,residual:calibration.residual||null}:null,
  });
  return {
    version:VERSION,market:'HHAD',handicapLine:line,handicapLineText:line>0?('+'+line):String(line),
    companionPolicyVersion:'straight-conditioned-margin-v1',probabilityBasis:'conditional-on-straight-primary',
    tipCode,companionRawProbabilities:companion.probabilities,rawProbabilities:companion.probabilities,probabilities,modelProbability:probabilities[tipCode],
    overallProbabilities:dist.probabilities,overallTipCode,overallModelProbability:dist.probabilities[overallTipCode],
    runnerUpProbability:CODES.filter(code=>code!==tipCode).map(code=>probabilities[code]).sort((a,b)=>b-a)[0],
    modelGap:round(probabilities[tipCode]-CODES.filter(code=>code!==tipCode).map(code=>probabilities[code]).sort((a,b)=>b-a)[0]),
    favoriteCode,coverProbability:probabilities[favoriteCode],landOnLineProbability:probabilities.X,
    failCoverProbability:probabilities[failCode],exactMargin:dist.exactMargin,exactMarginProbability:companion.probabilities.X,
    straightTipCode:CODES.includes(straightTipCode)?straightTipCode:null,relation:relation(straightTipCode,line,tipCode),
    lambdas:{home:lambda.home,away:lambda.away,source:lambda.source},capturedMass:dist.capturedMass,tailMass:dist.tailMass,straightConditionedMass:companion.conditionedMass,
    marketReference:market?{source:market.source,observedAt:market.observedAt,odds:market.odds,probabilities:market.probabilities,
      selectedOdds:market.odds[tipCode],selectedProbability:market.probabilities[tipCode],aligned:topCode(market.probabilities)===tipCode}:null,
    calibration:'unvalidated',historicalCalibration:{version:'handicap-calibration-v2',applied:Boolean(calibration?.applied),profileHash:calibration?.applied?calibration?.profileHash||null:null,key:calibration?.key||null,reason:calibration?.reason||null,weight:calibration?.weight||null,residual:calibration?.residual||null,metrics:calibration?.metrics||null},inputHash,
  };
}
function validHandicapMarginDecision(value) {
  if(!value)return true;
  try{
    if(![VERSION,LEGACY_VERSION].includes(value.version)||value.market!=='HHAD'||parseLine(value.handicapLine)===null||!CODES.includes(value.tipCode))return false;
    if(value.version===LEGACY_VERSION){
      const p=value.probabilities,raw=value.rawProbabilities||p;if(!p||!raw||!CODES.every(code=>typeof p[code]==='number'&&Number.isFinite(p[code])&&p[code]>=0&&p[code]<=1&&typeof raw[code]==='number'&&Number.isFinite(raw[code])&&raw[code]>=0&&raw[code]<=1))return false;
      if(Math.abs(CODES.reduce((sum,c)=>sum+p[c],0)-1)>1e-6||topCode(p)!==value.tipCode||Math.abs(p[value.tipCode]-value.modelProbability)>1e-9)return false;
      return Boolean(value.lambdas&&Number.isFinite(value.lambdas.home)&&Number.isFinite(value.lambdas.away)&&value.exactMargin===-value.handicapLine&&typeof value.inputHash==='string'&&/^[a-f0-9]{64}$/.test(value.inputHash));
    }
    if(value.companionPolicyVersion!=='straight-conditioned-margin-v1'||value.probabilityBasis!=='conditional-on-straight-primary'||!CODES.includes(value.straightTipCode))return false;
    const p=value.probabilities,raw=value.companionRawProbabilities||value.rawProbabilities,overall=value.overallProbabilities;
    if(!p||!raw||!overall||!CODES.every(code=>typeof p[code]==='number'&&Number.isFinite(p[code])&&p[code]>=0&&p[code]<=1&&typeof raw[code]==='number'&&Number.isFinite(raw[code])&&raw[code]>=0&&raw[code]<=1&&typeof overall[code]==='number'&&Number.isFinite(overall[code])&&overall[code]>=0&&overall[code]<=1))return false;
    if(Math.abs(CODES.reduce((sum,c)=>sum+p[c],0)-1)>1e-6||Math.abs(CODES.reduce((sum,c)=>sum+raw[c],0)-1)>1e-6||Math.abs(CODES.reduce((sum,c)=>sum+overall[c],0)-1)>1e-6||topCode(p)!==value.tipCode||topCode(overall)!==value.overallTipCode||Math.abs(p[value.tipCode]-value.modelProbability)>1e-9)return false;
    if(!value.lambdas||!Number.isFinite(value.lambdas.home)||!Number.isFinite(value.lambdas.away)||value.lambdas.home<0||value.lambdas.away<0)return false;
    const recomputedRaw=conditionalHandicapDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine,value.straightTipCode);
    if(!recomputedRaw||CODES.some(code=>Math.abs(recomputedRaw.probabilities[code]-raw[code])>1e-6))return false;
    const hc=value.historicalCalibration;
    if(hc?.applied){
      if(hc.version!=='handicap-calibration-v2'||!/^[a-f0-9]{64}$/.test(String(hc.profileHash||''))||!hc.residual||!Number.isFinite(hc.weight))return false;
      const recomputed=applyResidual(raw,hc.residual,hc.weight,true);
      if(CODES.some(code=>Math.abs(recomputed[code]-p[code])>1e-6))return false;
    }else if(CODES.some(code=>Math.abs(raw[code]-p[code])>1e-6))return false;
    if(value.exactMargin!==-value.handicapLine||typeof value.inputHash!=='string'||!/^[a-f0-9]{64}$/.test(value.inputHash))return false;
    if(value.marketReference){
      const odds=completeOdds(value.marketReference.odds);if(!odds||!Number.isFinite(instant(value.marketReference.observedAt)))return false;
      if(value.marketReference.selectedOdds!==odds[value.tipCode])return false;
    }
    return true;
  }catch{return false;}
}
module.exports={VERSION,LEGACY_VERSION,CODES,MAX_QUOTE_AGE_MS,parseLine,devig,lambdasFor,marginDistribution,conditionalHandicapDistribution,buildHandicapMarginDecision,validHandicapMarginDecision};
