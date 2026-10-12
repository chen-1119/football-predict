'use strict';
const model=require('../src/services/leagueBaselineModel.cjs');
const {verifyRow}=require('./postgresPrivateModelArtifactStore.cjs');
const SELECT=`SELECT artifact_key,artifact_version,generated_at,updated_at,payload::text AS payload_json,payload_sha256,payload_bytes
FROM football.private_model_artifacts WHERE artifact_key=$1`;
async function load(client,asOf){
  const packets=[],receipts=[];
  for(const league of model.LEAGUES){
    const key=model.KEY(league),rows=(await client.query(SELECT,[key])).rows;
    if(!rows.length){receipts.push({key,status:'missing'});continue;}
    model.check(rows.length===1,'REGISTRY_DUPLICATE');
    const row=verifyRow(rows[0],key),p=row.payload,verified=model.verifyPacket(p,asOf);
    const available=Date.parse(row.updatedAt)+1;
    const valid=verified.valid&&p.league===league&&row.artifactVersion===model.VERSION
      &&Date.parse(row.generatedAt)>=Date.parse(p.createdAt)&&Date.parse(row.updatedAt)>=Date.parse(p.availableAt)
      &&available<Date.parse(asOf);
    receipts.push({key,status:valid?'loaded':'blocked',modelHash:p.contentHash||null,parametersHash:p.parametersHash||null,
      payloadSha256:row.payloadSha256,updatedAt:row.updatedAt,blockers:valid?[]:[...verified.blockers,'registry-binding-or-availability']});
    if(valid)packets.push(p);
  }
  return {packets,receipts,asOf,storage:'postgres',formalEligible:false};
}
async function put(client,key,payload,{replace=false,updatedAt}={}){
  model.check(/^league-(?:baseline-(?:br1|fi1)(?:-history-[a-f0-9]{64})?|forecast-[a-f0-9]{64}(?:-ack)?)$/.test(key)
    &&(!replace||model.LEAGUES.some(l=>model.KEY(l)===key)),'WRITE_KEY_SCOPE');
  const json=JSON.stringify(payload),digest=model.sha(json);model.check(Buffer.byteLength(json)<=16*1024*1024,'PAYLOAD_SIZE');
  const rows=(await client.query(SELECT+' FOR UPDATE',[key])).rows;
  if(rows.length&&!replace){const old=verifyRow(rows[0],key);model.check(old.payloadJson===json,'IMMUTABLE_CONFLICT');return old;}
  await client.query(`INSERT INTO football.private_model_artifacts
    (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
    VALUES($1,$2,$3,$4,$5::json,$6,$7)
    ON CONFLICT(artifact_key) DO UPDATE SET artifact_version=EXCLUDED.artifact_version,generated_at=EXCLUDED.generated_at,
    updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,payload_bytes=EXCLUDED.payload_bytes`,
  [key,payload.version,payload.createdAt,updatedAt,json,digest,Buffer.byteLength(json)]);
  const read=verifyRow((await client.query(SELECT,[key])).rows[0],key);model.check(read.payloadJson===json,'ROUNDTRIP');return read;
}
async function install(packet,{pool,expectedSha256}={}){
  model.check(expectedSha256===null||/^[a-f0-9]{64}$/.test(expectedSha256||''),'EXPECTED_REGISTRY_SHA');
  model.check(model.verifyPacket(packet,new Date().toISOString()).valid,'INVALID_PACKET');
  const key=model.KEY(packet.league),client=await pool.connect();let committing=false,stored;
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL statement_timeout=10000');
    await client.query('SET LOCAL lock_timeout=2000');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
    const rows=(await client.query(SELECT+' FOR UPDATE',[key])).rows;model.check(rows.length<=1,'REGISTRY_DUPLICATE');
    const prior=rows[0]?verifyRow(rows[0],key):null;
    model.check((prior?.payloadSha256||null)===expectedSha256,'REGISTRY_CHANGED');
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    const updatedAt=now instanceof Date?now.toISOString():now;
    model.check(Date.parse(updatedAt)>Date.parse(packet.availableAt),'DB_CLOCK');
    if(prior)await put(client,key+'-history-'+prior.payloadSha256,prior.payload,{updatedAt:prior.updatedAt});
    const digest=model.sha(JSON.stringify(packet));
    await put(client,key+'-history-'+digest,packet,{updatedAt});
    stored=await put(client,key,packet,{replace:true,updatedAt});
    committing=true;await client.query('COMMIT');
  }catch(e){try{await client.query('ROLLBACK');}catch{/* preserve first error */}
    if(committing)throw Object.assign(Error('LEAGUE_MODEL_COMMIT_UNKNOWN_READ_BEFORE_RETRY'),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN_READ_BEFORE_RETRY'});throw e;
  }finally{client.release();}
  const reader=await pool.connect();
  try{await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query('SET LOCAL statement_timeout=5000');
    const row=verifyRow((await reader.query(SELECT,[key])).rows[0],key);model.check(row.payloadSha256===stored.payloadSha256,'COMMITTED_READBACK');
  }finally{try{await reader.query('ROLLBACK');}finally{reader.release();}}
  return {status:'research-model-registered',key,modelHash:packet.contentHash,parametersHash:packet.parametersHash,
    payloadSha256:stored.payloadSha256,updatedAt:stored.updatedAt,commitAcknowledged:true,readbackVerified:true,
    recommendationAdoptionConfirmed:false,formalEligible:false};
}
module.exports={SELECT,load,put,install};
