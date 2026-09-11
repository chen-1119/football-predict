'use strict';
const fs = require('node:fs'), path = require('node:path');
const { remote } = require('./repairRemoteTransport.cjs');
const files = ['scripts/syncData.cjs', 'server/dataGenerationBundle.cjs', 'server/dataGenerationStore.cjs',
  'scripts/exportDataStoreSqlite.cjs', 'scripts/migrateArchivedPreMatchReferences.cjs',
  'scripts/optimizePredictionStrategy.cjs', 'scripts/predictionCapabilityAudit.cjs', 'scripts/validateData.cjs',
  'scripts/verifyDecisionSnapshotClockLineage.cjs', 'scripts/verifyDecisionSnapshots.cjs', 'scripts/verifyPredictionAudit.cjs',
  'scripts/runSyncWorker.cjs'];
const result = remote(`const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
const root='/opt/football-predict',hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const files=${JSON.stringify(files)}.map(p=>{const b=fs.readFileSync(root+'/'+p);return {path:p,sha256:hash(b),base64:b.toString('base64')};});
const s=JSON.parse(fs.readFileSync('/var/lib/football-predict/sync-worker-status.json','utf8'));
const selectedStatus={ok:s.ok,phase:s.phase,pid:s.pid,checkedAt:s.checkedAt,lastCycle:s.lastCycle,eventCycle:s.eventCycle};
const info={checkedAt:new Date().toISOString(),productionWrites:0,files,status:selectedStatus,
services:cp.execFileSync('systemctl',['show','football-sync-worker.service','football-predict.service','--property=Id,ActiveState,MainPID,ExecMainStartTimestamp,MemoryMax'],{encoding:'utf8'}),
disk:cp.execFileSync('df',['-B1','/opt/football-predict','/var/lib/football-predict'],{encoding:'utf8'}),
layout:cp.execFileSync('du',['-s','--block-size=1',root,'/var/lib/football-predict'],{encoding:'utf8'}),
runtime:fs.readFileSync(root+'/.release-bundle-sha256','utf8').trim(),
snapshot:fs.statSync(root+'/public/data/prediction-snapshots.json').size,
keys:cp.execFileSync('find',['/etc/football-release','-maxdepth','2','-type','f'],{encoding:'utf8'}),
links:['public','public/data','server-data'].map(p=>({path:p,real:fs.realpathSync(root+'/'+p)}))};
console.log(JSON.stringify(info));`, { prefix: 'foundation-inventory' });
if (result.exitCode !== 0) { console.log(result); process.exitCode = 1; }
else {
  const data = JSON.parse(result.stdout), dir = path.join(__dirname,'../outputs/live-base');
  for(const row of data.files){const p=path.join(dir,row.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(row.base64,'base64'),{flag:'wx'});delete row.base64;}
  console.log(JSON.stringify({output:result.output,...data}));
}
