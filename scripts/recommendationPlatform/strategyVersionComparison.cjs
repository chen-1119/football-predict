'use strict';

const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const crypto=require('node:crypto');
const {strictInstant}=require('../../src/services/strictInstant.cjs');
const {validDecision}=require('./decision.cjs');
const {key,validResultEvent,settleDecision}=require('./results.cjs');
const {buildPublishedScoreDistribution}=require('../../src/services/publishedScoreDistribution.cjs');
const {evaluateEvidencePriceRecommendation}=require('../../src/services/evidencePriceRecommendationPolicy.cjs');
const {validPublicReferenceArchive,comparePublicReferenceArchive}=require('./publicStrategyReferenceComparison.cjs');

const VERSION='strategy-version-comparison-v1';
const CODES=['1','X','2'];
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const epoch=x=>strictInstant(x)?Date.parse(x):NaN;
function instant(value){
  if(!strictInstant(value))return null;
  const fraction=/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1]||'';
  return BigInt(Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/,'')))*1000000n+BigInt(fraction.padEnd(9,'0'));
}
const before=(a,b)=>instant(a)!==null&&instant(b)!==null&&instant(a)<instant(b);
const after=(a,b)=>instant(a)!==null&&instant(b)!==null&&instant(a)>instant(b);
const safeKey=x=>{try{return key(x);}catch{return null;}};
const sealed=body=>({...body,contentHash:hash(body)});
function validSeal(record){try{const {contentHash,...body}=record;return sha(contentHash)&&hash(body)===contentHash;}catch{return false;}}
const vector=p=>p&&CODES.every(c=>Number.isFinite(p[c])&&p[c]>=0&&p[c]<=1)&&Math.abs(CODES.reduce((s,c)=>s+p[c],0)-1)<1e-6;
const pick=(market,code,line,p,q)=>CODES.includes(code)?{market,tipCode:code,handicapLine:line,probability:p?.[code]??null,odds:q?.[code]??null}:null;
const clone=x=>structuredClone(x);

function assertSource(snapshot,sourceSha256){
  if(snapshot?.version!=='precutoff-target-versions-readonly-v1'||snapshot.readOnly!=='on'||snapshot.productionWrites!==0
    ||!Number.isFinite(epoch(snapshot.observedAt))||!sha(sourceSha256)||!Array.isArray(snapshot.latestFull)||!snapshot.latestFull.length
    ||!Array.isArray(snapshot.versions))throw new Error('A timestamped read-only PostgreSQL source and its actual file hash are required');
  const events=new Set(),versionIds=new Set(),recordHashes=new Set(),cohortEvents=new Set();
  for(const d of snapshot.latestFull){
    if(!validDecision(d)||!before(d.publishedAt,d.cutoffTime)||!before(d.publishedAt,d.kickoffTime)||after(d.publishedAt,snapshot.observedAt))throw new Error('Invalid final frozen decision');
    if(events.has(key(d)))throw new Error('Duplicate final event');events.add(key(d));
  }
  for(const v of snapshot.versions){
    if(!events.has(safeKey(v))||!sha(v.recordHash)||typeof v.decisionId!=='string'||!vector(v.HAD?.probabilities)
      ||!CODES.includes(v.HAD?.code)||!before(v.publishedAt,v.cutoffTime)||!before(v.publishedAt,v.eventVersion)
      ||after(v.publishedAt,snapshot.observedAt))throw new Error('Invalid archive projection');
    const cohortEvent=JSON.stringify([v.publishedAt,v.publication?.generationId,safeKey(v)]);
    if(versionIds.has(v.decisionId)||recordHashes.has(v.recordHash)||cohortEvents.has(cohortEvent))throw new Error('Duplicate archived version or cohort event');
    versionIds.add(v.decisionId);recordHashes.add(v.recordHash);cohortEvents.add(cohortEvent);
  }
  for(const d of snapshot.latestFull){
    const versions=snapshot.versions.filter(v=>key(v)===key(d));
    const latest=versions.reduce((a,b)=>a&&after(a.publishedAt,b.publishedAt)?a:b,null);
    if(!latest||latest.decisionId!==d.decisionId||latest.recordHash!==d.recordHash)throw new Error('Final decision is not the last archived publication');
  }
}

