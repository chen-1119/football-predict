'use strict';
// SELECT-only adapter. The caller owns the existing RR/serializable transaction.
// Raw payload text and ACK bytes are rehashed on EVERY read, including cache hits.
const coveragePolicy=require('./publishedReviewCoverage.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {hash}=require('../../src/services/leagueBaselineModel.cjs');
const {loadCollectorTrustRegistry}=require('../../src/services/collectorAttestation.cjs');
const ns=require('../../src/services/prematchV3Clock.cjs').epochNanoseconds;
const fail=code=>{throw Object.assign(Error(code),{code});};
const bounds=Object.freeze({pageSize:64,legacyPageSize:8,maxArtifacts:1024,maxLegacy:100000,maxBytes:64*1024*1024,maxResultHeads:100000});
function createVerificationCache({maxEntries=256,maxBytes=32*1024*1024}={}){
 if(!Number.isSafeInteger(maxEntries)||maxEntries<0||maxEntries>256||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>32*1024*1024)fail('COVERAGE_CACHE_BOUND');
 const entries=new Map();let bytes=0;
 return {get(key){const e=entries.get(key);if(!e)return null;entries.delete(key);entries.set(key,e);return e.rows;},
  put(key,rows,size){if(!Number.isSafeInteger(size)||size<0||size>maxBytes||maxEntries===0)return;
   const old=entries.get(key);if(old){bytes-=old.size;entries.delete(key);}while(entries.size>=maxEntries||bytes+size>maxBytes){const k=entries.keys().next().value,e=entries.get(k);if(!e)break;entries.delete(k);bytes-=e.size;}
   entries.set(key,{rows,size});bytes+=size;},size(){return {entries:entries.size,bytes};}};
}
const sharedCache=createVerificationCache();
const rawColumns='artifact_key,artifact_version,generated_at,updated_at,payload::text AS payload_json,payload_sha256,payload_bytes';
const metadataColumns='artifact_key,artifact_version,generated_at,updated_at,payload_sha256,payload_bytes,octet_length(payload::text) AS actual_payload_bytes';
const sameClock=(a,b)=>ns(a)!==null&&ns(a)===ns(b);
function targetOf(value){
 if(!value||typeof value!=='object')fail('COVERAGE_TARGET_IDENTITY');
 const sourceMatchId=String(value.sourceMatchId||'').replace(/^sporttery_/,'');
 if(!/^[1-9][0-9]{0,19}$/.test(sourceMatchId)||ns(value.eventVersion)===null
  ||!/^\d{4}-\d{2}-\d{2}$/.test(value.businessDate||'')||new Date(value.businessDate+'T00:00:00Z').toISOString().slice(0,10)!==value.businessDate
  ||typeof value.homeTeamId!=='string'||!value.homeTeamId||typeof value.awayTeamId!=='string'||!value.awayTeamId||value.homeTeamId===value.awayTeamId)fail('COVERAGE_TARGET_IDENTITY');
 return {sourceMatchId,eventVersion:new Date(value.eventVersion).toISOString(),businessDate:value.businessDate,homeTeamId:value.homeTeamId,awayTeamId:value.awayTeamId};
}
function matchesIdentity(row,target){
 return String(row.sourceMatchId||row.eventId||'').replace(/^sporttery_/,'')===target.sourceMatchId&&sameClock(row.eventVersion,target.eventVersion)
  &&row.businessDate===target.businessDate&&row.homeTeamId===target.homeTeamId&&row.awayTeamId===target.awayTeamId;
}
async function loadVerifiedCoverage(client,{asOf,trustRegistry,includeResults=true,includeLegacy=true,targetIdentity,includePublications=false,cache=sharedCache}={}){
 if(ns(asOf)===null)fail('COVERAGE_CLOCK');
 const target=targetIdentity===undefined?null:targetOf(targetIdentity);
 const mode=(await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0]?.isolation;
 if(!['repeatable read','serializable'].includes(mode))fail('COVERAGE_TRANSACTION_REQUIRED');
 const trust=typeof trustRegistry==='string'?loadCollectorTrustRegistry(trustRegistry):trustRegistry;
 if(!trust||typeof trust!=='object')fail('COVERAGE_TRUST_REQUIRED');
 const trustHash=hash(trust),verified=[],rejected=[],publications=new Map(),audit={artifacts:0,legacy:0,legacySelection:'latest-per-source-event',rawBytes:0,replays:0,cacheHits:0,pages:0,resultHeads:0};
 const consume=raw=>{if(typeof raw?.payload_json!=='string')fail('COVERAGE_RAW_JSON_REQUIRED');audit.rawBytes+=Buffer.byteLength(raw.payload_json);if(audit.rawBytes>bounds.maxBytes)fail('COVERAGE_BYTE_BOUND');};
 let cursor='';
 for(;;){
  const metadata=(await client.query(`SELECT ${metadataColumns} FROM football.private_model_artifacts
   WHERE artifact_key COLLATE "C">$1 AND ((artifact_version='reviewed-analysis-freeze-v1' AND artifact_key ~ '^reviewed-analysis-[0-9]{4}-[0-9]{2}-[0-9]{2}-(selected-two|batch-[a-f0-9]{64})$')
    OR (artifact_version='league-baseline-freeze-v1' AND artifact_key ~ '^league-forecast-[a-f0-9]{64}$'))
    AND ($3::text IS NULL OR (artifact_version='reviewed-analysis-freeze-v1' AND (artifact_key LIKE 'reviewed-analysis-'||$3||'-%'
      OR EXISTS (SELECT 1 FROM json_array_elements(payload->'record'->'records') AS entry
        WHERE entry->>'eventId'=$4 AND entry->>'eventVersion'=$5)))
      OR (artifact_version='league-baseline-freeze-v1' AND (payload->'record'->'forecast'->'event'->>'businessDate'=$3
        OR (payload->'record'->'forecast'->'event'->>'sourceMatchId'=$4 AND payload->'record'->'forecast'->'event'->>'eventVersion'=$5))))
   ORDER BY artifact_key COLLATE "C" LIMIT $2`,[cursor,bounds.pageSize,target?.businessDate||null,target?.sourceMatchId||null,target?.eventVersion||null])).rows;
  if(!metadata.length)break;if(metadata.length>bounds.pageSize)fail('COVERAGE_PAGE_BOUND');audit.pages++;
  for(const r of metadata){if(typeof r.artifact_key!=='string'||r.artifact_key<=cursor)fail('COVERAGE_CURSOR_ORDER');cursor=r.artifact_key;}
  audit.artifacts+=metadata.length;if(audit.artifacts>bounds.maxArtifacts)fail('COVERAGE_ARTIFACT_BOUND');
  const keys=metadata.map(r=>r.artifact_key+'-ack'),ackMetadata=(await client.query(`SELECT ${metadataColumns} FROM football.private_model_artifacts WHERE artifact_key=ANY($1::text[]) ORDER BY artifact_key COLLATE "C"`,[keys])).rows;
  if(ackMetadata.length>metadata.length)fail('COVERAGE_ACK_BOUND');
  // Ask PostgreSQL for the actual octet count before transmitting raw JSON.
  // The immutable RR snapshot keeps this budget and subsequent bytes aligned.
  const allMetadata=[...metadata,...ackMetadata],metadataMap=new Map();let pageBytes=0;
  for(const m of allMetadata){const n=Number(m.actual_payload_bytes);
   if(metadataMap.has(m.artifact_key)||!Number.isSafeInteger(n)||n<1||n>16*1024*1024||Number(m.payload_bytes)!==n)fail('COVERAGE_METADATA_BOUND');
   if(m.artifact_key.endsWith('-ack')&&!keys.includes(m.artifact_key))fail('COVERAGE_ACK_IDENTITY');
   metadataMap.set(m.artifact_key,m);pageBytes+=n;
  }
  if(audit.rawBytes+pageBytes>bounds.maxBytes)fail('COVERAGE_BYTE_BOUND');
  const rawRows=(await client.query(`SELECT ${rawColumns} FROM football.private_model_artifacts WHERE artifact_key=ANY($1::text[]) ORDER BY artifact_key COLLATE "C"`,[[...metadataMap.keys()]])).rows;
  if(rawRows.length!==metadataMap.size)fail('COVERAGE_RAW_ROW_COUNT');const rawMap=new Map();
  for(const r of rawRows){const meta=metadataMap.get(r.artifact_key);if(!meta||rawMap.has(r.artifact_key)||r.payload_sha256!==meta.payload_sha256||Buffer.byteLength(r.payload_json||'')!==Number(meta.actual_payload_bytes))fail('COVERAGE_RAW_METADATA_MISMATCH');consume(r);rawMap.set(r.artifact_key,r);}
  const page=metadata.map(r=>rawMap.get(r.artifact_key)),acks=new Map(ackMetadata.map(r=>[r.artifact_key,rawMap.get(r.artifact_key)]));
  for(const [index,recordRow]of page.entries()){
   const track=recordRow.artifact_version==='reviewed-analysis-freeze-v1'?'manual':'trained',ackRow=acks.get(recordRow.artifact_key+'-ack');
   try{
    const raw=verifyRow(recordRow,recordRow.artifact_key),ack=verifyRow(ackRow,recordRow.artifact_key+'-ack');
    if(raw.artifactVersion!==raw.payload.version||ack.artifactVersion!==ack.payload.version)fail('COVERAGE_STORAGE_VERSION');
    if(!sameClock(raw.generatedAt,raw.payload.createdAt)||!sameClock(ack.generatedAt,ack.payload.createdAt))fail('COVERAGE_STORAGE_CLOCK');
    const k=hash([trustHash,raw.artifactKey,raw.payloadSha256,ack.payloadSha256,raw.generatedAt,raw.updatedAt,ack.generatedAt,ack.updatedAt]);
    let rows=cache.get(k);if(rows)audit.cacheHits++;else{rows=(track==='manual'?coveragePolicy.reviewed:coveragePolicy.trained)({recordRow,ackRow},{asOf,trustRegistry:trust});cache.put(k,rows,raw.payloadBytes+ack.payloadBytes);audit.replays++;}
    verified.push(...rows);
    if(includePublications)for(const row of rows){
     const record=track==='manual'?raw.payload.record.records.find(r=>r.eventId===row.eventId):raw.payload.record;
     publications.set(row.recordId,{track,record,ack:ack.payload,publication:{artifactKey:raw.artifactKey,payloadSha256:raw.payloadSha256,
      recordHash:raw.payload.record.contentHash,createdAt:raw.payload.createdAt,storedAt:raw.payload.storedAt,
      ackArtifactKey:ack.artifactKey,ackPayloadSha256:ack.payloadSha256,ackAt:row.ackAt,ackContentHash:ack.payload.contentHash}});
    }
   }catch(e){rejected.push({track,index:audit.artifacts-page.length+index,reason:String(e.code||e.message)});}
  }
  if(page.length<bounds.pageSize)break;
 }
 let after='0';
 for(;includeLegacy;){
  // Match Repository.latest(): latest sequence per typed source/event, not all
  // historical quote versions. Source-record counts refer only to these admitted
  // latest records; this does not claim replay of the superseded legacy ledger.
  // Metadata budgets the exact JSON bytes before the same-RR payload fetch.
  // Materialize the narrow page before touching historical JSON. The event
  // index supplies latest identities; historical variants are grouped once
  // for this small page, with all three JSON fields decoded in one operation.
  const metadata=(await client.query(`SELECT legacy_metadata.* FROM (
   WITH latest_page AS MATERIALIZED (
    SELECT latest.* FROM (SELECT DISTINCT ON (source_match_id,event_version)
     sequence,id,source_match_id,event_version,business_date
     FROM football.recommendation_decisions ORDER BY source_match_id,event_version,sequence DESC) AS latest
    WHERE sequence>$1::bigint ORDER BY sequence LIMIT $2
   ), identity_groups AS MATERIALIZED (
    SELECT prior.source_match_id,prior.event_version,
     count(DISTINCT ROW(prior.business_date,identity."businessDate",identity."homeTeamId",identity."awayTeamId"))::text AS identity_variants
    FROM latest_page page JOIN football.recommendation_decisions prior
     ON prior.source_match_id=page.source_match_id AND prior.event_version=page.event_version
    CROSS JOIN LATERAL jsonb_to_record(prior.payload) AS identity("businessDate" text,"homeTeamId" text,"awayTeamId" text)
    GROUP BY prior.source_match_id,prior.event_version
   )
   SELECT page.sequence::text AS sequence,page.id,page.source_match_id,
    to_char(page.event_version AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_version,
    page.business_date::text AS business_date,octet_length(current.payload::text) AS actual_payload_bytes,identities.identity_variants
   FROM latest_page page JOIN football.recommendation_decisions current ON current.sequence=page.sequence
   JOIN identity_groups identities ON identities.source_match_id=page.source_match_id AND identities.event_version=page.event_version
  ) AS legacy_metadata ORDER BY legacy_metadata.sequence::bigint`,[after,bounds.legacyPageSize])).rows;
  if(!metadata.length)break;if(metadata.length>bounds.legacyPageSize)fail('COVERAGE_PAGE_BOUND');audit.legacy+=metadata.length;if(audit.legacy>bounds.maxLegacy)fail('COVERAGE_LEGACY_BOUND');
  const selected=new Map();let pageBytes=0;
  for(const m of metadata){
   if(!/^[1-9][0-9]*$/.test(String(m.sequence))||BigInt(m.sequence)<=BigInt(after))fail('COVERAGE_CURSOR_ORDER');after=String(m.sequence);
   const bytes=Number(m.actual_payload_bytes);if(!Number.isSafeInteger(bytes)||bytes<1||bytes>16*1024*1024)fail('COVERAGE_METADATA_BOUND');
   selected.set(String(m.sequence),m);pageBytes+=bytes;
  }
  if(audit.rawBytes+pageBytes>bounds.maxBytes)fail('COVERAGE_BYTE_BOUND');
  const rows=(await client.query(`SELECT sequence::text AS sequence,payload::text AS payload_json
   FROM football.recommendation_decisions WHERE sequence=ANY($1::bigint[]) ORDER BY sequence`,[[...selected.keys()]])).rows;
  if(rows.length!==metadata.length)fail('COVERAGE_RAW_ROW_COUNT');const seen=new Set();
  for(const [index,raw]of rows.entries()){
   const m=selected.get(String(raw.sequence));if(!m||seen.has(String(raw.sequence))||typeof raw.payload_json!=='string'||Buffer.byteLength(raw.payload_json)!==Number(m.actual_payload_bytes))fail('COVERAGE_RAW_METADATA_MISMATCH');
   seen.add(String(raw.sequence));audit.rawBytes+=Buffer.byteLength(raw.payload_json);
   try{const payload=JSON.parse(raw.payload_json);
    if(payload.decisionId!==m.id||payload.sourceMatchId!==m.source_match_id||!sameClock(payload.eventVersion,m.event_version)||payload.businessDate!==m.business_date)fail('COVERAGE_LEGACY_IDENTITY');
    const verifiedRow=coveragePolicy.old({sequence:raw.sequence,payload},{asOf});
    if(String(m.identity_variants)!=='1')fail('COVERAGE_LEGACY_HISTORICAL_IDENTITY_CONFLICT');
    verified.push(verifiedRow);
   }catch(e){rejected.push({track:'legacy',index:audit.legacy-rows.length+index,reason:String(e.code||e.message)});}
  }if(metadata.length<bounds.legacyPageSize)break;
 }
 const targetRows=target?verified.filter(r=>matchesIdentity(r,target)):verified;
 const resultHeads=[];
 if(includeResults){const keys=[...new Set(targetRows.map(r=>r.eventKey))];
  for(let i=0;i<keys.length;i+=bounds.pageSize){const part=keys.slice(i,i+bounds.pageSize),rows=(await client.query(`SELECT e.payload FROM football.recommendation_result_heads h JOIN football.recommendation_result_events e ON e.id=h.event_id WHERE e.payload->>'eventKey'=ANY($1::text[])`,[part])).rows;
   if(rows.length>part.length)fail('COVERAGE_RESULT_IDENTITY');for(const r of rows){audit.rawBytes+=Buffer.byteLength(JSON.stringify(r.payload));if(audit.rawBytes>bounds.maxBytes)fail('COVERAGE_BYTE_BOUND');resultHeads.push(r.payload);}
   if(resultHeads.length>bounds.maxResultHeads)fail('COVERAGE_RESULT_BOUND');}
 }audit.resultHeads=resultHeads.length;
 // Candidate metadata only selects raw rows; it never admits them. Replay the
 // full day plus exact source/event matches from other dates before filtering,
 // so a conflicting batch cannot be hidden by a requested business date.
 const coverage=coveragePolicy.aggregateVerified({rows:verified,resultHeads,asOf,rejected});
 const conflicts=new Set([...coverage.identityConflicts,...coverage.selectionConflicts]),events=new Map();
 for(const r of coverage.rows.filter(r=>r.track!=='legacy'&&!conflicts.has(r.eventKey))){
  const sourceMatchId=String(r.sourceMatchId).replace(/^sporttery_/,'');if(!/^[1-9][0-9]{0,19}$/.test(sourceMatchId))fail('COVERAGE_EVENT_ID');
  events.set(r.eventKey,{sourceMatchId,eventVersion:new Date(r.eventVersion).toISOString(),businessDate:r.businessDate,homeTeamId:r.homeTeamId,awayTeamId:r.awayTeamId});
 }
 const selectedPublications=includePublications?coverage.rows.filter(r=>!conflicts.has(r.eventKey)&&(!target||matchesIdentity(r,target)))
  .map(r=>publications.get(r.recordId)).filter(Boolean):undefined;
 return {coverage,events:[...events.values()],audit,...(selectedPublications?{publications:selectedPublications,resultHeads}:{})};
}
function publicCoverage(coverage){const {rows,...summary}=coverage;void rows;return summary;}
async function loadVerifiedPublicationForIdentity(client,options={}){
 const target=targetOf(options.targetIdentity);
 const loaded=await loadVerifiedCoverage(client,{...options,targetIdentity:target,includeLegacy:false,includeResults:true,includePublications:true});
 if(!loaded.coverage.complete)fail('COVERAGE_PUBLICATION_INCOMPLETE');
 if(loaded.coverage.rows.some(row=>coveragePolicy.eventKey(row)===coveragePolicy.eventKey(target)&&!matchesIdentity(row,target)))fail('COVERAGE_PUBLICATION_IDENTITY_CONFLICT');
 const postMatch=loaded.coverage.rows.filter(r=>matchesIdentity(r,target)).map(r=>{
  const settlement=r.settlement,e=loaded.resultHeads.find(e=>e.eventId===settlement.resultEventId);
  const settled=['WON','LOST'].includes(settlement.state);
  return {track:r.track,state:settlement.state,score:settled?settlement.score:null,
   resultEventId:settled?e.eventId:null,revision:settled?e.revision:null,
   resultObservedAt:settled?e.observedAt:null,source:settled?e.source:null};
 });
 return {version:'verified-published-event-v1',identity:target,asOf:options.asOf,publications:loaded.publications,postMatch,audit:loaded.audit};
}
module.exports={loadVerifiedCoverage,loadVerifiedPublicationForIdentity,publicCoverage,createVerificationCache,bounds,targetOf,matchesIdentity};
