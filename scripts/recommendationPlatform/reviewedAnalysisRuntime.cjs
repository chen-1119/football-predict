'use strict';
const p=require('./reviewedAnalysis.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {SELECT}=require('../leagueBaselineRegistry.cjs');
const {transaction}=require('./leagueBaselineRuntime.cjs');
const {loadCollectorTrustRegistry}=require('../../src/services/collectorAttestation.cjs');
const {readLiveOfficialSnapshot}=require('./liveOfficialHandicap.cjs');
const key=d=>'reviewed-analysis-'+d.businessDate+'-selected-two';
const trust=()=>loadCollectorTrustRegistry(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH||require('node:path').resolve(__dirname,'../../deploy/light-server/collector-trust-registry.json'));
async function dbNow(c){const t=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;return t instanceof Date?t.toISOString():t;}
function deadline(record,at){p.check(Number.isFinite(Date.parse(at))&&Date.parse(at)>Date.parse(record.createdAt)&&record.records.every(r=>Date.parse(at)<Date.parse(r.cutoffAt)),'COMMIT_DEADLINE');}
async function insert(c,k,v,at){
 const json=JSON.stringify(v);p.check(Buffer.byteLength(json)<=8*1024*1024,'STORE_BOUND');
 await c.query(`INSERT INTO football.private_model_artifacts (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
 VALUES($1,$2,$3,$4,$5::json,$6,$7)`,[k,v.version,v.createdAt,at,json,p.sha(json),Buffer.byteLength(json)]);
 const row=verifyRow((await c.query(SELECT,[k])).rows[0],k);p.check(row.payloadJson===json,'ROUNDTRIP');return row;
}
async function publish(draft,{pool,expectedDraftHash}){
 p.check(p.hash(draft)===expectedDraftHash,'DRAFT_CHANGED');const registry=trust(),k=key(draft);
 const stored=await transaction(pool,false,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
  p.check(!(await c.query(SELECT,[k])).rows.length,'ALREADY_PUBLISHED_READ_FIRST');
  const matches=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);p.check(matches.length<=512,'MATCH_BOUND');
  const snapshot=readLiveOfficialSnapshot(),asOf=await dbNow(c),record=p.make(draft,{matches,snapshot,trustRegistry:registry,asOf});
  const inputs={matches:matches.filter(m=>record.records.some(r=>r.eventId===String(m.sourceMatchId||'').replace(/^sporttery_/,''))),snapshot};
  const storedAt=await dbNow(c);deadline(record,storedAt);
  const payload=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:record.createdAt,record,draft,inputs,storedAt});
  const row=await insert(c,k,payload,storedAt);deadline(record,await dbNow(c));return row;
 });
 // Unknown COMMIT is never retried. The separate ACK proves committed readback.
 const ack=await transaction(pool,false,async c=>{
  const row=verifyRow((await c.query(SELECT,[k])).rows[0],k);p.check(row.payloadSha256===stored.payloadSha256,'COMMITTED_READBACK');
  const at=await dbNow(c);deadline(row.payload.record,at);
  p.check(Date.parse(at)>=Date.parse(row.payload.storedAt)&&Date.parse(at)-Date.parse(row.payload.storedAt)<=30000,'ACK_CLOCK');
  return insert(c,k+'-ack',p.seal({version:'reviewed-analysis-ack-v1',createdAt:at,recordKey:k,storedSha256:row.payloadSha256,recordHash:row.payload.record.contentHash}),at);
 });
 return {status:'committed-and-acknowledged',key:k,payloadSha256:stored.payloadSha256,ackSha256:ack.payloadSha256,
  records:stored.payload.record.records,formalEligible:false,modelAdoption:false};
}
async function projection(c,businessDate,asOf){
 const k=key({businessDate}),rows=(await c.query(SELECT,[k])).rows;
 if(!rows.length)return {version:'reviewed-analysis-view-v1',businessDate,updatedAt:asOf,records:[],combos:[],formalEligible:false};
 const saved=verifyRow(rows[0],k),v=saved.payload,{contentHash,...body}=v;
 p.check(p.hash(body)===contentHash,'FREEZE_HASH');
 const replay=p.make(v.draft,{...v.inputs,trustRegistry:trust(),asOf:v.record.createdAt});p.check(p.hash(replay)===p.hash(v.record),'REPLAY');
 const ackRows=(await c.query(SELECT,[k+'-ack'])).rows;p.check(ackRows.length===1,'ACK_MISSING');
 const ack=verifyRow(ackRows[0],k+'-ack').payload,{contentHash:ah,...ab}=ack;
 p.check(p.hash(ab)===ah&&ack.recordKey===k&&ack.storedSha256===saved.payloadSha256&&ack.recordHash===v.record.contentHash,'ACK_BINDING');
 deadline(v.record,ack.createdAt);p.check(Date.parse(ack.createdAt)>=Date.parse(v.storedAt)&&Date.parse(ack.createdAt)-Date.parse(v.storedAt)<=30000&&Date.parse(ack.createdAt)<=Date.parse(asOf),'ACK_CLOCK');
 return p.seal({version:'reviewed-analysis-view-v1',businessDate,updatedAt:asOf,createdAt:v.record.createdAt,commitObservedAt:ack.createdAt,
  publicationHash:v.record.contentHash,draftHash:v.record.draftHash,originalFrozenAt:v.record.originalFrozenAt,
  records:v.record.records,combos:p.combinations(v.record.records),formalEligible:false});
}
module.exports={publish,projection,deadline};
