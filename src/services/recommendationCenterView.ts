export type Outcome = '1' | 'X' | '2';
export type ResultState = 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'DISPUTED';
export interface Decision {
  decisionId:string; sourceMatchId:string; matchId:string; eventVersion:string; businessDate:string;
  publishedAt:string; cutoffTime:string; kickoffTime:string; homeTeamName:string; awayTeamName:string;
  matchNo:string|null; tipCode:Outcome; odds:number; probabilities:Record<Outcome,number>;
  modelProbability:number; modelGeneratedAt:string; quoteObservedAt:string; recordHash:string;
}
export interface Settlement { state:ResultState; score?:string|null; actual?:Outcome; resultEventId?:string|null; legs?:Array<{decisionId:string;state:ResultState;score?:string|null}> }
export interface SingleRow { decision:Decision; settlement:Settlement }
export interface Combo { id:string; businessDate:string; size:2|3; totalOdds:number; rawTotalOdds:number; legs:Decision[]; decisionIds:string[]; freezeAt:string; frozenAt?:string; generatedAt:string }
export interface ComboRow { combo:Combo; settlement:Settlement }
export interface Summary { published:number;settled:number;won:number;lost:number;pending:number;void:number;disputed:number;hitRate:number|null;brier?:number|null;logLoss?:number|null;marketBrier?:number|null }
export interface Lane {status:'ok'|'error';lastSuccessAt?:string;lastAttemptAt:string;errorCode?:string|null}
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
  return {decisionId:text(d.decisionId),matchId:text(d.matchId),sourceMatchId:text(d.sourceMatchId),eventVersion:stamp(d.eventVersion),businessDate:date(d.businessDate),homeTeamName:text(d.homeTeamName),awayTeamName:text(d.awayTeamName),matchNo:d.matchNo==null?null:text(d.matchNo),publishedAt,kickoffTime,cutoffTime,tipCode,odds,probabilities,modelProbability,modelGeneratedAt,quoteObservedAt,recordHash};
}
function settlement(v:unknown):Settlement{
  const s=object(v),result:Settlement={state:state(s.state)};
  if(s.score!=null){result.score=text(s.score);if(!/^\d+-\d+$/.test(result.score))throw new Error('Invalid score');}
  if(s.actual!=null)result.actual=outcome(s.actual);
  if(s.resultEventId!=null)result.resultEventId=text(s.resultEventId);
  if(s.legs!=null)result.legs=list(s.legs).map(v=>{const l=object(v);return {decisionId:text(l.decisionId),state:state(l.state),score:l.score==null?null:text(l.score)};});
  return result;
}
function single(v:unknown):SingleRow{
  const x=object(v),d=decision(x.decision),s=settlement(x.settlement);
  if(['WON','LOST'].includes(s.state)&&(!s.actual||!s.score||(s.actual===d.tipCode)!==(s.state==='WON')))throw new Error('Settlement disagrees with decision');
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
  for(const k of ['publish','combos','settlement','view'] as const){if(lanes[k]==null)continue;const l=object(lanes[k]);if(l.status!=='ok'&&l.status!=='error')throw new Error('Invalid lane status');parsedLanes[k]={status:l.status,lastAttemptAt:stamp(l.lastAttemptAt),lastSuccessAt:l.lastSuccessAt==null?undefined:stamp(l.lastSuccessAt),errorCode:l.errorCode==null?null:text(l.errorCode)};}
  const result:RecommendationCenterData={version:'recommendation-center-v1',updatedAt:stamp(x.updatedAt),businessDate:date(x.businessDate),inputAsOf:x.inputAsOf==null?null:stamp(x.inputAsOf),resultAsOf:x.resultAsOf==null?null:stamp(x.resultAsOf),lanes:parsedLanes,current:list(x.current).map(single),previews:list(x.previews).map(combo),todayCombos:list(x.todayCombos).map(comboRow),overlapDecisionIds:list(x.overlapDecisionIds).map(text),review:{singles:list(review.singles).map(single),combos:list(review.combos).map(comboRow),limit:count(review.limit),statistics:{single:summary(stats.single),two:summary(stats.two),three:summary(stats.three)},definition:text(review.definition)},excludedCorruptRecords:count(x.excludedCorruptRecords),modelValidation:'unvalidated'};
  if(new Set(result.current.map(r=>r.decision.decisionId)).size!==result.current.length)throw new Error('Duplicate current decision');
  for(const c of result.previews)for(const leg of c.legs){const same=result.current.find(s=>s.decision.decisionId===leg.decisionId);if(same&&same.decision.recordHash!==leg.recordHash)throw new Error('Conflicting decision payload');}
  return result;
}
export function visiblePreview(c:Combo,now:number):boolean{return c.legs.every(l=>now<Date.parse(l.cutoffTime)&&now>=Date.parse(l.quoteObservedAt)&&now-Date.parse(l.quoteObservedAt)<=15*60000);}
