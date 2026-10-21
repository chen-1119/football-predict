'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {installRoot,readInstallerBody}=require('../scripts/installResearchBroker.cjs');
const {Readable}=require('node:stream');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),NODE='/opt/node-v22.22.1/bin/node';
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
function fixture(change=()=>{},badLock=false){
 const body={version:'research-broker-install-v1',attemptId:'a'.repeat(24),head:'b'.repeat(40),installerSha256:sha(installRoot.toString()),releaseSha:'c'.repeat(64),manifestSha256:'d'.repeat(64),signatureSha256:'e'.repeat(64),dependenciesSha256:'f'.repeat(64),platformSha256:'1'.repeat(64),unitApiPid:123,unitWorkerPid:124,issuedAtMs:Date.now()-1000,expiresAtMs:Date.now()+600000,keyId:sha(keys.publicKey.export({type:'spki',format:'der'})),files:[]};
 change(body);
 const signature=crypto.sign('RSA-SHA256',Buffer.concat([Buffer.from('football-'+body.version+'\0'),Buffer.from(JSON.stringify(body))]),{key:keys.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64');
 let writes=0;
 const raw={ '/proc/self/fdinfo/9':'lock:\t1: FLOCK  ADVISORY  WRITE 777 00:01:123 0 EOF\n', '/proc/locks':'1: FLOCK  ADVISORY  WRITE 777 00:01:123 0 EOF\n', '/etc/football-release/signing-public.pem':keys.publicKey.export({type:'spki',format:'pem'}) };
 const stat=()=>({isDirectory:()=>true,isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o444,nlink:1,dev:1,ino:123,size:450,mtimeMs:1,ctimeMs:1});
 const fakeFs={constants:require('node:fs').constants,existsSync:()=>false,readdirSync:()=>['9'],lstatSync:p=>{if(p==='/etc/football-release/signing-trust-v1'){const e=Error('fixture absent trust store');e.code='ENOENT';throw e;}return {...stat(),uid:badLock?999:0};},fstatSync:()=>stat(),openSync:()=>10,closeSync(){},readFileSync(p){if(p===10)return Buffer.from(raw['/etc/football-release/signing-public.pem']);return raw[p];},writeFileSync(){writes++;},mkdirSync(){writes++;}};
 const context={Buffer,process:{platform:'linux',getuid:()=>0,execPath:NODE,version:'v22.22.1',execArgv:[],env:{},pid:777},require:n=>n==='node:fs'?fakeFs:require(n)};
 const call=vm.runInNewContext('('+installRoot.toString()+')',context);
 return {body,signature,invoke:(signatureValue=signature)=>call({body,signature:signatureValue,payloads:[]}),writes:()=>writes};
}
test('valid signed authority proceeds to payload checks while a changed signature cannot install',()=>{
 const f=fixture();a.throws(()=>f.invoke(),/RESEARCH_INSTALL_PAYLOAD/);a.equal(f.writes(),0);
 a.throws(()=>f.invoke(Buffer.alloc(256).toString('base64')),/RESEARCH_INSTALL_SIGNATURE/);a.equal(f.writes(),0);
});
for(const [label,change]of [['expired',b=>{b.expiresAtMs=Date.now()-1;}],['long authority',b=>{b.expiresAtMs=b.issuedAtMs+900001;}],['future',b=>{b.issuedAtMs=Date.now()+10000;}],['arbitrary command',b=>{b.program='/bin/bash';}],['changed installer',b=>{b.installerSha256='0'.repeat(64);}]] )
 test('installer refuses '+label+' before any installation write',()=>{const f=fixture(change);a.throws(()=>f.invoke(),/RESEARCH_INSTALL_AUTHORITY/);a.equal(f.writes(),0);});
test('a signed body cannot substitute an ordinary-user lock file',()=>{const f=fixture(()=>{},true);a.throws(()=>f.invoke(),/RESEARCH_INSTALL_LOCK/);a.equal(f.writes(),0);});
test('installer stdin supports the signed manifest envelope without widening API bodies',async()=>{
 const raw=Buffer.alloc(2*1024*1024,32);a.deepEqual(await readInstallerBody(Readable.from([raw])),raw);
 a.equal(require('../server/researchRequestBody.cjs').MAX_BYTES,1024*1024);
 await a.rejects(readInstallerBody(Readable.from([Buffer.alloc(16*1024*1024+1)])),/RESEARCH_INSTALL_WIRE_BOUND/);
});
test('refresh has a distinct signed scope and requires its exact previous boundary',()=>{
 const f=fixture(b=>{b.version='research-broker-refresh-v1';b.previous={};});
 a.throws(()=>f.invoke(),/RESEARCH_INSTALL_PAYLOAD/);a.equal(f.writes(),0);
 const crossDomain=crypto.sign('RSA-SHA256',Buffer.concat([Buffer.from('football-research-broker-install-v1\0'),Buffer.from(JSON.stringify(f.body))]),{key:keys.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64');
 a.throws(()=>f.invoke(crossDomain),/RESEARCH_INSTALL_SIGNATURE/);a.equal(f.writes(),0);
 const missing=fixture(b=>{b.version='research-broker-refresh-v1';});a.throws(()=>missing.invoke(),/RESEARCH_INSTALL_AUTHORITY/);
});
