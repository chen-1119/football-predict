'use strict';
// Operator-reviewed facts, with independently fetched readable excerpts. No
// search snippet, arbitrary URL, redirect or guessed identity is admitted.
const fs=require('node:fs'),crypto=require('node:crypto');
const evidence=require('./recommendationPlatform/dailySourceEvidence.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function capture(request,{fetcher=fetch,clock=Date.now}={}){
  if(!request?.identityVerified||!request.reviewedBy||!Array.isArray(request.facts)||request.facts.length!==6)throw Error('Reviewed identity and six facts required');
  const facts=[];
  for(const fact of request.facts){
    const sources=[];
    if(fact.status==='verified')for(const source of fact.sources||[]){
      const provider=evidence.provider(source.url);if(!provider||!source.excerpt||source.excerpt.length<12||source.excerpt.length>1000||source.independent!==true)throw Error('Invalid source');
      const response=await fetcher(source.url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'user-agent':'Football research source verification/1.0','accept':'text/html'}});
      if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw Error('Source not readable');
      const reader=response.body.getReader(),chunks=[];let length=0;
      for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024){await reader.cancel();throw Error('Source size bound');}chunks.push(value);}
      const body=Buffer.concat(chunks);
      const charset=/charset\s*=\s*["']?([a-z0-9-]+)/i.exec(response.headers.get('content-type'))?.[1]?.toLowerCase()||'utf-8';
      if(!['utf-8','utf8','gbk','gb2312','gb18030'].includes(charset))throw Error('Unsupported source charset');
      const html=new TextDecoder(charset,{fatal:true}).decode(body);
      // Conservative lexical excerpt verification, not browser rendering or
      // automatic truth/identity extraction. Encoded/malformed text can reject.
      const main=/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1];
      if(!main)throw Error('Source body missing');
      const text=main.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
        .replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
      if(!text.includes(source.excerpt.replace(/\s+/g,' ').trim()))throw Error('Reviewed excerpt missing from fetched page');
      sources.push({url:source.url,provider,origin:source.origin,independent:true,value:fact.text,excerpt:source.excerpt,
        bodyHash:digest(body),fetchedAt:new Date(clock()).toISOString(),publishedAt:source.publishedAt||null,
        excerptMatched:true,preview:source.preview===true,modelGenerated:source.modelGenerated===true});
    }
    // Market movements need separately captured numeric snapshots; a prose
    // page alone must remain unverified until that adapter is integrated.
    facts.push({name:fact.name,status:fact.name==='盘口与赔率变化'?'unverified':fact.status,
      text:fact.name==='盘口与赔率变化'?'未核实':fact.text,sources:fact.name==='盘口与赔率变化'?[]:sources});
  }
  const {sourceMatchId,eventVersion,homeTeamId,awayTeamId,businessDate,cutoffTime,reviewedBy}=request;
  const record=evidence.seal({version:'daily-source-evidence-v1',createdAt:new Date(clock()).toISOString(),
    sourceMatchId,eventVersion,homeTeamId,awayTeamId,businessDate,cutoffTime,reviewedBy,identityVerified:true,facts});
  if(!evidence.valid(record,record,clock()))throw Error('Evidence contract failed');return record;
}
async function install(record,{pool,expectedSha256}){
  if(Buffer.byteLength(JSON.stringify(record))>262144||digest(JSON.stringify(record))!==expectedSha256||!evidence.valid(record,record,Date.now()))throw Error('Prepared evidence changed');
  const c=await pool.connect(),key='daily-evidence-'+hash([record.sourceMatchId,record.eventVersion,record.homeTeamId,record.awayTeamId,record.businessDate])+'-'+record.contentHash.slice(0,32);
  let committing=false;
  try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout=10000; SET LOCAL lock_timeout=2000");
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
    // Only an existing admitted future publication can supply canonical identity.
    const rows=(await c.query(`SELECT payload FROM football.recommendation_decisions WHERE source_match_id=$1 AND event_version=$2 ORDER BY sequence DESC LIMIT 1`,[record.sourceMatchId,record.eventVersion])).rows;
    const d=rows[0]?.payload;
    if(!require('./recommendationPlatform/decision.cjs').validDecision(d)||!evidence.valid(record,d,Date.now())||Date.now()>=Date.parse(d.cutoffTime))throw Error('Live event binding rejected');
    const json=JSON.stringify(record);
    const result=await c.query(`INSERT INTO football.private_model_artifacts(artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
      VALUES($1,$2,$3,$3,$4::json,$5,$6) ON CONFLICT(artifact_key) DO NOTHING RETURNING artifact_key`,[key,record.version,record.createdAt,json,digest(json),Buffer.byteLength(json)]);
    if(!result.rows.length)throw Error('Evidence already exists; no overwrite');
    if(Date.now()>=Date.parse(d.cutoffTime))throw Error('Cutoff crossed');
    committing=true;await c.query('COMMIT');
    const saved=await require('./postgresPrivateModelArtifactStore.cjs').readPrivateModelArtifact({pool,artifactKey:key});
    if(saved.payloadSha256!==expectedSha256)throw Error('Commit readback mismatch');return {key,payloadSha256:expectedSha256,committed:true};
  }catch(error){try{await c.query('ROLLBACK');}catch{/* retain original */}
    if(committing)throw Object.assign(Error('DAILY_EVIDENCE_COMMIT_UNCONFIRMED_READ_KEY_BEFORE_RETRY'),{code:'DAILY_EVIDENCE_COMMIT_UNCONFIRMED',artifactKey:key});throw error;}finally{c.release();}
}
if(require.main===module)(async()=>{
  const [mode,input,output]=process.argv.slice(2);if(!['prepare','apply'].includes(mode)||!input||!output)throw Error('Usage: prepare request.json output.json | apply prepared.json expected-sha256');
  const raw=fs.readFileSync(input);if(raw.length>262144)throw Error('Input size bound');const request=JSON.parse(raw);
  if(mode==='prepare'){const record=await capture(request),json=JSON.stringify(record);fs.writeFileSync(output,json,{flag:'wx',mode:0o600});console.log(JSON.stringify({output,sha256:digest(json)}));}
  else{const pool=require('../server/postgresStore.cjs').createPostgresPool({applicationName:'daily-source-evidence'});try{console.log(JSON.stringify(await install(request,{pool,expectedSha256:output})));}finally{await pool.end();}}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={capture,install};
