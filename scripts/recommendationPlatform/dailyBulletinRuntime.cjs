'use strict';
const p=require('./dailyBulletinPolicy.cjs');
const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {validDecision}=require('./decision.cjs');
const opening=require('../../src/services/sportteryOpeningPolicy.cjs');
const {projectFrozenScoreDistribution}=require('../../src/services/publishedScoreDistribution.cjs');
const {verifySignedCurrentEventIdentity,joinOfficialHad}=require('./liveOfficialHad.cjs');
const {joinOfficialHandicap}=require('./liveOfficialHandicap.cjs');
const {loadCollectorTrustRegistry}=require('../../src/services/collectorAttestation.cjs');
const crypto=require('node:crypto');
const SELECT=`SELECT artifact_key,artifact_version,generated_at,updated_at,payload::text AS payload_json,payload_sha256,payload_bytes
 FROM football.private_model_artifacts WHERE artifact_key LIKE 'daily-pick-%' OR artifact_key LIKE 'daily-combo-%' OR artifact_key LIKE 'daily-ack-%' ORDER BY generated_at LIMIT 10001`;
async function read(client){
  const bound=(await client.query(`SELECT count(*)::int AS count,COALESCE(sum(payload_bytes),0)::bigint AS bytes,COALESCE(max(payload_bytes),0)::int AS largest
    FROM football.private_model_artifacts WHERE artifact_key LIKE 'daily-pick-%' OR artifact_key LIKE 'daily-combo-%' OR artifact_key LIKE 'daily-ack-%'`)).rows[0];
  if(!bound||Number(bound.count)>10000||Number(bound.bytes)>16*1024*1024||Number(bound.largest)>262144)throw Error('DAILY_ARCHIVE_BOUND');
  const rows=(await client.query(SELECT)).rows;if(rows.length>10000)throw Error('DAILY_ARCHIVE_BOUND');
  return rows.map(row=>{const record=verifyRow(row,row.artifact_key).payload;
    if(!p.valid(record)||!['pick','combo','ack'].includes(record.kind)||record.id!==row.artifact_key)throw Error('DAILY_ARCHIVE_INVALID');return record;});}
