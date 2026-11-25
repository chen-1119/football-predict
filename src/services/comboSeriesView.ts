export interface SeriesLeg {eventId:string;matchNum:string;market:'HAD'|'HHAD';handicap?:number;selection:'h'|'d'|'a';sp:number}
export interface SeriesDecision extends SeriesLeg {eventVersion:string;cutoffAt:string;homeTeamName:string;awayTeamName:string;scores:number[][];quoteObservedAt:string}
export interface SeriesGroup {size:2|3;band:2.5|5|10;eventIds:string[];legs:SeriesLeg[];product:number;cutoffAt:string}
export interface ComboSeries {key:string;label:string;publishedAt:string;commitObservedAt:string;records:SeriesDecision[];groups:SeriesGroup[];openEventIds:string[];saleValidUntil:Record<string,string>}
export interface ComboSeriesView {version:string;businessDate:string;updatedAt:string;series:ComboSeries[]}
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Combination object');return v as Record<string,unknown>;};
const text=(v:unknown,n=100):v is string=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f\x7f\ufffd]/.test(v);
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const need=(v:unknown):void=>{if(!v)throw Error('Combination record invalid');};
export function parseComboSeriesView(value:unknown,day:string):ComboSeriesView{
 const v=obj(value);need(v.version==='reviewed-combo-series-view-v1'&&v.businessDate===day&&stamp(v.updatedAt)&&v.formalEligible===false&&v.modelAdoption===false&&Array.isArray(v.series)&&v.series.length<=16);
 const keys=new Set();for(const entry of v.series as unknown[]){const s=obj(entry);need(text(s.key,150)&&new RegExp('^reviewed-combo-series-'+day+'-[a-f0-9]{64}$').test(s.key)&&!keys.has(s.key));keys.add(s.key);
  need(s.verified===true&&s.state==='committed-and-acknowledged'&&s.businessDate===day&&s.formalEligible===false&&s.modelAdoption===false&&s.originalSettlementPreserved===true
   &&text(s.label,40)&&stamp(s.publishedAt)&&stamp(s.commitObservedAt)&&Date.parse(s.commitObservedAt)>Date.parse(s.publishedAt)&&Date.parse(s.commitObservedAt)<=Date.parse(v.updatedAt as string)
   &&['payloadSha256','ackSha256','recordHash'].every(k=>typeof s[k]==='string'&&/^[a-f0-9]{64}$/.test(s[k] as string))
   &&Array.isArray(s.records)&&s.records.length>=2&&s.records.length<=18&&Array.isArray(s.groups)&&s.groups.length>=1&&s.groups.length<=6&&Array.isArray(s.openEventIds));
  const records=new Map<string,Record<string,unknown>>();for(const raw of s.records as unknown[]){const d=obj(raw);need(text(d.eventId,20)&&/^\d+$/.test(d.eventId)&&!records.has(d.eventId)&&text(d.matchNum)&&text(d.homeTeamName)&&text(d.awayTeamName)&&d.homeTeamName!==d.awayTeamName&&d.businessDate===day&&stamp(d.eventVersion)&&stamp(d.cutoffAt)&&stamp(d.quoteObservedAt)&&Date.parse(d.cutoffAt)>Date.parse(s.commitObservedAt as string)&&Date.parse(d.eventVersion)>Date.parse(s.commitObservedAt as string)&&['h','d','a'].includes(d.selection as string)&&['HAD','HHAD'].includes(d.market as string)&&(d.market!=='HHAD'||Number.isSafeInteger(d.handicap))&&typeof d.sp==='number'&&d.sp>1&&d.sp<1000&&d.modelProbability===null&&d.formalEligible===false&&Array.isArray(d.scores)&&d.scores.length===2&&d.scores.every(score=>Array.isArray(score)&&score.length===2&&score.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=15)));records.set(d.eventId as string,d);}
  need(new Set(s.openEventIds as unknown[]).size===(s.openEventIds as unknown[]).length&&(s.openEventIds as unknown[]).every(id=>records.has(id as string)));
  const validity=obj(s.saleValidUntil);need(Object.keys(validity).sort().join(',')===(s.openEventIds as string[]).slice().sort().join(',')&&Object.values(validity).every(at=>stamp(at)&&Date.parse(at)>Date.parse(v.updatedAt as string)&&Date.parse(at)<=Date.parse(v.updatedAt as string)+30000));
  const slots=new Set();for(const raw of s.groups as unknown[]){const g=obj(raw);need([2,3].includes(g.size as number)&&[2.5,5,10].includes(g.band as number)&&!slots.has(g.size+'/'+g.band));slots.add(g.size+'/'+g.band);
   need(Array.isArray(g.legs)&&g.legs.length===g.size&&Array.isArray(g.eventIds)&&g.eventIds.length===g.size&&new Set(g.eventIds).size===g.size&&stamp(g.cutoffAt));let product=1;let cutoff=Infinity;
   for(const [i,rawLeg]of (g.legs as unknown[]).entries()){const l=obj(rawLeg),d=records.get(l.eventId as string);need(d&&l.eventId===(g.eventIds as unknown[])[i]&&['eventId','matchNum','market','selection','sp'].every(k=>d[k]===l[k])&&(d.handicap??null)===(l.handicap??null));product*=l.sp as number;cutoff=Math.min(cutoff,Date.parse(d!.cutoffAt as string));}
   need(typeof g.product==='number'&&Number.isFinite(g.product)&&g.product>=(g.band as number)&&Math.abs(g.product-product)<1e-9&&Date.parse(g.cutoffAt as string)===cutoff);
  }
 }
 return value as ComboSeriesView;
}
