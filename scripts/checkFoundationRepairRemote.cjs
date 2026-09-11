'use strict';
const assert=require('node:assert/strict');const {remote}=require('./repairRemoteTransport.cjs');
const id=process.argv[2];assert.match(id||'',/^[a-f0-9]{64}$/);
const r=remote(String.raw`const fs=require('node:fs'),cp=require('node:child_process');const id=CAPSULE_ID,dir='/var/lib/football-release/foundation-repairs/'+id;
const names=['prepare-started','prepared','activation-started','objects-before','backed-up','code-swap-started','activated','official-publication','accepted','failed','recovered'];
const states={};for(const n of names)if(fs.existsSync(dir+'/'+n+'.json')){const p=JSON.parse(fs.readFileSync(dir+'/'+n+'.json','utf8'));
states[n]=n==='objects-before'?{checkedAt:p.checkedAt,frozen:Object.keys(p.frozen).length,decisions:p.decisions.length,evidence:p.evidence.length}:p;}
const unit='football-foundation-activate-'+id.slice(0,12);
const status=cp.execFileSync('systemctl',['show',unit,'football-predict.service','football-sync-worker.service','--property=Id,ActiveState,SubState,MainPID,Result'],{encoding:'utf8'});
const worker=JSON.parse(fs.readFileSync('/var/lib/football-predict/sync-worker-status.json','utf8'));
console.log(JSON.stringify({checkedAt:new Date().toISOString(),states,status,
backup:fs.existsSync(dir+'/backup')?fs.readdirSync(dir+'/backup').map(n=>({name:n,bytes:fs.statSync(dir+'/backup/'+n).isFile()?fs.statSync(dir+'/backup/'+n).size:null})):[],
worker:{pid:worker.pid,ok:worker.ok,phase:worker.phase,checkedAt:worker.checkedAt,eventCycle:worker.eventCycle,lastCycle:worker.lastCycle},
journal:cp.execFileSync('journalctl',['-u',unit,'-n','8','--no-pager','-o','cat'],{encoding:'utf8'}).slice(-3000)}));`.replace('CAPSULE_ID',JSON.stringify(id)),{prefix:'foundation-activation-state'});
if(r.exitCode===0){const v=JSON.parse(r.stdout);console.log(JSON.stringify({output:r.output,checkedAt:v.checkedAt,stages:Object.keys(v.states),
  backup:v.backup,status:v.status,worker:v.worker,failed:v.states.failed||null,accepted:v.states.accepted||null,
  ...(v.states.failed?{journal:v.journal}:{})}));}
else{console.log(JSON.stringify(r));process.exitCode=1;}
