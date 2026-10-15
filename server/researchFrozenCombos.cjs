'use strict';
// Retain a genuinely committed pre-match display in the existing view writer.
// Never rebuild a closed group from today's singles or overwrite its prices.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const archive=require('../services/recommendation/comboArchive.cjs');
const {verifyRow}=require('../scripts/postgresPrivateModelArtifactStore.cjs');
const {SELECT}=require('../scripts/leagueBaselineRegistry.cjs');
const {epochNanoseconds:ns}=require('../src/services/prematchV3Clock.cjs');
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const core=r=>{const {publicationCreatedAt,publicationCommitObservedAt,...v}=r;void publicationCreatedAt;void publicationCommitObservedAt;return v;};
async function anchorCommitted(c,view,at){
 // Nonblocking admission preserves the normal worker's lock order. Another
 // writer means defer archival to its next natural view, never start a writer.
 if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',['football-postgres-projection-sync-v1'])).rows[0]?.locked)return;
 const bounds=(await c.query("SELECT octet_length((payload->'recommendationCenter'->'reviewedAnalysis')::text) AS bytes FROM football.daily_featured_combo_state WHERE id=1")).rows;
 if(!bounds.length||bounds[0].bytes==null)return;
 const bytes=Number(bounds[0].bytes);if(!Number.isSafeInteger(bytes)||bytes<2||bytes>512*1024)fail('REVIEW_REVISION_COMBO_VIEW_BOUND');
 const candidate=(await c.query("SELECT payload->'recommendationCenter'->'reviewedAnalysis' AS view FROM football.daily_featured_combo_state WHERE id=1")).rows[0]?.view;
 if(!candidate||candidate.businessDate!==view.businessDate||candidate.comboFreeze||candidate.publicationHash!==view.publicationHash||p.hash(candidate.records)!==p.hash(view.records))return;
 const populated=[...(candidate.combos||[]),...(candidate.threeCombos||[])].filter(g=>g.legs.length);
 if(!populated.length||populated.some(g=>g.legs.some(l=>{const d=candidate.records.find(d=>d.eventId===l.eventId);return !d||ns(at)>=ns(d.cutoffAt)||ns(at)>=ns(d.eventVersion);})))return;
 const matches=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);
 if(matches.length>512)fail('REVIEW_REVISION_MATCH_BOUND');
 if(populated.some(g=>g.legs.some(l=>{const d=candidate.records.find(d=>d.eventId===l.eventId),found=matches.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===d.eventId&&ns(m.eventVersion||m.kickoffTime)===ns(d.eventVersion));
  return found.length!==1||found[0].status!=='SCHEDULED'||['homeTeamId','awayTeamId','homeTeamName','awayTeamName'].some(k=>found[0][k]!==d[k]);})))return;
 const meta=(await c.query('SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])',[['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at']])).rows;
 const publication=require('./postgresProjectionStore.cjs').publicationIdentityFromMeta(Object.fromEntries(meta.map(r=>[r.key,{value:r.value}])),{strictGenerationSource:true});
 if(publication.mode!=='active-generation'||!/^g-[a-f0-9]{64}$/.test(publication.generationId||'')||publication.generationId!=='g-'+publication.manifestHash
  ||typeof publication.sourceCycleId!=='string'||!publication.sourceCycleId||publication.sourceCycleId.length>256||ns(publication.committedAt)===null||ns(publication.committedAt)>ns(at))fail('REVIEW_REVISION_COMMITTED_PUBLICATION');
 await archive.retain(c,candidate,publication,at);
}
async function freezeOriginalGroups(c,view,at,{anchor=false}={}){
 if(!view?.records?.length||ns(at)===null)return view;
 if(anchor)await anchorCommitted(c,view,at);
 const keys=(await c.query(`SELECT artifact_key,payload_bytes,octet_length(payload::text) AS bytes FROM football.private_model_artifacts
 WHERE artifact_version=$1 AND artifact_key LIKE $2 ORDER BY generated_at,artifact_key LIMIT 65`,[archive.VERSION,'reviewed-combo-view-'+view.businessDate+'-%'])).rows;
 if(keys.length>64)fail('REVIEW_REVISION_COMBO_ARCHIVE_BOUND');
 const chosen=new Map();
 for(const row of keys){
  const n=Number(row.payload_bytes);if(!Number.isSafeInteger(n)||n<2||n>512*1024||Number(row.bytes)!==n)fail('REVIEW_REVISION_COMBO_ARCHIVE_BOUND');
  const full=(await c.query(SELECT,[row.artifact_key])).rows;if(full.length!==1)fail('REVIEW_REVISION_COMBO_ARCHIVE');
  const saved=verifyRow(full[0],row.artifact_key,512*1024),v=saved.payload,{contentHash,...body}=v;
  if(saved.artifactVersion!==archive.VERSION||p.hash(body)!==contentHash||v.source?.artifactKey!==row.artifact_key||ns(v.createdAt)===null||ns(v.createdAt)>ns(at)
   ||p.hash(archive.prepare(v.view,{generationId:v.source.generationId,committedAt:v.source.committedAt},v.source.observedAt).archive)!==p.hash(v))fail('REVIEW_REVISION_COMBO_ARCHIVE');
  for(const [name,size]of [['combos',2],['threeCombos',3]])for(const combo of v.view[name]||[]){
   const key=size+'/'+combo.band;if(chosen.has(key)||!combo.legs.length)continue;
   const compatible=combo.legs.every(l=>{const original=v.view.records.find(r=>r.eventId===l.eventId),current=view.records.find(r=>r.eventId===l.eventId);
    return original&&current&&p.hash(core(original))===p.hash(core(current));});
   if(compatible)chosen.set(key,{combo,size,sourceArchiveKey:row.artifact_key,sourceArchiveSha256:saved.payloadSha256,observedAt:v.source.observedAt});
  }
 }
 if(!chosen.size)return view;
 const matches=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);
 if(matches.length>512)fail('REVIEW_REVISION_MATCH_BOUND');
 const comboFreeze=[...chosen.values()].map(v=>({size:v.size,band:v.combo.band,sourceArchiveKey:v.sourceArchiveKey,sourceArchiveSha256:v.sourceArchiveSha256,observedAt:v.observedAt,originalComboHash:p.hash(v.combo),
  frozen:v.combo.legs.some(l=>{const d=view.records.find(r=>r.eventId===l.eventId),observed=matches.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===l.eventId&&ns(m.eventVersion||m.kickoffTime)===ns(d.eventVersion));
   return ns(at)>=ns(d.eventVersion)||ns(at)>=ns(d.cutoffAt)||observed.length!==1||observed[0].status!=='SCHEDULED';})}));
 const groups=size=>[2.5,5,10].map(band=>chosen.get(size+'/'+band)?.combo||{band,legs:[],product:null,confidence:null});
 const {contentHash,...body}=view;void contentHash;
 return p.seal({...body,combos:groups(2),threeCombos:groups(3),comboFreezePolicy:'persisted-original-groups-v1',comboFreeze});
}
module.exports={freezeOriginalGroups,anchorCommitted};
