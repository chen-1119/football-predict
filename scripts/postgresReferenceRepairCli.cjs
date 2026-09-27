'use strict';
// This module is dispatched only by deployReleaseBundle's explicit signed repair mode.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const policy=require('./postgresReferenceRepairPolicy.cjs');
const root=path.resolve(__dirname,'..');
function parseArgs(args){const options={action:'inspect'},seen=new Set();for(const arg of args){if(arg==='--signed-reference-repair')continue;const m=/^--repair-(action|capsule|observation|output)=(.+)$/.exec(arg);assert.ok(m,'unsupported signed repair argument');assert.equal(seen.has(m[1]),false,'duplicate repair argument');seen.add(m[1]);options[m[1]]=m[2];}assert.ok(['inspect','create','prepare','activate','status','recover'].includes(options.action));return options;}
function material(file){const bytes=fs.readFileSync(file);return{sha256:policy.hash(bytes),base64:bytes.toString('base64')};}
function transport(code){
 const host=process.env.RELEASE_DEPLOY_HOST||'134.175.132.183',port=Number(process.env.RELEASE_DEPLOY_PORT||22),user=process.env.RELEASE_DEPLOY_USER||'ubuntu';assert.equal(host,'134.175.132.183');assert.equal(port,22);assert.equal(user,'ubuntu');assert.equal(process.env.RELEASE_DEPLOY_HOST_KEY_SHA256,'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to');
 const {resolveReleaseSshHostKeyPin,buildPinnedSshBaseOptions}=require('./releaseSshHostKeyPin.cjs');
 const pin=resolveReleaseSshHostKeyPin({rootDir:root,tmpDir:path.join(root,'.codex-tmp'),host,port}),keyPath=path.resolve(process.env.RELEASE_DEPLOY_KEY||'');assert.ok(process.env.RELEASE_DEPLOY_KEY&&fs.statSync(keyPath).isFile());
 const result=spawnSync('ssh',['-p',String(port),...buildPinnedSshBaseOptions({keyPath,pin}),user+'@'+host,'sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/opt/node-v22.22.1/bin/node','--max-old-space-size=1152','-'],{input:code,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:8*1024*1024});
 if(result.status!==0)throw new Error('signed reference repair remote operation failed: '+String(result.stderr||result.error?.message||'').slice(-600));
 const lines=result.stdout.trim().split('\n');return JSON.parse(lines.at(-1));
}
function observationSource(){
 const controller=fs.readFileSync(path.join(__dirname,'postgresReferenceRepairController.cjs'),'utf8'),source=fs.readFileSync(path.join(__dirname,'postgresReferenceRepairPolicy.cjs'),'utf8');
 return `const Module=require('node:module');const p=new Module('/tmp/reference-repair-readonly/policy.cjs');p._compile(${JSON.stringify(source)},p.id);const c=new Module('/tmp/reference-repair-readonly/controller.cjs');const original=c.require.bind(c);c.require=n=>n==='./postgresReferenceRepairPolicy.cjs'?p.exports:original(n);c._compile(${JSON.stringify(controller)},c.id);c.exports.observe().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});`;
}
function createCapsule(observation,output){
 policy.validateObservation(observation,{fresh:true});const privatePath=process.env.RELEASE_SIGNING_PRIVATE_KEY,publicPath=process.env.RELEASE_SIGNING_PUBLIC_KEY;assert.ok(privatePath&&publicPath&&path.isAbsolute(privatePath)&&path.isAbsolute(publicPath),'explicit signing key paths required');
 const target=policy.guardedEntrypoint(Buffer.from(observation.entrypoint.base64,'base64'));
 const now=Date.now(),p={version:policy.VERSION,site:'football-predict',channel:'production',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+4*3600000).toISOString(),baseRuntimeSha256:policy.BASE_RUNTIME,baseSequence:773,faultCode:'POSTGRES_REFERENCE_ADMISSION_LIMIT',observation,projectionRepair:{kind:'forward-same-database',from:observation.postgres.publication,to:observation.generation,previous:observation.previousGeneration,dataRollback:false},entrypointGuard:{path:policy.ENTRYPOINT,beforeSha256:observation.entrypoint.sha256,sha256:policy.hash(target),base64:target.toString('base64'),preserveOnRollback:true},files:policy.FILES.map(file=>({path:file,beforeSha256:observation.files.find(f=>f.path===file).sha256,...material(path.join(root,file))})),artifacts:Object.fromEntries([['controller','postgresReferenceRepairController.cjs'],['proof','provePostgresReferenceRepair.cjs'],['policy','postgresReferenceRepairPolicy.cjs']].map(([name,file])=>[name,material(path.join(__dirname,file))])),modelPromotion:false,storageMigration:false,dataRewrite:false};
 const bytes=Buffer.from(JSON.stringify(p)+'\n'),signature=crypto.sign('sha256',bytes,fs.readFileSync(privatePath));policy.verify(bytes,signature,fs.readFileSync(publicPath));
 const id=policy.hash(bytes),directory=output?path.resolve(output):path.join(root,'.codex-tmp','reference-repair-'+id);fs.mkdirSync(directory,{recursive:false});fs.writeFileSync(directory+'/capsule.json',bytes,{flag:'wx'});fs.writeFileSync(directory+'/capsule.sig',signature,{flag:'wx'});return{ok:true,capsuleSha256:id,directory,productionWrites:0,activated:false};
}
function remoteSigned(input){
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),Module=require('node:module'),cp=require('node:child_process');
 const bytes=Buffer.from(input.bytes,'base64'),signature=Buffer.from(input.signature,'base64'),key=fs.readFileSync('/etc/football-release/signing-public.pem'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 assert.equal(hash(crypto.createPublicKey(key).export({type:'spki',format:'der'})),input.keyId,'local and remote trusted signing keys differ');assert.ok(crypto.verify('sha256',bytes,key,signature),'untrusted repair signature');
 const raw=JSON.parse(bytes),source=Buffer.from(raw.artifacts.policy.base64,'base64');assert.equal(hash(source),raw.artifacts.policy.sha256);const m=new Module('/tmp/verified-reference-repair-policy.cjs');m._compile(source.toString('utf8'),m.id);
 const p=m.exports.verify(bytes,signature,key,['status','recover'].includes(input.action)?Date.parse(raw.createdAt):Date.now()),id=hash(bytes),parent='/var/lib/football-release/reference-repairs',dir=parent+'/'+id;
 assert.ok(['prepare','activate','status','recover'].includes(input.action));
 if(input.action==='prepare'&&!fs.existsSync(dir)){
  assert.equal(fs.existsSync('/var/lib/football-release/recovery/current'),false);assert.equal(fs.existsSync(parent+'/current'),false,'prior reference repair is unresolved');
  if(!fs.existsSync(parent))fs.mkdirSync(parent,{mode:0o700});assert.equal(fs.realpathSync(parent),parent);const st=fs.statSync(parent);assert.equal(st.uid,0);assert.equal(st.mode&0o777,0o700);fs.mkdirSync(dir,{mode:0o700});
  fs.writeFileSync(dir+'/capsule.json',bytes,{flag:'wx',mode:0o600});fs.writeFileSync(dir+'/capsule.sig',signature,{flag:'wx',mode:0o600});
  for(const [name,file]of [['controller','controller.cjs'],['policy','postgresReferenceRepairPolicy.cjs'],['proof','proof.cjs']])fs.writeFileSync(dir+'/'+file,Buffer.from(p.artifacts[name].base64,'base64'),{flag:'wx',mode:0o600});
 }
 assert.equal(hash(fs.readFileSync(dir+'/capsule.json')),id);const controller=require(dir+'/controller.cjs');controller.load(dir,{fresh:!['status','recover'].includes(input.action)});
 const node='/opt/node-v22.22.1/bin/node',lock='/run/lock/football-release.lock';
 if(input.action==='activate'){
  assert.equal(fs.existsSync(dir+'/activation-started.json'),false);assert.equal(fs.existsSync(parent+'/current'),false);
  const unit='football-reference-repair-'+id.slice(0,12);
  const output=cp.execFileSync('/usr/bin/systemd-run',['--unit='+unit,'--property=Type=exec','--property=RuntimeMaxSec=10800','--property=TimeoutStopSec=900','--property=KillMode=mixed','--property=MemoryMax=1536M','--property=MemorySwapMax=256M','--property=ExecStopPost=/usr/bin/flock -w 120 '+lock+' /usr/bin/env -i PATH=/usr/bin:/bin '+node+' '+dir+'/controller.cjs recover '+dir,'/usr/bin/flock','--no-fork','-n',lock,'/usr/bin/env','-i','PATH=/usr/bin:/bin',node,dir+'/controller.cjs','supervise',dir],{encoding:'utf8',timeout:30000});
  return{ok:true,dispatched:true,accepted:false,unit,directory:dir,maintenanceRequired:true,output};
 }
 const output=cp.execFileSync('/usr/bin/flock',['-n',lock,node,dir+'/controller.cjs',input.action,dir],{encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024});return JSON.parse(output.trim().split('\n').at(-1));
}
async function main(args=process.argv.slice(2)){
 const options=parseArgs(args);let report;
 if(options.action==='inspect'){report=transport(observationSource());const output=options.output?path.resolve(options.output):path.join(root,'.codex-tmp','reference-repair-observation-'+Date.now()+'.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({ok:true,output,observedAt:report.checkedAt,generation:report.generation,frozen:report.frozen,window:report.window,productionWrites:0}));return;}
 if(options.action==='create'){assert.ok(options.observation);report=createCapsule(JSON.parse(fs.readFileSync(path.resolve(options.observation))),options.output);}
 else{
  assert.ok(options.capsule,'signed repair capsule directory required');assert.ok(process.env.RELEASE_SIGNING_PUBLIC_KEY&&path.isAbsolute(process.env.RELEASE_SIGNING_PUBLIC_KEY),'explicit release public key required');
  const directory=path.resolve(options.capsule),bytes=fs.readFileSync(directory+'/capsule.json'),signature=fs.readFileSync(directory+'/capsule.sig'),key=fs.readFileSync(process.env.RELEASE_SIGNING_PUBLIC_KEY),now=['status','recover'].includes(options.action)?Date.parse(JSON.parse(bytes).createdAt):Date.now();policy.verify(bytes,signature,key,now);
  const input={action:options.action,bytes:bytes.toString('base64'),signature:signature.toString('base64'),keyId:policy.hash(crypto.createPublicKey(key).export({type:'spki',format:'der'}))};report=transport('try{const result=('+remoteSigned.toString()+')('+JSON.stringify(input)+');console.log(JSON.stringify(result));}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}');
 }
 console.log(JSON.stringify(report));return report;
}
module.exports={main,parseArgs,createCapsule,observationSource,remoteSigned};
