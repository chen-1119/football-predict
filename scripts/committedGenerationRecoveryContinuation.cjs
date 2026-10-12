'use strict';

// A cold continuation of a previously authenticated FULL code transaction.
// No application file overlay, database rewrite, or raw pointer repair.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const VERSION='committed-generation-full-recovery-continuation-v1';
const HASH=/^[a-f0-9]{64}$/;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function verifySignedBytes(bytes,signature,publicKey){
  const key=crypto.createPublicKey(publicKey);assert.equal(key.asymmetricKeyType,'rsa');assert(key.asymmetricKeyDetails.modulusLength>=3072);
  assert(crypto.verify('sha256',bytes,key,signature),'untrusted signed full material');return true;
}
function requireHash(value){assert.match(value||'',HASH);}
function validateAuthorization(p,now=Date.now()){
  assert.equal(p.version,VERSION);assert.equal(p.site,'football-predict');assert.equal(p.channel,'production');
  assert.equal(p.action,'continue-authenticated-full-code-recovery');
  for(const key of ['targetSha256','baseRuntimeSha256','manifestSha256','recoveryHelperSha256','controllerSha256','policySha256','pendingSnapshotSha256','shellSha256','nativeSha256'])requireHash(p[key]);
  assert(Number.isSafeInteger(p.targetSequence)&&p.targetSequence>848);
  assert.equal(p.databaseOid,'28598409');assert.equal(p.targetDataPlane,'code-only');
  assert.equal(p.expectedPhase,'recovering-rollback');
  assert.equal(p.failureCode,'PUBLICATION_SQLITE_IDENTITY_MISMATCH');
  assert.equal(p.failureMessage,'SQLite publication identity matches neither the serving generation nor its immutable previous generation');
  assert.equal(p.productionDataWrites,false);assert.equal(p.applicationFileOverlay,false);
  if(p.resumeSeed===true){requireHash(p.seedReceiptSha256);requireHash(p.seedIdentity?.manifestHash);assert.equal(p.seedIdentity.generationId,'g-'+p.seedIdentity.manifestHash);assert.equal(p.seedIdentity.mode,'active-generation');}
  if(p.externalAuthorizationVersion){assert.equal(p.externalAuthorizationVersion,'cold-full-recovery-authorizations-v1');for(const k of ['engineSha256','externalEmergencySha256','externalEmergencyAuthorizationHash','externalWorkerSha256','originalNativeStateSha256'])requireHash(p[k]);assert.equal(p.externalEmergency.expiresAt,p.expiresAt);assert.equal(p.externalWorker.expiresAt,p.expiresAt);assert.equal(p.externalWorker.baseRuntimeSha256,p.baseRuntimeSha256);assert.equal(p.externalWorker.publication.databaseOid,p.databaseOid);assert.equal(digest(JSON.stringify(p.externalEmergency)+'\n'),p.externalEmergencySha256);assert.equal(digest(JSON.stringify(p.externalWorker)+'\n'),p.externalWorkerSha256);assert.equal(digest(JSON.stringify({version:p.externalEmergency.version,mode:p.externalEmergency.mode,reason:p.externalEmergency.reason,authorizedAt:p.externalEmergency.authorizedAt,expiresAt:p.externalEmergency.expiresAt})),p.externalEmergencyAuthorizationHash);}
  assert.equal(p.forcedSynchronization,false);assert.equal(p.transitionSeconds,900);
  if(p.controllerMemoryMaxBytes!==undefined){assert.equal(p.controllerMemoryMaxBytes,3*1024**3);assert.equal(p.controllerMemorySwapMaxBytes,512*1048576);}
  if(p.recordedFailedImage){const image=p.recordedFailedImage;assert.equal(image.path,'/opt/football-predict.failed');assert.equal(image.priorUnitResult,'oom-kill');requireHash(image.priorId);requireHash(image.priorAuthorizationSha256);requireHash(image.newTreeIdentitySha256);requireHash(image.dependencies?.sha256);for(const k of ['device','inode'])assert.match(image[k],/^[0-9]+$/);assert(Number.isSafeInteger(image.signedFiles)&&image.signedFiles>1700);assert.equal(image.controllerMemoryMaxBytes,p.controllerMemoryMaxBytes);assert.equal(image.controllerMemorySwapMaxBytes,p.controllerMemorySwapMaxBytes);assert.deepEqual(image.finalReceipts.map(r=>r.name),['final-started.json','data-finalized.json']);for(const r of image.finalReceipts)requireHash(r.sha256);}
  if(p.retiredCandidateFiles?.length){assert.deepEqual(p.retiredCandidateFiles.map(r=>r.name),['candidate-access-intent.json','candidate-access.json','candidate-access-dropped.json','candidate.env']);for(const row of p.retiredCandidateFiles)requireHash(row.sha256);}
  assert.match(p.buildDir,new RegExp('^/opt/football-predict\\.build-'+p.targetSha256.slice(0,12)+'-[1-9][0-9]{0,9}$'));
  assert.equal(p.sourceDir,'/var/lib/football-release/recovery-continuations/'+p.id+'/source');requireHash(p.id);
  const start=Date.parse(p.createdAt),end=Date.parse(p.expiresAt);
  assert.equal(new Date(start).toISOString(),p.createdAt);assert.equal(new Date(end).toISOString(),p.expiresAt);
  assert(start<=now+5000&&end>now&&end>start&&end-start<=60*60*1000,'continuation authorization expired');
  assert(Array.isArray(p.pendingFiles)&&p.pendingFiles.length>0&&p.pendingFiles.length<=128);
  for(const row of p.pendingFiles){assert.match(row.path,/^[A-Za-z0-9_.\/-]+$/);assert(!row.path.startsWith('/')&&!row.path.split('/').includes('..'));requireHash(row.sha256);}
  return p;
}
function validateObservation(p,o){
  assert.equal(o.runtime,p.baseRuntimeSha256);assert.equal(o.complete,p.baseRuntimeSha256);
  assert.equal(o.pendingTarget,p.targetSha256);assert.equal(o.pendingPhase,p.expectedPhase);
  assert.equal(o.dataPlane,'code-only');assert.equal(o.databaseOid,p.databaseOid);
  assert.equal(o.helperSha256,p.recoveryHelperSha256);assert.equal(o.pendingSnapshotSha256,p.pendingSnapshotSha256);
  assert.equal(o.activeReleaseControllers,0);assert.equal(o.apiListening,false);
  assert.equal(o.startupFailure.code,p.failureCode);assert.equal(o.startupFailure.message,p.failureMessage);
  assert.equal(o.appTopology,'old');assert.equal(o.backupTopology,'absent');assert.equal(o.failedTopology,p.recordedFailedImage?'new':'absent');
  assert.equal(o.verifiedSignedFull,true);assert.equal(o.verifiedPreparedBuild,true);
  assert.equal(o.schemaUnchanged,true);assert.equal(o.capacityAccepted,true);
  assert.equal(o.readonlyPublicationPairAccepted,true);assert.equal(o.archivesAccepted,true);
  return true;
}
function replaceOnce(source,before,after){assert.equal(source.split(before).length,2,'ambiguous continuation source anchor');return source.replace(before,after);}
function renderScript(shell,native,p){
  validateAuthorization(p);
  assert.equal(digest(shell),p.shellSha256);assert.equal(digest(native),p.nativeSha256);
  shell=shell.replace(/\r\n/g,'\n');native=native.replace(/\r\n/g,'\n');
  const shellCut='\nrequire_cmd npm\n';assert.equal(shell.split(shellCut).length,2);
  const nativeCut='\nrun_native_release() {';assert.equal(native.split(nativeCut).length,2);
  const prefix=shell.slice(0,shell.indexOf(shellCut));
  const functions=native.slice(0,native.indexOf(nativeCut));
  const anchor='\n  validate_build_artifacts\n  normalize_validated_artifact_modes "$BUILD_DIR"\n  validate_build_artifacts\n';assert.equal(native.split(anchor).length,2);
  let tail=native.slice(native.indexOf(anchor)+1);assert(tail.endsWith('}\n'));
  // Old HTTP cannot become healthy on these exact startup-failure premises.
  // Require a stopped, fully reclaimed old cgroup instead; all candidate,
  // same-database final checks and the atomic exchange remain the normal code.
  tail=replaceOnce(tail,'  wait_for_health "http://${HOST}:${PORT}" native-before-stop 90 2 service',
    '  assert_continuation_old_stopped');
  const pause='  if [ "${RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE:-0}" = 1 ]; then\n    # The code lane already owns this pause from its immutable seed capture.\n    # Preserve it until the stopped window; do not try to install it twice.\n    assert_release_fast_watcher_pause_guard\n  else\n    pause_current_fast_watcher_for_live_prebuild\n  fi';
  tail=replaceOnce(tail,pause,'  assert_continuation_old_stopped');
  tail=replaceOnce(tail,'  start_release_sync_write_barrier\n','  assert_continuation_old_stopped\n  quiesce_native_auxiliary_writers\n  assert_native_cutover_processes_drained\n');
  assert.equal(tail.split('\n  quiesce_native_auxiliary_writers\n').length,3);
  tail=tail.split('\n  quiesce_native_auxiliary_writers\n').join('\n  quiesce_continuation_writers\n');
  // This cold path never starts an HTTP-backed sync barrier: the old service
  // and every football writer are positively stopped instead. Do not demand
  // ownership of an uncreated barrier when leaving candidate or final stages.
  const barrierExit='stop_release_sync_write_barrier clean';
  assert.equal(tail.split(barrierExit).length,3,'two normal barrier exits required');
  tail=tail.split(barrierExit).join('assert_continuation_old_stopped; quiesce_continuation_writers; assert_native_cutover_processes_drained');
  assert(tail.includes('run_trusted_candidate_verifier'));assert(tail.includes('native_data final'));
  assert(tail.includes('native_code_verify_cutover_lease "$CODE_CUTOVER_POST_SWAP_MARGIN_SECONDS"'));
  assert(tail.includes('mv "$APP_DIR" "$BACKUP_DIR"'));assert(tail.includes('mv "$NEXT_DIR" "$APP_DIR"'));
  const setup=`
export PATH=/opt/node-v22.22.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TRUSTED_SOURCE_DIR='${p.sourceDir}'
BUNDLE_SHA256='${p.targetSha256}'
RELEASE_SITE=football-predict
RELEASE_CHANNEL=production
RELEASE_SEQUENCE=${p.targetSequence}
`;
  const initialize=`
PRIMARY_READ_SOURCE=postgres
TRANSACTION_VERSION=4
RECOVERY_ACTIVE=1
NATIVE_CODE_RELEASE=1
NATIVE_RELEASE_KIND=runtime-only
NATIVE_STATE_DIR='/var/lib/football-release/native/${p.targetSha256}'
BUILD_DIR='${p.buildDir}'
BUILD_HOME="${'${BUILD_DIR}'}/.build-home"
CANDIDATE_STORE_DIR="${'${BUILD_DIR}'}/server-data"
CANDIDATE_SQLITE_PATH="${'${CANDIDATE_STORE_DIR}'}/football.db"
CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS=300
CODE_CUTOVER_POST_SWAP_MARGIN_SECONDS=300
CODE_EMERGENCY_ACTIVE=1
CODE_EMERGENCY_AUTHORIZATION="$TRUSTED_SOURCE_DIR/deploy/light-server/code-release-activation-authorization.json"
CANDIDATE_TRANSITION_LEASE="$NATIVE_STATE_DIR/code-transition-lease.json"
PREBUILT_DIST_VALIDATED=1
TIMER_STATE_DIRTY=1
WORKER_STOPPED_FOR_SWAP=1
trap native_exit EXIT
assert_continuation_old_stopped() {
  if systemctl is-active --quiet "$SERVICE_NAME"; then return 1; fi
  if systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then return 1; fi
  wait_for_current_service_cgroup_reclaimed "/system.slice/${'${SERVICE_NAME}'}.service" || return 1
  assert_sync_worker_inactive_for_live_prebuild || return 1
}
quiesce_continuation_writers() {
  local unit state
  for unit in "${'${NATIVE_AUXILIARY_UNITS[@]}'}" football-daily-prematch.service football-read-api-component-6073aafaaf5dae590bfb2b50.service; do
    systemctl stop "$unit" || return 1
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in inactive|failed) ;; *) return 1 ;; esac
  done
  assert_native_cutover_processes_drained || return 1
}
release_stage_observe init "$TRUSTED_SOURCE_DIR"
quiesce_managed_maintenance_for_sqlite_snapshot
stop_worker_for_release_window
systemctl stop "$SERVICE_NAME"
wait_for_current_service_cgroup_reclaimed "/system.slice/${'${SERVICE_NAME}'}.service"
assert_continuation_old_stopped
assert_build_user_quiescent
write_recovery_phase prepared
NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/nativeCodeReleaseDataPlane.cjs" lease-input "$BUNDLE_SHA256"
CODE_CUTOVER_STARTED_SECONDS=$SECONDS
"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseTransitionLease.cjs" create \\
  --current "$NATIVE_STATE_DIR/code-lease-current.json" --lease "$CANDIDATE_TRANSITION_LEASE" \\
  --at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" --verifier-runtime-max-seconds 300 \\
  --preverify-refresh-budget-seconds 570 --atomic-swap-margin-seconds 30 \\
  --emergency-authorization "$CODE_EMERGENCY_AUTHORIZATION" --data-plane code-only
quiesce_continuation_writers
assert_native_cutover_processes_drained
if [ "${p.resumeSeed===true?1:0}" = 1 ]; then
  [ "$(sha256sum "$NATIVE_STATE_DIR/seed-accepted.json" | cut -d' ' -f1)" = "${p.seedReceiptSha256||''}" ]
  if [ "${p.recordedFailedImage?1:0}" = 1 ]; then
    native_materialize_candidate
    seed_candidate_model_artifacts
    candidate_ai_state_status=0
    copy_regular_file_nofollow "$LIVE_STORE_DIR/ai-arena-state.json" "$CANDIDATE_STORE_DIR/ai-arena-state.json" || candidate_ai_state_status="$?"
    [ "$candidate_ai_state_status" = 0 ] || [ "$candidate_ai_state_status" = 2 ]
  fi
else
native_data seed >"$NATIVE_STATE_DIR/recovery-seed.log" 2>&1
native_materialize_candidate
seed_candidate_model_artifacts
candidate_ai_state_status=0
copy_regular_file_nofollow "$LIVE_STORE_DIR/ai-arena-state.json" "$CANDIDATE_STORE_DIR/ai-arena-state.json" || candidate_ai_state_status="$?"
[ "$candidate_ai_state_status" = 0 ] || [ "$candidate_ai_state_status" = 2 ]
fi
chown -hR "$BUILD_USER:$BUILD_USER" "$BUILD_DIR"
NATIVE_CANDIDATE_ENV_FILE="$NATIVE_STATE_DIR/candidate.env"
NATIVE_NEXT_CREATED=1
run_recovery_tail() {
`;
  // The full target source supplies every normal function. The explicit new
  // recovery attempt has its own retained old-clock receipt and fresh lease;
  // it never edits the expired first-attempt lease in place.
  let result=setup+prefix+'\n'+functions+'\n'+initialize+tail+'\nrun_recovery_tail\n';
  if(p.externalAuthorizationVersion){
    const dir=p.sourceDir.slice(0,-7),replacement=`native_data() {\n  NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" '${dir}/engine.cjs' '${dir}' "$TRUSTED_SOURCE_DIR" native "$1" "$BUNDLE_SHA256"\n}`;
    const original=functions.match(/^native_data\(\) \{[\s\S]*?^\}/m);assert(original);result=replaceOnce(result,original[0],replacement);
    result=replaceOnce(result,'CODE_EMERGENCY_AUTHORIZATION="$TRUSTED_SOURCE_DIR/deploy/light-server/code-release-activation-authorization.json"',`CODE_EMERGENCY_AUTHORIZATION='${dir}/code-release-activation-authorization.json'`);
    result=result.split('"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/nativeCodeReleaseDataPlane.cjs"').join(`"$NODE_HOME/bin/node" '${dir}/engine.cjs' '${dir}' "$TRUSTED_SOURCE_DIR" code`);
  }
  return result;
}
module.exports={VERSION,digest,verifySignedBytes,validateAuthorization,validateObservation,renderScript};
