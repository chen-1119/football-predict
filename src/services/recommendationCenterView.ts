export type Outcome = '1' | 'X' | '2';
export type ResultState = 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'DISPUTED';
export interface Decision {
  handicapAnalysis?:HandicapAnalysisView;
  decisionId:string; sourceMatchId:string; matchId:string; eventVersion:string; businessDate:string;
  publishedAt:string; cutoffTime:string; kickoffTime:string; homeTeamName:string; awayTeamName:string;
  matchNo:string|null; tipCode:Outcome; odds:number; probabilities:Record<Outcome,number>;
  modelProbability:number; modelGeneratedAt:string; quoteObservedAt:string; recordHash:string; quoteSource?:string|null;
}
export interface Settlement { handicap?:HandicapSettlementView; state:ResultState; score?:string|null; actual?:Outcome; resultEventId?:string|null; legs?:Array<{decisionId:string;state:ResultState;score?:string|null}> }
export interface SingleRow { decision:Decision; settlement:Settlement }
export interface Combo { id:string; businessDate:string; size:2|3; totalOdds:number; rawTotalOdds:number; legs:Decision[]; decisionIds:string[]; freezeAt:string; frozenAt?:string; generatedAt:string }
export interface ComboRow { combo:Combo; settlement:Settlement }
export interface Summary { published:number;settled:number;won:number;lost:number;pending:number;void:number;disputed:number;hitRate:number|null;brier?:number|null;logLoss?:number|null;marketBrier?:number|null }
export interface Lane {status:'ok'|'error';lastSuccessAt?:string;lastAttemptAt:string;errorCode?:string|null;inputAsOf?:string;candidateCount?:number;eligibleCount?:number;bindingFailures?:number}
export interface RecommendationCenterData {
  version:'recommendation-center-v1';updatedAt:string;businessDate:string;inputAsOf:string|null;resultAsOf:string|null;
  lanes:Partial<Record<'publish'|'combos'|'settlement'|'view',Lane>>;
  current:SingleRow[];previews:Combo[];todayCombos:ComboRow[];overlapDecisionIds:string[];
  review:{singles:SingleRow[];combos:ComboRow[];limit:number;statistics:{single:Summary;two:Summary;three:Summary};definition:string};
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
function decision(v:unknown):Decision{
  const d=object(v),p=object(d.probabilities),probabilities={'1':number(p['1']),X:number(p.X),'2':number(p['2'])};
  if(d.version!=='unified-decision-v1'||d.market!=='HAD'||d.modelValidation!=='unvalidated')throw new Error('Unsupported decision contract');
  const tipCode=outcome(d.tipCode),odds=number(d.odds),modelProbability=number(d.modelProbability);
  if(Object.values(probabilities).some(n=>n<0||n>1)||Math.abs(probabilities['1']+probabilities.X+probabilities['2']-1)>1e-8||modelProbability!==probabilities[tipCode]||Object.entries(probabilities).some(([c,n])=>c!==tipCode&&n>=modelProbability)||odds<=1)throw new Error('Direction and probabilities disagree');
  const publishedAt=stamp(d.publishedAt),kickoffTime=stamp(d.kickoffTime),cutoffTime=stamp(d.cutoffTime),quoteObservedAt=stamp(d.quoteObservedAt),modelGeneratedAt=stamp(d.modelGeneratedAt);
  if(Date.parse(publishedAt)>=Math.min(Date.parse(kickoffTime),Date.parse(cutoffTime))||Date.parse(quoteObservedAt)>Date.parse(publishedAt)||Date.parse(modelGeneratedAt)>Date.parse(publishedAt))throw new Error('Invalid pre-match publication');
  const recordHash=text(d.recordHash);if(!/^[a-f0-9]{64}$/.test(recordHash))throw new Error('Invalid record hash');
  const quoteSource=d.quoteSource==null?null:text(d.quoteSource);
  if(quoteSource==='500.com:jczq:HAD') {
    const receipt=object(d.quoteProvenance),quotes=object(receipt.quoteOdds);
    const k=tipCode==='1'?'odds1':tipCode==='X'?'oddsX':'odds2';
    if(receipt.version!=='500-jczq-had-copy-v1'||receipt.source!==quoteSource||receipt.officialDirect!==false
      ||receipt.market!=='HAD'||receipt.priceType!=='lottery-sp'||receipt.observedAt!==quoteObservedAt
      ||receipt.sourceMatchId!==d.sourceMatchId||Date.parse(String(receipt.kickoffTime))!==Date.parse(kickoffTime)
      ||number(quotes[k])!==odds||! /^[a-f0-9]{64}$/.test(text(receipt.receiptHash))) throw new Error('Invalid copied lottery SP receipt');
  }

  return {handicapAnalysis:parseHandicapAnalysis(d.handicapAnalysis,{probabilities,publishedAt,modelGeneratedAt,sourceMatchId:text(d.sourceMatchId),eventVersion:stamp(d.eventVersion)}),decisionId:text(d.decisionId),matchId:text(d.matchId),sourceMatchId:text(d.sourceMatchId),eventVersion:stamp(d.eventVersion),businessDate:date(d.businessDate),homeTeamName:text(d.homeTeamName),awayTeamName:text(d.awayTeamName),matchNo:d.matchNo==null?null:text(d.matchNo),publishedAt,kickoffTime,cutoffTime,tipCode,odds,probabilities,modelProbability,modelGeneratedAt,quoteObservedAt,recordHash,quoteSource};
}
function settlement(v:unknown):Settlement{
  const s=object(v),result:Settlement={state:state(s.state),handicap:parseHandicapSettlement(s.handicap)};
  if(s.score!=null){result.score=text(s.score);if(!/^\d+-\d+$/.test(result.score))throw new Error('Invalid score');}
  if(s.actual!=null)result.actual=outcome(s.actual);
  if(s.resultEventId!=null)result.resultEventId=text(s.resultEventId);
  if(s.legs!=null)result.legs=list(s.legs).map(v=>{const l=object(v);return {decisionId:text(l.decisionId),state:state(l.state),score:l.score==null?null:text(l.score)};});
  return result;
}
function single(v:unknown):SingleRow{
  const x=object(v),d=decision(x.decision),s=settlement(x.settlement);
  if(['WON','LOST'].includes(s.state)&&(!s.actual||!s.score||(s.actual===d.tipCode)!==(s.state==='WON')))throw new Error('Settlement disagrees with decision');
  if(s.handicap && (d.handicapAnalysis?.status!=='ready'||s.handicap.line!==d.handicapAnalysis.line||s.handicap.tipCode!==d.handicapAnalysis.tipCode||s.handicap.score!==(s.score||null)))throw new Error('Handicap settlement binding mismatch');
  return {decision:d,settlement:s};
}
function combo(v:unknown):Combo{
  const c=object(v);if(c.size!==2&&c.size!==3)throw new Error('Invalid combo size');
  const legs=list(c.legs).map(decision),ids=list(c.decisionIds).map(text);
  if(legs.length!==c.size||ids.length!==c.size||new Set(legs.map(l=>l.sourceMatchId)).size!==c.size||legs.some((l,i)=>l.decisionId!==ids[i]))throw new Error('Invalid combo decision binding');
  const rawTotalOdds=number(c.rawTotalOdds),totalOdds=number(c.totalOdds),product=legs.reduce((p,l)=>p*l.odds,1);
  if(Math.abs(rawTotalOdds-product)>1e-8||rawTotalOdds<(c.size===2?2.5:5)||Math.abs(totalOdds-product)>.005001)throw new Error('Invalid SP product');
  const frozenAt=c.frozenAt==null?undefined:stamp(c.frozenAt);
  if(frozenAt&&legs.some(l=>Date.parse(frozenAt)>=Date.parse(l.cutoffTime)))throw new Error('Post-cutoff combo');
  return {id:text(c.id),businessDate:date(c.businessDate),size:c.size,totalOdds,rawTotalOdds,legs,decisionIds:ids,freezeAt:stamp(c.freezeAt),frozenAt,generatedAt:stamp(c.generatedAt)};
}
const comboRow=(v:unknown):ComboRow=>{const x=object(v),c=combo(x.combo),s=settlement(x.settlement);if(!c.frozenAt)throw new Error('Unfrozen combo in record');if(s.legs&&(s.legs.length!==c.size||new Set(s.legs.map(l=>l.decisionId)).size!==c.size||s.legs.some(l=>!c.decisionIds.includes(l.decisionId))))throw new Error('Settlement bindings disagree');return {combo:c,settlement:s};};
function summary(v:unknown):Summary{
  const s=object(v),r:Summary={published:count(s.published),settled:count(s.settled),won:count(s.won),lost:count(s.lost),pending:count(s.pending),void:count(s.void),disputed:count(s.disputed),hitRate:null};
  if(r.won+r.lost!==r.settled||r.settled+r.pending+r.void+r.disputed!==r.published)throw new Error('Inconsistent statistics');
  r.hitRate=r.settled?r.won/r.settled:null;
  for(const k of ['brier','logLoss','marketBrier'] as const)if(s[k]!=null){r[k]=number(s[k]);if(r[k]!<0)throw new Error('Invalid model metric');}
  return r;
}
export function parseRecommendationCenter(response:unknown):RecommendationCenterData{
  const root=object(response),x=object(root.recommendationCenter),review=object(x.review),stats=object(review.statistics),lanes=object(x.lanes);
  if(x.version!=='recommendation-center-v1'||x.modelValidation!=='unvalidated')throw new Error('Unsupported center contract');
  const parsedLanes:RecommendationCenterData['lanes']={};
  for(const k of ['publish','combos','settlement','view'] as const){if(lanes[k]==null)continue;const l=object(lanes[k]);if(l.status!=='ok'&&l.status!=='error')throw new Error('Invalid lane status');parsedLanes[k]={status:l.status,lastAttemptAt:stamp(l.lastAttemptAt),lastSuccessAt:l.lastSuccessAt==null?undefined:stamp(l.lastSuccessAt),errorCode:l.errorCode==null?null:text(l.errorCode),inputAsOf:l.inputAsOf==null?undefined:stamp(l.inputAsOf),candidateCount:l.candidateCount==null?undefined:count(l.candidateCount),eligibleCount:l.eligibleCount==null?undefined:count(l.eligibleCount),bindingFailures:l.bindingFailures==null?undefined:count(l.bindingFailures)};}
  const result:RecommendationCenterData={version:'recommendation-center-v1',updatedAt:stamp(x.updatedAt),businessDate:date(x.businessDate),inputAsOf:x.inputAsOf==null?null:stamp(x.inputAsOf),resultAsOf:x.resultAsOf==null?null:stamp(x.resultAsOf),lanes:parsedLanes,current:list(x.current).map(single),previews:list(x.previews).map(combo),todayCombos:list(x.todayCombos).map(comboRow),overlapDecisionIds:list(x.overlapDecisionIds).map(text),review:{singles:list(review.singles).map(single),combos:list(review.combos).map(comboRow),limit:count(review.limit),statistics:{single:summary(stats.single),two:summary(stats.two),three:summary(stats.three)},definition:text(review.definition)},excludedCorruptRecords:count(x.excludedCorruptRecords),modelValidation:'unvalidated'};
  if(new Set(result.current.map(r=>r.decision.decisionId)).size!==result.current.length)throw new Error('Duplicate current decision');
  for(const c of result.previews)for(const leg of c.legs){const same=result.current.find(s=>s.decision.decisionId===leg.decisionId);if(same&&same.decision.recordHash!==leg.recordHash)throw new Error('Conflicting decision payload');}
  return result;
}
export function visiblePreview(c:Combo,now:number):boolean{return c.legs.every(l=>now<Date.parse(l.cutoffTime)&&now>=Date.parse(l.quoteObservedAt)&&now-Date.parse(l.quoteObservedAt)<=15*60000);}

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

export function quoteSourceLabel(d:Pick<Decision,'quoteSource'>,language:'zh'|'en'):string {
  if(d.quoteSource==='500.com:jczq:HAD')return language==='zh'?'500竞彩页面转录':'500 JCZQ SP copy';
  if(/^sporttery:had(?:$|:)/i.test(d.quoteSource||''))return language==='zh'?'竞彩网来源SP':'Sporttery-sourced SP';
  return language==='zh'?'已存档SP，来源见原记录':'Archived SP; see original source';
}

export type HandicapCode = '1' | 'X' | '2';
export type HandicapVector = Record<HandicapCode, number>;
export interface HandicapAnalysisView {
  status: 'ready' | 'unavailable'; line: number | null; reason?: string;
  tipCode?: HandicapCode | null; probabilities?: HandicapVector;
  primaryTipCode?: HandicapCode | null; primaryProbability?: number | null;
  conditionalOnPrimary?: HandicapVector | null;
  conditions?: { homeWinMinimumMargin: number; drawExactMargin: number; awayWinMaximumMargin: number };
  snapshot?: { lineObservedAt: string; modelGeneratedAt: string; homeLambda: number; awayLambda: number };
}
export interface HandicapSettlementView {
  line: number; tipCode: HandicapCode; actual: HandicapCode | null;
  state: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'DISPUTED'; score: string | null;
}
const hcCodes: HandicapCode[] = ['1', 'X', '2'];
const hcObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid handicap object');
  return v as Record<string, unknown>;
};
function hcVector(value: unknown): HandicapVector {
  const p = hcObject(value);
  if (!hcCodes.every(c => typeof p[c] === 'number' && Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1 + 1e-12)
    || Math.abs(hcCodes.reduce((sum, c) => sum + (p[c] as number), 0) - 1) > 1e-8) throw new Error('Invalid handicap vector');
  return { '1': p['1'] as number, X: p.X as number, '2': p['2'] as number };
}
const hcCode = (v: unknown): HandicapCode | null => {
  if (v === null) return null;
  if (v !== '1' && v !== 'X' && v !== '2') throw new Error('Invalid handicap direction');
  return v;
};
const hcStamp = (v: unknown) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error('Invalid handicap timestamp');
  return v;
};
export function parseHandicapAnalysis(value: unknown, parent: { probabilities: HandicapVector; publishedAt: string; modelGeneratedAt: string; sourceMatchId: string; eventVersion: string }): HandicapAnalysisView | undefined {
  if (value == null) return undefined;
  const x = hcObject(value);
  if (x.version !== 'net-margin-hhad-v1') throw new Error('Unsupported handicap analysis');
  if (x.status === 'unavailable') {
    if (typeof x.reason !== 'string' || x.probabilities || x.tipCode) throw new Error('Invalid unavailable handicap');
    return { status: 'unavailable', line: Number.isSafeInteger(x.line) ? x.line as number : null, reason: x.reason };
  }
  if (x.status !== 'ready' || x.market !== 'HHAD' || x.period !== 'REGULATION_90' || x.modelValidation !== 'unvalidated'
    || x.comboEligible !== false || x.odds !== null || !Number.isSafeInteger(x.line)) throw new Error('Invalid handicap contract');
  const line = x.line as number, p = hcVector(x.probabilities), had = hcVector(x.hadProbabilities), s = hcObject(x.snapshot);
  const tipCode = hcCode(x.tipCode), primaryTipCode = hcCode(x.primaryTipCode);
  const ranked = hcCodes.slice().sort((a, b) => p[b] - p[a]);
  const expected = p[ranked[0]] - p[ranked[1]] > 1e-9 ? ranked[0] : null;
  if (tipCode !== expected || hcCodes.some(c => Math.abs(had[c] - parent.probabilities[c]) > 1e-8)
    || !primaryTipCode || Math.abs(Number(x.primaryProbability) - had[primaryTipCode]) > 1e-8) throw new Error('Handicap and HAD disagree');
  const conditional = x.conditionalOnPrimary === null ? null : hcVector(x.conditionalOnPrimary);
  if (!conditional || hcCodes.some(c => conditional[c] * had[primaryTipCode] > p[c] + 1e-8)) throw new Error('Conditional probability exceeds full probability');
  const lineObservedAt = hcStamp(s.lineObservedAt), modelGeneratedAt = hcStamp(s.modelGeneratedAt);
  if (Date.parse(lineObservedAt) > Date.parse(parent.publishedAt) || modelGeneratedAt !== parent.modelGeneratedAt
    || s.sourceMatchId !== parent.sourceMatchId || s.eventVersion !== parent.eventVersion) throw new Error('Handicap snapshot mismatch');
  if (![s.homeLambda, s.awayLambda].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 30)) throw new Error('Invalid handicap expected goals');
  const c = hcObject(x.conditions);
  if (c.homeWinMinimumMargin !== 1 - line || c.drawExactMargin !== -line || c.awayWinMaximumMargin !== -line - 1) throw new Error('Handicap sign mismatch');
  return { status: 'ready', line, tipCode, probabilities: p, primaryTipCode, primaryProbability: had[primaryTipCode], conditionalOnPrimary: conditional,
    conditions: { homeWinMinimumMargin: 1 - line, drawExactMargin: -line, awayWinMaximumMargin: -line - 1 },
    snapshot: { lineObservedAt, modelGeneratedAt, homeLambda: s.homeLambda as number, awayLambda: s.awayLambda as number } };
}
export function parseHandicapSettlement(value: unknown): HandicapSettlementView | undefined {
  if (value == null) return undefined;
  const x = hcObject(value), tipCode = hcCode(x.tipCode), actual = hcCode(x.actual);
  if (!tipCode || !Number.isSafeInteger(x.line) || !['PENDING', 'WON', 'LOST', 'VOID', 'DISPUTED'].includes(String(x.state))) throw new Error('Invalid handicap result');
  const score = x.score == null ? null : String(x.score);
  if (['WON', 'LOST'].includes(String(x.state))) {
    const m = /^(\d+)-(\d+)$/.exec(score || '');
    if (!m) throw new Error('Missing handicap score');
    const margin = Number(m[1]) - Number(m[2]) + Number(x.line);
    const expected = margin > 0 ? '1' : margin < 0 ? '2' : 'X';
    if (actual !== expected || (actual === tipCode) !== (x.state === 'WON')) throw new Error('Wrong handicap settlement');
  }
  return { line: x.line as number, tipCode, actual, state: x.state as HandicapSettlementView['state'], score };
}
