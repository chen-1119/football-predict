'use strict';
// A distinct, signed installation scope. This is not a read-API controller
// permission and never rewrites application code, credentials or PostgreSQL.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const DOMAIN=Buffer.from('football-research-broker-install-v1\0');
function installRoot(wire){
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
 const BASE='/usr/local/libexec/football-research-broker',APP='/opt/football-predict',JOURNAL='/var/lib/football-research-broker';
 const NODE='/opt/node-v22.22.1/bin/node',UNIT='football-research-broker.service',UNITFILE='/etc/systemd/system/'+UNIT;
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),fail=c=>{throw Error(c);};
 const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
 function directory(p){for(let s=p;;s=path.dirname(s)){const st=fs.lstatSync(s);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))fail('RESEARCH_INSTALL_DIRECTORY');if(s==='/')break;}}
 function read(p,max){directory(path.dirname(p));const before=fs.lstatSync(p);if(!before.isFile()||before.isSymbolicLink()||before.uid!==0||before.nlink!==1||(before.mode&0o022)||before.size>max)fail('RESEARCH_INSTALL_FILE');
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd),b=fs.readFileSync(fd),z=fs.fstatSync(fd),end=fs.lstatSync(p);
   if(a.dev!==before.dev||a.ino!==before.ino||a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs||z.ino!==end.ino||z.dev!==end.dev||z.mtimeMs!==end.mtimeMs||z.ctimeMs!==end.ctimeMs)fail('RESEARCH_INSTALL_CHANGED');return b;
  }finally{fs.closeSync(fd);}}
 function sync(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function create(p,raw,mode){directory(path.dirname(p));const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(path.dirname(p));}
 function command(program,args){return cp.execFileSync(program,args,{env,encoding:'utf8',timeout:15000,maxBuffer:65536});}
 function unit(name){const names=['MainPID','ActiveState','SubState','ControlPID','Job','User','Group','ControlGroup','NoNewPrivileges','RestrictSUIDSGID','WorkingDirectory'];
  return Object.fromEntries(command('/usr/bin/systemctl',['show','--all','--property='+names.join(','),name]).trim().split('\n').map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));}
 if(process.platform!=='linux'||process.getuid()!==0||process.execPath!==NODE||process.version!=='v22.22.1'||process.execArgv.length||['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH'].some(k=>process.env[k]))fail('RESEARCH_INSTALL_FIXED_RUNTIME');
 const lock=fs.lstatSync('/run/lock/football-release.lock');
 if(!lock.isFile()||lock.isSymbolicLink()||lock.uid!==0||lock.nlink!==1||(lock.mode&0o022))fail('RESEARCH_INSTALL_LOCK');
 // util-linux --no-fork opens its own descriptor. Accept only the matching
 // kernel open-file lock owned by this exact process; never presume FD9.
 let own;
 for(const name of fs.readdirSync('/proc/self/fd')){if(!/^\d+$/.test(name))continue;let held,info;try{held=fs.fstatSync(Number(name));info=fs.readFileSync('/proc/self/fdinfo/'+name,'utf8');}catch{continue;}
  if(held.ino!==lock.ino||held.dev!==lock.dev)continue;
  const line=info.split('\n').find(s=>/lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/.test(s));
  if(line?.includes(' '+process.pid+' ')){own=line;break;}}
 if(!own||!own.includes(' '+process.pid+' ')||!fs.readFileSync('/proc/locks','utf8').includes(own.slice(own.indexOf('FLOCK'))))fail('RESEARCH_INSTALL_EXCLUSIVE_LOCK');
 const {body,signature,payloads}=wire;
 const fields='attemptId,dependenciesSha256,expiresAtMs,files,head,installerSha256,issuedAtMs,keyId,manifestSha256,platformSha256,releaseSha,signatureSha256,unitApiPid,unitWorkerPid,version';
 if(!body||Object.keys(body).sort().join(',')!==fields||body.version!=='research-broker-install-v1'||!/^[a-f0-9]{24}$/.test(body.attemptId||'')||!/^[a-f0-9]{40}$/.test(body.head||'')
  ||['installerSha256','manifestSha256','releaseSha','keyId','dependenciesSha256','platformSha256','signatureSha256'].some(k=>!/^[a-f0-9]{64}$/.test(body[k]||''))
  ||['unitApiPid','unitWorkerPid'].some(k=>!Number.isSafeInteger(body[k])||body[k]<2)||body.installerSha256!==hash(installRoot.toString())
  ||!Number.isSafeInteger(body.issuedAtMs)||!Number.isSafeInteger(body.expiresAtMs)||body.issuedAtMs>Date.now()||body.expiresAtMs<=Date.now()||body.expiresAtMs-body.issuedAtMs>900000||body.expiresAtMs<=body.issuedAtMs)fail('RESEARCH_INSTALL_AUTHORITY');
 const keyRaw=read('/etc/football-release/signing-public.pem',16384),key=crypto.createPublicKey(keyRaw);
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048||hash(key.export({type:'spki',format:'der'}))!==body.keyId
  ||!crypto.verify('RSA-SHA256',Buffer.concat([Buffer.from('football-research-broker-install-v1\0'),Buffer.from(JSON.stringify(body))]),{key,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(signature,'base64')))fail('RESEARCH_INSTALL_SIGNATURE');
 const names=['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service','manifest.json','manifest.sig','dependencies.json','platform.json'];
 if(!Array.isArray(body.files)||body.files.length!==names.length||!Array.isArray(payloads)||payloads.length!==names.length)fail('RESEARCH_INSTALL_PAYLOAD');
 const bytes=body.files.map((r,i)=>{if(Object.keys(r).sort().join(',')!=='bytes,path,sha256'||r.path!==names[i]||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>16*1024*1024||!/^[a-f0-9]{64}$/.test(r.sha256)||typeof payloads[i]!=='string'||payloads[i].length>24*1024*1024)fail('RESEARCH_INSTALL_PAYLOAD');const b=Buffer.from(payloads[i],'base64');if(b.length!==r.bytes||hash(b)!==r.sha256)fail('RESEARCH_INSTALL_PAYLOAD');return b;});
 if(hash(bytes[3])!==body.manifestSha256||hash(bytes[4])!==body.signatureSha256||hash(bytes[5])!==body.dependenciesSha256||hash(bytes[6])!==body.platformSha256
  ||!crypto.verify('sha256',bytes[3],{key,padding:crypto.constants.RSA_PKCS1_PADDING},bytes[4]))fail('RESEARCH_INSTALL_RELEASE_SIGNATURE');
 const manifest=JSON.parse(bytes[3]),inventory=new Map(manifest.archiveSourceEvidence?.inventory?.entries?.map(r=>[r.path,r.sha256]));
 if(manifest.ok!==true||manifest.manifestVersion!==3||manifest.sha256!==body.releaseSha||!Number.isSafeInteger(manifest.releaseSequence)||!inventory.size
  ||manifest.archiveSourceEvidence.archiveSha256!==body.releaseSha||manifest.archiveSourceEvidence.inventorySha256!==manifest.archiveSourceEvidence.inventory.treeHash
  ||manifest.signature?.keyId!==body.keyId||manifest.signature?.algorithm!=='rsa-sha256-pkcs1-v1_5')fail('RESEARCH_INSTALL_RELEASE');
 if(inventory.get('scripts/installResearchBroker.cjs')!==hash(read(APP+'/scripts/installResearchBroker.cjs',1048576)))fail('RESEARCH_INSTALL_ENTRY_SOURCE');
 for(let i=0;i<3;i++)if(inventory.get(names[i])!==hash(bytes[i])||!read(APP+'/'+names[i],1048576).equals(bytes[i]))fail('RESEARCH_INSTALL_SOURCE');
 // All root broker/worker imports must come from this signed full source tree.
 const visited=new Set();function visit(p){if(!p.startsWith(APP+'/'))fail('RESEARCH_INSTALL_SOURCE_PATH');if(visited.has(p))return;visited.add(p);const b=read(p,8*1024*1024);if(inventory.get(path.relative(APP,p))!==hash(b))fail('RESEARCH_INSTALL_SOURCE');for(const r of b.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g))visit(require.resolve(path.resolve(path.dirname(p),r[1])));}
 visit(APP+'/scripts/researchReleaseBroker.cjs');visit(APP+'/scripts/researchBrokerWorker.cjs');visit(APP+'/deploy/light-server/collector-trust-registry.json');
 // Use the normal archive producer's commitment: treeHash commits the inventory
 // body, excluding the treeHash field itself. Verify its complete schema/counts
 // and source closure before importing the shared validator.
 visit(APP+'/scripts/releaseArchiveSourceInventory.cjs');
 require(APP+'/scripts/releaseArchiveSourceInventory.cjs').validateSignedArchiveSourceEvidence(manifest);
 require(APP+'/server/researchBrokerDependencies.cjs').verify(APP,JSON.parse(bytes[5]),p=>read(p,4*1024*1024));
 const platform=JSON.parse(bytes[6]);if(platform.version!=='research-platform-runtime-v1'||!Array.isArray(platform.files)||platform.files.length<5||platform.files.length>512)fail('RESEARCH_INSTALL_PLATFORM');
 const fixed=['/usr/bin/python3.12','/usr/bin/flock','/usr/bin/systemctl','/usr/sbin/runuser',NODE];
 for(const r of platform.files){if(!fixed.includes(r.path)&&!r.path.startsWith('/usr/lib/python3.12/'))fail('RESEARCH_INSTALL_PLATFORM_PATH');if(hash(read(r.path,128*1024*1024))!==r.sha256)fail('RESEARCH_INSTALL_PLATFORM');}
 if(fixed.some(p=>!platform.files.some(r=>r.path===p)))fail('RESEARCH_INSTALL_PLATFORM');
 function boundary(){if(Date.now()>=body.expiresAtMs)fail('RESEARCH_INSTALL_EXPIRED');for(const n of ['.release-bundle-sha256','.release-live-complete'])if(read(APP+'/'+n,128).toString().trim()!==body.releaseSha)fail('RESEARCH_INSTALL_RELEASE_CHANGED');
  if(fs.existsSync('/var/lib/football-release/recovery/current')||fs.existsSync('/var/lib/football-release/reference-repairs/current'))fail('RESEARCH_INSTALL_RECOVERY_PENDING');
  for(const [n,pid]of [['football-predict.service',body.unitApiPid],['football-sync-worker.service',body.unitWorkerPid]]){const s=unit(n);if(s.MainPID!==String(pid)||s.ActiveState!=='active'||s.SubState!=='running'||s.ControlPID!=='0'||s.Job||s.User!=='football'||s.Group!=='football'||s.NoNewPrivileges!=='yes'||s.RestrictSUIDSGID!=='yes'||s.WorkingDirectory!==APP||s.ControlGroup!=='/system.slice/'+n)fail('RESEARCH_INSTALL_UNIT_CHANGED');}}
 boundary();for(const p of [BASE,JOURNAL,UNITFILE])if(fs.existsSync(p))fail('RESEARCH_INSTALL_ALREADY_PRESENT_READ_FIRST');
 if(unit(UNIT).MainPID!=='0'||unit(UNIT).ActiveState!=='inactive')fail('RESEARCH_INSTALL_EXISTING_UNIT');
 for(const p of ['/usr/local/libexec','/var/lib','/etc/systemd/system']){directory(p);const s=fs.statfsSync(p);if(s.bavail*s.bsize<64*1024*1024)fail('RESEARCH_INSTALL_CAPACITY');}
 const receipt='/var/lib/football-release/research-install-'+body.attemptId+'.json';
 create(receipt,Buffer.from(JSON.stringify({body,signature,startedAt:new Date().toISOString(),scope:'fixed-authenticated-api-root-lock-broker-no-data-write'})+'\n'),0o600);
 const uid=Number(command('/usr/bin/id',['-u','football']).trim()),gid=Number(command('/usr/bin/id',['-g','football']).trim());if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)fail('RESEARCH_INSTALL_USER');
 fs.mkdirSync(BASE,{mode:0o755});sync(path.dirname(BASE));fs.mkdirSync(JOURNAL,{mode:0o700});sync(path.dirname(JOURNAL));
 for(const [name,index]of [['researchSocketServer.py',0],['researchSocketPeer.py',1],['manifest.json',3],['manifest.sig',4],['dependencies.json',5],['platform.json',6]])create(BASE+'/'+name,bytes[index],0o444);
 const binding={version:'research-broker-binding-v1',releaseSha:body.releaseSha,manifestSha:body.manifestSha256,manifestPath:BASE+'/manifest.json',signaturePath:BASE+'/manifest.sig',publicKeyPath:'/etc/football-release/signing-public.pem',nodeSha:platform.files.find(r=>r.path===NODE).sha256,dependenciesSha256:body.dependenciesSha256,
  transport:{version:'research-unix-socket-v1',apiSourceSha:inventory.get('server/index.cjs'),clientSourceSha:inventory.get('server/researchBrokerClient.cjs'),peerSourceSha:hash(bytes[1]),footballUid:uid,footballGid:gid},
  socketService:{version:'research-root-socket-service-v1',listenerSha:hash(bytes[0]),brokerSourceSha:inventory.get('scripts/researchReleaseBroker.cjs'),platformSha256:body.platformSha256}};
 create(BASE+'/runtime-binding.json',Buffer.from(JSON.stringify(binding)+'\n'),0o444);create(UNITFILE,bytes[2],0o444);boundary();
 try{command('/usr/bin/systemctl',['daemon-reload']);command('/usr/bin/systemctl',['enable',UNIT]);command('/usr/bin/systemctl',['start',UNIT]);
  const s=unit(UNIT);if(s.ActiveState!=='active'||s.SubState!=='running'||s.User!=='root'||s.Group!=='football'||s.ControlPID!=='0'||s.Job)fail('RESEARCH_INSTALL_SERVICE_UNVERIFIED');
  boundary();create(receipt+'.completed.json',Buffer.from(JSON.stringify({version:'research-broker-installed-v1',releaseSha:body.releaseSha,head:body.head,bindingSha256:hash(read(BASE+'/runtime-binding.json',16384)),unit:s,completedAt:new Date().toISOString(),productionDataWrites:0,cloudHandoverVerified:false})+'\n'),0o600);
  console.log(JSON.stringify({installed:true,receipt:receipt+'.completed.json',releaseSha:body.releaseSha,productionDataWrites:0,cloudHandoverVerified:false}));
 }catch(e){try{command('/usr/bin/systemctl',['stop',UNIT]);command('/usr/bin/systemctl',['disable',UNIT]);}catch{/* keep failed material and report original failure */}throw e;}
}
function packageInstall({bundlePath,boundaryPath,dependenciesPath,platformPath}){
 const state=JSON.parse(fs.readFileSync(boundaryPath)),boundary=state.stdout?JSON.parse(state.stdout):state;
 if(state.status!==undefined&&state.status!==0)throw Error('RESEARCH_INSTALL_BOUNDARY');
 const manifest=fs.readFileSync(bundlePath+'.manifest.json'),signature=fs.readFileSync(bundlePath+'.manifest.sig'),m=JSON.parse(manifest);
 const observed=Date.parse(boundary.observedAt);
 if(boundary.releaseSha!==m.sha256||!Number.isFinite(observed)||observed>Date.now()||Date.now()-observed>180000)throw Error('RESEARCH_INSTALL_FRESH_BOUNDARY');
 const head=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 if(cp.execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim())throw Error('RESEARCH_INSTALL_DIRTY_SOURCE');
 const units=Object.fromEntries(boundary.units.trim().split(/\n\n/).map(s=>{const d=Object.fromEntries(s.split('\n').map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));return[d.Id,d];}));
 const names=['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service','manifest.json','manifest.sig','dependencies.json','platform.json'];
 const payload=[...names.slice(0,3).map(p=>fs.readFileSync(path.join(root,p))),manifest,signature,fs.readFileSync(dependenciesPath),fs.readFileSync(platformPath)];
 const signing=require('./releaseSigning.cjs').loadReleasePrivateKey(),issuedAtMs=Date.now();
 const body={version:'research-broker-install-v1',attemptId:crypto.randomBytes(12).toString('hex'),head,installerSha256:sha(installRoot.toString()),releaseSha:m.sha256,manifestSha256:sha(manifest),signatureSha256:sha(signature),dependenciesSha256:sha(payload[5]),platformSha256:sha(payload[6]),unitApiPid:Number(units['football-predict.service'].MainPID),unitWorkerPid:Number(units['football-sync-worker.service'].MainPID),issuedAtMs,expiresAtMs:issuedAtMs+900000,keyId:signing.keyId,files:names.map((p,i)=>({path:p,bytes:payload[i].length,sha256:sha(payload[i])}))};
 return {body,signature:crypto.sign('RSA-SHA256',Buffer.concat([DOMAIN,Buffer.from(JSON.stringify(body))]),{key:signing.key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64'),payloads:payload.map(b=>b.toString('base64'))};
}
// Deployment orchestration supplies only freshly observed, exact paths. Root
// never accepts caller-selected executable, user, environment or destination.
module.exports={installRoot,packageInstall};
function readInstallerBody(stream){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,done=false;
  const end=error=>{if(done)return;done=true;clearTimeout(timer);stream.removeListener('data',data);stream.removeListener('end',finish);stream.removeListener('error',failure);if(error){stream.destroy();reject(Error(error));}else resolve(Buffer.concat(chunks));};
  const data=b=>{if(!Buffer.isBuffer(b)||bytes+b.length>16*1024*1024)return end('RESEARCH_INSTALL_WIRE_BOUND');bytes+=b.length;chunks.push(b);};
  const finish=()=>end(),failure=()=>end('RESEARCH_INSTALL_WIRE_UNAVAILABLE'),timer=setTimeout(()=>end('RESEARCH_INSTALL_WIRE_TIMEOUT'),8000);
  stream.on('data',data);stream.once('end',finish);stream.once('error',failure);
 });
}
module.exports.readInstallerBody=readInstallerBody;
if(require.main===module){
 if(process.argv.length!==3||process.argv[2]!=='--install-stdin')throw Error('RESEARCH_INSTALL_FIXED_ENTRY_REQUIRED');
 readInstallerBody(process.stdin)
  .then(raw=>{if(!Buffer.from(raw.toString('utf8')).equals(raw))throw Error('RESEARCH_INSTALL_WIRE_UTF8');installRoot(JSON.parse(raw.toString('utf8')));})
  .catch(()=>{process.stdin.destroy();process.stderr.write('RESEARCH_INSTALL_UNCONFIRMED_READ_FIRST\n');process.exitCode=1;});
}
