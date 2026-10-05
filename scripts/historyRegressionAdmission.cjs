'use strict';
// Pure admission of a bounded online capture. Never reads public/data or writes a model.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {isDecisionClockAuditEligible,DECISION_SNAPSHOT_VERSION}=require('../src/services/decisionSnapshot.cjs');
const {exactDecisionEventMatch}=require('../src/services/decisionEventIdentity.cjs');
const {normalizeMarketSourceProvenance}=require('../src/services/marketSourceProvenance.cjs');
const {publicKeyFingerprint,COLLECTOR_TRUST_REGISTRY_VERSION}=require('../src/services/collectorAttestation.cjs');
const {buildResultProvenance}=require('../src/services/matchLifecycle.cjs');
const {strictInstant}=require('../src/services/strictInstant.cjs');
const {resultObservationForMatch}=require('./asOfResultTimeline.cjs');
const {summarizeProbabilityRows}=require('./walkForwardValidation.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const stamp=v=>strictInstant(v)?Date.parse(v):null;
const hashPattern=/^[a-f0-9]{64}$/;
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=512;
const sameInstant=(left,right)=>stamp(left)!==null&&stamp(left)===stamp(right);
const assert=(condition,code)=>{if(!condition)throw Error(code);};
const isOmitted=value=>!!value&&typeof value==='object'&&(value.omitted===true||(typeof value.omitted==='string'&&value.omitted.length>0));
const classes=['home','draw','away'],codes=['1','X','2'];
function triplet(value,{odds=false}={}){
  if(!value||typeof value!=='object')return null;
  // Mixed aliases must agree, including explicit null/undefined; do not let an
  // invalid named value silently fall through to a different encoded outcome.
  if(classes.some((k,i)=>Object.hasOwn(value,k)&&Object.hasOwn(value,codes[i])&&value[k]!==value[codes[i]]))return null;
  const a=classes.map((k,i)=>Object.hasOwn(value,k)?value[k]:value[codes[i]]);
  if(!a.every(x=>typeof x==='number'&&Number.isFinite(x)&&(odds?x>1:x>=0&&x<=1)))return null;
  if(!odds&&Math.abs(a.reduce((x,y)=>x+y,0)-1)>0.00001)return null;
  return Object.fromEntries(classes.map((k,i)=>[k,a[i]]));
}
function sameOdds(left,right){return left&&right&&classes.every(k=>Math.abs(left[k]-right[k])<1e-9);}
function featureAudit(snapshot,decision){
  const f=snapshot?.featureSnapshot;
  const present=!!f&&!isOmitted(f),projection=snapshot?.featureSnapshotProjection===true;
  const at=stamp(f?.capturedAt),decisionAt=stamp(decision?.decisionAt);
  const bound=present&&!!f.hash&&f.hash===decision?.featureSnapshotHash;
  const timeValid=at!==null&&decisionAt!==null&&at<=decisionAt;
  const modelInputs=present&&!isOmitted(f.modelInputs)?f.modelInputs:null;
  const names=['elo','form','poisson','leaguePrior','lineup','injuries','weather','xg','scheduleDensity'];
  const groups=Object.fromEntries(names.map(name=>{
    const sourcePresence=snapshot?.featureProjectionAudit?.groups?.[name];
    const valuePresent=modelInputs?.[name]!==undefined&&modelInputs?.[name]!==null&&!isOmitted(modelInputs[name]);
    const omitted=isOmitted(f)||isOmitted(f?.modelInputs)||isOmitted(modelInputs?.[name])||sourcePresence?.status==='export-omitted';
    const status=omitted?'export-omitted':valuePresent
      ?bound&&timeValid?'frozen-value-requires-field-source-audit':'frozen-value-binding-or-clock-unverified'
      :['source-null','source-absent'].includes(sourcePresence?.status)?'source-snapshot-field-missing'
      :projection?'not-present-in-exported-feature-projection':'source-snapshot-field-missing';
    return [name,{available:valuePresent&&bound&&timeValid,valuePresent,exportOmitted:omitted,status,
      sourcePresent:sourcePresence?.sourcePresent??null,sourceNonNull:sourcePresence?.sourceNonNull??null,
    // A feature hash is a binding, not proof of a timestamp for each provider value.
    candidateEligible:false}];}));
  return {present,bound,timeValid,projection,capturedAt:f?.capturedAt||null,groups,
    missing:names.filter(name=>!groups[name].available),candidateEligible:false,
    missingSemantics:'unavailable in this frozen export; not a claim that an upstream provider failed to collect it',
    exportOmitted:names.filter(name=>groups[name].exportOmitted),
    sourceSnapshotMissing:names.filter(name=>groups[name].status==='source-snapshot-field-missing'),
    projectionPresenceUnknown:names.filter(name=>groups[name].status==='not-present-in-exported-feature-projection'),
    blocker:'field-level-source-and-availability-proof-required',
    xgPolicy:'Market-implied lambda is not observed xG; missing xG never filled from odds.'};
}
function originalClockConsistent(d){
  const audit=d?.clockAudit,times=d?.sourceTimestamps;
  if(audit?.version!=='decision-clock-audit-v1'||!times)return false;
  for(const key of ['capturedAt','decisionAt','cutoffTime','kickoffTime'])if(!sameInstant(d[key],audit[key]))return false;
  for(const key of ['modelGeneratedAt','baseModelGeneratedAt','unifiedPosteriorGeneratedAt'])if(!sameInstant(times[key],audit[key]))return false;
  const base=stamp(audit.baseModelGeneratedAt),unified=stamp(audit.unifiedPosteriorGeneratedAt),model=stamp(audit.modelGeneratedAt),decision=stamp(d.decisionAt);
  return [base,unified,model,decision].every(v=>v!==null)&&base<=unified&&model===Math.max(base,unified)&&model<=decision;
}
function resultLineageConsistent(match,sourceMatchId){
  const p=match?.resultProvenance,normalized=buildResultProvenance(match),kickoff=stamp(match?.kickoffTime);
  if(!normalized||kickoff===null||String(normalized.sourceMatchId||'')!==sourceMatchId)return false;
  // buildResultProvenance normalizes current score fields. Inspect the original
  // receipt too so a different event/result cannot lend it an observation time.
  if(p){
    if(String(p.sourceMatchId||'')!==sourceMatchId)return false;
    if(Object.hasOwn(p,'scoreHome')&&p.scoreHome!==match.scoreHome)return false;
    if(Object.hasOwn(p,'scoreAway')&&p.scoreAway!==match.scoreAway)return false;
    if(p.kickoffTime!==undefined&&!sameInstant(p.kickoffTime,match.kickoffTime))return false;
    if(p.sourceStatus!==undefined&&p.sourceStatus!=='FINISHED')return false;
  }
  const versions=[match.eventVersion,p?.eventVersion].filter(v=>v!==undefined&&v!==null);
  return versions.length>0&&versions.every(v=>stamp(v)!==null&&stamp(v)===kickoff);
}
function inspectRow(row,{collectorTrustRegistry=null,publication=null}={}){
  row=row&&typeof row==='object'?row:{};
  const match=row.match||{},snapshot=row.snapshot,d=snapshot?.decisionSnapshot;
  const decisionOmitted=isOmitted(d);
  const reasons=[];const add=(condition,reason)=>{if(!condition)reasons.push(reason);};
  const kickoff=stamp(match.kickoffTime),decisionAt=stamp(d?.decisionAt),captured=stamp(d?.capturedAt),cutoff=stamp(d?.cutoffTime);
  const score=[match.scoreHome,match.scoreAway];
  add(!row.conflictingMatchRows,'conflicting-match-rows');
  add(text(row.matchId)&&row.market==='HAD'&&String(match.sourceMatchId||'')===row.matchId,'identity-missing-or-mismatched');
  add(match.status==='FINISHED'&&score.every(v=>Number.isSafeInteger(v)&&v>=0),'unsettled-or-invalid-score');
  const observation=resultObservationForMatch(match);
  add(observation?.promotionEligible===true&&kickoff!==null&&stamp(observation.observedAt)!==null&&stamp(observation.observedAt)>kickoff,'result-observation-ineligible');
  add(resultLineageConsistent(match,row.matchId),'result-observation-lineage-mismatch');
  if(publication)add(stamp(observation?.observedAt)!==null&&stamp(observation.observedAt)<=stamp(publication.committedAt),'result-observation-after-publication');
  add(!!d,'frozen-decision-missing');
  if(decisionOmitted)reasons.push('projection-evidence-omitted');
  if(d&&!decisionOmitted){
    add(d.version===DECISION_SNAPSHOT_VERSION,'decision-version-ineligible');
    add(exactDecisionEventMatch(d,match),'decision-event-mismatch');
    if(snapshot.sourceMatchId!==undefined&&snapshot.sourceMatchId!==null)add(String(snapshot.sourceMatchId)===row.matchId,'snapshot-wrapper-event-mismatch');
    if(snapshot.kickoffTime!==undefined&&snapshot.kickoffTime!==null)add(sameInstant(snapshot.kickoffTime,match.kickoffTime),'snapshot-wrapper-event-mismatch');
    if(d.eventVersion!==undefined&&d.eventVersion!==null)add(sameInstant(d.eventVersion,match.kickoffTime),'decision-event-mismatch');
    add([kickoff,decisionAt,captured,cutoff].every(v=>v!==null)&&captured<=decisionAt&&decisionAt<=cutoff&&decisionAt<kickoff,'decision-clock-invalid');
    add(originalClockConsistent(d),'model-clock-lineage-mismatch');
    add(snapshot.phase!=='review','review-phase');
    add(text(snapshot.decisionId)&&text(d.modelVersion)&&d.modelVersion!=='unknown-model','decision-identity-or-model-version-missing');
  }
  const probabilities=triplet(d?.probabilities?.HAD);
  if(!decisionOmitted)add(!!probabilities,'frozen-probabilities-invalid');
  const originalReasons=[...reasons];
  const market=d?.markets?.HAD;
  const sp=triplet(market?.odds,{odds:true});
  if(!decisionOmitted)add(!!sp,'same-decision-sp-missing');
  const clockEligible=!!collectorTrustRegistry&&isDecisionClockAuditEligible(d,{collectorTrustRegistry});
  if(!decisionOmitted)add(clockEligible,'clock-or-provider-attestation-rejected');
  const normalized=decisionOmitted?null:normalizeMarketSourceProvenance(market?.provenance,{trustRegistry:collectorTrustRegistry});
  if(!decisionOmitted)add(market?.line===0&&normalized?.market?.poolCode==='HAD'&&String(normalized?.market?.sourceMatchId||'')===row.matchId
    &&sameOdds(sp,triplet(normalized?.extraction?.odds,{odds:true})),'sp-extraction-or-event-mismatch');
  const features=featureAudit(snapshot,d);
  const actual=match.status==='FINISHED'&&score.every(v=>Number.isSafeInteger(v)&&v>=0)
    ?score[0]>score[1]?'home':score[0]<score[1]?'away':'draw':null;
  const resultProvenance=buildResultProvenance(match);
  const record={matchId:row.matchId,market:'HAD',league:match.leagueName||match.leagueId||'unknown',
    kickoffAt:match.kickoffTime,businessDate:match.businessDate||null,cutoffAt:d?.cutoffTime||null,
    homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId,
    decision:{id:snapshot?.decisionId||null,at:d?.decisionAt||null,capturedAt:d?.capturedAt||null,modelVersion:d?.modelVersion||null,
      policyVersion:d?.policyVersion||null,probabilities,sourceCycleId:d?.sourceCycleId||null,featureSnapshotHash:d?.featureSnapshotHash||null},
    officialOdds:{sp,providerObservedAt:market?.observedAt||null,receivedAt:market?.receivedAt||null,
      provenanceHash:market?.provenanceHash||null,sourceCycleId:normalized?.cycles?.collectorSourceCycleId||null},
    result:{outcome:actual,scoreHome:score[0],scoreAway:score[1],observedAt:observation?.observedAt||null,source:observation?.source||null,
      lineage:{sourceMatchId:resultProvenance?.sourceMatchId||null,eventVersion:resultProvenance?.eventVersion||null,
        observationSourceInferred:observation?.sourceInferred===true,sourceUpdatedAt:resultProvenance?.sourceUpdatedAt||null,
        rawProvenanceJsonSha256:match.resultProvenance?sha(JSON.stringify(match.resultProvenance)):null}},
    features,sourceRows:{match:match.inputFileRowIndex,snapshot:snapshot?.inputFileRowIndex??null,
      matchObjectSha256:match.originalObjectCanonicalSha256,snapshotObjectSha256:snapshot?.originalObjectCanonicalSha256||null}};
  return {record,originalEligible:originalReasons.length===0,pairedEligible:reasons.length===0,
    replayFeatureEligible:false,reasons:[...new Set(reasons)],originalReasons,
    primaryReason:decisionOmitted?'projection-evidence-omitted':reasons[0]||'paired-accepted',clockBlockers:d?.clockAudit?.blockers||[],
    providerBlockers:normalized?.strict?.blockers||[],snapshotSelectionAudit:row.snapshotSelectionAudit};
}
function verifyEnvelope(input,{expectedPublication=null,expectedManifestFileSha256=null,rawResponseBytes=null}={}){
  if(!input||input.version!=='bounded-online-history-export-v1'||input.ok!==true||input.productionWrites!==false
    ||input.source!=='online-immutable-active-generation'||input.sameSnapshot!==true
    ||!Array.isArray(input.rows)||input.rows.length>500)throw Error('UNVERIFIED_ONLINE_CAPTURE');
  assert(Buffer.isBuffer(rawResponseBytes)&&rawResponseBytes.length>0&&rawResponseBytes.length<=10*1024*1024+1,'RAW_RESPONSE_PROOF_REQUIRED');
  const transport=input.transport;
  assert(hashPattern.test(transport?.responseByteSha256||'')&&sha(rawResponseBytes)===transport.responseByteSha256,'RAW_RESPONSE_HASH_MISMATCH');
  let remote;
  try{remote=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(rawResponseBytes));}catch{throw Error('RAW_RESPONSE_INVALID_JSON');}
  const {transport:ignored,...projected}=input;
  assert(isDeepStrictEqual(remote,projected),'CAPTURE_DIFFERS_FROM_RAW_RESPONSE');
  assert(!rawResponseBytes.toString('utf8').toUpperCase().includes('PRIVATE KEY'),'PRIVATE_KEY_FORBIDDEN');
  assert(text(transport.sourceHost)&&/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(transport.pinnedSshFingerprint||'')
    &&hashPattern.test(transport.exporterSha256||'')&&stamp(transport.receivedAt)!==null,'TRANSPORT_PROOF_INVALID');
  assert(stamp(input.observedAt)!==null&&stamp(input.completedAt)!==null&&stamp(input.completedAt)>=stamp(input.observedAt)
    ,'CAPTURE_CLOCK_INVALID');
  const p=input.publication;
  if(!hashPattern.test(p?.manifestHash||'')||p.generationId!=='g-'+p.manifestHash||!text(p.sourceCycleId)||stamp(p.committedAt)===null
    ||stamp(p.committedAt)>stamp(input.observedAt))throw Error('INVALID_PUBLICATION');
  if(expectedPublication&&['generationId','manifestHash','sourceCycleId','committedAt'].some(k=>p[k]!==expectedPublication[k]))throw Error('PUBLICATION_MISMATCH');
  assert(hashPattern.test(input.pointerSha256||'')&&hashPattern.test(input.manifestFileSha256||'')&&hashPattern.test(input.rowsCanonicalSha256||''),'CONTROL_HASH_MISSING');
  if(expectedManifestFileSha256!==null)assert(hashPattern.test(expectedManifestFileSha256)&&input.manifestFileSha256===expectedManifestFileSha256,'MANIFEST_FILE_HASH_MISMATCH');
  const selection=input.selection,from=stamp(selection?.from),until=stamp(selection?.until);
  assert(Number.isSafeInteger(selection?.maxMatches)&&selection.maxMatches>=1&&selection.maxMatches<=500
    &&Number.isSafeInteger(selection?.pageSize)&&selection.pageSize>=1&&selection.pageSize<=50
    &&input.rows.length<=selection.maxMatches,'SELECTION_LIMIT_INVALID');
  assert(from!==null&&until!==null&&from<until,'SELECTION_DATE_INVALID');
  const keys=new Set();for(const row of input.rows){
    assert(text(row?.matchId)&&row.matchId.length<=160&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(row.matchId)&&row.market==='HAD','ROW_IDENTITY_INVALID');
    const key=row.matchId+'|'+row.market;if(keys.has(key))throw Error('DUPLICATE_MATCH_MARKET');keys.add(key);
    const kickoff=stamp(row.match?.kickoffTime);
    assert(kickoff!==null&&kickoff>=from&&kickoff<until,'ROW_OUTSIDE_SELECTION_WINDOW');
    for(const entity of [row.match,...(row.snapshot?[row.snapshot]:[])])assert(Number.isSafeInteger(entity?.inputFileRowIndex)
      &&entity.inputFileRowIndex>=0&&hashPattern.test(entity.originalObjectCanonicalSha256||''),'SOURCE_ROW_PROOF_MISSING');
  }
  assert(Array.isArray(input.files)&&input.files.length===2,'SOURCE_FILE_PROOF_MISSING');
  for(const name of ['matches-history.json','prediction-snapshots.json']){
    const found=input.files?.filter(x=>x.path===name)||[];
    if(found.length!==1||!Number.isSafeInteger(found[0].bytes)||found[0].bytes<0||found[0].bytes>900*1024*1024||!hashPattern.test(found[0].sha256||''))throw Error('SOURCE_FILE_PROOF_MISSING');
  }
  assert(Array.isArray(input.pages)&&input.pages.length===Math.ceil(input.rows.length/selection.pageSize),'PAGE_PROOF_INVALID');
  input.pages.forEach((page,i)=>{
    const start=i*selection.pageSize,slice=input.rows.slice(start,start+selection.pageSize);
    assert(page?.offset===start&&page.rows===slice.length&&isDeepStrictEqual(page.matchIds,slice.map(row=>row.matchId))
      &&hashPattern.test(page.canonicalSha256||''),'PAGE_PROOF_INVALID');
  });
  const registry=input.collectorTrustRegistry,evidence=input.collectorTrustRegistryEvidence;
  assert(registry?.version===COLLECTOR_TRUST_REGISTRY_VERSION&&Array.isArray(registry.keys)&&registry.keys.length>0&&registry.keys.length<=64,'COLLECTOR_REGISTRY_INVALID');
  assert(evidence?.stableBeforeAfter===true&&hashPattern.test(evidence.fileSha256||'')&&Number.isSafeInteger(evidence.bytes)
    &&evidence.bytes>0&&evidence.bytes<=262144,'COLLECTOR_REGISTRY_PROOF_MISSING');
  const registryIds=new Set();
  for(const key of registry.keys){
    assert(text(key?.keyId)&&key.keyId.length<=128&&!registryIds.has(key.keyId)&&key.algorithm==='Ed25519'
      &&typeof key.enabled==='boolean'&&typeof key.publicKeyPem==='string'&&key.publicKeyPem.length<=4096
      &&key.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')&&hashPattern.test(key.fingerprint||''),'COLLECTOR_REGISTRY_INVALID');
    try{assert(publicKeyFingerprint(key.publicKeyPem)===key.fingerprint,'COLLECTOR_REGISTRY_INVALID');}catch{throw Error('COLLECTOR_REGISTRY_INVALID');}
    registryIds.add(key.keyId);
  }
  return {rawResponseSha256:transport.responseByteSha256,rawResponseVerified:true,captureMatchesRawResponse:true,
    crossHostClockOrderingAssumed:false,
    pythonCanonicalHashesRecomputed:false,pythonCanonicalHashPolicy:'row/page/object hashes are retained from the hash-bound raw exporter response; no cross-language JSON re-encoding claim',
    expectedPublicationMatched:!!expectedPublication,expectedManifestFileMatched:expectedManifestFileSha256!==null};
}
function metrics(rows,key='model'){
  return summarizeProbabilityRows(rows.map(r=>({actual:codes[classes.indexOf(r.result.outcome)],probabilities:key==='model'?r.decision.probabilities:
    Object.fromEntries(classes.map(k=>[k,1/r.officialOdds.sp[k]]))})));
}
function analyzeCapture(input,options={}){
  const envelopeVerification=verifyEnvelope(input,options);
  const inspections=input.rows.map(row=>inspectRow(row,{collectorTrustRegistry:options.collectorTrustRegistry||input.collectorTrustRegistry||null,publication:input.publication}));
  const records=inspections.filter(x=>x.pairedEligible).map(x=>x.record),original=inspections.filter(x=>x.originalEligible).map(x=>x.record);
  const primary={},reasons={},featureMissing={},featureUnavailability={};
  for(const x of inspections){primary[x.primaryReason]=(primary[x.primaryReason]||0)+1;
    for(const reason of x.reasons)reasons[reason]=(reasons[reason]||0)+1;
    for(const name of x.record.features.missing){featureMissing[name]=(featureMissing[name]||0)+1;
      const status=x.record.features.groups[name].status;featureUnavailability[status]=(featureUnavailability[status]||0)+1;}}
  return {version:'history-regression-admission-v1',productionWrites:false,productionEligible:false,source:{publication:input.publication,files:input.files,
      transport:input.transport,selection:input.selection,observedAt:input.observedAt,envelopeVerification},
    funnel:{...input.counts,selected:input.rows.length,frozenProbabilityScorable:original.length,sameDecisionPaired:records.length,
      replayFeatureEligible:0,primaryExclusions:primary,overlappingExclusionReasons:reasons,featureMissing,featureUnavailability},
    originalPublishedForecastReview:{label:'Frozen history audit, not proof of the released 145-event cohort',rows:original.length,metrics:metrics(original)},
    pairedReview:{label:'Same-decision signed-market paired subset; not model promotion evidence',rows:records.length,model:metrics(records),market:metrics(records,'market')},
    records,originalRecords:original,inspections,limitations:['Published strict 145-event cohort also requires reconstructed historical-feature admission; not replicated here.',
      'Current-generation result receipt can be later than the original result; only preserved observation times may train replay.',
      'ROI/drawdown omitted: frozen wager ledger and settlement semantics have not been fully verified.',
      'Feature presence is diagnostic, not proof of field-level pre-decision availability. Candidate feature replay remains blocked.']};
}
if(require.main===module){
  const [inputFile,priorReceipt,outputFile]=process.argv.slice(2);
  if(!outputFile)throw Error('Usage: node scripts/historyRegressionAdmission.cjs CAPTURE.json PRIOR_ONLINE_RECEIPT.json REPORT.json');
  const rawFile=inputFile+'.remote-response.json';
  if([inputFile,priorReceipt,rawFile].some(file=>path.resolve(outputFile)===path.resolve(file)))throw Error('OUTPUT_OVERLAPS_INPUT');
  for(const [file,limit] of [[inputFile,32*1024*1024],[priorReceipt,4*1024*1024],[rawFile,10*1024*1024+1]]){
    const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=limit,'LOCAL_INPUT_BOUND');
  }
  const bytes=fs.readFileSync(inputFile),receiptBytes=fs.readFileSync(priorReceipt),rawResponseBytes=fs.readFileSync(rawFile),input=JSON.parse(bytes),receipt=JSON.parse(receiptBytes);
  assert(receipt.version==='online-validation-inputs-v1'&&receipt.productionWrites===false&&receipt.sameSnapshot===true
    &&receipt.source==='online-immutable-active-generation'&&receipt.publication&&hashPattern.test(receipt.manifestFileSha256||''),'PRIOR_RECEIPT_INVALID');
  const report=analyzeCapture(input,{expectedPublication:receipt.publication,expectedManifestFileSha256:receipt.manifestFileSha256,rawResponseBytes});
  report.inputs={capture:{path:path.resolve(inputFile),bytes:bytes.length,sha256:sha(bytes)},priorReceipt:{path:path.resolve(priorReceipt),sha256:sha(receiptBytes)},rawResponse:{path:path.resolve(rawFile),bytes:rawResponseBytes.length,sha256:sha(rawResponseBytes)}};
  fs.mkdirSync(path.dirname(path.resolve(outputFile)),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({outputFile,funnel:report.funnel,pairedReview:report.pairedReview}));
}
module.exports={triplet,featureAudit,inspectRow,verifyEnvelope,analyzeCapture,metrics,originalClockConsistent,resultLineageConsistent};
