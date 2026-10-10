'use strict';
const p=require('./reviewedAnalysis.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {SELECT}=require('../leagueBaselineRegistry.cjs');
const {transaction}=require('./leagueBaselineRuntime.cjs');
const {loadCollectorTrustRegistry}=require('../../src/services/collectorAttestation.cjs');
const {readLiveOfficialSnapshot}=require('./liveOfficialHandicap.cjs');
const key=d=>d.version===3?'reviewed-analysis-'+d.businessDate+'-batch-'+p.hash(d):'reviewed-analysis-'+d.businessDate+'-selected-two';
async function keys(c,businessDate){
 p.check(/^\d{4}-\d{2}-\d{2}$/.test(businessDate),'BUSINESS_DAY');
 const rows=(await c.query("SELECT artifact_key FROM football.private_model_artifacts WHERE artifact_key=$1 OR (artifact_key LIKE $2 AND artifact_version=$3) ORDER BY artifact_key LIMIT 33",
  [key({businessDate}),'reviewed-analysis-'+businessDate+'-batch-%','reviewed-analysis-freeze-v1'])).rows;
 p.check(rows.length<=32,'PUBLICATION_BOUND');return rows.map(r=>r.artifact_key);
}
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
  const prior=await projection(c,draft.businessDate,await dbNow(c));
  p.check(prior.records.length+draft.singles.length<=32,'DAILY_RECORD_BOUND');
  p.check(draft.singles.every(r=>!prior.records.some(v=>v.eventId===r.eventId)),'EVENT_ALREADY_FROZEN');
  const allMatches=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);p.check(allMatches.length<=512,'MATCH_BOUND');
  const snapshot=readLiveOfficialSnapshot(),asOf=await dbNow(c),evidenceByEvent={};
  p.validateDraft(draft,asOf);
  // Freeze only this batch's events. Keep the complete signed source and every
  // matching candidate so identity, duplicates and the existing 8 MiB bound
  // are still checked by make and by committed readback replay.
  const requested=new Set(draft.singles.map(r=>r.eventId));
  const matches=allMatches.filter(m=>requested.has(String(m.sourceMatchId||'').replace(/^sporttery_/,'')));
  if(draft.version===2){for(const r of draft.singles){const packets=[];
   for(const k of r.evidenceKeys)packets.push(await require('../teamEvidenceStore.cjs').readPacket(c,k,asOf));
   evidenceByEvent[r.eventId]=packets;
  }}
  const record=p.make(draft,{matches,snapshot,trustRegistry:registry,asOf,evidenceByEvent});
  const inputs={matches:matches.filter(m=>record.records.some(r=>r.eventId===String(m.sourceMatchId||'').replace(/^sporttery_/,''))),snapshot,
   ...(draft.version===2?{evidenceByEvent}:{})};
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
async function readPublication(c,k,asOf){
 const rows=(await c.query(SELECT,[k])).rows;p.check(rows.length===1,'PUBLICATION_MISSING');
 const saved=verifyRow(rows[0],k),v=saved.payload,{contentHash,...body}=v;
 p.check(p.hash(body)===contentHash,'FREEZE_HASH');
 const replay=p.make(v.draft,{...v.inputs,trustRegistry:trust(),asOf:v.record.createdAt});p.check(p.hash(replay)===p.hash(v.record),'REPLAY');
 const ackRows=(await c.query(SELECT,[k+'-ack'])).rows;p.check(ackRows.length===1,'ACK_MISSING');
 const ack=verifyRow(ackRows[0],k+'-ack').payload,{contentHash:ah,...ab}=ack;
 p.check(p.hash(ab)===ah&&ack.recordKey===k&&ack.storedSha256===saved.payloadSha256&&ack.recordHash===v.record.contentHash,'ACK_BINDING');
 deadline(v.record,ack.createdAt);p.check(Date.parse(ack.createdAt)>=Date.parse(v.storedAt)&&Date.parse(ack.createdAt)-Date.parse(v.storedAt)<=30000&&Date.parse(ack.createdAt)<=Date.parse(asOf),'ACK_CLOCK');
 return {v,ack};
}
async function projection(c,businessDate,asOf,{historical=false}={}){
 const allKeys=await keys(c,businessDate);
 if(!allKeys.length)return {version:'reviewed-analysis-view-v1',businessDate,updatedAt:asOf,records:[],combos:[],threeCombos:[],formalEligible:false};
 const publications=[];for(const k of allKeys){const publication=await readPublication(c,k,asOf);
  if(historical){const {v,ack}=publication,ns=require('../../src/services/prematchV3Clock.cjs').epochNanoseconds;
   const created=ns(v.createdAt),stored=ns(v.storedAt),observed=ns(ack.createdAt);
   p.check(v.version==='reviewed-analysis-freeze-v1'
   &&ack.version==='reviewed-analysis-ack-v1'&&key(v.draft)===k&&v.record.businessDate===businessDate
   &&v.createdAt===v.record.createdAt&&created!==null&&stored!==null&&observed!==null
   &&created<stored&&stored<=observed,'HISTORY_IDENTITY');}
  publications.push(publication);}
 // History recovers frozen singles only. No combo was independently frozen in
 // these records, so never backdate a clock or create a purported original combo.
 const combos=(records,size)=>historical?[]:p.combinations(records.filter(r=>Date.parse(asOf)<Date.parse(r.cutoffAt)),size);
 if(publications.length===1){const {v,ack}=publications[0];return p.seal({version:'reviewed-analysis-view-v1',businessDate,updatedAt:asOf,createdAt:v.record.createdAt,commitObservedAt:ack.createdAt,
  publicationHash:v.record.contentHash,draftHash:v.record.draftHash,originalFrozenAt:v.record.originalFrozenAt,
  records:v.record.records,combos:combos(v.record.records,2),
  threeCombos:combos(v.record.records,3),formalEligible:false});}
 publications.sort((a,b)=>Date.parse(a.v.record.createdAt)-Date.parse(b.v.record.createdAt));
 const records=publications.flatMap(({v,ack})=>v.record.records.map(r=>({...r,publicationCreatedAt:v.record.createdAt,publicationCommitObservedAt:ack.createdAt})));
 p.check(records.length<=32&&new Set(records.map(r=>r.eventId)).size===records.length,'DAILY_RECORD_BOUND');
 const last=publications[publications.length-1];
 return p.seal({version:'reviewed-analysis-view-v1',businessDate,updatedAt:asOf,createdAt:last.v.record.createdAt,
  commitObservedAt:last.ack.createdAt,publicationHash:p.hash(publications.map(x=>x.v.record.contentHash)),
  draftHash:p.hash(publications.map(x=>x.v.record.draftHash)),originalFrozenAt:publications[0].v.record.originalFrozenAt,
  records,combos:combos(records,2),threeCombos:combos(records,3),formalEligible:false});
}
async function readLatestHistory(c,beforeDay,asOf){
 const now=Date.parse(asOf),day=require('../../src/services/publishedForecastPolicy.cjs').day;
 p.check(/^\d{4}-\d{2}-\d{2}$/.test(beforeDay)&&Number.isFinite(now)&&beforeDay<=day(now),'HISTORY_CLOCK');
 const found=(await c.query(`SELECT artifact_key FROM football.private_model_artifacts
  WHERE artifact_version=$1 AND artifact_key LIKE $2 AND artifact_key < $3 ORDER BY artifact_key DESC LIMIT 1`,
  ['reviewed-analysis-freeze-v1','reviewed-analysis-%','reviewed-analysis-'+beforeDay+'-'])).rows;
 p.check(Array.isArray(found)&&found.length<=1,'HISTORY_BOUND');if(!found.length)return null;
 const matched=/^reviewed-analysis-(\d{4}-\d{2}-\d{2})-(?:selected-two|batch-[a-f0-9]{64})$/.exec(found[0].artifact_key);
 p.check(matched&&matched[1]<beforeDay&&day(Date.parse(matched[1]+'T00:00:00+08:00'))===matched[1],'HISTORY_KEY');
 return projection(c,matched[1],asOf,{historical:true});
}
module.exports={publish,projection,deadline,readLatestHistory};
