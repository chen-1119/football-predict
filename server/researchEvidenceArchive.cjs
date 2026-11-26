'use strict';
const evidence=require('../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const store=require('../scripts/teamEvidenceStore.cjs');
const {transaction}=require('../scripts/recommendationPlatform/leagueBaselineRuntime.cjs');
const fail=code=>{throw Object.assign(Error(code),{code,retryWriteAutomatically:false});};
function identity(key,payloadSha256){
 if(!/^team-evidence-[a-f0-9]{64}$/.test(key||'')||!/^[a-f0-9]{64}$/.test(payloadSha256||''))fail('RESEARCH_EVIDENCE_IDENTITY');
}
async function observe(pool,key,payloadSha256){
 identity(key,payloadSha256);
 return transaction(pool,true,async client=>{
  const bounds=(await client.query('SELECT payload_bytes,octet_length(payload::text) AS actual_bytes FROM football.private_model_artifacts WHERE artifact_key=$1',[key])).rows;
  if(!bounds.length)return {state:'not-observed',key,verified:false,archiveOnly:true,published:false,retryWriteAutomatically:false};
  if(bounds.length!==1||!Number.isSafeInteger(Number(bounds[0].payload_bytes))||Number(bounds[0].payload_bytes)<1
   ||Number(bounds[0].payload_bytes)>evidence.MAX_BYTES||Number(bounds[0].payload_bytes)!==Number(bounds[0].actual_bytes))fail('RESEARCH_EVIDENCE_BOUND');
  const row=await store.read(client,key),value=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  const at=value instanceof Date?value.toISOString():value;
  if(!row||row.payloadSha256!==payloadSha256||row.artifactVersion!==evidence.VERSION
   ||key!=='team-evidence-'+row.payload.contentHash||row.generatedAt!==row.payload.createdAt
   ||Date.parse(row.generatedAt)>Date.parse(row.updatedAt)||Date.parse(row.updatedAt)>Date.parse(at))fail('RESEARCH_EVIDENCE_BINDING');
  evidence.validate(row.payload,at);
  return {state:'committed-readback-verified',key,payloadSha256:row.payloadSha256,contentHash:row.payload.contentHash,
   archivedAt:row.updatedAt,observedAt:at,verified:true,archiveOnly:true,commitAcknowledged:true,published:false,retryWriteAutomatically:false};
 });
}
async function archive(pool,packet,payloadSha256){
 const key='team-evidence-'+packet.contentHash,before=await observe(pool,key,payloadSha256);
 if(before.state!=='not-observed')return {...before,submitted:false};
 await store.write(pool,(client,at)=>evidence.archive(client,packet,at));
 const after=await observe(pool,key,payloadSha256);
 if(!after.verified)fail('RESEARCH_EVIDENCE_READBACK');
 return {...after,submitted:true};
}
module.exports={identity,observe,archive};
