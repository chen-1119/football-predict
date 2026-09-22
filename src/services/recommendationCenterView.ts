export type Outcome = '1' | 'X' | '2';
export type ResultState = 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'DISPUTED';
export interface HandicapAnalysis {
  version:'handicap-margin-v1'|'handicap-margin-v2'|'handicap-margin-v3'; market:'HHAD'; handicapLine:number; handicapLineText:string; tipCode:Outcome;
  companionPolicyVersion?:'straight-conditioned-margin-v1'; probabilityBasis?:'conditional-on-straight-primary';
  rawProbabilities?:Record<Outcome,number>; companionRawProbabilities?:Record<Outcome,number>; probabilities:Record<Outcome,number>; modelProbability:number; modelGap:number; exactMargin:number; exactMarginProbability:number;
  overallProbabilities?:Record<Outcome,number>; overallTipCode?:Outcome; overallModelProbability?:number;
  straightProbabilities?:Record<Outcome,number>; distributionBasis?:string;
  coverProbability:number; landOnLineProbability:number; failCoverProbability:number; straightTipCode:Outcome|null; relation:string;
  lambdas:{home:number;away:number;source:string}; calibration:'unvalidated';
  marketReference?:{source:string;observedAt:string;selectedOdds:number;selectedProbability:number;aligned:boolean}|null;
  historicalCalibration?:{version:string;applied:boolean;profileHash?:string|null;key?:string|null;reason?:string|null;weight?:number|null;metrics?:{rawBrier?:number;calibratedBrier?:number;rawHitRate?:number;calibratedHitRate?:number}|null}|null;
}
export interface Decision {
  decisionId:string; sourceMatchId:string; matchId:string; eventVersion:string; businessDate:string;
  publishedAt:string; cutoffTime:string; kickoffTime:string; homeTeamName:string; awayTeamName:string;
  matchNo:string|null; tipCode:Outcome; odds:number; probabilities:Record<Outcome,number>;
  modelProbability:number; modelGeneratedAt:string; quoteObservedAt:string; recordHash:string; quoteSource?:string|null;
  handicapAnalysis?:HandicapAnalysis|null;
}
export interface Settlement { state:ResultState; score?:string|null; actual?:Outcome; resultEventId?:string|null; legs?:Array<{decisionId:string;selectionId?:string;state:ResultState;score?:string|null}> }
export interface SelectionQuality {version:'recommendation-selection-quality-v1';status:'watch'|'reference-qualified';qualified:boolean;reasons:string[];samples:{elo:{home:number|null;away:number|null};form:{home:number|null;away:number|null}}|null;probabilityLead:number|null;marketProbability:number|null;modelMarketGap:number|null;expectedValue:number|null;marketFavorite:boolean}
export interface PublishedScore {home:number;away:number;label:string;probability:number;hadCode:Outcome;hhadCode:Outcome}
export interface PublishedScores {status:'available'|'unavailable';version:'published-score-distribution-v1';decisionId:string;recordHash:string;topScores:PublishedScore[];alignedScores:PublishedScore[]}
export interface SingleRow { decision:Decision; settlement:Settlement; handicapSettlement?:Settlement|null;selectionQuality?:SelectionQuality|null;scoreDistribution?:PublishedScores|null }
export interface ComboSelection {
  version:'combo-selection-v1'; selectionId:string; decisionId:string; decisionRecordHash:string; recordHash:string;
  market:'HAD'|'HHAD'; handicapLine:number; tipCode:Outcome; odds:number; modelProbability:number;
  probabilityBasis:'unconditional'; probabilities:Record<Outcome,number>; quoteOdds:Record<Outcome,number>; quoteObservedAt:string; quoteSource:string;
}
export interface Combo { version:'unified-combo-v1'|'unified-combo-v2'; id:string; businessDate:string; size:2|3; totalOdds:number; rawTotalOdds:number; legs:Decision[]; decisionIds:string[]; selections?:ComboSelection[];selectionIds?:string[]; freezeAt:string; frozenAt?:string; generatedAt:string }
export interface ComboRow { combo:Combo; settlement:Settlement }
export interface Summary { published:number;settled:number;won:number;lost:number;pending:number;void:number;disputed:number;hitRate:number|null;brier?:number|null;logLoss?:number|null;marketBrier?:number|null }
export interface HandicapBreakdown {standaloneV1:Summary;companionV2All:Summary;companionV2WhenHadWon:Summary;companionV2BothWon:Summary;companionV3All?:Summary;companionV3WhenHadWon?:Summary;companionV3BothWon?:Summary}
export interface Lane {status:'ok'|'error';lastSuccessAt?:string;lastAttemptAt:string;errorCode?:string|null;inputAsOf?:string;candidateCount?:number;eligibleCount?:number;bindingFailures?:number;referenceCount?:number;watchCount?:number}
export interface ModelQualityReport {independentMatchDays:number;settled:number;won:number;hitRate:number|null;marketTopHitRate:number|null;brier:number|null;marketBrier:number|null;logLoss:number|null;marketLogLoss:number|null;blockers:string[];minimumSettled:number;minimumMatchDays:number}
export interface HandicapCalibrationGroup {
  key:string;rows:number;active:boolean;reason:string;bias:Record<Outcome,number>;meanRaw:Record<Outcome,number>;actualShare:Record<Outcome,number>;
  metrics?:{holdout?:number;rawBrier?:number;calibratedBrier?:number;rawLogLoss?:number;calibratedLogLoss?:number;rawHitRate?:number;calibratedHitRate?:number}|null;
}
export interface HandicapCalibrationProfile {version:string;profileHash:string;sampleRows:number;groups:Record<string,HandicapCalibrationGroup>}
export interface RecommendationCenterData {
  version:'recommendation-center-v1';updatedAt:string;businessDate:string;inputAsOf:string|null;resultAsOf:string|null;
  lanes:Partial<Record<'publish'|'combos'|'settlement'|'view',Lane>>;
  current:SingleRow[];previews:Combo[];todayCombos:ComboRow[];overlapDecisionIds:string[];
  review:{singles:SingleRow[];combos:ComboRow[];limit:number;statistics:{single:Summary;qualifiedSingle?:Summary;handicap?:Summary;handicapBreakdown?:HandicapBreakdown;two:Summary;three:Summary};qualityReport?:ModelQualityReport;handicapCalibration?:HandicapCalibrationProfile;definition:string};
  excludedCorruptRecords:number;modelValidation:'unvalidated';
}
type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid recommendation response');return v as Obj;};
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim())throw new Error('Missing recommendation field');return v;};
const number=(v:unknown):number=>{if(typeof v!=='number'||!Number.isFinite(v))throw new Error('Invalid recommendation number');return v;};
const count=(v:unknown)=>{const n=number(v);if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid count');return n;};
const stamp=(v:unknown)=>{const s=text(v);if(!Number.isFinite(Date.parse(s)))throw new Error('Invalid timestamp');return s;};
const date=(v:unknown)=>{const s=text(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)throw new Error('Invalid date');return s;};
const list=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw new Error('Missing array');return v;};
const outcome=(v:unknown):Outcome=>{if(v!=='1'&&v!=='X'&&v!=='2')throw new Error('Invalid outcome');return v;};
const state=(v:unknown):ResultState=>{if(!['PENDING','WON','LOST','VOID','DISPUTED'].includes(String(v)))throw new Error('Invalid result');return v as ResultState;};
function handicapAnalysis(v:unknown):HandicapAnalysis{
  const h=object(v),p=object(h.probabilities),probabilities={'1':number(p['1']),X:number(p.X),'2':number(p['2'])};
  if(!['handicap-margin-v1','handicap-margin-v2','handicap-margin-v3'].includes(String(h.version))||h.market!=='HHAD'||h.calibration!=='unvalidated')throw new Error('Unsupported handicap analysis');
  const handicapLine=number(h.handicapLine),tipCode=outcome(h.tipCode),modelProbability=number(h.modelProbability);
  if(!Number.isSafeInteger(handicapLine)||handicapLine===0||Object.values(probabilities).some(n=>n<0||n>1)
    ||Math.abs(probabilities['1']+probabilities.X+probabilities['2']-1)>1e-6
    ||Math.abs(probabilities[tipCode]-modelProbability)>1e-9
    ||Object.entries(probabilities).some(([c,n])=>c!==tipCode&&n>=modelProbability))throw new Error('Invalid handicap probabilities');
  const lambdas=object(h.lambdas),home=number(lambdas.home),away=number(lambdas.away);
  if(home<0||away<0||number(h.exactMargin)!==-handicapLine)throw new Error('Invalid handicap margin model');
  let marketReference:HandicapAnalysis['marketReference']=null;
  if(h.marketReference!=null){const m=object(h.marketReference);marketReference={source:text(m.source),observedAt:stamp(m.observedAt),selectedOdds:number(m.selectedOdds),selectedProbability:number(m.selectedProbability),aligned:Boolean(m.aligned)};if(marketReference.selectedOdds<=1||marketReference.selectedProbability<0||marketReference.selectedProbability>1)throw new Error('Invalid handicap market reference');}
  const parseTriplet=(value:unknown)=>{const r=object(value);const x={'1':number(r['1']),X:number(r.X),'2':number(r['2'])};if(Object.values(x).some(n=>n<0||n>1)||Math.abs(x['1']+x.X+x['2']-1)>1e-6)throw new Error('Invalid handicap probability vector');return x;};
  const raw=h.rawProbabilities==null?undefined:parseTriplet(h.rawProbabilities);
  const companionRaw=h.companionRawProbabilities==null?undefined:parseTriplet(h.companionRawProbabilities);
  const overall=h.overallProbabilities==null?undefined:parseTriplet(h.overallProbabilities);
  const overallTipCode=h.overallTipCode==null?undefined:outcome(h.overallTipCode),overallModelProbability=h.overallModelProbability==null?undefined:number(h.overallModelProbability);
  if(h.version==='handicap-margin-v2'||h.version==='handicap-margin-v3'){
    if(h.companionPolicyVersion!=='straight-conditioned-margin-v1'||h.probabilityBasis!=='conditional-on-straight-primary'||!companionRaw||!overall||!overallTipCode||overallModelProbability==null)throw new Error('Invalid coherent handicap contract');
    if(Math.abs(overall[overallTipCode]-overallModelProbability)>1e-9||Object.entries(overall).some(([c,n])=>c!==overallTipCode&&n>=overallModelProbability))throw new Error('Invalid overall handicap diagnostic');
  }
  let historicalCalibration:HandicapAnalysis['historicalCalibration']=null;
  if(h.historicalCalibration!=null){const c=object(h.historicalCalibration),metrics=c.metrics==null?null:object(c.metrics);historicalCalibration={version:text(c.version),applied:Boolean(c.applied),profileHash:c.profileHash==null?null:text(c.profileHash),key:c.key==null?null:text(c.key),reason:c.reason==null?null:text(c.reason),weight:c.weight==null?null:number(c.weight),metrics:metrics?{rawBrier:metrics.rawBrier==null?undefined:number(metrics.rawBrier),calibratedBrier:metrics.calibratedBrier==null?undefined:number(metrics.calibratedBrier),rawHitRate:metrics.rawHitRate==null?undefined:number(metrics.rawHitRate),calibratedHitRate:metrics.calibratedHitRate==null?undefined:number(metrics.calibratedHitRate)}:null};if(historicalCalibration.applied&&!/^[a-f0-9]{64}$/.test(historicalCalibration.profileHash||''))throw new Error('Invalid handicap calibration hash');}
  return {version:h.version as HandicapAnalysis['version'],market:'HHAD',handicapLine,handicapLineText:text(h.handicapLineText),tipCode,
    companionPolicyVersion:h.companionPolicyVersion==='straight-conditioned-margin-v1'?'straight-conditioned-margin-v1':undefined,
    probabilityBasis:h.probabilityBasis==='conditional-on-straight-primary'?'conditional-on-straight-primary':undefined,
    rawProbabilities:raw,companionRawProbabilities:companionRaw,probabilities,modelProbability,overallProbabilities:overall,overallTipCode,overallModelProbability,
    straightProbabilities:h.straightProbabilities==null?undefined:parseTriplet(h.straightProbabilities),distributionBasis:h.distributionBasis==null?undefined:text(h.distributionBasis),
    modelGap:number(h.modelGap),exactMargin:number(h.exactMargin),exactMarginProbability:number(h.exactMarginProbability),
    coverProbability:number(h.coverProbability),landOnLineProbability:number(h.landOnLineProbability),failCoverProbability:number(h.failCoverProbability),
    straightTipCode:h.straightTipCode==null?null:outcome(h.straightTipCode),relation:text(h.relation),lambdas:{home,away,source:text(lambdas.source)},
    calibration:'unvalidated',marketReference,historicalCalibration};
}
function decision(v:unknown):Decision{
  const d=object(v),p=object(d.probabilities),probabilities={'1':number(p['1']),X:number(p.X),'2':number(p['2'])};
  if(d.version!=='unified-decision-v1'||d.market!=='HAD'||d.modelValidation!=='unvalidated')throw new Error('Unsupported decision contract');
  const tipCode=outcome(d.tipCode),odds=number(d.odds),modelProbability=number(d.modelProbability);
  if(Object.values(probabilities).some(n=>n<0||n>1)||Math.abs(probabilities['1']+probabilities.X+probabilities['2']-1)>1e-8||modelProbability!==probabilities[tipCode]||Object.entries(probabilities).some(([c,n])=>c!==tipCode&&n>=modelProbability)||odds<=1)throw new Error('Direction and probabilities disagree');
  const publishedAt=stamp(d.publishedAt),kickoffTime=stamp(d.kickoffTime),cutoffTime=stamp(d.cutoffTime),quoteObservedAt=stamp(d.quoteObservedAt),modelGeneratedAt=stamp(d.modelGeneratedAt);
  if(Date.parse(publishedAt)>=Math.min(Date.parse(kickoffTime),Date.parse(cutoffTime))||Date.parse(quoteObservedAt)>Date.parse(publishedAt)||Date.parse(modelGeneratedAt)>Date.parse(publishedAt))throw new Error('Invalid pre-match publication');
  const recordHash=text(d.recordHash);if(!/^[a-f0-9]{64}$/.test(recordHash))throw new Error('Invalid record hash');
  const quoteSource=d.quoteSource==null?null:text(d.quoteSource);
  const parsedHandicap=d.handicapAnalysis==null?null:handicapAnalysis(d.handicapAnalysis);
  if(parsedHandicap&&parsedHandicap.straightTipCode!==tipCode)throw new Error('Handicap analysis is not bound to the straight pick');
  if(parsedHandicap?.version==='handicap-margin-v3'&&(parsedHandicap.distributionBasis!=='had-calibrated-poisson-score-matrix-v1'||!parsedHandicap.straightProbabilities||(['1','X','2'] as const).some(code=>Math.abs(parsedHandicap.straightProbabilities![code]-probabilities[code])>1e-8)))throw new Error('Incoherent straight and handicap probabilities');
  if(quoteSource==='500.com:jczq:HAD') {
    const receipt=object(d.quoteProvenance),quotes=object(receipt.quoteOdds);
    const k=tipCode==='1'?'odds1':tipCode==='X'?'oddsX':'odds2';
    if(receipt.version!=='500-jczq-had-copy-v1'||receipt.source!==quoteSource||receipt.officialDirect!==false
      ||receipt.market!=='HAD'||receipt.priceType!=='lottery-sp'||receipt.observedAt!==quoteObservedAt
      ||receipt.sourceMatchId!==d.sourceMatchId||Date.parse(String(receipt.kickoffTime))!==Date.parse(kickoffTime)
      ||number(quotes[k])!==odds||! /^[a-f0-9]{64}$/.test(text(receipt.receiptHash))) throw new Error('Invalid copied lottery SP receipt');
  }

  return {decisionId:text(d.decisionId),matchId:text(d.matchId),sourceMatchId:text(d.sourceMatchId),eventVersion:stamp(d.eventVersion),businessDate:date(d.businessDate),homeTeamName:text(d.homeTeamName),awayTeamName:text(d.awayTeamName),matchNo:d.matchNo==null?null:text(d.matchNo),publishedAt,kickoffTime,cutoffTime,tipCode,odds,probabilities,modelProbability,modelGeneratedAt,quoteObservedAt,recordHash,quoteSource,handicapAnalysis:parsedHandicap};
}
function settlement(v:unknown):Settlement{
  const s=object(v),result:Settlement={state:state(s.state)};
  if(s.score!=null){result.score=text(s.score);if(!/^\d+-\d+$/.test(result.score))throw new Error('Invalid score');}
  if(s.actual!=null)result.actual=outcome(s.actual);
  if(s.resultEventId!=null)result.resultEventId=text(s.resultEventId);
  if(s.legs!=null)result.legs=list(s.legs).map(v=>{const l=object(v);return {decisionId:text(l.decisionId),selectionId:l.selectionId==null?undefined:text(l.selectionId),state:state(l.state),score:l.score==null?null:text(l.score)};});
  return result;
}
function single(v:unknown):SingleRow{
  const x=object(v),d=decision(x.decision),s=settlement(x.settlement);
  if(['WON','LOST'].includes(s.state)&&(!s.actual||!s.score||(s.actual===d.tipCode)!==(s.state==='WON')))throw new Error('Settlement disagrees with decision');
  const hs=x.handicapSettlement==null?null:settlement(x.handicapSettlement);
  if(hs&&['WON','LOST'].includes(hs.state)&&d.handicapAnalysis&&(!hs.actual||!hs.score||(hs.actual===d.handicapAnalysis.tipCode)!==(hs.state==='WON')))throw new Error('Handicap settlement disagrees with decision');
  let quality:SelectionQuality|null=null,scores:PublishedScores|null=null;
  if(x.selectionQuality!=null){
    const q=object(x.selectionQuality),qualified=q.qualified===true;
    if(q.version!=='recommendation-selection-quality-v1'||q.validation!=='unvalidated'||q.status!==(qualified?'reference-qualified':'watch')||q.priceFilterApplied!==false)throw new Error('Invalid selection quality');
    const pair=(v:unknown)=>{const a=object(v);return {home:a.home==null?null:count(a.home),away:a.away==null?null:count(a.away)};};
    const samples=q.samples==null?null:object(q.samples);
    quality={version:q.version,status:qualified?'reference-qualified':'watch',qualified,reasons:list(q.reasons).map(text),samples:samples?{elo:pair(samples.elo),form:pair(samples.form)}:null,probabilityLead:q.probabilityLead==null?null:number(q.probabilityLead),marketProbability:q.marketProbability==null?null:number(q.marketProbability),modelMarketGap:q.modelMarketGap==null?null:number(q.modelMarketGap),expectedValue:q.expectedValue==null?null:number(q.expectedValue),marketFavorite:q.marketFavorite===true};
    if(qualified&&quality.reasons.length)throw new Error('Contradictory selection quality');
  }
  if(x.scoreDistribution!=null){
    const p=object(x.scoreDistribution);
    if(p.version!=='published-score-distribution-v1'||p.decisionId!==d.decisionId||p.recordHash!==d.recordHash||!['available','unavailable'].includes(String(p.status)))throw new Error('Invalid score binding');
    const score=(v:unknown):PublishedScore=>{const r=object(v),home=count(r.home),away=count(r.away),probability=number(r.probability);if(probability<=0||probability>1||r.label!==`${home}-${away}`)throw new Error('Invalid score probability');return {home,away,label:String(r.label),probability,hadCode:outcome(r.hadCode),hhadCode:outcome(r.hhadCode)};};
    scores={version:p.version,status:p.status as PublishedScores['status'],decisionId:d.decisionId,recordHash:d.recordHash,topScores:list(p.topScores).map(score),alignedScores:list(p.alignedScores).map(score)};
    if(scores.alignedScores.some(r=>r.hadCode!==d.tipCode||r.hhadCode!==d.handicapAnalysis?.tipCode))throw new Error('Incoherent aligned score');
  }
  return {decision:d,settlement:s,handicapSettlement:hs,selectionQuality:quality,scoreDistribution:x.scoreDistribution===undefined?undefined:scores};
}
function comboSelection(v:unknown,parent:Decision,rawParent:Obj):ComboSelection{
  const s=object(v),market=s.market,tipCode=outcome(s.tipCode),handicapLine=number(s.handicapLine),odds=number(s.odds),modelProbability=number(s.modelProbability);
  if(s.version!=='combo-selection-v1'||s.probabilityBasis!=='unconditional'||(market!=='HAD'&&market!=='HHAD'))throw new Error('Unsupported combo selection');
  const p=object(s.probabilities),q=object(s.quoteOdds),probabilities={'1':number(p['1']),X:number(p.X),'2':number(p['2'])},quoteOdds={'1':number(q['1']),X:number(q.X),'2':number(q['2'])};
  if(!Number.isSafeInteger(handicapLine)||Object.values(probabilities).some(n=>n<0||n>1)||Math.abs(probabilities['1']+probabilities.X+probabilities['2']-1)>1e-6||Math.abs(probabilities[tipCode]-modelProbability)>1e-9||Object.entries(probabilities).some(([code,n])=>code!==tipCode&&n>=modelProbability)||Object.values(quoteOdds).some(n=>n<=1)||quoteOdds[tipCode]!==odds)throw new Error('Invalid combo selection probability or SP');
  const selectionId=text(s.selectionId),decisionId=text(s.decisionId),decisionRecordHash=text(s.decisionRecordHash),recordHash=text(s.recordHash),quoteSource=text(s.quoteSource),quoteObservedAt=stamp(s.quoteObservedAt);
  if(decisionId!==parent.decisionId||decisionRecordHash!==parent.recordHash||!/^selection_[a-f0-9]{64}$/.test(selectionId)||!/^[a-f0-9]{64}$/.test(recordHash)||Date.parse(quoteObservedAt)>Date.parse(parent.publishedAt))throw new Error('Invalid selection evidence binding');
  let expectedProbabilities:Record<Outcome,number>,expectedQuotes:Obj,expectedSource:unknown,expectedObservedAt:unknown;
  if(market==='HAD'){
    if(handicapLine!==0||tipCode!==parent.tipCode||odds!==parent.odds)throw new Error('Changed HAD combo direction');
    expectedProbabilities=parent.probabilities;expectedQuotes=object(rawParent.quoteOdds);expectedSource=parent.quoteSource;expectedObservedAt=parent.quoteObservedAt;
  }else{
    const h=parent.handicapAnalysis,rawH=object(rawParent.handicapAnalysis),reference=object(rawH.marketReference);
    if(!h||handicapLine===0||handicapLine!==h.handicapLine)throw new Error('Invalid bound handicap line');
    expectedProbabilities=h.overallProbabilities??h.probabilities;expectedQuotes=object(reference.odds);expectedSource=reference.source;expectedObservedAt=reference.observedAt;
    if(h.probabilityBasis==='conditional-on-straight-primary'&&!h.overallProbabilities)throw new Error('Conditional probability cannot rank a combo');
  }
  if(quoteSource!==expectedSource||quoteObservedAt!==expectedObservedAt||(['1','X','2'] as const).some(code=>Math.abs(probabilities[code]-expectedProbabilities[code])>1e-9||quoteOdds[code]!==expectedQuotes[code]))throw new Error('Selection differs from archived market evidence');
  return {version:'combo-selection-v1',selectionId,decisionId,decisionRecordHash,recordHash,market,handicapLine,tipCode,odds,modelProbability,probabilityBasis:'unconditional',probabilities,quoteOdds,quoteObservedAt,quoteSource};
}
function combo(v:unknown):Combo{
  const c=object(v);if(c.size!==2&&c.size!==3)throw new Error('Invalid combo size');
  if(c.version!=='unified-combo-v1'&&c.version!=='unified-combo-v2')throw new Error('Unsupported combo contract');
  const rawLegs=list(c.legs).map(object),legs=rawLegs.map(decision),ids=list(c.decisionIds).map(text);
  if(legs.length!==c.size||ids.length!==c.size||new Set(legs.map(l=>l.sourceMatchId)).size!==c.size||legs.some((l,i)=>l.decisionId!==ids[i]))throw new Error('Invalid combo decision binding');
  let selections:ComboSelection[]|undefined,selectionIds:string[]|undefined;
  if(c.version==='unified-combo-v2'){
    const rawSelections=list(c.selections);selectionIds=list(c.selectionIds).map(text);
    if(rawSelections.length!==c.size||selectionIds.length!==c.size||new Set(selectionIds).size!==c.size)throw new Error('Invalid combo selection count');
    selections=rawSelections.map((s,i)=>comboSelection(s,legs[i],rawLegs[i]));
    if(selections.some((s,i)=>s.selectionId!==selectionIds![i]))throw new Error('Invalid combo selection binding');
  }else if(c.selections!=null||c.selectionIds!=null)throw new Error('Legacy combo cannot override its bound direction');
  const rawTotalOdds=number(c.rawTotalOdds),totalOdds=number(c.totalOdds),product=(selections??legs).reduce((p,l)=>p*l.odds,1);
  if(Math.abs(rawTotalOdds-product)>1e-8||rawTotalOdds<(c.size===2?2.5:5)||Math.abs(totalOdds-product)>.005001)throw new Error('Invalid SP product');
  const frozenAt=c.frozenAt==null?undefined:stamp(c.frozenAt);
  if(frozenAt&&legs.some(l=>Date.parse(frozenAt)>=Date.parse(l.cutoffTime)))throw new Error('Post-cutoff combo');
  return {version:c.version,id:text(c.id),businessDate:date(c.businessDate),size:c.size,totalOdds,rawTotalOdds,legs,decisionIds:ids,selections,selectionIds,freezeAt:stamp(c.freezeAt),frozenAt,generatedAt:stamp(c.generatedAt)};
}
const comboRow=(v:unknown):ComboRow=>{const x=object(v),c=combo(x.combo),s=settlement(x.settlement);if(!c.frozenAt)throw new Error('Unfrozen combo in record');if(s.legs&&(s.legs.length!==c.size||new Set(s.legs.map(l=>l.decisionId)).size!==c.size||s.legs.some(l=>!c.decisionIds.includes(l.decisionId)||(c.selections&&l.selectionId!==c.selections.find(a=>a.decisionId===l.decisionId)?.selectionId))))throw new Error('Settlement bindings disagree');return {combo:c,settlement:s};};
function summary(v:unknown):Summary{
  const s=object(v),r:Summary={published:count(s.published),settled:count(s.settled),won:count(s.won),lost:count(s.lost),pending:count(s.pending),void:count(s.void),disputed:count(s.disputed),hitRate:null};
  if(r.won+r.lost!==r.settled||r.settled+r.pending+r.void+r.disputed!==r.published)throw new Error('Inconsistent statistics');
  r.hitRate=r.settled?r.won/r.settled:null;
  for(const k of ['brier','logLoss','marketBrier'] as const)if(s[k]!=null){r[k]=number(s[k]);if(r[k]!<0)throw new Error('Invalid model metric');}
  return r;
}
function handicapBreakdown(v:unknown):HandicapBreakdown{
  const b=object(v),r:HandicapBreakdown={standaloneV1:summary(b.standaloneV1),companionV2All:summary(b.companionV2All),companionV2WhenHadWon:summary(b.companionV2WhenHadWon),companionV2BothWon:summary(b.companionV2BothWon)};
  if(b.companionV3All!=null||b.companionV3WhenHadWon!=null||b.companionV3BothWon!=null){r.companionV3All=summary(b.companionV3All);r.companionV3WhenHadWon=summary(b.companionV3WhenHadWon);r.companionV3BothWon=summary(b.companionV3BothWon);}
  for(const [all,conditional,both] of [[r.companionV2All,r.companionV2WhenHadWon,r.companionV2BothWon],[r.companionV3All,r.companionV3WhenHadWon,r.companionV3BothWon]])if(all&&conditional&&both&&(conditional.published>all.published||both.published!==all.published||both.won>all.won||both.won!==conditional.won))throw new Error('Inconsistent handicap cohort statistics');
  return r;
}
function calibrationGroup(v:unknown):HandicapCalibrationGroup{
  const g=object(v),triplet=(x:unknown)=>{const o=object(x);return {'1':number(o['1']),X:number(o.X),'2':number(o['2'])};};
  const metrics=g.metrics==null?null:(()=>{const m=object(g.metrics);const result:NonNullable<HandicapCalibrationGroup['metrics']>={};for(const key of ['holdout','rawBrier','calibratedBrier','rawLogLoss','calibratedLogLoss','rawHitRate','calibratedHitRate'] as const)if(m[key]!=null)result[key]=number(m[key]);return result;})();
  return {key:text(g.key),rows:count(g.rows),active:Boolean(g.active),reason:text(g.reason),bias:triplet(g.bias),meanRaw:triplet(g.meanRaw),actualShare:triplet(g.actualShare),metrics};
}
function calibrationProfile(v:unknown):HandicapCalibrationProfile{
  const p=object(v),groupsObj=object(p.groups),groups:Record<string,HandicapCalibrationGroup>={};
  for(const [key,value] of Object.entries(groupsObj)){const parsed=calibrationGroup(value);if(parsed.key!==key)throw new Error('Calibration group key mismatch');groups[key]=parsed;}
  const profileHash=text(p.profileHash);if(!/^[a-f0-9]{64}$/.test(profileHash))throw new Error('Invalid calibration profile hash');
  return {version:text(p.version),profileHash,sampleRows:count(p.sampleRows),groups};
}
function modelQuality(v:unknown):ModelQualityReport{
 const q=object(v),m=object(q.overall),policy=object(q.policy);
 if(q.version!=='frozen-quality-review-v1'||q.formalPromotion!==false)throw new Error('Invalid model quality report');
 const metric=(key:string)=>m[key]==null?null:number(m[key]);
 return {independentMatchDays:count(q.independentMatchDays),settled:count(m.settled),won:count(m.won),hitRate:metric('hitRate'),marketTopHitRate:metric('marketTopHitRate'),brier:metric('brier'),marketBrier:metric('marketBrier'),logLoss:metric('logLoss'),marketLogLoss:metric('marketLogLoss'),blockers:list(q.blockers).map(text),minimumSettled:count(policy.minimumSettled),minimumMatchDays:count(policy.minimumMatchDays)};
}
export function parseRecommendationCenter(response:unknown):RecommendationCenterData{
  const root=object(response),x=object(root.recommendationCenter),review=object(x.review),stats=object(review.statistics),lanes=object(x.lanes);
  if(x.version!=='recommendation-center-v1'||x.modelValidation!=='unvalidated')throw new Error('Unsupported center contract');
  const parsedLanes:RecommendationCenterData['lanes']={};
  for(const k of ['publish','combos','settlement','view'] as const){if(lanes[k]==null)continue;const l=object(lanes[k]);if(l.status!=='ok'&&l.status!=='error')throw new Error('Invalid lane status');parsedLanes[k]={status:l.status,lastAttemptAt:stamp(l.lastAttemptAt),lastSuccessAt:l.lastSuccessAt==null?undefined:stamp(l.lastSuccessAt),errorCode:l.errorCode==null?null:text(l.errorCode),inputAsOf:l.inputAsOf==null?undefined:stamp(l.inputAsOf),candidateCount:l.candidateCount==null?undefined:count(l.candidateCount),eligibleCount:l.eligibleCount==null?undefined:count(l.eligibleCount),bindingFailures:l.bindingFailures==null?undefined:count(l.bindingFailures),referenceCount:l.referenceCount==null?undefined:count(l.referenceCount),watchCount:l.watchCount==null?undefined:count(l.watchCount)};}
  const result:RecommendationCenterData={version:'recommendation-center-v1',updatedAt:stamp(x.updatedAt),businessDate:date(x.businessDate),inputAsOf:x.inputAsOf==null?null:stamp(x.inputAsOf),resultAsOf:x.resultAsOf==null?null:stamp(x.resultAsOf),lanes:parsedLanes,current:list(x.current).map(single),previews:list(x.previews).map(combo),todayCombos:list(x.todayCombos).map(comboRow),overlapDecisionIds:list(x.overlapDecisionIds).map(text),review:{singles:list(review.singles).map(single),combos:list(review.combos).map(comboRow),limit:count(review.limit),qualityReport:review.qualityReport==null?undefined:modelQuality(review.qualityReport),statistics:{single:summary(stats.single),qualifiedSingle:stats.qualifiedSingle==null?undefined:summary(stats.qualifiedSingle),handicap:stats.handicap==null?undefined:summary(stats.handicap),handicapBreakdown:stats.handicapBreakdown==null?undefined:handicapBreakdown(stats.handicapBreakdown),two:summary(stats.two),three:summary(stats.three)},handicapCalibration:review.handicapCalibration==null?undefined:calibrationProfile(review.handicapCalibration),definition:text(review.definition)},excludedCorruptRecords:count(x.excludedCorruptRecords),modelValidation:'unvalidated'};
  if(new Set(result.current.map(r=>r.decision.decisionId)).size!==result.current.length)throw new Error('Duplicate current decision');
  for(const c of result.previews)for(const leg of c.legs){const same=result.current.find(s=>s.decision.decisionId===leg.decisionId);if(same&&same.decision.recordHash!==leg.recordHash)throw new Error('Conflicting decision payload');}
  return result;
}
export function visiblePreview(c:Combo,now:number):boolean{return c.legs.every((l,i)=>{const observedAt=Date.parse(c.selections?.[i].quoteObservedAt??l.quoteObservedAt);return now<Date.parse(l.cutoffTime)&&now>=observedAt&&now-observedAt<=15*60000;});}

