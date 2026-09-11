'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { evaluateWorkerPreflight, buildReadOnlyWorkerProbe } = require('./releaseWorkerPreflight.cjs');

function verifyReleaseWorkerPreflight() {
  let checks = 0;
  const check = (_name, run) => { run(); checks++; };
  const base = { checkedAt: '2026-09-08T03:00:00.000Z', processMatches: true,
    serviceBefore: { ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: 'Tue 2026-09-08 02:00:00 UTC' },
    serviceAfter: { ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: 'Tue 2026-09-08 02:00:00 UTC' },
    status: { pid: 42, checkedAt: '2026-09-08T02:59:00Z', phase: 'official-result', ok: true } };
  const run = overrides => evaluateWorkerPreflight({ ...structuredClone(base), ...overrides });
  check('running is preparation only', () => { const r=run({}); assert.equal(r.ok,true); assert.equal(r.readyToCutover,false); });
  const failed = { ...base.status, phase:'failed', ok:false, errorCode:'SYNC_WORKER_COMMAND_FAILED',
    lastCycle:{phase:'official-result-failed',ok:false}, lastSuccessAt:'2026-09-08T02:58:00Z' };
  check('recent old success does not hide latest failure',()=>assert.equal(run({status:failed}).ok,false));
  check('next active attempt is not a recovery receipt',()=>{
    const r=run({status:{...failed,ok:true,phase:'official-result'}});
    assert.equal(r.ok,false);assert.ok(r.blockers.includes('worker-official-recovery-unproven'));
  });
  const recovered = { ...failed, ok:true, phase:'official-result',
    lastCycle:{ok:false,phase:'official-result-failed',finishedAt:'2026-09-08T02:30:00Z'},
    eventCycle:{ok:true,phase:'official-result-published',startedAt:'2026-09-08T02:31:00Z',finishedAt:'2026-09-08T02:58:00Z'} };
  check('a genuinely later official publication clears the preparation blocker only',()=>{
    const r=run({status:recovered});assert.equal(r.ok,true);assert.equal(r.readyToCutover,false);
  });
  for(const patch of [{startedAt:'2026-09-08T02:00:00Z'}, {finishedAt:'2026-09-08T03:10:00Z'},
    {finishedAt:null}, {ok:false}, {phase:'running'}])
    check('invalid or old recovery publication rejected '+JSON.stringify(patch),()=>
      assert.equal(run({status:{...recovered,eventCycle:{...recovered.eventCycle,...patch}}}).ok,false));
  check('slow supplement failure not confused with failed official publication',()=>{ const r=run({status:{...failed,
    lastCycle:{phase:'slow-enrichment-failed',ok:false},eventCycle:{phase:'official-result-published',ok:true}}}); assert.equal(r.ok,true);assert.equal(r.warnings.length,1); });
  check('no official proof for slow failure',()=>assert.equal(run({status:{...failed,lastCycle:{phase:'slow-enrichment-failed'}}}).ok,false));
  for(const key of ['serviceBefore','serviceAfter']) check('inactive '+key,()=>assert.equal(run({[key]:{...base[key],ActiveState:'inactive'}}).ok,false));
  check('restarted process rejected',()=>assert.equal(run({serviceAfter:{...base.serviceAfter,MainPID:'43'}}).ok,false));
  check('PID reuse start-time rejected',()=>assert.equal(run({serviceAfter:{...base.serviceAfter,ExecMainStartTimestamp:'Tue 2026-09-08 02:30:00 UTC'}}).ok,false));
  check('file PID mismatch',()=>assert.equal(run({status:{...base.status,pid:41}}).ok,false));
  check('status predates process',()=>assert.equal(run({status:{...base.status,checkedAt:'2026-09-08T01:59:00Z'}}).ok,false));
  check('future status rejected',()=>assert.equal(run({status:{...base.status,checkedAt:'2026-09-08T04:00:00Z'}}).ok,false));
  check('missing status rejected',()=>assert.equal(run({status:null}).ok,false));
  check('unknown status rejected',()=>assert.equal(run({status:{...base.status,ok:undefined}}).ok,false));
  check('real process must match',()=>assert.equal(run({processMatches:false}).ok,false));
  check('invalid probe clock',()=>assert.equal(run({checkedAt:'bad'}).ok,false));
  check('raw errors never exposed',()=>{const r=run({status:{...failed,error:'secret-value',errorCode:'https://secret-value'}});assert.ok(!JSON.stringify(r).includes('secret-value'));});
  check('serialized SSH probe executes identical policy and only approved reads',()=>{
    for(const status of [base.status,failed,{...failed,ok:true,phase:'official-result'},recovered]) {
      const output=[];let serviceReads=0,closed=0;
      const info={isFile:()=>true,nlink:1,size:100,mtimeMs:1};
      const filesystem={constants:{O_RDONLY:0,O_NOFOLLOW:1},openSync:(p)=>{assert.equal(p,'/var/lib/football-predict/sync-worker-status.json');return 9;},
        fstatSync:()=>info,closeSync:()=>closed++,readlinkSync:p=>{assert.equal(p,'/proc/42/cwd');return '/opt/football-predict';},
        readFileSync:p=>{if(p===9)return JSON.stringify(status);assert.equal(p,'/proc/42/cmdline');return '/opt/node-v22.22.1/bin/node\0scripts/runSyncWorker.cjs\0';}};
      const child={execFileSync:(command,args)=>{assert.equal(command,'systemctl');assert.deepEqual(Array.from(args),['show','football-sync-worker.service','--property=ActiveState,MainPID,ExecMainStartTimestamp','--no-pager']);serviceReads++;return Object.entries(base.serviceBefore).map(([k,v])=>k+'='+v).join('\n');}};
      const processMock={env:{},exitCode:0};
      class FixedDate extends Date { constructor(...args){super(...(args.length?args:[base.checkedAt]));} }
      vm.runInNewContext(buildReadOnlyWorkerProbe(),{require:name=>{if(name==='node:fs')return filesystem;if(name==='node:child_process')return child;throw Error('unexpected '+name);},
        process:processMock,console:{log:value=>output.push(JSON.parse(value))},Date:FixedDate},{timeout:1000});
      assert.deepEqual(output,[run({status})]);assert.equal(serviceReads,2);assert.equal(closed,1);assert.equal(processMock.exitCode,run({status}).ok?0:1);
    }
  });
  const root=path.resolve(__dirname,'..');
  const shell=fs.readFileSync(path.join(root,'deploy/light-server/release-from-bundle.sh'),'utf8');
  const client=fs.readFileSync(path.join(root,'scripts/deployReleaseBundle.cjs'),'utf8');
  check('signed probe before host changes, original final gates retained',()=>{
    const start=shell.indexOf('log "trusted signed source accepted');
    const probe=shell.indexOf('"$TRUSTED_SOURCE_DIR/scripts/releaseWorkerPreflight.cjs"',start);
    assert.ok(probe>start && probe<shell.indexOf('rotate_fixed_recovery_helper \\',start));
    assert.match(shell,/wait_for_worker_official_publish_after \\\r?\n  "\$LIVE_SQLITE_PUBLICATION_WORKER_STARTED_AT"/);
    assert.match(shell,/wait_for_worker_official_publish_after "\$WORKER_RELEASE_STARTED_AT"/);
    assert.match(shell,/wait_for_worker_readiness_idle_after "\$WORKER_RELEASE_STARTED_AT"/);
  });
  check('client probe runs before any uploads',()=>{
    assert.match(client,/require\("\.\/releaseWorkerPreflight\.cjs"\)/);
    assert.match(client,/shellQuote\(buildReadOnlyWorkerProbe\(\)\)/);
    assert.ok(client.indexOf('const remotePreflight = runCommand')<client.indexOf('for (const artifact of uploads)'));
  });
  check('known worker failure stops the actual builder before all expensive preparation', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/createReleaseBundle.cjs'), 'utf8');
    const start = source.indexOf('if (process.env.RELEASE_DEPLOY_KEY) {');
    const end = source.indexOf('\n} else {', start);
    assert.ok(start > 0 && end > start);
    const events = [];
    assert.throws(() => vm.runInNewContext(source.slice(start, end) + '\n}', {
      process:{env:{RELEASE_DEPLOY_KEY:'fixture'}}, console:{error:()=>{}},
      require:name=>{events.push(name);assert.equal(name,'./runReleaseWorkerPreflight.cjs');
        return {runLiveWorkerPreflight:()=>({ok:false,blockers:['worker-official-recovery-unproven']})};},
    }), /foundation unavailable/);
    assert.deepEqual(events, ['./runReleaseWorkerPreflight.cjs']);
    assert.ok(end < source.indexOf('const verifierContracts = spawnSync'));
    assert.ok(end < source.indexOf('const sequenceReservation = reserveReleaseSequence'));
  });
  check('remote preparation client is read only and rejects stale or inconsistent reports', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/runReleaseWorkerPreflight.cjs'), 'utf8');
    for (const variant of ['healthy','failed','stale','exit-mismatch','malformed']) {
      let calls = 0;
      const report = {...run({}), checkedAt:new Date().toISOString()};
      if(variant==='failed'){report.ok=false;report.blockers=['worker-official-recovery-unproven'];}
      if(variant==='stale')report.checkedAt='2000-01-01T00:00:00Z';
      const module = {exports:{}};
      const localRequire=name=>{
        if(name==='node:assert/strict')return assert;
        if(name==='node:path')return path;
        if(name==='node:fs')return {statSync:()=>({isFile:()=>true})};
        if(name==='./releaseSshHostKeyPin.cjs')return {resolveReleaseSshHostKeyPin:()=>({pinned:true}),
          buildPinnedSshBaseOptions:({pin})=>{assert.equal(pin.pinned,true);return ['-o','StrictHostKeyChecking=yes'];}};
        if(name==='./releaseWorkerPreflight.cjs')return {buildReadOnlyWorkerProbe};
        assert.equal(name,'node:child_process');
        return {spawnSync:(command,args,options)=>{calls++;assert.equal(command,'ssh');
          assert.deepEqual(Array.from(args.slice(-7)),['sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/opt/node-v22.22.1/bin/node','-']);
          assert.equal(options.input,buildReadOnlyWorkerProbe());assert.equal(options.timeout,20000);
          return {status:variant==='exit-mismatch'?1:(report.ok?0:1),stdout:variant==='malformed'?'bad':JSON.stringify(report)};
        }};
      };
      vm.runInNewContext(source,{require:localRequire,module,__dirname:path.join(root,'scripts'),process:{env:{}}});
      if(['healthy','failed'].includes(variant))assert.equal(module.exports.runLiveWorkerPreflight().ok,report.ok);
      else assert.throws(()=>module.exports.runLiveWorkerPreflight());
      assert.equal(calls,1);
    }
  });
  return {ok:true,checks,productionWrites:0,synthetic:true};
}
module.exports={verifyReleaseWorkerPreflight};
if(require.main===module)console.log(JSON.stringify(verifyReleaseWorkerPreflight()));
