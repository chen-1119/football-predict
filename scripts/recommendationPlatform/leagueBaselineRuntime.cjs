'use strict';
const m=require('../../src/services/leagueBaselineModel.cjs');
const maker=require('../../src/services/leagueBaselineRecommendation.cjs');
const registry=require('../leagueBaselineRegistry.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {Repository}=require('./repository.cjs');
const {loadCollectorTrustRegistry}=require('../../src/services/collectorAttestation.cjs');
const {readLiveOfficialSnapshot}=require('./liveOfficialHandicap.cjs');
const {day}=require('../../src/services/publishedForecastPolicy.cjs');
const ns=require('../../src/services/prematchV3Clock.cjs').epochNanoseconds;
const code=e=>/^LEAGUE_MODEL_[A-Z_]+$/.test(e?.code||'')?e.code:'LEAGUE_MODEL_CYCLE_FAILED';
async function transaction(pool,readOnly,action){
  const c=await pool.connect();let committing=false;
  try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE'+(readOnly?' READ ONLY':''));
    await c.query('SET LOCAL statement_timeout=10000');await c.query('SET LOCAL lock_timeout=2000');
    const result=await action(c);committing=true;await c.query('COMMIT');return result;
  }catch(e){try{await c.query('ROLLBACK');}catch{/* retain failure */}
    if(committing&&!readOnly)throw Object.assign(Error('Commit outcome unconfirmed'),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});throw e;
  }finally{c.release();}
}
async function dbNow(c){
  const s=(await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now")).rows[0]?.now;
  m.check(ns(s)!==null,'DB_CLOCK');return s;
}
function within(record,at){m.check(ns(at)>ns(record.createdAt)&&ns(at)<ns(record.forecast.cutoffAt)
  &&ns(at)-ns(record.createdAt)<60000000000n,'COMMIT_DEADLINE');}
async function append(pool,record,inputs){
  m.check(maker.verify(record,inputs),'RECORD_REPLAY');
  const key=record.id,ackKey=key+'-ack';
  const stored=await transaction(pool,false,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
    const old=(await c.query(registry.SELECT,[key])).rows;
    if(old.length){const prior=verifyRow(old[0],key);return {prior:true,row:prior};}
    const loaded=await registry.load(c,record.createdAt);
    m.check(loaded.packets.some(p=>p.contentHash===record.modelHash),'ACTIVE_MODEL_CHANGED');
    const now=await dbNow(c);within(record,now);
    // Persist the original probability, model and full signed source together.
    const payload=m.seal({version:'league-baseline-freeze-v1',createdAt:record.createdAt,
      record,inputs,storedAt:now});
    const row=await registry.put(c,key,payload,{updatedAt:new Date(now).toISOString()});
    within(record,await dbNow(c));return {prior:false,row};
  });
  if(stored.prior)return {created:false,acknowledged:false,reason:'existing-first-forecast'};
  // ACK is written in a second transaction only after the original COMMIT.
  // A crash between them leaves an unacknowledged original, never a public pick.
  await transaction(pool,false,async c=>{
    const row=verifyRow((await c.query(registry.SELECT,[key])).rows[0],key);
    m.check(row.payloadSha256===stored.row.payloadSha256,'COMMIT_READBACK');
    const observedAt=await dbNow(c);within(record,observedAt);
    m.check(ns(observedAt)>=ns(row.payload.storedAt)&&ns(observedAt)-ns(row.payload.storedAt)<=30000000000n,'ACK_CLOCK');
    const ack=m.seal({version:'league-baseline-adoption-ack-v1',createdAt:new Date(observedAt).toISOString(),
      observedAt,recordKey:key,recordHash:record.contentHash,storedSha256:row.payloadSha256,
      modelHash:record.modelHash,parametersHash:record.parametersHash,formalEligible:false});
    await registry.put(c,ackKey,ack,{updatedAt:ack.createdAt});within(record,await dbNow(c));
  });
  return {created:true,acknowledged:true,modelHash:record.modelHash,parametersHash:record.parametersHash};
}
async function run({pool,trustRegistry}={}){
  const trust=loadCollectorTrustRegistry(trustRegistry||process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
    ||require('node:path').resolve(__dirname,'../../deploy/light-server/collector-trust-registry.json'));
  const batch=await transaction(pool,true,async c=>{
    const models=await registry.load(c,new Date().toISOString());
    if(!models.packets.length)return {models,matches:[]};
    const repo=new Repository(c,{trustRegistry:trust});
    const inputs=await repo.currentInputs(Date.now());
    m.check(inputs.current.length<=512,'MATCH_BOUND');
    return {models,matches:inputs.current};
  });
  const report={enabled:true,status:'awaiting-model',created:0,acknowledged:0,blocked:0,reasons:[],
    registry:batch.models.receipts,formalEligible:false,adoptedModels:[]};
  if(!batch.models.packets.length)return report;
  report.status='awaiting-mapped-events';
  const snapshot=readLiveOfficialSnapshot();m.check(snapshot,'SOURCE_MISSING');
  const grouped=new Map();for(const match of batch.matches){const id=String(match.sourceMatchId||'');const group=grouped.get(id)||[];group.push(match);grouped.set(id,group);}
  let attempted=0;
  for(const rows of grouped.values()){
    const match=rows[0];if(match.businessDate!==day(Date.now()))continue;
    const packets=batch.models.packets.filter(p=>p.bindings.some(b=>b.leagueId===String(match.leagueId)));
    if(!packets.length)continue;
    if(++attempted>32){report.reasons.push('LEAGUE_MODEL_BATCH_BOUND');break;}
    try{
      m.check(packets.length===1&&new Set(rows.map(m.hash)).size===1,'AMBIGUOUS_EVENT');
      const inputs={packet:packets[0],match,snapshot,trustRegistry:trust};
      const record=maker.make({...inputs,asOf:new Date().toISOString()});
      const result=await append(pool,record,inputs);
      report.created+=Number(result.created);report.acknowledged+=Number(result.acknowledged);
      if(result.acknowledged&&!report.adoptedModels.includes(record.modelHash))report.adoptedModels.push(record.modelHash);
    }catch(e){report.blocked++;if(!report.reasons.includes(code(e)))report.reasons.push(code(e));}
  }
  report.status=report.acknowledged?'reference-recorded':report.blocked?'blocked':'awaiting-mapped-events';return report;
}
async function projection(c,businessDate,asOf,trustRegistry){
  const rows=(await c.query(`SELECT artifact_key,artifact_version,generated_at,updated_at,payload::text AS payload_json,payload_sha256,payload_bytes
    FROM football.private_model_artifacts WHERE artifact_key ~ '^league-forecast-[a-f0-9]{64}$'
    AND payload->'record'->>'businessDate'=$1 ORDER BY generated_at DESC LIMIT 33`,[businessDate])).rows;
  m.check(rows.length<=32,'PROJECTION_BOUND');let blocked=0;const records=[];
  for(const raw of rows){try{
    const saved=verifyRow(raw,raw.artifact_key),p=saved.payload,r=p.record;
    const {contentHash,...body}=p;m.check(contentHash===m.hash(body),'FREEZE_HASH');
    m.check(r.businessDate===businessDate&&r.id===raw.artifact_key&&maker.verify(r,{...p.inputs,trustRegistry}),'FREEZE_REPLAY');
    const ackRows=(await c.query(registry.SELECT,[raw.artifact_key+'-ack'])).rows;m.check(ackRows.length===1,'ACK_MISSING');
    const ack=verifyRow(ackRows[0],raw.artifact_key+'-ack').payload;
    const {contentHash:ah,...ab}=ack;m.check(ah===m.hash(ab)&&ack.version==='league-baseline-adoption-ack-v1'
      &&ack.recordKey===r.id&&ack.recordHash===r.contentHash&&ack.storedSha256===saved.payloadSha256
      &&ack.modelHash===r.modelHash&&ack.parametersHash===r.parametersHash&&ack.formalEligible===false,'ACK_BINDING');
    within(r,ack.observedAt);m.check(ns(ack.observedAt)>=ns(p.storedAt)&&ns(ack.observedAt)-ns(p.storedAt)<=30000000000n
      &&ns(ack.observedAt)<=ns(asOf),'ACK_CLOCK');
    records.push(m.seal({version:'league-baseline-direction-view-v1',id:r.id,businessDate:r.businessDate,
      homeTeamName:r.homeTeamName,awayTeamName:r.awayTeamName,event:r.forecast.event,cutoffAt:r.forecast.cutoffAt,
      createdAt:r.createdAt,commitObservedAt:ack.observedAt,modelVersion:r.modelVersion,modelHash:r.modelHash,
      parametersHash:r.parametersHash,recordHash:r.contentHash,forecastHash:r.forecastHash,
      direction:r.forecast.direction,grid:r.forecast.grid,comparisons:r.comparisons,formalEligible:false}));
  }catch{blocked++;}}
  return {version:'league-baseline-directions-v1',businessDate,updatedAt:asOf,records,blocked,formalEligible:false};
}
module.exports={run,append,projection,transaction,within};
