'use strict';
// Actual Bash dispatch with explicit external service/SQL fixtures.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'../deploy/light-server/release-native.sh'),'utf8').replace(/\r\n/g,'\n');
const extract=name=>{const r=source.match(new RegExp('^'+name+'\\(\\) \\{[\\s\\S]*?^\\}','m'));assert(r);return r[0];};
const run=extract('run_native_release'),failure=extract('native_exit');
const variables=[...new Set([...run.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g),...failure.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map(m=>m[1]))];
const stubs=['log','release_stage_observe','wait_for_health','prepare_managed_tree_topology_for_transaction',
  'rotate_fixed_recovery_helper','install_fixed_qa_access_operator','ensure_build_user','assert_build_user_quiescent',
  'quiesce_managed_maintenance_for_sqlite_snapshot','cleanup_build_tree','copy_regular_file_nofollow',
  'native_materialize_candidate','start_release_sync_write_barrier','stop_worker_for_release_window',
  'seed_candidate_model_artifacts','stop_release_sync_write_barrier','restore_live_service_after_candidate_barrier',
  'restart_worker_if_needed','run_build_step','run_candidate_model_artifact_catchup','validate_build_artifacts',
  'normalize_validated_artifact_modes','assemble_final_tree','fix_app_permissions','fix_worker_write_permissions',
  'verify_worker_write_permissions','prepare_release_static_attestations','run_candidate_refresh_step',
  'start_candidate_unit','run_trusted_candidate_verifier','stop_candidate','snapshot_app_tree_identity',
  'write_recovery_phase','link_runtime_env','install_systemd_units','install_nginx_config',
  'pause_current_fast_watcher_for_live_prebuild','stop_service_for_release_window','quiesce_native_auxiliary_writers',
  'assert_native_cutover_processes_drained','sync_model_artifact_mirrors','restart_service_if_needed',
  'stop_release_candidate_heartbeat_keeper','cleanup_release_static_attestations',
  'cp','rm','install','chown','mv','sync','systemctl'];
const cases=[
  {name:'code-success',mode:1},{name:'database-success',mode:0},
  {name:'unsigned-dist',mode:1,prebuilt:0},{name:'seed-failed',mode:1,fail:'native_data:seed'},
  {name:'reader-failed',mode:1,fail:'native_data:candidate-access'},
  {name:'candidate-failed',mode:1,fail:'run_trusted_candidate_verifier'},
  {name:'final-failed',mode:1,fail:'native_data:final'},
  {name:'reader-retire-failed',mode:1,fail:'native_data:drop-candidate-access'}];
