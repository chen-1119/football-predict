#!/usr/bin/env bash
# Sourced only after the normal root entrypoint verified the signed source
# tree. Native dispatch, including its bootstrap identity, is signed policy.

native_data() {
  NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" \
    "$TRUSTED_SOURCE_DIR/scripts/nativeReleaseDataPlane.cjs" "$1" "$BUNDLE_SHA256"
}

native_exit() {
  local status="$?"
  trap - EXIT
  stop_candidate || { log "native failure: candidate could not be stopped; recovery retained"; exit 1; }
  stop_release_candidate_heartbeat_keeper || { log "native failure: heartbeat keeper remains; recovery retained"; exit 1; }
  stop_release_sync_write_barrier || { log "native failure: sync barrier remains; recovery retained"; exit 1; }
  cleanup_release_static_attestations || true
  if [ "${RECOVERY_ACTIVE:-0}" = "1" ]; then
    if [ "${SWAP_STARTED:-0}" != "1" ] && [ "${NATIVE_NEXT_CREATED:-0}" = "1" ]; then
      [ "$NEXT_DIR" = "/opt/football-predict.next" ] && [ ! -L "$NEXT_DIR" ] || exit 1
      rm -rf --one-file-system -- "$NEXT_DIR" || exit 1
    fi
    # The fixed v4 reader observes actual database OIDs, including a committed
    # rename before APP was exchanged. It never restores SQLite/model data.
    "$NODE_HOME/bin/node" /usr/local/libexec/football-release-recovery.cjs || exit 1
  fi
  release_stage_observe finish error
  [ "$status" -ne 0 ] || status=1
  exit "$status"
}

native_materialize_candidate() {
  NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" - "$NATIVE_STATE_DIR/seed-accepted.json" "$CANDIDATE_STORE_DIR" "$BUILD_DIR/public/data" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [proofFile,target,publicDir]=process.argv.slice(2),proof=JSON.parse(fs.readFileSync(proofFile,'utf8'));
assert.equal(proof.ok,true);assert.equal(proof.seed,true);assert.equal(fs.existsSync(target),false);
assert.match(target,/^\/opt\/football-predict\.build-[a-f0-9]{12}-[0-9]+\/server-data$/);
assert.equal(publicDir,path.join(path.dirname(target),'public/data'));
fs.cpSync(proof.store,target,{recursive:true,errorOnExist:true,force:false,dereference:false});
const generation=path.join(proof.store,'data-generations/generations',proof.identity.generationId);
const manifest=JSON.parse(fs.readFileSync(path.join(generation,'manifest.json'),'utf8'));
for(const item of manifest.files){
 assert.ok(typeof item.path==='string'&&!item.path.startsWith('/')&&!item.path.split('/').includes('..'));
 const from=path.join(generation,item.path),to=path.join(publicDir,item.path),st=fs.lstatSync(from);
 assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size===item.bytes);
 if(fs.existsSync(to)){const old=fs.lstatSync(to);assert.ok(old.isFile()&&!old.isSymbolicLink()&&old.nlink===1);}
 fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
}
console.log(JSON.stringify({ok:true,generationId:proof.identity.generationId,sqliteExports:0}));
NODE
}