/** Match identity stays bound to the original decision; display its selected market separately. */
export function comboLegSelection(c:Combo,index:number){
  const d=c.legs[index],s=c.selections?.[index];
  return s??{market:'HAD' as const,handicapLine:0,tipCode:d.tipCode,odds:d.odds,modelProbability:d.modelProbability,probabilityBasis:'unconditional' as const,quoteSource:d.quoteSource,quoteObservedAt:d.quoteObservedAt,selectionId:null};
}

export function handicapAnalysisBasis(d:Pick<Decision,'handicapAnalysis'>):'conditional'|'unconditional'{return d.handicapAnalysis?.probabilityBasis==='conditional-on-straight-primary'?'conditional':'unconditional';}

export function calibrationSampleBasis(profile:Pick<HandicapCalibrationProfile,'version'>|undefined):'all'|'had-won'{return profile?.version==='handicap-calibration-v1'?'all':'had-won';}

/** The combo lane, not the single-pick lane, owns preview availability.
 * View refreshes do not refresh its input clock. Quotes/cutoffs are still
 * checked per leg; frozen records are rendered separately even during errors. */
export function comboLaneFresh(data:RecommendationCenterData|undefined|null,now:number):boolean {
  if(!data||!Number.isFinite(now)||data.businessDate!==new Date(now+8*3600000).toISOString().slice(0,10))return false;
  const lane=data.lanes.combos;
  if(lane?.status!=='ok')return false;
  const fresh=(value:string|undefined|null)=>{
    const stamp=Date.parse(value||'');return Number.isFinite(stamp)&&stamp<=now&&now-stamp<=15*60000;
  };
  // Older API responses may lack the per-lane source clock. Their source
  // watermark is a compatibility fallback, never a single-pick status gate.
  return fresh(lane.inputAsOf??data.inputAsOf)&&fresh(lane.lastSuccessAt);
}
export function comboPreviewForSize(data:RecommendationCenterData|undefined|null,size:2|3,now:number,readFailed=false):Combo|undefined {
  if(readFailed||!comboLaneFresh(data,now)||!data)return undefined;
  if(data.todayCombos.some(r=>r.combo.size===size&&r.combo.businessDate===data.businessDate))return undefined;
  return data.previews.find(c=>c.size===size&&c.businessDate===data.businessDate&&visiblePreview(c,now));
}

