import { parseReviewedAnalysis, parseReviewedRevisions, type ReviewedAnalysisRecord, type ReviewedRevisions } from './recommendationCenterView';
import type { Match } from './mockData';
import type { RecommendationCenterData } from './recommendationCenterView';
import { reviewedMatchRecommendation } from './publishedMatchRecommendation';
export interface OfficialEditorialReferences {businessDate:string;updatedAt:string;records:ReviewedAnalysisRecord[];revisions?:ReviewedRevisions}
export function officialReferenceNeedsSeparateCard(record:ReviewedAnalysisRecord,visibleNativeMatches:Match[],published:RecommendationCenterData|null):boolean{
 return !visibleNativeMatches.some(match=>JSON.stringify(reviewedMatchRecommendation(published,match))===JSON.stringify(record));
}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Official reference object');return v as Record<string,unknown>;};
export function officialReferenceRoute(record:Pick<ReviewedAnalysisRecord,'businessDate'|'eventId'>):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(record.businessDate)||!/^[1-9]\d{0,19}$/.test(record.eventId))throw Error('Official reference route');
 return 'official_'+record.businessDate.replaceAll('-','')+'_'+record.eventId;
}
export function parseOfficialReferenceRoute(id:string):{businessDate:string;eventId:string}|null{
 const m=/^official_(\d{4})(\d{2})(\d{2})_([1-9]\d{0,19})$/.exec(id);if(!m)return null;
 const businessDate=m[1]+'-'+m[2]+'-'+m[3];
 if(!Number.isFinite(Date.parse(businessDate+'T00:00:00Z'))||new Date(businessDate+'T00:00:00Z').toISOString().slice(0,10)!==businessDate)return null;
 return {businessDate,eventId:m[4]};
}
export function parseOfficialEditorialReferences(value:unknown,expectedDay:string):OfficialEditorialReferences{
 const v=object(value);
 if(v.version!=='official-editorial-reference-view-v1'||v.businessDate!==expectedDay||typeof v.updatedAt!=='string'
  ||v.formalEligible!==false||v.modelAdoption!==false||!Array.isArray(v.officialEventIds)||v.officialEventIds.length>32)throw Error('Official reference envelope');
 const original=object(v.original),data=parseReviewedAnalysis(original,expectedDay,v.updatedAt),raw=original.records;
 if(!Array.isArray(raw))throw Error('Official reference records');
 const ids:string[]=[];
 for(const value of raw){
  const row=object(value);if(row.eventAuthority===undefined)continue;
  const a=object(row.eventAuthority);
  if(Object.keys(a).sort().join(',')!=='calculatorCommitmentHash,calculatorRowHash,currentCommitmentHash,currentRowHash,officialOrderedTeamIds,sourceCycleId,version'
   ||a.version!=='signed-official-events-v1'||typeof a.sourceCycleId!=='string'||a.sourceCycleId.length<1||a.sourceCycleId.length>256
   ||!Array.isArray(a.officialOrderedTeamIds)||a.officialOrderedTeamIds.length!==2
   ||a.officialOrderedTeamIds.some(n=>!Number.isSafeInteger(n)||Number(n)<=0)||a.officialOrderedTeamIds[0]===a.officialOrderedTeamIds[1]
   ||['calculatorCommitmentHash','calculatorRowHash','currentCommitmentHash','currentRowHash'].some(k=>typeof a[k]!=='string'||!/^[a-f0-9]{64}$/.test(String(a[k])))
   ||typeof row.eventId!=='string')throw Error('Official event authority');
  ids.push(row.eventId);
 }
 if(new Set(ids).size!==ids.length||JSON.stringify(ids)!==JSON.stringify(v.officialEventIds))throw Error('Official reference selection');
 const revisions=v.revisions===null?undefined:parseReviewedRevisions(v.revisions,original,data,v.updatedAt);
 return {businessDate:expectedDay,updatedAt:v.updatedAt,records:data.records.filter(r=>ids.includes(r.eventId)),revisions};
}