run_native_release() {
  local prebuilt_status native_seed_log candidate_ai_state_status
  # The core checker reads runtime health and one native publication identity;
  # it has no model/UI suites and is killed if it exceeds five minutes.
  CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS=300
  # This lane refreshes before creating its lease and acquires one subsequent
  # write barrier after stopping the old worker and pausing its HTTP watcher.
  # Reserve 900 seconds for final reconciliation plus the complete post-swap
  # official-cycle/rollback reserve. No old official cycle is awaited here.
  CANDIDATE_PREVERIFY_AND_BARRIER_BUDGET_SECONDS=$((
    ((RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS + 999) / 1000) +
    900 + POST_SWAP_TRANSITION_START_BUDGET_SECONDS - CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS
  ))
  # The early probe runs before the candidate is seeded, installed and built.
  # Reserve that entire preparation interval in addition to the unchanged
  # candidate lease. The candidate still creates a fresh 3,720-second lease
  # after the build and verifies it again immediately before the swap.
  NATIVE_CANDIDATE_PREPARATION_SECONDS=3600
  [ "$APP_DIR" = /opt/football-predict ] && [ "$NEXT_DIR" = /opt/football-predict.next ]
  [ "$BACKUP_DIR" = /opt/football-predict.previous ] && [ "$FAILED_DIR" = /opt/football-predict.failed ]
  export NODE_PATH="$APP_DIR/node_modules"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/validateNativeReleasePolicy.cjs" "$TRUSTED_SOURCE_DIR/deploy/light-server/native-release-policy.json"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseSequencePreflight.cjs"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/verifyDeploymentConfig.cjs"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseWorkerPreflight.cjs"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseTransitionLease.cjs" probe \
    --current "$APP_DIR/public/data/matches-current.json" --at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --verifier-runtime-max-seconds "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" \
    --preverify-refresh-budget-seconds "$((CANDIDATE_PREVERIFY_AND_BARRIER_BUDGET_SECONDS + NATIVE_CANDIDATE_PREPARATION_SECONDS))" \
    --atomic-swap-margin-seconds "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS"
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/verifyCandidateArtifactSeed.cjs"
  rotate_fixed_recovery_helper
  install_fixed_qa_access_operator
  trap native_exit EXIT
  release_stage_observe init "$TRUSTED_SOURCE_DIR"
  wait_for_health "http://${HOST}:${PORT}" native-preflight 90 2 service
  prepare_managed_tree_topology_for_transaction
  NATIVE_STATE_DIR="/var/lib/football-release/native/$BUNDLE_SHA256"
  native_data allocate
  mapfile -t native_state < <("$NODE_HOME/bin/node" -e 'const s=require(process.argv[1]);console.log([s.kind,s.candidateDatabase,s.archiveDatabase].join("\n"))' "$NATIVE_STATE_DIR/state.json")
  [ "${#native_state[@]}" = 3 ]
  NATIVE_RELEASE_KIND="${native_state[0]}"
  NATIVE_CANDIDATE_DATABASE="${native_state[1]}"
  NATIVE_ARCHIVE_DATABASE="${native_state[2]}"
  [ "$NATIVE_RELEASE_KIND" = runtime-only ] || {
    log "signed 013 research migration requires the existing PostgreSQL-only runtime"
    return 1
  }
  if [ "$NATIVE_RELEASE_KIND" = runtime-only ]; then NATIVE_CANDIDATE_DATABASE=-; NATIVE_ARCHIVE_DATABASE=-; fi
  TRANSACTION_VERSION=4
  PRIMARY_READ_SOURCE=postgres
  initialize_release_recovery_snapshot
  ensure_build_user
  assert_build_user_quiescent
  TIMER_STATE_DIRTY=1
  quiesce_managed_maintenance_for_sqlite_snapshot
  release_stage_observe begin candidate-build
  cleanup_build_tree
  install -d -o root -g root -m 0700 "$BUILD_DIR"
  cp -a --no-dereference -- "$TRUSTED_SOURCE_DIR/." "$BUILD_DIR/"
  rm -f -- "$BUILD_DIR/.release-trusted-sha256"
  install -d -o root -g root -m 0700 "$BUILD_DIR/.release-archive-evidence"
  copy_regular_file_nofollow "$BUILD_DIR/public/data/prediction-snapshots.json" "$BUILD_DIR/.release-archive-evidence/prediction-snapshots.json"
  copy_regular_file_nofollow "$BUILD_DIR/public/data/matches-current.json" "$BUILD_DIR/.release-archive-evidence/matches-current.json"
  # Hold a database snapshot through dump, independent restore and full row
  # comparison. The production HTTP process and official worker remain live.
  native_seed_log="$NATIVE_STATE_DIR/seed.log"
  native_data seed >"$native_seed_log" 2>&1
  native_materialize_candidate
  # Candidate reconciliation itself verifies the exact PostgreSQL schema, so
  # migrate the isolated clone before any build role or candidate process runs.
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/deploy/light-server/recommendation-schema-bridge.cjs" candidate "$BUNDLE_SHA256"
  start_release_sync_write_barrier "$APP_DIR"
  stop_worker_for_release_window
  seed_candidate_model_artifacts
  candidate_ai_state_status=0
  copy_regular_file_nofollow "$LIVE_STORE_DIR/ai-arena-state.json" "$CANDIDATE_STORE_DIR/ai-arena-state.json" || candidate_ai_state_status="$?"
  [ "$candidate_ai_state_status" = 0 ] || [ "$candidate_ai_state_status" = 2 ]
  stop_release_sync_write_barrier clean
  restore_live_service_after_candidate_barrier candidate-cache-snapshot
  restart_worker_if_needed
  native_data import-ledgers
  native_data build-access
  NATIVE_BUILD_ENV_FILE="$NATIVE_STATE_DIR/build.env"
  chown -hR "$BUILD_USER:$BUILD_USER" "$BUILD_DIR"
  install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME"
  prebuilt_status=0
  verify_and_normalize_prebuilt_dist || prebuilt_status="$?"
  [ "$prebuilt_status" = 0 ] || [ "$prebuilt_status" = 2 ]
  run_build_step npm-ci env PATH="$PATH" HOME="$BUILD_HOME" npm_config_cache="${BUILD_HOME}/.npm" NODE_ENV=development "$NODE_HOME/bin/npm" ci --include=dev --ignore-scripts
  run_build_step postgres-migration-plan env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production "$NODE_HOME/bin/node" scripts/verifyPostgresMigrationPlan.cjs
  if [ "$PREBUILT_DIST_VALIDATED" != 1 ]; then run_build_step application-build env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production "$NODE_HOME/bin/npm" run build; fi
  run_candidate_model_artifact_catchup "$CANDIDATE_STORE_DIR" "$CANDIDATE_STORE_DIR/retired-sqlite-must-not-open.db"
  run_build_step npm-prune env PATH="$PATH" HOME="$BUILD_HOME" npm_config_cache="${BUILD_HOME}/.npm" NODE_ENV=production "$NODE_HOME/bin/npm" prune --omit=dev --ignore-scripts
  assert_build_user_quiescent
  validate_build_artifacts
  normalize_validated_artifact_modes "$BUILD_DIR"
  validate_build_artifacts
  NATIVE_NEXT_CREATED=1
  assemble_final_tree
  fix_app_permissions "$NEXT_DIR"
  fix_worker_write_permissions "$NEXT_DIR"
  validate_build_artifacts "$NEXT_DIR"
  verify_worker_write_permissions "$NEXT_DIR"
  prepare_release_static_attestations
  run_candidate_refresh_step native-deadline-refresh env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
    SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" PUBLIC_DATA_DIR="$NEXT_DIR/public/data" DATA_GENERATION_PUBLIC_DATA_DIR="$NEXT_DIR/public/data" \
    "$NODE_HOME/bin/node" scripts/captureCandidateProspectiveDeadline.cjs --deadline-only
  fix_app_permissions "$NEXT_DIR"
  # The deadline refresh is followed by root ownership normalization. Restore
  # the service write directories before accepting and exchanging this tree.
  fix_worker_write_permissions "$NEXT_DIR"
  verify_worker_write_permissions "$NEXT_DIR"
  native_data drop-build-access
  native_data candidate-access
  NATIVE_CANDIDATE_ENV_FILE="$NATIVE_STATE_DIR/candidate.env"
  CANDIDATE_ADMIN_TOKEN="release-candidate-admin-$$"
  CANDIDATE_ACCESS_SECRET="release-candidate-secret-$$"
  start_candidate_unit "$NEXT_DIR" env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production HOST="$HOST" PORT="$CANDIDATE_PORT" \
    ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" ACCESS_CODE_SECRET="$CANDIDATE_ACCESS_SECRET" \
    ENABLE_SYNC_CRON=0 ENABLE_GPT_CRON=0 RELAY_FAST_WATCHER_ENABLED=0 SYNC_WORKER_EVENT_BRIDGE=0 \
    WRITE_LEGACY_STATIC_PAYLOADS=0 MIRROR_PUBLISHED_DATA_TO_DIST=0 SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" "$NODE_HOME/bin/node" server/index.cjs
  wait_for_health "http://${HOST}:${CANDIDATE_PORT}" native-candidate 90 2 service
  NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/verifyReleaseArchiveSuccessor.cjs" candidate "$BUNDLE_SHA256" "$CANDIDATE_STORE_DIR"
  "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/releaseTransitionLease.cjs" create --current "$NEXT_DIR/public/data/matches-current.json" \
    --lease "$CANDIDATE_TRANSITION_LEASE" --at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --verifier-runtime-max-seconds "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" --preverify-refresh-budget-seconds "$CANDIDATE_PREVERIFY_AND_BARRIER_BUDGET_SECONDS" \
    --atomic-swap-margin-seconds "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS"
  release_stage_observe end candidate-build ok
  release_stage_observe begin candidate-readiness
  run_trusted_candidate_verifier env PATH="$PATH" HOME="$BUILD_HOME" ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
    VERIFY_STATIC_ATTESTATION_DIR="$RELEASE_STATIC_ATTESTATION_REUSE_DIR" VERIFY_STATIC_RELEASE_SHA="$BUNDLE_SHA256" VERIFY_STATIC_RECEIPT_DIR= \
    WRITE_LEGACY_STATIC_PAYLOADS=0 MIRROR_PUBLISHED_DATA_TO_DIST=0 MODEL_INPUT_AUDIT_MIN_MARKET_ROWS=30 \
    VERIFY_BASE_URL="http://${HOST}:${CANDIDATE_PORT}" VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=0 VERIFY_REQUIRED_READ_SOURCE=postgres \
    SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" "$NODE_HOME/bin/node" scripts/verifyNativeDeploymentCore.cjs
  release_stage_observe end candidate-readiness ok
  stop_candidate
  assert_build_user_quiescent
  native_data drop-candidate-access
  cleanup_build_tree
  snapshot_app_tree_identity "$RECOVERY_DIR" new-app "$NEXT_DIR" /opt/football-predict.next
  write_recovery_phase candidate-validated
  link_runtime_env "$NEXT_DIR"
  HOST_CONFIG_DIRTY=1
  write_recovery_phase host-config-changing
  install_systemd_units "$NEXT_DIR"
  install_nginx_config "$NEXT_DIR"
  systemctl daemon-reload
  write_recovery_phase host-config-applied
  wait_for_health "http://${HOST}:${PORT}" native-before-stop 90 2 service
  quiesce_managed_maintenance_for_sqlite_snapshot
  stop_worker_for_release_window
  pause_current_fast_watcher_for_live_prebuild
  start_release_sync_write_barrier
  stop_service_for_release_window
  quiesce_native_auxiliary_writers
  stop_release_sync_write_barrier clean
  assert_native_cutover_processes_drained
  # All old PostgreSQL writers are stopped. Install the additive 014 schema in
  # the serving database immediately before the new application can start.
  # A durable intent lets cold recovery remove an empty 014 table and its
  # migration row together if this release is rolled back.
  "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/deploy/light-server/recommendation-schema-bridge.cjs" live "$BUNDLE_SHA256"
  "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/candidateReleaseContinuity.cjs" snapshot \
    --revision-transition "$NEXT_DIR/deploy/light-server/candidate-revision-transition.json" \
    --registry "$LIVE_STORE_DIR/model-artifacts/candidate-prospective-registry.json" --output "$RECOVERY_DIR/candidate-release-continuity-before.json" \
    --bundle-sha256 "$BUNDLE_SHA256" --release-sequence "$RELEASE_SEQUENCE"
  release_stage_observe begin stopped-window
  native_data final
  "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/releaseTransitionLease.cjs" verify --current "$NEXT_DIR/public/data/matches-current.json" \
    --lease "$CANDIDATE_TRANSITION_LEASE" --at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" --required-margin-seconds "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS"
  RUNTIME_ENV_DIRTY=1
  install -o root -g football -m 0640 "$RECOVERY_DIR/native-mode/runtime-env/env" "$RUNTIME_ENV_FILE"
  sync -f "$RUNTIME_ENV_FILE"
  write_recovery_phase swap-starting
  SWAP_STARTED=1
  mv "$APP_DIR" "$BACKUP_DIR"
  mv "$NEXT_DIR" "$APP_DIR"
  write_recovery_phase swap-complete
  printf '%s\n' "$BUNDLE_SHA256" >"$APP_DIR/.release-bundle-sha256.next"
  chown root:root "$APP_DIR/.release-bundle-sha256.next"
  chmod 0644 "$APP_DIR/.release-bundle-sha256.next"
  mv "$APP_DIR/.release-bundle-sha256.next" "$APP_DIR/.release-bundle-sha256"
  cd "$APP_DIR"
  sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR" store-only
  verify_worker_write_permissions "$APP_DIR"
  restart_service_if_needed
  wait_for_health "http://${HOST}:${PORT}" native-post-swap 120 2 service
  release_stage_observe end stopped-window ok
  native_finish_readiness
}

