'use strict';
// This compatibility contract covers the one accepted read-only component.
// A component upgrade requires a new reviewed contract, never a wildcard unit.
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),a=require('node:assert/strict');
const UNIT='football-read-api-component-6073aafaaf5dae590bfb2b50.service';
const BASE='/var/lib/football-release/components/read-api';
const DIGEST='ffb1ddc6d2f1ec1809309f9d374e5f623cc3700e3f5601306a459e7aefc334df';
const IMAGE='/opt/football-services/read-api/releases/'+DIGEST;
const PINS=[
 [BASE+'/selection.json',340,'aa7505a896d2ead761d56493100aea0361ac2480d929006162dfcf3b13aadddb'],
 [BASE+'/attempt-6073aafaaf5dae590bfb2b50.json',1389,'a4c9ca247d6e7a055dd215536bbb985403286a1fda62c1d06df2bfb7deef16ac'],
 ['/etc/systemd/system/'+UNIT,878,'650943c5ca1e5113b5f8219b16d201765e09c5cb773722c65facfac1a63efd00'],
 ['/var/lib/football-release/components/incoming/'+DIGEST+'/artifact.manifest.json',2289346,'3e2dc4cd6dc95d4025fecc1673ea96d6a9327ed821cd3afb725a621b3650828e']
];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(selection,receipt,state){
 a.deepEqual(selection,{version:'readonly-component-selection-v1',attemptId:'6073aafaaf5dae590bfb2b50',archiveSha256:DIGEST,head:'09f02e9400861c887e4d2ebdb0eb14723dc9ba79',unit:UNIT,port:8790,acceptedAt:'2026-10-12T02:18:02.367Z'});
 a.equal(receipt.phase,'accepted');a.deepEqual(receipt.candidate,selection);
 a.equal(state.LoadState,'loaded');a.equal(state.User,'football');a.equal(state.WorkingDirectory,IMAGE);a.equal(state.FragmentPath,PINS[2][0]);a.equal(state.DropInPaths,'');
 a(['active','inactive','failed'].includes(state.ActiveState));a.equal(state.ControlPID,'0');a(['','0'].includes(state.Job));
 a.equal((state.ExecStart.match(/\bpath=/g)||[]).length,1);a.equal((state.ExecStart.match(/argv\[\]=/g)||[]).length,1);
 a.equal(state.ExecStart.split(' ; ')[0],'{ path=/opt/node-v22.22.1/bin/node');
 a.equal(state.ExecStart.split(' ; ')[1],'argv[]=/opt/node-v22.22.1/bin/node '+IMAGE+'/services/read-api/server.cjs');
 a(['','/system.slice/'+UNIT].includes(state.ControlGroup));
 if(state.ActiveState==='active'){a.match(state.MainPID,/^[1-9][0-9]*$/);a.equal(state.ControlGroup,'/system.slice/'+UNIT);}else a.equal(state.MainPID,'0');
 return{ok:true,unit:UNIT,acceptedImage:DIGEST,scope:'exact installed read API lifecycle identity',productionWrites:0};
}
function read(p,max){a.equal(fs.realpathSync(p),p);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);a(s.isFile()&&s.uid===0&&s.nlink===1&&!(s.mode&0o022)&&s.size<=max);return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
function main(){a.equal(process.platform,'linux');a.equal(process.getuid(),0);a(!fs.existsSync(BASE+'/active-transaction.json'));
 const bytes=PINS.map(([p,n,h])=>{const b=read(p,n);a.equal(b.length,n);a.equal(hash(b),h);return b;});
 const manifest=JSON.parse(bytes[3]);a.equal(manifest.sourceFiles,12083);a.equal(manifest.sourceBytes,195276523);
 // The accepted image is immutable; every dependency and source byte matters.
 let total=0;for(const item of manifest.inventory){a.match(item.path,/^[A-Za-z0-9_.@+/-]+$/);a(!item.path.split('/').some(s=>s==='..'||s==='.'||s===''));const b=read(IMAGE+'/'+item.path,item.bytes);a.equal(b.length,item.bytes);a.equal(hash(b),item.sha256);total+=b.length;}a.equal(manifest.inventory.length,12083);a.equal(total,195276523);
 const fields=['LoadState','ActiveState','User','WorkingDirectory','FragmentPath','DropInPaths','ControlGroup','ControlPID','MainPID','Job','ExecStart'];
 function state(){const rows=cp.execFileSync('/usr/bin/systemctl',['show',UNIT,...fields.map(k=>'--property='+k)],{encoding:'utf8',timeout:5000,maxBuffer:16384}).trim().split('\n').map(l=>{const i=l.indexOf('=');a(i>0);return[l.slice(0,i),l.slice(i+1)];});a.equal(rows.length,fields.length);const s=Object.fromEntries(rows);a.equal(Object.keys(s).length,fields.length);for(const k of fields)a(Object.hasOwn(s,k));return s;}
 const before=state(),result=validate(JSON.parse(bytes[0]),JSON.parse(bytes[1]),before);
 if(before.ActiveState==='active'){a.equal(fs.readFileSync('/proc/'+before.MainPID+'/cgroup','utf8').trim(),'0::/system.slice/'+UNIT);a.deepEqual(fs.readFileSync('/proc/'+before.MainPID+'/cmdline','utf8').split('\0').filter(Boolean),['/opt/node-v22.22.1/bin/node',IMAGE+'/services/read-api/server.cjs']);}
 a.deepEqual(state(),before);a(!fs.existsSync(BASE+'/active-transaction.json'));for(const [p,n,h]of PINS){const b=read(p,n);a.equal(b.length,n);a.equal(hash(b),h);}return result;
}
if(require.main===module){try{console.log(JSON.stringify(main()));}catch(e){console.error('INSTALLED_READ_API_IDENTITY_REJECTED: '+e.message);process.exitCode=1;}}
module.exports={validate,main,UNIT,IMAGE,PINS};