function alignedHandicapCodes(straight:Outcome,line:number):Outcome[]{
  if(!Number.isSafeInteger(line)||line===0)return [];
  // This is a display policy for extending the 1X2 thesis, not a change to
  // score probabilities: a narrow win can still lose a deep handicap.
  if(straight==='1')return line<0?['1','X']:['1'];
  if(straight==='2')return line>0?['2','X']:['2'];
  return [line<0?'2':'1'];
}
export function primarySelectionSummary(d:Pick<Decision,'tipCode'|'odds'|'modelProbability'|'handicapAnalysis'>){
  const h=d.handicapAnalysis;
  if(!h)return {had:{code:d.tipCode,odds:d.odds,probability:d.modelProbability},handicap:null};
  const aligned=alignedHandicapCodes(d.tipCode,h.handicapLine);
  const probabilityFor=(code:Outcome)=>{const value=h.probabilities?.[code];return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value:null;};
  const rankedAligned=aligned.filter(code=>probabilityFor(code)!==null).sort((a,b)=>(probabilityFor(b)??0)-(probabilityFor(a)??0));
  const suggestedCode=rankedAligned.length&&(probabilityFor(rankedAligned[0])??0)>0?rankedAligned[0]:null;
  const recommended=aligned.includes(h.tipCode);
  return {
    had:{code:d.tipCode,odds:d.odds,probability:d.modelProbability},
    handicap:{
      status:recommended?'recommend' as const:'pass' as const,
      code:recommended?h.tipCode:null,line:h.handicapLine,lineText:h.handicapLineText,
      probability:recommended?h.modelProbability:null,odds:recommended?h.marketReference?.selectedOdds??null:null,
      calibrated:h.historicalCalibration?.applied===true,conditional:h.probabilityBasis==='conditional-on-straight-primary',overallCode:h.overallTipCode??null,
      riskCode:recommended?null:h.tipCode,riskProbability:recommended?null:h.modelProbability,
      suggestedCode:recommended?null:suggestedCode,suggestedProbability:recommended||!suggestedCode?null:probabilityFor(suggestedCode),
    },
  };
}

