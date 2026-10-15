'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),vm=require('node:vm');
const {installRoot}=require('../scripts/installResearchBroker.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const BASE='/usr/local/libexec/football-research-broker',UNIT='football-research-broker.service',UNITFILE='/etc/systemd/system/'+UNIT,APP='/opt/football-predict',JOURNAL='/var/lib/football-research-broker';
function fixture(change=()=>{}){
 const names=['researchSocketServer.py','researchSocketPeer.py','manifest.json','manifest.sig','dependencies.json','platform.json','runtime-binding.json'];
 const data=new Map(),put=(name,value)=>data.set(name,Buffer.isBuffer(value)?value:Buffer.from(value));
 put(names[0],'signed synthetic listener');put(names[1],'signed synthetic peer');put(names[4],'synthetic dependencies');put(names[5],'synthetic platform');put(UNITFILE,'signed synthetic fixed unit');
 const manifest={ok:true,sha256:'a'.repeat(64),releaseSequence:874,archiveSourceEvidence:{inventory:{entries:[
  {path:'scripts/researchSocketServer.py',sha256:hash(data.get(names[0]))},{path:'scripts/researchSocketPeer.py',sha256:hash(data.get(names[1]))},{path:'deploy/light-server/football-research-broker.service',sha256:hash(data.get(UNITFILE))}]}}};
 put(names[2],JSON.stringify(manifest));put(names[3],crypto.sign('sha256',data.get(names[2]),{key:keys.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}));
 put(names[6],JSON.stringify({version:'research-broker-binding-v1',releaseSha:manifest.sha256,manifestSha:hash(data.get(names[2])),manifestPath:BASE+'/manifest.json',signaturePath:BASE+'/manifest.sig',publicKeyPath:'/etc/football-release/signing-public.pem',transport:{peerSourceSha:hash(data.get(names[1]))},socketService:{listenerSha:hash(data.get(names[0])),platformSha256:hash(data.get(names[5]))},dependenciesSha256:hash(data.get(names[4]))}));
 const s={MainPID:'0',ControlPID:'0',Job:'',User:'root',Group:'football',NoNewPrivileges:'yes',RestrictSUIDSGID:'yes',WorkingDirectory:APP,ControlGroup:'',ActiveState:'inactive',SubState:'dead'};
 const previous={brokerPid:0,invocationId:'',releaseSha:manifest.sha256,files:[...names.map(n=>({path:BASE+'/'+n,bytes:data.get(n).length,sha256:hash(data.get(n))})),{path:UNITFILE,bytes:data.get(UNITFILE).length,sha256:hash(data.get(UNITFILE))}]};
 const writes=[];let validatorCalls=0;const source=installRoot.toString(),start=source.indexOf('if(refresh){\n  const old=body.previous'),end=source.indexOf(' }else{\n  for(const p of [BASE,JOURNAL,UNITFILE])',start);
 a(start>0&&end>start,'actual refresh gate must remain before mutation');
 const context={BASE,UNIT,UNITFILE,APP,JOURNAL,body:{previous,releaseSha:'b'.repeat(64),attemptId:'1'.repeat(24)},manifest:{releaseSequence:875},key:keys.publicKey,crypto,hash,names:['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service'],previousFiles:names,
  refresh:true,read:p=>data.get(p.startsWith(BASE+'/')?p.slice(BASE.length+1):p),unit:()=>s,command:()=>'',fail:c=>{throw Error(c);},
  fs:{readdirSync:()=>[...names],existsSync:()=>false,lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o700}),writeFileSync:()=>writes.push('write'),renameSync:()=>writes.push('rename')},
  require:()=>({validateSignedArchiveSourceEvidence(v){a.equal(v.sha256,manifest.sha256);validatorCalls++;}})};
 change({context,data,s,previous});
 return {run:()=>vm.runInNewContext(source.slice(start,end)+'\n}',context),writes,validatorCalls:()=>validatorCalls};
}
test('actual refresh gate accepts signed prior bytes and an inactive unit without assuming a live cgroup',()=>{const f=fixture();f.run();a.equal(f.validatorCalls(),1);a.deepEqual(f.writes,[]);});
for(const [label,change]of [
 ['changed binding',f=>f.data.set('runtime-binding.json',Buffer.from('{}'))],['wrong prior release',f=>{f.previous.releaseSha='0'.repeat(64);}],
 ['changed prior unit',f=>{f.s.MainPID='99';}],['arbitrary path',f=>{f.previous.files[0].path='/tmp/anything';}],
 ['active control job',f=>{f.s.Job='999';}],['non-successor',f=>{f.context.manifest.releaseSequence=874;}],
 ['unexpected file',f=>{f.context.fs.readdirSync=()=>['injected'];}],['unsafe journal',f=>{f.context.fs.lstatSync=()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o777});}],
])test('refresh refuses '+label+' before stop, rename or installation writes',()=>{const f=fixture(change);a.throws(f.run);a.deepEqual(f.writes,[]);});
test('refresh mutation keeps previous files and the journal and retains the normal deadline/lock gates',()=>{
 const s=fs.readFileSync(require.resolve('../scripts/installResearchBroker.cjs'),'utf8');
 a.match(s,/fs\.renameSync\(BASE,BASE\+'\.retired-'/);a.match(s,/if\(!refresh\)\{fs\.mkdirSync\(JOURNAL/);
 a.doesNotMatch(s,/rmSync|unlinkSync|chmodSync|chownSync/);
 a.match(s,/expiresAtMs-body\.issuedAtMs>900000/);a.match(s,/RESEARCH_INSTALL_EXCLUSIVE_LOCK/);
});