function archiveRow(v,d){
  const h=v.HHAD,primary=v.coherentPrimary;
  const hCode=v.primaryPickPolicyVersion==='coherent-market-primary-v1'?primary?.hhadCode??null
    :v.primaryPickPolicyVersion==='independent-market-primary-v1'?h?.overallTipCode:h?.tipCode;
  const hh=pick('HHAD',hCode,h?.line,h?.overallProbabilities,h?.quoteOdds);
  const had=pick('HAD',v.HAD.code,0,v.HAD.probabilities,v.HAD.quoteOdds);
  const main=primary?.anchorMarket==='HHAD'?hh:had;
  const exact=v.supplementaryResearch?.exactScore;
  return {sourceMatchId:v.sourceMatchId,eventVersion:v.eventVersion,homeTeamId:d.homeTeamId,awayTeamId:d.awayTeamId,
    matchNo:d.matchNo,homeTeamName:d.homeTeamName,awayTeamName:d.awayTeamName,decisionId:v.decisionId,recordHash:v.recordHash,
    publishedAt:v.publishedAt,cutoffTime:v.cutoffTime,upstreamModelVersion:v.upstreamModelVersion,
    sourceCycleId:v.sourceCycleId,publication:clone(v.publication),originalPrimary:main,HAD:had,HHAD:hh,
    exactScore:exact?{label:exact.label,probability:exact.probability}:null,
    originalScoreOrigin:exact?'stored-frozen-supplementary-research':'no-stored-score-pick',
    sourceEvidenceHashes:clone(v.sourceEvidenceHashes||{}),validationScope:'readonly-postgres-archive-projection'};
}

/** Freeze a new selection experiment before kickoff, with its actual creation
 * time. It is an after-sale-cutoff replay of a verified online publication;
 * it cannot become an official pre-cutoff recommendation or recalibrate p. */
function buildExperiment(sourceBytes,{generatedAt,sourceSha256,codeCommit,codeHashes,publicReferenceArchive=null}={}){
  if(!Buffer.isBuffer(sourceBytes)&&typeof sourceBytes!=='string')throw new Error('Original online source bytes are required');
  if(crypto.createHash('sha256').update(sourceBytes).digest('hex')!==sourceSha256)throw new Error('Source file hash mismatch');
  const snapshot=JSON.parse(sourceBytes.toString());
  assertSource(snapshot,sourceSha256);
  const at=epoch(generatedAt);
  if(!Number.isFinite(at)||after(snapshot.observedAt,generatedAt)||typeof codeCommit!=='string'||!/^[a-f0-9]{40}$/.test(codeCommit)||!codeHashes||!Object.keys(codeHashes).length
    ||Object.values(codeHashes).some(x=>!sha(x)))throw new Error('Actual generation time and code identity are required');
  if(publicReferenceArchive&&(!validPublicReferenceArchive(publicReferenceArchive)||after(publicReferenceArchive.sourceObservedAt,generatedAt)
    ||publicReferenceArchive.businessDate!==snapshot.latestFull[0].businessDate
    ||publicReferenceArchive.finalDecisionBindings.length!==snapshot.latestFull.length
    ||publicReferenceArchive.finalDecisionBindings.some(b=>!snapshot.latestFull.some(d=>d.decisionId===b.decisionId&&d.recordHash===b.recordHash))))throw new Error('Public reference archive binding invalid');
  const fullByKey=new Map(snapshot.latestFull.map(d=>[key(d),d]));
  const archive=sealed({version:VERSION,kind:'original-archive',sourceSha256,sourceObservedAt:snapshot.observedAt,
    createdAt:generatedAt,productionWrites:0,independentMatchCount:fullByKey.size,
    warning:'Repeated versions of the same event are not independent accuracy samples.',
    rows:snapshot.versions.map(v=>archiveRow(v,fullByKey.get(key(v))))});
  const rows=snapshot.latestFull.map(d=>{
    const referenceMatch=snapshot.matches?.map(x=>x.payload||x).find(m=>key(m)===key(d)&&m.homeTeamId===d.homeTeamId&&m.awayTeamId===d.awayTeamId)||null;
    // Assess the immutable input at its original publication clock. generatedAt
    // remains separate and must never be represented as a fresh quote clock.
    const assessment=evaluateEvidencePriceRecommendation(d,{asOf:d.publishedAt,referenceMatch});
    const distribution=buildPublishedScoreDistribution(d,{limit:3});
    const had=assessment.distributions.HAD,hh=assessment.distributions.HHAD;
    const original=archive.rows.find(v=>v.decisionId===d.decisionId);
    const afterCutoff=!before(generatedAt,d.cutoffTime),beforeKickoff=before(generatedAt,d.kickoffTime);
    const topScores=distribution.status==='available'?distribution.topScores.map(s=>({label:s.label,home:s.home,away:s.away,
      probability:s.probability,hadCode:s.hadCode,hhadCode:s.hhadCode,
      compatibleOriginalPrimary:original.originalPrimary?.market==='HHAD'?s.hhadCode===original.originalPrimary.tipCode:s.hadCode===original.originalPrimary?.tipCode,
      compatibleModelTendency:s.hadCode===had.modelLeader})):[];
    return {sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,homeTeamId:d.homeTeamId,awayTeamId:d.awayTeamId,
      matchNo:d.matchNo,homeTeamName:d.homeTeamName,awayTeamName:d.awayTeamName,kickoffTime:d.kickoffTime,cutoffTime:d.cutoffTime,
      decisionId:d.decisionId,decisionRecordHash:d.recordHash,inputPublishedAt:d.publishedAt,modelGeneratedAt:d.modelGeneratedAt,
      generatedAt,afterCutoff,beforeKickoff,formalHitRateEligible:false,researchComparisonEligible:beforeKickoff,
      probabilitiesUnchanged:true,formalEligible:false,primary:null,companion:null,
      referenceLabel:'model outcome tendency; uncalibrated; not a betting recommendation',
      modelTendency:pick('HAD',had.modelLeader,0,had.modelProbabilities,had.quoteOdds),
      marketBaseline:pick('HAD',had.marketLeader,0,had.marketProbabilities,had.quoteOdds),
      independentHandicapTendency:pick('HHAD',hh.modelLeader,hh.handicapLine,hh.modelProbabilities,hh.quoteOdds),
      fullHADDistribution:clone(had.modelProbabilities),fullHHADDistribution:clone(hh.modelProbabilities),
      originalPrimary:clone(original.originalPrimary),originalHAD:clone(original.HAD),originalHHAD:clone(original.HHAD),
      originalExactScore:clone(original.exactScore),topScores,scoreRule:'global-unconditional-top3; no conditional branch filter',
      sourceQuoteClocks:{HAD:had.quoteObservedAt,HHAD:hh.quoteObservedAt},strategyAssessment:assessment};
  });
  const shadow=sealed({version:VERSION,kind:'shadow-experiment',experimentVersion:'independent-outcome-shadow-v2-20261005',
    generatedAt,businessDate:snapshot.latestFull[0].businessDate,sourceObservedAt:snapshot.observedAt,
    sourceSha256,archiveContentHash:archive.contentHash,publicReferenceArchiveContentHash:publicReferenceArchive?.contentHash??null,codeCommit,codeHashes,productionWrites:0,
    modelTrainingPerformed:false,probabilityCalibrationPerformed:false,formalHitRateEligible:false,
    comparisonScope:'Prospective pre-kickoff shadow. Sale-cutoff eligibility is not retrospective.',rows});
  return {shadow,archive};
}