const base=fs.mkdtempSync(path.join(os.tmpdir(),'code-lane-bash-')),checks=[];
try{for(const item of cases){
  const dir=path.join(base,item.name);fs.mkdirSync(path.join(dir,'node/bin'),{recursive:true});fs.mkdirSync(path.join(dir,'app'));
  fs.mkdirSync(path.join(dir,'state','a'.repeat(64)),{recursive:true});
  fs.writeFileSync(path.join(dir,'node/bin/node'),'#!/usr/bin/env bash\nset -eu\n'+
    'if [ "$1" = -e ]; then\n case "$2" in *dataPlane*) echo "$FIXTURE_MODE";; *) printf "runtime-only\\nfootball\\nnull\\n";; esac\n'+
    'else printf "node:%s\\n" "$1" >>"$FIXTURE_LOG"; fi\n',{mode:0o700});
  const setup=variables.filter(v=>!['PATH','HOME'].includes(v)).map(v=>v+'=0').join('\n')+'\n'+
    'RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS=900000\nPOST_SWAP_TRANSITION_START_BUDGET_SECONDS=1620\nCANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS=30\n'+
    'export FIXTURE_ROOT="$PWD" FIXTURE_LOG="$PWD/events" FIXTURE_MODE='+item.mode+'\n'+
    'FIXTURE_FAIL='+JSON.stringify(item.fail||'')+'\nNODE_HOME="$PWD/node"\n'+
    'APP_DIR="$PWD/app"\nNEXT_DIR="$PWD/app.next"\nBACKUP_DIR="$PWD/app.previous"\nFAILED_DIR="$PWD/app.failed"\n'+
    'BUILD_DIR="$PWD/build"\nBUILD_HOME="$PWD/home"\nTRUSTED_SOURCE_DIR="$PWD/source"\nRECOVERY_DIR="$PWD/recovery"\n'+
    'LIVE_STORE_DIR="$PWD/live"\nCANDIDATE_STORE_DIR="$BUILD_DIR/server-data"\nRUNTIME_ENV_FILE="$PWD/runtime.env"\n'+
    'BUNDLE_SHA256='+'a'.repeat(64)+'\n'+
    'fixture_event() { printf "%s\\n" "$1" >>"$FIXTURE_LOG"; [ "$1" != "$FIXTURE_FAIL" ]; }\n'+
    stubs.map(n=>n+'() { fixture_event "'+n+'"; }').join('\n')+'\n'+
    'native_data() { fixture_event "native_data:$1"; }\n'+
    'initialize_release_recovery_snapshot() { RECOVERY_ACTIVE=1; fixture_event recovery-prepared; }\n'+
    'verify_and_normalize_prebuilt_dist() { PREBUILT_DIST_VALIDATED='+(item.prebuilt??1)+'; }\n'+
    'native_finish_readiness() { fixture_event post-swap-readiness; trap - EXIT; }\n';
  // Only filesystem roots are relocated; branch predicates and order are real.
  const relocate=s=>s.replaceAll('/opt/football-predict','$'+'{FIXTURE_ROOT}/app').replaceAll('/var/lib/football-release/native','$'+'{FIXTURE_ROOT}/state');
  const input='set -euo pipefail\n'+setup+relocate(failure)+'\n'+relocate(run)+'\nrun_native_release\n';
  const result=spawnSync(process.platform==='win32'?'D:/app/Git/bin/bash.exe':'/bin/bash',['--noprofile','--norc','-s'],
    {cwd:dir,input,encoding:'utf8',timeout:10000,maxBuffer:65536,windowsHide:true});
  const events=fs.existsSync(path.join(dir,'events'))?fs.readFileSync(path.join(dir,'events'),'utf8').trim().split('\n'):[];
  const success=!item.fail&&item.prebuilt!==0;
  assert.equal(result.status,success?0:1,item.name+': '+result.stderr+'\n'+events.join('\n'));
  if(success){
    assert(events.includes('post-swap-readiness'));assert(events.includes('native_data:final'));
    assert(events.includes('native_data:candidate-access'));
    assert(events.indexOf('native_data:drop-candidate-access')<events.indexOf('snapshot_app_tree_identity'));
  }else{assert(!events.includes('mv'),item.name+': failed candidate must not swap');assert(!events.includes('post-swap-readiness'));}
  if(item.name==='reader-retire-failed')assert(events.includes('node:/usr/local/libexec/football-release-recovery.cjs'),'reader cleanup must not prevent service recovery');
  if(item.mode===1){
    for(const name of ['native_data:build-access','run_candidate_model_artifact_catchup','run_candidate_refresh_step'])assert(!events.includes(name));
    assert(!events.some(v=>v.includes('recommendation-schema-bridge.cjs')));
    if(events.includes('native_data:seed'))assert(events.indexOf('run_build_step')<events.indexOf('native_data:seed'));
  }else{
    for(const name of ['native_data:build-access','run_candidate_model_artifact_catchup','run_candidate_refresh_step'])assert(events.includes(name));
    assert(events.some(v=>v.includes('recommendation-schema-bridge.cjs')));
  }
  checks.push({name:item.name,ok:true,exit:result.status,events});
}}finally{
  assert.equal(fs.realpathSync(base).toLowerCase(),path.resolve(base).toLowerCase());
  assert(path.basename(base).startsWith('code-lane-bash-'));fs.rmSync(base,{recursive:true});
}
console.log(JSON.stringify({ok:true,checks,actualBashBranchExecution:true,externalEffectsMocked:true,productionWrites:0}));