native_finish_readiness() {
  if ! prepare_release_enrichment_reuse_request; then
    log "native enrichment reuse unavailable; full enrichment remains required"
    clear_release_enrichment_reuse_request
  fi
  prepare_release_worker_priority_request
  WORKER_RELEASE_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  start_worker_for_live_release
  release_stage_observe begin worker-official-wait
  wait_for_worker_official_publish_after "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"
  release_stage_observe end worker-official-wait ok
  release_stage_observe begin worker-enrichment-wait
  wait_for_worker_readiness_idle_after "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"
  release_stage_observe end worker-enrichment-wait ok
  systemctl restart "$SERVICE_NAME"
  wait_for_health "http://${HOST}:${PORT}" native-post-worker 180 2 service
  refresh_candidate_capture_heartbeat_for_readiness "$APP_DIR" "$APP_DIR"
  freeze_worker_for_readiness "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"
  wait_for_frozen_worker_children_to_drain "$WORKER_FROZEN_MAIN_PID"
  start_release_candidate_heartbeat_keeper
  clear_release_worker_priority_request
  clear_release_enrichment_reuse_request
  release_stage_observe begin post-swap-readiness
  run_as_service_user_with_runtime_env env VERIFY_BASE_URL="http://${HOST}:${PORT}" \
    VERIFY_STATIC_ATTESTATION_DIR="$RELEASE_STATIC_ATTESTATION_REUSE_DIR" VERIFY_STATIC_RELEASE_SHA="$BUNDLE_SHA256" VERIFY_STATIC_RECEIPT_DIR= \
    VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=0 VERIFY_REQUIRED_READ_SOURCE=postgres SERVER_STORE_DIR="$LIVE_STORE_DIR" \
    "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyNativeDeploymentCore.cjs"
  NODE_PATH="$APP_DIR/node_modules" "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyReleaseArchiveSuccessor.cjs" live "$BUNDLE_SHA256"
  release_stage_observe end post-swap-readiness ok
  wait_for_release_candidate_heartbeat_keeper_healthy
  "$NODE_HOME/bin/node" "$APP_DIR/scripts/candidateReleaseContinuity.cjs" verify \
    --revision-transition "$APP_DIR/deploy/light-server/candidate-revision-transition.json" \
    --registry "$LIVE_STORE_DIR/model-artifacts/candidate-prospective-registry.json" \
    --snapshot "$RECOVERY_DIR/candidate-release-continuity-before.json" --output "$RECOVERY_DIR/candidate-release-continuity-after.json" \
    --bundle-sha256 "$BUNDLE_SHA256" --release-sequence "$RELEASE_SEQUENCE"
  install -o root -g root -m 0644 "$RECOVERY_DIR/candidate-release-continuity-after.json" "$APP_DIR/.release-candidate-continuity.json"
  sync -f "$APP_DIR/.release-candidate-continuity.json"
  wait_for_release_candidate_heartbeat_public_budget
  if [ -n "$PUBLIC_BASE_URL" ]; then
    run_as_service_user_with_runtime_env env REMOTE_BASE_URL="$PUBLIC_BASE_URL" REMOTE_REQUIRE_HEALTHY=0 \
      REMOTE_REQUIRE_SQLITE=0 REMOTE_REQUIRE_POSTGRES_ONLY=1 REMOTE_REQUIRED_READ_SOURCE=postgres REMOTE_REQUIRE_SYNC_WORKER=0 \
      "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyRemotePublicReadiness.cjs"
  fi
  wait_for_release_candidate_heartbeat_keeper_healthy
  stop_release_candidate_heartbeat_keeper clean
  resume_worker_after_readiness
  if [ -n "$PUBLIC_BASE_URL" ]; then
    run_as_service_user_with_runtime_env env REMOTE_BASE_URL="$PUBLIC_BASE_URL" REMOTE_REQUIRE_HEALTHY=0 \
      REMOTE_REQUIRE_SQLITE=0 REMOTE_REQUIRE_POSTGRES_ONLY=1 REMOTE_REQUIRED_READ_SOURCE=postgres REMOTE_REQUIRE_SYNC_WORKER=1 \
      "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyRemotePublicReadiness.cjs"
  fi
  release_stage_observe begin finalization
  write_recovery_phase readiness-passed
  restore_native_auxiliary_states_after_readiness
  enable_managed_timers_after_readiness
  printf '%s\n' "$BUNDLE_SHA256" >"$APP_DIR/.release-live-complete.next"
  chown root:root "$APP_DIR/.release-live-complete.next"
  chmod 0644 "$APP_DIR/.release-live-complete.next"
  mv "$APP_DIR/.release-live-complete.next" "$APP_DIR/.release-live-complete"
  sync -f "$APP_DIR/.release-live-complete"
  sync -f "$APP_DIR"
  commit_release_transaction
  clear_release_recovery_snapshot
  release_stage_observe end finalization ok
  release_stage_observe finish ok
  trap - EXIT
  cleanup_release_static_attestations
  log "native full release accepted: $BUNDLE_SHA256"
}
