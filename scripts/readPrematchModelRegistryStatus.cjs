'use strict';
// Narrow independent registry observation. A failed fixture-identity read must
// not be reinterpreted as a valid fixture; this query makes no fixture claims.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {validateReleaseSshHostKeyPin,buildPinnedSshBaseOptions}=require('./releaseSshHostKeyPin.cjs');
const {validateStoredPrematchV3Artifact}=require('../src/services/prematchV3ModelRegistry.cjs');
const VERSION='prematch-model-registry-status-v1';
const KEYS=['prematch-v3-baseline','prematch-v3-parameters'];
const MAX_ARTIFACT=16*1024*1024,MAX_RESPONSE=36*1024*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,code)=>{if(!v)throw Error(`MODEL_REGISTRY_READ_${code}`);};
function query(){return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15000';
SET LOCAL lock_timeout='2000';
SELECT jsonb_build_object('version','${VERSION}','observedAt',clock_timestamp(),
'database',current_database(),'readOnly',current_setting('transaction_read_only'),'productionWrites',0,
'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_generation_id','manifest_hash','committed_at','data_publication_mode','data_generation_source_cycle_id')),
'artifacts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('key',artifact_key,'version',artifact_version,
'generatedAt',generated_at,'updatedAt',updated_at,'sha256',payload_sha256,'bytes',payload_bytes,
'payloadJson',CASE WHEN payload_bytes<=${MAX_ARTIFACT} AND octet_length(payload::text)<=${MAX_ARTIFACT} THEN payload::text ELSE NULL END)),'[]'::jsonb)
FROM football.private_model_artifacts WHERE artifact_key IN ('prematch-v3-baseline','prematch-v3-parameters')));
ROLLBACK;`;}
function inspect(value,startedAt,finishedAt){
  check(value?.version===VERSION&&value.database==='football'&&value.readOnly==='on'&&value.productionWrites===0,'IDENTITY');
  const observed=Date.parse(value.observedAt),start=Date.parse(startedAt),finish=Date.parse(finishedAt);
  check([observed,start,finish].every(Number.isFinite)&&start<=finish&&observed>=start-120000&&observed<=finish+120000,'CLOCK');
  check(Array.isArray(value.artifacts)&&value.artifacts.length<=2&&new Set(value.artifacts.map(a=>a.key)).size===value.artifacts.length,'ROWS');
  check(value.artifacts.every(a=>KEYS.includes(a.key)),'KEYS');
  const keys=KEYS.map(key=>{
    const row=value.artifacts.find(a=>a.key===key);if(!row)return {key,present:false,loadable:false,reasons:['artifact-missing']};
    check(typeof row.payloadJson==='string'&&Buffer.byteLength(row.payloadJson)<=MAX_ARTIFACT
      &&row.bytes===Buffer.byteLength(row.payloadJson)&&row.sha256===hash(row.payloadJson),'PAYLOAD');
    const stored={storage:'postgres',artifactKey:key,artifactVersion:row.version,generatedAt:row.generatedAt,updatedAt:row.updatedAt,
      payloadJson:row.payloadJson,payload:JSON.parse(row.payloadJson),payloadBytes:row.bytes,payloadSha256:row.sha256};
    const verification=validateStoredPrematchV3Artifact(stored,key===KEYS[0]?'baseline':'parameters',value.observedAt);
    return {key,present:true,loadable:verification.valid===true,reasons:verification.blockers,sha256:row.sha256,version:row.version};
  });
  return {observedAt:value.observedAt,readOnly:true,productionWrites:0,keys,
    registryArtifacts:keys.filter(k=>k.present).length,loadableArtifacts:keys.filter(k=>k.loadable).length,
    recommendationAdoptionConfirmed:false,fixtureIdentityVerified:false};
}
function read(output,env=process.env){
  check(Number(process.versions.node.split('.')[0])===22,'NODE22');
  check(typeof output==='string'&&path.isAbsolute(output)&&!fs.existsSync(output)&&!fs.existsSync(output+'.remote-response.json'),'NEW_OUTPUT');
  const host=env.RELEASE_DEPLOY_HOST,user=env.RELEASE_DEPLOY_USER;
  check(host==='134.175.132.183'&&user==='ubuntu'&&env.RELEASE_DEPLOY_KEY,'SSH_CONFIG');
  const pin=validateReleaseSshHostKeyPin({knownHostsPath:env.RELEASE_DEPLOY_KNOWN_HOSTS,host,port:22,expectedFingerprint:env.RELEASE_DEPLOY_HOST_KEY_SHA256});
  const source=`const cp=require('node:child_process');try{const raw=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--dbname=football'],{input:${JSON.stringify(query())},timeout:22000,maxBuffer:${MAX_RESPONSE},stdio:['pipe','pipe','pipe']});process.stdout.write(raw);}catch{process.stderr.write('MODEL_REGISTRY_REMOTE_READ_FAILED');process.exitCode=1;}`;
  const startedAt=new Date().toISOString();
  const raw=cp.execFileSync('ssh',[...buildPinnedSshBaseOptions({keyPath:env.RELEASE_DEPLOY_KEY,pin}),'-p','22',`${user}@${host}`,'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'],{input:source,timeout:45000,maxBuffer:MAX_RESPONSE,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finishedAt=new Date().toISOString();
  fs.writeFileSync(output+'.remote-response.json',raw,{flag:'wx',mode:0o600});
  const value=JSON.parse(raw.toString('utf8')),summary=inspect(value,startedAt,finishedAt);
  const receipt={version:VERSION,...summary,generation:value.generation,
    transport:{startedAt,finishedAt,hostKeyPinVerified:true,rawSha256:hash(raw),rawFile:path.basename(output+'.remote-response.json')},
    implementationSha256:hash(fs.readFileSync(__filename)),loaderSha256:hash(fs.readFileSync(require.resolve('../src/services/prematchV3ModelRegistry.cjs')))};
  fs.writeFileSync(output,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});return {output,...summary};
}
if(require.main===module){try{console.log(JSON.stringify(read(process.argv[2])));}catch(e){console.error(/^MODEL_REGISTRY_READ_/.test(e.message)?e.message:'MODEL_REGISTRY_READ_FAILED');process.exitCode=1;}}
module.exports={VERSION,KEYS,query,inspect,read};