function verifiedHead(row,heads,asOf){
  const same=(heads||[]).filter(e=>safeKey(e)===safeKey(row));
  if(!same.length)return {state:'PENDING',score:null};
  const sorted=same.slice().sort((a,b)=>Number(b.revision)-Number(a.revision));
  const head=sorted[0];
  if(!validResultEvent(head)||instant(head.observedAt)===null||after(head.observedAt,asOf)
    ||(head.state==='FINAL'&&before(head.observedAt,row.eventVersion))
    ||(head.homeTeamId&&head.homeTeamId!==row.homeTeamId)||(head.awayTeamId&&head.awayTeamId!==row.awayTeamId))
    return {state:'DISPUTED',score:null,reason:'unverified-or-mismatched-result'};
  if(same.some(e=>e!==head&&e.revision===head.revision&&e.eventId!==head.eventId))return {state:'DISPUTED',score:null,reason:'conflicting-result-head'};
  return {state:head.state,score:head.state==='FINAL'?`${head.scoreHome}-${head.scoreAway}`:null,
    event:head,resultEventId:head.eventId,revision:head.revision};
}
function settlePick(row,p,result,eligible=true){
  if(!eligible)return {state:'EXCLUDED',score:result.score,reason:'generated-after-kickoff'};
  if(!p)return {state:'EXCLUDED',score:result.score,reason:'no-frozen-pick'};
  if(result.state!=='FINAL')return {state:result.state,score:result.score,resultEventId:result.resultEventId??null};
  const d={...row,market:p.market,tipCode:p.tipCode,handicapLine:p.handicapLine};
  return settleDecision(d,result.event);
}
const summarize=items=>{
  const count=state=>items.filter(x=>x.state===state).length;
  const settled=count('WON')+count('LOST');
  return {published:items.length,settled,won:count('WON'),lost:count('LOST'),pending:count('PENDING'),void:count('VOID'),
    disputed:count('DISPUTED'),excluded:count('EXCLUDED'),hitRate:settled?count('WON')/settled:null};
};
function scoreSettle(row,labels,result,eligible=true){
  if(!eligible||!labels?.length)return {state:'EXCLUDED',score:result.score};
  if(result.state!=='FINAL')return {state:result.state,score:result.score};
  return {state:labels.includes(result.score)?'WON':'LOST',score:result.score,resultEventId:result.resultEventId,revision:result.revision};
}

