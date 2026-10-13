'use strict';
const p=require('./teamEvidenceSources.cjs');
const {verifyRow}=require('./postgresPrivateModelArtifactStore.cjs');
const {SELECT}=require('./leagueBaselineRegistry.cjs');
const {transaction}=require('./recommendationPlatform/leagueBaselineRuntime.cjs');
const key=h=>'team-evidence-'+h;
async function read(c,k){const rows=(await c.query(SELECT,[k])).rows;p.check(rows.length<=1,'STORE_DUPLICATE');return rows.length?verifyRow(rows[0],k):null;}
async function insert(c,k,payload,at,{replace=false}={}){
 p.check(/^team-evidence-(?:[a-f0-9]{64}|body-[a-f0-9]{64}|head-[a-z0-9.-]{1,70}|attempt-[a-z0-9.-]{1,70})$/.test(k),'STORE_KEY');
 const json=JSON.stringify(payload);p.check(Buffer.byteLength(json)<=4*1024*1024,'STORE_BOUND');
 const old=await read(c,k);if(old&&!replace){p.check(old.payloadJson===json,'IMMUTABLE_CONFLICT');return old;}
 await c.query(`INSERT INTO football.private_model_artifacts (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
 VALUES($1,$2,$3,$4,$5::json,$6,$7) ${replace?'ON CONFLICT(artifact_key) DO UPDATE SET artifact_version=EXCLUDED.artifact_version,generated_at=EXCLUDED.generated_at,updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,payload_bytes=EXCLUDED.payload_bytes':''}`,
 [k,payload.version,payload.createdAt,at,json,p.sha(json),Buffer.byteLength(json)]);
 const saved=await read(c,k);p.check(saved.payloadJson===json,'ROUNDTRIP');return saved;
}
async function write(pool,action){return transaction(pool,false,async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
 const value=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now,at=value instanceof Date?value.toISOString():value;
 p.check(Number.isFinite(Date.parse(at)),'DB_CLOCK');return action(c,at);});}
async function save(pool,packet){
 p.check(p.verify(packet),'PACKET');
 const stored=await write(pool,async(c,at)=>{
  p.check(Date.parse(packet.createdAt)<=Date.parse(at)&&Date.parse(at)-Date.parse(packet.createdAt)<120000,'STORE_CLOCK');
  // Identical HTTP bodies are stored once. Each observation retains its own
  // request/receive clocks without copying unchanged multi-season histories.
  const rawKey='team-evidence-body-'+packet.response.rawSha256,body=await read(c,rawKey);
  if(body)p.check(body.payload.version==='team-evidence-body-v1'&&p.sha(body.payload.raw)===packet.response.rawSha256&&body.payload.raw===packet.response.raw,'RAW_STORE_CONFLICT');
  else await insert(c,rawKey,{version:'team-evidence-body-v1',createdAt:packet.createdAt,raw:packet.response.raw,rawSha256:packet.response.rawSha256},at);
  const {raw,...response}=packet.response;void raw;
  const row=await insert(c,key(packet.contentHash),{version:'team-evidence-stored-v1',createdAt:packet.createdAt,rawKey,packet:{...packet,response}},at);
  const head=p.seal({version:'team-evidence-head-v1',createdAt:at,sourceId:packet.sourceId,key:row.artifactKey,payloadSha256:row.payloadSha256,receivedAt:packet.createdAt});
  const prior=await read(c,'team-evidence-head-'+packet.sourceId);p.check(!prior||Date.parse(prior.payload.receivedAt)<=Date.parse(packet.createdAt),'HEAD_REGRESSION');
  await insert(c,'team-evidence-head-'+packet.sourceId,head,at,{replace:true});return row;
 });
 return transaction(pool,true,async c=>{const row=await read(c,stored.artifactKey);p.check(row?.payloadSha256===stored.payloadSha256,'COMMITTED_READBACK');return {key:row.artifactKey,payloadSha256:row.payloadSha256,commitReadback:true};});
}
async function readPacket(c,k,asOf){
 p.check(/^team-evidence-[a-f0-9]{64}$/.test(k),'PACKET_KEY');const row=await read(c,k);
 p.check(row&&row.payload.version==='team-evidence-stored-v1'&&Date.parse(row.updatedAt)<=Date.parse(asOf),'REVIEW_KNOWLEDGE');
 const stored=row.payload;p.check(stored.rawKey==='team-evidence-body-'+stored.packet?.response?.rawSha256,'RAW_KEY');
 const raw=await read(c,stored.rawKey);p.check(raw&&raw.payload.version==='team-evidence-body-v1'&&Date.parse(raw.updatedAt)<=Date.parse(asOf),'RAW_KNOWLEDGE');
 const packet={...stored.packet,response:{...stored.packet.response,raw:raw.payload.raw}};
 p.check(key(packet.contentHash)===k&&p.verify(packet),'STORED_PACKET_REPLAY');return packet;
}
async function loadForReview(c,keys,event,asOf){
 p.check(Array.isArray(keys)&&keys.length>0&&keys.length<=4&&new Set(keys).size===keys.length&&keys.every(k=>/^team-evidence-[a-f0-9]{64}$/.test(k)),'REVIEW_KEYS');
 const packets=[];for(const k of keys)packets.push(await readPacket(c,k,asOf));
 return {packets,adoption:p.adopt(packets,event,asOf)};
}
module.exports={key,read,readPacket,write,insert,save,loadForReview};
