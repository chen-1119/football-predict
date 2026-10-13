'use strict';
const a=require('node:assert/strict');
function client({pairs=[],legacy=[],heads=[],isolation='repeatable read'}={}){
 const raw=pairs.flatMap(p=>[p.recordRow,p.ackRow]).filter(Boolean),log=[];
 return {raw,log,async query(sql,args=[]){log.push({sql,args});a.match(sql,/^SELECT /,'coverage adapter is strictly SELECT only');
  if(sql.includes("current_setting('transaction_isolation')"))return {rows:[{isolation}]};
  const project=rows=>rows.map(r=>sql.includes('actual_payload_bytes')?{...r,actual_payload_bytes:Buffer.byteLength(r.payload_json)}:r);
  if(sql.includes('FROM football.private_model_artifacts')&&sql.includes('artifact_key COLLATE "C">'))return {rows:project(raw.filter(r=>!r.artifact_key.endsWith('-ack')&&r.artifact_key>args[0]).sort((a,b)=>a.artifact_key<b.artifact_key?-1:1).slice(0,args[1]))};
  if(sql.includes('FROM football.private_model_artifacts')&&sql.includes('ANY('))return {rows:project(raw.filter(r=>args[0].includes(r.artifact_key)))};
  if(sql.includes('FROM football.recommendation_decisions')){
   if(sql.includes('sequence=ANY'))return {rows:legacy.filter(r=>args[0].includes(String(r.sequence))).sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1)
    .map(r=>({sequence:String(r.sequence),payload_json:JSON.stringify(r.payload)}))};
   a.match(sql,/WITH latest_page AS MATERIALIZED \(/);a.match(sql,/SELECT DISTINCT ON \(source_match_id,event_version\)/);
   a.match(sql,/WHERE sequence>\$1::bigint ORDER BY sequence LIMIT \$2\s*\), identity_groups AS MATERIALIZED/);
   a.equal(sql.slice(sql.indexOf('WITH latest_page'),sql.indexOf('identity_groups AS MATERIALIZED')).includes('payload'),false);
   a.match(sql,/count\(DISTINCT ROW\(prior.business_date,identity\."businessDate",identity\."homeTeamId",identity\."awayTeamId"\)\)/);
   a.match(sql,/CROSS JOIN LATERAL jsonb_to_record\(prior.payload\)/);a.match(sql,/GROUP BY prior.source_match_id,prior.event_version/);
   a.ok(args[1]<=16,'legacy JSON work must be bounded to the smaller materialized page');
   const groups=new Map();for(const r of legacy){const k=JSON.stringify([r.payload.sourceMatchId,Date.parse(r.payload.eventVersion)]),group=groups.get(k)||[];group.push(r);groups.set(k,group);}
   const latest=[...groups.values()].map(group=>{const r=group.reduce((a,b)=>BigInt(a.sequence)>BigInt(b.sequence)?a:b),p=r.payload;return {sequence:String(r.sequence),id:p.decisionId,source_match_id:p.sourceMatchId,event_version:p.eventVersion,business_date:p.businessDate,
    actual_payload_bytes:Buffer.byteLength(JSON.stringify(p)),identity_variants:String(new Set(group.map(x=>JSON.stringify([x.payload.businessDate,x.payload.businessDate,x.payload.homeTeamId,x.payload.awayTeamId]))).size)};});
   return {rows:latest.filter(r=>BigInt(r.sequence)>BigInt(args[0])).sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1).slice(0,args[1])};
  }
  if(sql.includes('recommendation_result_heads'))return {rows:heads.filter(e=>args[0].includes(e.eventKey)).map(payload=>({payload}))};
  throw Error('Unexpected read');
 }};
}
module.exports={client};