/** A separate result projection. Never writes the original recommendation or
 * result ledger. Unknown results are pending and are absent from denominators. */
function compareVersions(shadow,archive,heads,{asOf,publicReferenceArchive=null}={}){
  if(!validSeal(shadow)||!validSeal(archive)||shadow.kind!=='shadow-experiment'||archive.kind!=='original-archive'
    ||shadow.archiveContentHash!==archive.contentHash||shadow.sourceSha256!==archive.sourceSha256
    ||!Number.isFinite(epoch(asOf))||before(asOf,shadow.generatedAt))throw new Error('Broken frozen experiment or comparison clock');
  if(shadow.publicReferenceArchiveContentHash!==null&&(!validPublicReferenceArchive(publicReferenceArchive)
    ||publicReferenceArchive.contentHash!==shadow.publicReferenceArchiveContentHash))throw new Error('Frozen public reference archive missing or changed');
  const publicReferenceComparison=publicReferenceArchive?comparePublicReferenceArchive(publicReferenceArchive,heads,{asOf}):null;
  const rows=shadow.rows.map(row=>{
    const result=verifiedHead(row,heads,asOf),eligible=row.researchComparisonEligible===true;
    return {sourceMatchId:row.sourceMatchId,matchNo:row.matchNo,match:`${row.homeTeamName} - ${row.awayTeamName}`,
      state:result.state,score:result.score,resultEventId:result.resultEventId??null,revision:result.revision??null,
      originalPrimary:settlePick(row,row.originalPrimary,result),originalHAD:settlePick(row,row.originalHAD,result),
      originalHHAD:settlePick(row,row.originalHHAD,result),v2ModelTendency:settlePick(row,row.modelTendency,result,eligible),
      marketBaseline:settlePick(row,row.marketBaseline,result,eligible),v2HandicapTendency:settlePick(row,row.independentHandicapTendency,result,eligible),
      originalExactScore:scoreSettle(row,row.originalExactScore?[row.originalExactScore.label]:[],result),
      v2GlobalScoreTop1:scoreSettle(row,row.topScores.slice(0,1).map(s=>s.label),result,eligible),
      v2GlobalScoreTop3:scoreSettle(row,row.topScores.map(s=>s.label),result,eligible)};
  });
  const grouped=new Map();
  for(const row of archive.rows){
    const cohortKey=JSON.stringify([row.publishedAt,row.publication?.generationId]);
    const list=grouped.get(cohortKey)||[];list.push(row);grouped.set(cohortKey,list);
  }
  const archiveCohorts=[...grouped].map(([cohortKey,versions])=>{
    const resolved=versions.map(row=>{const r=verifiedHead(row,heads,asOf);return {row,r};});
    const sums=property=>summarize(resolved.map(({row,r})=>property==='exactScore'?scoreSettle(row,row.exactScore?[row.exactScore.label]:[],r):settlePick(row,row[property],r)));
    return {cohortKey,publishedAt:versions[0].publishedAt,decisionIds:versions.map(v=>v.decisionId),independentMatchCount:new Set(versions.map(key)).size,
      originalPrimary:sums('originalPrimary'),HAD:sums('HAD'),HHAD:sums('HHAD'),exactScore:sums('exactScore')};
  });
  const categories=['originalPrimary','originalHAD','originalHHAD','v2ModelTendency','marketBaseline','v2HandicapTendency','originalExactScore','v2GlobalScoreTop1','v2GlobalScoreTop3'];
  return sealed({version:VERSION,kind:'result-comparison',asOf,productionWrites:0,shadowContentHash:shadow.contentHash,archiveContentHash:archive.contentHash,
    finalConfirmed:rows.filter(r=>r.state==='FINAL').length,independentMatchCount:rows.length,
    formalHitRateEligible:false,interpretation:'Exploratory per-version counts only; no accuracy improvement claim from one day or repeated versions.',
    warning:'Top3 score coverage uses three selections per match and must not be compared as a single-score hit rate.',
    summary:Object.fromEntries(categories.map(c=>[c,summarize(rows.map(r=>r[c]))])),rows,archiveCohorts,publicReferenceComparison});
}

module.exports={VERSION,validSeal,buildExperiment,compareVersions};
