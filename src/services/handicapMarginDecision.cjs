'use strict';

const VERSION = 'handicap-margin-v3';
const COMPANION_VERSION = 'handicap-margin-v2';
const LEGACY_VERSION = 'handicap-margin-v1';
const DISTRIBUTION_BASIS = 'had-calibrated-poisson-score-matrix-v1';
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
function normalizedStraight(value) {
  return require('./publishedForecastPolicy.cjs').probabilities(value);
}
function roundedProbabilities(p) {
  const out=Object.fromEntries(CODES.map(c=>[c,round(p[c])]));
  const largest=CODES.slice().sort((a,b)=>out[b]-out[a])[0];
  out[largest]=round(out[largest]+1-CODES.reduce((s,c)=>s+out[c],0));
  return out;
}
/** Preserve each Poisson score ratio within its HAD region, while making that
 * region's mass equal the frozen final HAD probability. An optional calibrated
 * companion split changes only cells inside its HAD region, never that region's
 * mass. Both published HHAD views therefore refer to the same distribution. */
function coherentHandicapDistribution(homeLambda,awayLambda,line,straight,straightTipCode,conditionedTarget=null) {
  const target=normalizedStraight(straight),home=poisson(homeLambda),away=poisson(awayLambda);
  if(!target||!home||!away||parseLine(line)===null||!CODES.includes(straightTipCode))return null;
  const joint=Object.fromEntries(CODES.map(c=>[c,{'1':0,X:0,'2':0}]));
  const baseStraight={'1':0,X:0,'2':0};let captured=0;
  for(let h=0;h<home.values.length;h++)for(let a=0;a<away.values.length;a++){
    const mass=home.values[h]*away.values[a],margin=h-a,had=margin>0?'1':margin<0?'2':'X',adjusted=margin+line;
    captured+=mass;baseStraight[had]+=mass;joint[had][adjusted>0?'1':adjusted<0?'2':'X']+=mass;
  }
  if(captured<=0||target[straightTipCode]<=0)return null;
  for(const had of CODES){
    if(baseStraight[had]===0&&target[had]>0)return null;
    for(const hhad of CODES)joint[had][hhad]=baseStraight[had]>0?joint[had][hhad]*target[had]/baseStraight[had]:0;
  }
  if(conditionedTarget){
    const adjusted=normalizedStraight(conditionedTarget);if(!adjusted)return null;
    for(const c of CODES){
      if(joint[straightTipCode][c]===0&&adjusted[c]>0)return null;
      joint[straightTipCode][c]=target[straightTipCode]*adjusted[c];
    }
  }
  const overall=Object.fromEntries(CODES.map(c=>[c,CODES.reduce((s,had)=>s+joint[had][c],0)]));
  const conditional=Object.fromEntries(CODES.map(c=>[c,joint[straightTipCode][c]/target[straightTipCode]]));
  return {probabilities:roundedProbabilities(overall),conditionalProbabilities:roundedProbabilities(conditional),
    straightProbabilities:target,jointProbabilities:joint,conditionedMass:target[straightTipCode],
    structuralSupport:Object.fromEntries(CODES.map(c=>[c,joint[straightTipCode][c]>0])),
    exactMargin:-line,exactMarginProbability:round(overall.X),capturedMass:round(captured,12),tailMass:round(Math.max(0,1-captured),12)};
}
function officialHandicapSources(match, now, cutoff) {
  const external=match?.externalSignals?.bookmakerOdds?.hhad;
  const candidates=[
    {odds:match?.handicapOdds,line:match?.handicapLine,source:match?.handicapOddsSource,at:match?.handicapOddsReceivedAt||match?.handicapOddsObservedAt||match?.handicapOddsUpdatedAt},
    {odds:external,line:external?.handicapLine,source:external?.source,at:external?.receivedAt||external?.observedAt||external?.updatedAt,
      sourceMatchId:external?.sourceMatchId,eventVersion:external?.eventVersion},
  ];
  const sourceId=value=>String(value||'').replace(/^sporttery_/, '');
  const event=instant(match?.eventVersion||match?.kickoffTime);
  return candidates.filter(row=>{
    const at=instant(row.at);
    return row.source==='sporttery:HHAD' && parseLine(row.line)!==null
      && Number.isFinite(at) && at<=now && at<cutoff
      && (row.sourceMatchId==null||sourceId(row.sourceMatchId)===sourceId(match?.sourceMatchId||match?.id))
      && (row.eventVersion==null||(Number.isFinite(event)&&instant(row.eventVersion)===event));
  });
}
function officialHandicapLine(match, now, cutoff) {
  const rows=officialHandicapSources(match,now,cutoff);
  const lines=new Set(rows.map(row=>parseLine(row.line)));
  // A numeric value alone is not authority for an official three-way handicap.
  // Conflicting current source records must be reconciled before deriving a pick.
  return lines.size===1?[...lines][0]:null;
}
function marketFor(match, line, now, cutoff) {
  const candidates=officialHandicapSources(match,now,cutoff);
  for(const row of candidates){
    const rowLine=parseLine(row.line),odds=completeOdds(row.odds),at=instant(row.at);
    if(rowLine!==line||!odds||!Number.isFinite(at)||at>now||at>=cutoff||now-at>MAX_QUOTE_AGE_MS)continue;
    if(String(row.source||'')!=='sporttery:HHAD')continue;
    return {source:String(row.source),handicapLine:line,observedAt:new Date(at).toISOString(),odds,probabilities:devig(odds)};
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
  const cutoff=Date.parse(cutoffTime||'');
  const line=officialHandicapLine(match,now,cutoff);
  const lambda=lambdasFor(match?.probabilityModel);
  if(line===null||!lambda||!Number.isFinite(now)||!Number.isFinite(cutoff)||now>=cutoff)return null;
  const straight=normalizedStraight(match?.probabilityModel?.oneXTwo?.final);
  if(!straight||!CODES.includes(straightTipCode)||!(straight[straightTipCode]>0))return null;
  const rawDist=coherentHandicapDistribution(lambda.home,lambda.away,line,match?.probabilityModel?.oneXTwo?.final,straightTipCode);
  if(!rawDist)return null;
  const raw=rawDist.conditionalProbabilities;
  const profileAt=instant(calibrationProfile?.asOf);
  const calibration=calibrateHandicapProbabilities(raw,line,straightTipCode,Number.isFinite(profileAt)&&profileAt<=now?calibrationProfile:null);
  const dist=calibration?.applied?coherentHandicapDistribution(lambda.home,lambda.away,line,rawDist.straightProbabilities,straightTipCode,calibration.probabilities):rawDist;
  if(!dist)return null;
  const probabilities=dist.conditionalProbabilities;
  const tipCode=topCode(probabilities);
  const overallTipCode=topCode(dist.probabilities);
  if(!tipCode||!overallTipCode)return null;
  const favoriteCode=line<0?'1':'2',failCode=line<0?'2':'1';
  const market=marketFor(match,line,now,cutoff);
  const value={
    version:VERSION,market:'HHAD',handicapLine:line,handicapLineText:line>0?('+'+line):String(line),
    distributionBasis:DISTRIBUTION_BASIS,straightProbabilities:rawDist.straightProbabilities,
    computedAt:new Date(now).toISOString(),cutoffTime:new Date(cutoff).toISOString(),
    companionPolicyVersion:'straight-conditioned-margin-v1',probabilityBasis:'conditional-on-straight-primary',
    tipCode,companionRawProbabilities:raw,rawProbabilities:raw,probabilities,modelProbability:probabilities[tipCode],
    overallRawProbabilities:rawDist.probabilities,overallProbabilities:dist.probabilities,overallTipCode,overallModelProbability:dist.probabilities[overallTipCode],
    runnerUpProbability:CODES.filter(code=>code!==tipCode).map(code=>probabilities[code]).sort((a,b)=>b-a)[0],
    modelGap:round(probabilities[tipCode]-CODES.filter(code=>code!==tipCode).map(code=>probabilities[code]).sort((a,b)=>b-a)[0]),
    favoriteCode,coverProbability:probabilities[favoriteCode],landOnLineProbability:probabilities.X,
    failCoverProbability:probabilities[failCode],exactMargin:dist.exactMargin,exactMarginProbability:probabilities.X,
    straightTipCode:CODES.includes(straightTipCode)?straightTipCode:null,relation:relation(straightTipCode,line,tipCode),
    lambdas:{home:lambda.home,away:lambda.away,source:lambda.source},capturedMass:dist.capturedMass,tailMass:dist.tailMass,straightConditionedMass:dist.conditionedMass,
    marketReference:market?{source:market.source,handicapLine:line,observedAt:market.observedAt,odds:market.odds,probabilities:market.probabilities,
      selectedOdds:market.odds[tipCode],selectedProbability:market.probabilities[tipCode],aligned:topCode(market.probabilities)===tipCode}:null,
    calibration:'unvalidated',historicalCalibration:{version:'handicap-calibration-v2',applied:Boolean(calibration?.applied),profileHash:calibration?.applied?calibration?.profileHash||null:null,key:calibration?.key||null,reason:calibration?.reason||null,weight:calibration?.weight||null,residual:calibration?.residual||null,metrics:calibration?.metrics||null},
  };
  value.inputHash=handicapInputHash(value);return value;
}
function handicapInputHash(value) {
  const market=value.marketReference,hc=value.historicalCalibration;
  const inputs={version:value.version,line:value.handicapLine,lambdaHome:value.lambdas.home,lambdaAway:value.lambdas.away,lambdaSource:value.lambdas.source,
    market:market?{source:market.source,observedAt:market.observedAt,odds:market.odds,...(value.version===VERSION?{handicapLine:market.handicapLine}:{})}:null,
    companion:{policy:value.companionPolicyVersion,straightTipCode:value.straightTipCode,rawProbabilities:value.companionRawProbabilities},
    calibration:hc?{profileHash:hc.applied?hc.profileHash:null,key:hc.key,applied:hc.applied,weight:hc.weight||null,residual:hc.residual||null}:null};
  if(value.version===VERSION)Object.assign(inputs,{distributionBasis:value.distributionBasis,straightProbabilities:value.straightProbabilities,cutoffTime:value.cutoffTime});
  return require('./publishedForecastPolicy.cjs').hash(inputs);
}
function validHandicapMarginDecision(value) {
  if(!value)return true;
  try{
    if(![VERSION,COMPANION_VERSION,LEGACY_VERSION].includes(value.version)||value.market!=='HHAD'||parseLine(value.handicapLine)===null||!CODES.includes(value.tipCode))return false;
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
    const coherent=value.version===VERSION;
    const matrix=coherent?coherentHandicapDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine,value.straightProbabilities,value.straightTipCode):null;
    if(coherent&&(!matrix||value.distributionBasis!==DISTRIBUTION_BASIS||!Number.isFinite(instant(value.computedAt))||!Number.isFinite(instant(value.cutoffTime))||instant(value.computedAt)>=instant(value.cutoffTime)))return false;
    const recomputedRaw=coherent?{probabilities:matrix.conditionalProbabilities}:conditionalHandicapDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine,value.straightTipCode);
    if(!recomputedRaw||CODES.some(code=>Math.abs(recomputedRaw.probabilities[code]-raw[code])>1e-6))return false;
    const hc=value.historicalCalibration;
    if(hc?.applied){
      if(hc.version!=='handicap-calibration-v2'||!/^[a-f0-9]{64}$/.test(String(hc.profileHash||''))||!hc.residual||!Number.isFinite(hc.weight))return false;
      const residual=applyResidual(raw,hc.residual,hc.weight,true);
      const recomputed=coherent?coherentHandicapDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine,value.straightProbabilities,value.straightTipCode,residual)?.conditionalProbabilities:residual;
      if(!recomputed||CODES.some(code=>Math.abs(recomputed[code]-p[code])>1e-6+1e-12))return false;
    }else if(CODES.some(code=>Math.abs(raw[code]-p[code])>1e-6))return false;
    const full=coherent?(hc?.applied?coherentHandicapDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine,value.straightProbabilities,value.straightTipCode,p):matrix):marginDistribution(value.lambdas.home,value.lambdas.away,value.handicapLine);
    if(!full||CODES.some(code=>Math.abs(full.probabilities[code]-overall[code])>1e-6))return false;
    if(coherent){
      if(!value.overallRawProbabilities||CODES.some(code=>typeof value.straightProbabilities[code]!=='number'||!Number.isFinite(value.straightProbabilities[code])||typeof value.overallRawProbabilities[code]!=='number'||!Number.isFinite(value.overallRawProbabilities[code])||Math.abs(matrix.straightProbabilities[code]-value.straightProbabilities[code])>1e-9||Math.abs(matrix.probabilities[code]-value.overallRawProbabilities[code])>1e-6))return false;
      if(['straightConditionedMass','overallModelProbability','exactMarginProbability','capturedMass','tailMass','coverProbability','landOnLineProbability','failCoverProbability','modelGap','runnerUpProbability'].some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k])))return false;
      if(Math.abs(value.straightConditionedMass-matrix.conditionedMass)>1e-9||Math.abs(value.overallModelProbability-overall[value.overallTipCode])>1e-9||Math.abs(value.exactMarginProbability-p.X)>1e-9)return false;
      const second=Math.max(...CODES.filter(c=>c!==value.tipCode).map(c=>p[c])),favorite=value.handicapLine<0?'1':'2',fail=value.handicapLine<0?'2':'1';
      if(value.favoriteCode!==favorite||value.coverProbability!==p[favorite]||value.landOnLineProbability!==p.X||value.failCoverProbability!==p[fail]||value.runnerUpProbability!==second||value.modelGap!==round(p[value.tipCode]-second)||value.capturedMass!==matrix.capturedMass||value.tailMass!==matrix.tailMass)return false;
      if(value.handicapLineText!==(value.handicapLine>0?'+'+value.handicapLine:String(value.handicapLine))||value.relation!==relation(value.straightTipCode,value.handicapLine,value.tipCode))return false;
      if(hc?.applied&&(!(hc.weight>0&&hc.weight<=.65)||!CODES.every(c=>typeof hc.residual[c]==='number'&&Number.isFinite(hc.residual[c])&&Math.abs(hc.residual[c])<=.12)||!(hc.metrics?.sampleDays>=4&&hc.metrics?.holdoutDays>=2&&hc.metrics?.holdout>=6)))return false;
    }
    if(value.exactMargin!==-value.handicapLine||typeof value.inputHash!=='string'||!/^[a-f0-9]{64}$/.test(value.inputHash))return false;
    if(value.marketReference){
      const odds=completeOdds(value.marketReference.odds);if(!odds||!Number.isFinite(instant(value.marketReference.observedAt)))return false;
      if(value.marketReference.selectedOdds!==odds[value.tipCode])return false;
      if(coherent){
        const market=value.marketReference,at=instant(market.observedAt),now=instant(value.computedAt);
        if(market.source!=='sporttery:HHAD'||market.handicapLine!==value.handicapLine||at>now||at>=instant(value.cutoffTime)||now-at>MAX_QUOTE_AGE_MS)return false;
        const marketP=devig(odds);
        if(!market.probabilities||CODES.some(c=>market.probabilities[c]!==marketP[c])||market.selectedProbability!==marketP[value.tipCode]||market.aligned!==(topCode(marketP)===value.tipCode))return false;
      }
    }
    if(value.inputHash!==handicapInputHash(value))return false;
    return true;
  }catch{return false;}
}
module.exports={VERSION,COMPANION_VERSION,LEGACY_VERSION,DISTRIBUTION_BASIS,CODES,MAX_QUOTE_AGE_MS,parseLine,devig,lambdasFor,marginDistribution,conditionalHandicapDistribution,normalizedStraight,coherentHandicapDistribution,buildHandicapMarginDecision,validHandicapMarginDecision};