/** Shared copy keeps recommendation, fixture and detail cards on one policy. */
export function handicapExtensionText(h:NonNullable<ReturnType<typeof primarySelectionSummary>['handicap']>,language:'zh'|'en'){
  const zh=language==='zh';
  const title=(code:Outcome)=>zh?({'1':'让胜',X:'让平','2':'让负'}[code]):({'1':'Handicap home',X:'Handicap draw','2':'Handicap away'}[code]);
  if(h.status==='recommend')return {
    title:`${h.lineText} · ${title(h.code!)}`,
    detail:`${h.conditional?(zh?'条件占比 ':'Conditional share '):''}${(h.probability!*100).toFixed(1)}%${h.odds?' · SP '+h.odds.toFixed(2):''}${h.calibrated?(zh?' · 已校准':' · calibrated'):''}`,
  };
  return {
    title:`${h.lineText} · ${zh?'不追让球':'Pass handicap'}`,
    detail:`${h.conditional?(zh?'条件模型偏 ':'Conditional model leans '):(zh?'盘口模型偏 ':'Model leans ')}${title(h.riskCode!)} ${(h.riskProbability!*100).toFixed(1)}%${h.suggestedCode?(zh?' · 同向备选 ':' · aligned alternative ')+title(h.suggestedCode)+' '+(h.suggestedProbability!*100).toFixed(1)+'%':''}`,
  };
}

export function quoteSourceLabel(d:Pick<Decision,'quoteSource'>,language:'zh'|'en'):string {
  if(d.quoteSource==='500.com:jczq:HAD')return language==='zh'?'500竞彩页面转录':'500 JCZQ SP copy';
  if(/^sporttery:(?:had|hhad)(?:$|:)/i.test(d.quoteSource||''))return language==='zh'?'竞彩网来源SP':'Sporttery-sourced SP';
  return language==='zh'?'已存档SP，来源见原记录':'Archived SP; see original source';
}
