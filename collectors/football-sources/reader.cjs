'use strict';
const {identity,hash,instant,PROVIDERS}=require('./core.cjs');
let pool;
function publicView(raw,match,now){
  const ident=identity(match);
  if(!ident||!raw||hash(raw.identity)!==hash(ident)||instant(raw.generatedAt)===null||instant(raw.generatedAt)>now)return null;
  const fields={};
  for(const key of ['fixture','form','standings','weather']){
    const f=raw.fields?.[key];
    if(!f){fields[key]={status:'missing',data:null};continue;}
    const valid=PROVIDERS[f.provider]&&instant(f.observedAt)!==null&&instant(f.observedAt)<=now&&instant(f.expiresAt)>now;
    fields[key]={status:f.data&&!valid?'stale':f.status,provider:PROVIDERS[f.provider]?f.provider:null,attribution:PROVIDERS[f.provider]?.attribution||null,
      observedAt:f.observedAt||null,checkedAt:f.checkedAt||null,expiresAt:f.expiresAt||null,rawHash:f.rawHash||null,data:valid?f.data:null,predictionEligible:false};
  }
  return {version:raw.version,status:Object.values(fields).some(f=>f.data)?'available':'missing',matchId:match.id,eventVersion:ident.eventVersion,generatedAt:raw.generatedAt,fields,collection:raw.collection||null,predictionEligible:false};
}
async function readFacts(match){
  if(!pool){const {createPostgresPool}=require('../../server/postgresStore.cjs');pool=createPostgresPool({max:2,min:0,connectionTimeoutMillis:1000,queryTimeoutMillis:2000,idleTimeoutMillis:1000,applicationName:'football-source-reader'});}
  const raw=await require('./store.cjs').repository(pool).readView(match);
  return publicView(raw,match,Date.now());
}
async function close(){if(pool){await pool.end();pool=null;}}
module.exports={publicView,readFacts,close};