async function insert(client,record){
  const json=JSON.stringify(record);if(Buffer.byteLength(json)>262144||!p.valid(record)||!/^daily-(pick|combo|ack)-[a-f0-9]{64}$/.test(record.id))throw Error('DAILY_RECORD_INVALID');
  const digest=crypto.createHash('sha256').update(json).digest('hex');
  const result=await client.query(`INSERT INTO football.private_model_artifacts
   (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
   VALUES($1,$2,$3,$3,$4::json,$5,$6) ON CONFLICT(artifact_key) DO NOTHING RETURNING artifact_key`,
  [record.id,p.VERSION,record.publishedAt,json,digest,Buffer.byteLength(json)]);
  return result.rows.length>0;
}
async function projection(repo,{now,decisions,heads}){
  // Called inside the existing view transaction. The bulletin archive and view
  // New records are hidden until a LATER transaction observes the already
  // committed bytes before cutoff. Its immutable ACK proves the record's
  // commit preceded that observation; an in-transaction write is not an ACK.
  const schedule=p.schedule(now),active=p.slots(now),archive=await read(repo.client),ids=new Set(archive.map(r=>r.id));
  const snapshot=active.length?repo.readOfficialSnapshot():null,endpoint=snapshot?.endpoints?.filter(e=>e.method==='current');
  const trust=loadCollectorTrustRegistry(repo.trustRegistry),created=[];
  const at=repo.clock();if(at<now||at-now>30000)throw Error('DAILY_INPUT_CLOCK');
  const observed=(await repo.client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  const observedAt=observed instanceof Date?observed.getTime():Date.parse(observed);
  if(!Number.isFinite(observedAt)||observedAt<at||observedAt-at>30000)throw Error('DAILY_OBSERVATION_CLOCK');
  const committed=archive.filter(r=>r.kind==='pick'||r.kind==='combo');
  for(const record of committed){
    const id='daily-ack-'+hash([record.id,record.contentHash]);
    if(ids.has(id)||observedAt<Date.parse(record.publishedAt)||observedAt>=Date.parse(record.cutoffAt))continue;
    const ack=p.seal({version:p.VERSION,kind:'ack',id,publishedAt:new Date(observedAt).toISOString(),
      recordId:record.id,recordHash:record.contentHash});
    if(await insert(repo.client,ack)){archive.push(ack);ids.add(id);}
  }
  const confirmed=r=>archive.some(a=>a.kind==='ack'&&a.recordId===r.id&&a.recordHash===r.contentHash
    &&Date.parse(a.publishedAt)>=Date.parse(r.publishedAt)&&Date.parse(a.publishedAt)<Date.parse(r.cutoffAt));
  if(endpoint?.length===1){
    for(const d of decisions.filter(d=>d.businessDate===schedule.businessDate).slice(0,512)){
      if(!validDecision(d,{trustRegistry:trust})||!opening.assessDecisionOpening(d,new Date(at).toISOString(),{trustRegistry:trust}).eligible)continue;
      const input={...d,id:d.matchId,status:'SCHEDULED'};
      const identity=verifySignedCurrentEventIdentity(input,endpoint[0],{asOf:new Date(at).toISOString(),trustRegistry:trust});
      if(!identity)continue;
      const audit={},joined=joinOfficialHad([input],snapshot,{now:at,trustRegistry:trust,audit});
      if(audit.reasonCounts?.['had-applied']!==1||['1','X','2'].some((c,i)=>joined.current[0].odds[['odds1','oddsX','odds2'][i]]!==d.quoteOdds[c]))continue;
      const h=d.handicapAnalysis;
      if(h?.handicapLine<0&&p.leader(d.probabilities)!=='1'){
        const hAudit={},hh=joinOfficialHandicap([input],snapshot,{now:at,trustRegistry:trust,audit:hAudit})[0];
        if(hAudit.reasonCounts?.['hhad-applied']!==1||Number(hh.handicapLine)!==h.handicapLine
          ||['1','X','2'].some((c,i)=>hh.handicapOdds[['odds1','oddsX','odds2'][i]]!==h.marketReference?.odds?.[c]))continue;
      }
      const evidenceKey='daily-evidence-'+hash([d.sourceMatchId,d.eventVersion,d.homeTeamId,d.awayTeamId,d.businessDate]);
      const evidenceRows=(await repo.client.query(`SELECT artifact_key,artifact_version,generated_at,updated_at,payload::text AS payload_json,payload_sha256,payload_bytes
        FROM football.private_model_artifacts WHERE artifact_key LIKE $1 AND generated_at<=$2
        ORDER BY generated_at DESC,artifact_key DESC LIMIT 1`,[evidenceKey+'-%',new Date(at).toISOString()])).rows;
      const sourceEvidence=evidenceRows.length?verifyRow(evidenceRows[0],evidenceRows[0].artifact_key,262144).payload:null;
      const distribution=projectFrozenScoreDistribution(d,{limit:6561});
      for(const slot of active){
        if(slot==='early'&&archive.some(r=>r.sourceMatchId===d.sourceMatchId&&r.eventVersion===d.eventVersion))continue;
        const record=p.pick({decision:d,distribution,identity,slot,now:at,sourceEvidence});if(!record||ids.has(record.id))continue;
        if(await insert(repo.client,record)){created.push(record);archive.push(record);ids.add(record.id);}
      }
    }
  }
  if(active.includes('featured')){
    for(const tier of p.chooseTiers(committed.filter(r=>r.kind==='pick'&&r.slot==='featured'&&confirmed(r)),at)){
      if(tier.status!=='available')continue;
      const id='daily-combo-'+hash([p.VERSION,schedule.businessDate,tier.minimum]);if(ids.has(id))continue;
      const legs=tier.legs.map(l=>archive.find(r=>r.id===l.id));
      const record=p.seal({version:p.VERSION,id,kind:'combo',businessDate:schedule.businessDate,publishedAt:new Date(at).toISOString(),
        cutoffAt:new Date(Math.min(...legs.map(l=>Date.parse(l.cutoffAt)))).toISOString(),...tier});
      if(await insert(repo.client,record)){created.push(record);archive.push(record);ids.add(id);}
    }
  }
  const db=(await repo.client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  const end=db instanceof Date?db.getTime():Date.parse(db);
  if(!Number.isFinite(end)||end<at||end-at>30000||created.some(r=>end>=Date.parse(r.cutoffAt)))throw Error('DAILY_COMMIT_DEADLINE');
  const accepted=committed.filter(confirmed);
  const today=accepted.filter(r=>r.kind==='pick'&&r.businessDate===schedule.businessDate);
  const current=new Map();for(const r of today.sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)))current.set(hash([r.sourceMatchId,r.eventVersion]),r);
  return {version:p.VERSION,businessDate:schedule.businessDate,updatedAt:new Date(end).toISOString(),schedule,
    status:today.length?'reference-recorded':active.length?'awaiting-verified-inputs':'waiting-schedule',formalEligible:false,
    records:[...current.values()],tiers:[2.5,5,10].map(minimum=>accepted.find(r=>r.kind==='combo'&&r.businessDate===schedule.businessDate&&r.minimum===minimum)
      ||{minimum,status:'unavailable',reason:'缺少有据可核的两场选项',legs:[],totalOdds:null}),
    review:end>=Date.parse(schedule.reviewAt)?p.review(accepted.filter(r=>r.kind==='pick'),heads,end,accepted.filter(r=>r.kind==='combo')):null,
    archiveCount:archive.length,sourcePolicy:'500-cross-check; official-final; two-independent-team-sources',
    missingEvidence:'未接入并核验的球队资料保持未核实，不降低来源门槛。'};
}
module.exports={read,insert,projection};
