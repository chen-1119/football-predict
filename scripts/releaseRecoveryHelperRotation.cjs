const FIXED_RECOVERY_HELPER_ROTATION_CONTRACT = "football-fixed-recovery-helper-rotation-v1";
const FIXED_RECOVERY_HELPER_ROTATION_SOURCE = "deploy/light-server/football-release-recovery.cjs";
const FIXED_RECOVERY_HELPER_ROTATION_TARGET = "/usr/local/libexec/football-release-recovery.cjs";
const RELEASE_SHELL_ENTRY = "deploy/light-server/release-from-bundle.sh";

const exactDeclarations = Object.freeze([
  `readonly FIXED_RECOVERY_HELPER_ROTATION_CONTRACT="${FIXED_RECOVERY_HELPER_ROTATION_CONTRACT}"`,
  `readonly FIXED_RECOVERY_HELPER_ROTATION_SOURCE="${FIXED_RECOVERY_HELPER_ROTATION_SOURCE}"`,
  `readonly FIXED_RECOVERY_HELPER_ROTATION_TARGET="${FIXED_RECOVERY_HELPER_ROTATION_TARGET}"`
]);

const requiredImplementationTokens = Object.freeze([
  "rotate_fixed_recovery_helper() (",
  'source_path="${TRUSTED_SOURCE_DIR}/${FIXED_RECOVERY_HELPER_ROTATION_SOURCE}"',
  'target_parent="$(dirname "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")"',
  'source_real="$(realpath -e -- "$source_path")"',
  '"$(stat -c \'%u:%g:%a:%h\' -- "$source_path")" = "0:0:600:1"',
  '"$NODE_HOME/bin/node" --check "$source_path"',
  '"$(stat -c \'%u:%g:%a:%h\' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")" = "0:0:644:1"',
  '"$NODE_HOME/bin/node" --check "$FIXED_RECOVERY_HELPER_ROTATION_TARGET"',
  'temporary="$(mktemp "${target_parent}/.football-release-recovery.rotate.XXXXXX.cjs")"',
  'install -o root -g root -m 0644 -- "$source_path" "$temporary"',
  'sync -f "$temporary"',
  'mv -fT -- "$temporary" "$FIXED_RECOVERY_HELPER_ROTATION_TARGET"',
  'sync -f "$target_parent"',
  'current_target_token="$(stat -c',
  'fixed recovery helper target changed during rotation',
  'recovery transaction appeared before fixed helper rotation',
  'recovery transaction appeared during fixed helper rotation',
  'fixed recovery helper rotation committed; application release not started'
]);

const countExactLine = (lines, expected) => lines.filter((line) => line.trim() === expected).length;

function parseFixedRecoveryHelperRotationContract(input) {
  let text;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "release-shell-not-valid-utf8" };
  }

  const lines = text.split(/\r?\n/);
  const declarationPrefixes = [
    "FIXED_RECOVERY_HELPER_ROTATION_CONTRACT",
    "FIXED_RECOVERY_HELPER_ROTATION_SOURCE",
    "FIXED_RECOVERY_HELPER_ROTATION_TARGET"
  ];
  const declarationDiagnostics = exactDeclarations.map((expected, index) => {
    const prefix = declarationPrefixes[index];
    const assignmentLike = lines.filter((line) => (
      line.trim().startsWith(`${prefix}=`)
      || line.trim().startsWith(`readonly ${prefix}=`)
    ));
    return {
      prefix,
      exactCount: countExactLine(lines, expected),
      assignmentCount: assignmentLike.length,
      exact: assignmentLike.length === 1 && assignmentLike[0].trim() === expected
    };
  });
  const declarationsOk = declarationDiagnostics.every((row) => row.exact);
  const missingImplementationTokens = requiredImplementationTokens.filter((token) => !text.includes(token));
  const definitionCount = countExactLine(lines, "rotate_fixed_recovery_helper() (");
  const callCount = countExactLine(lines, "rotate_fixed_recovery_helper \\");
  const treeValidationIndex = text.indexOf("trusted source tree failed owner, mode, type, or hard-link validation");
  const configValidationIndex = text.indexOf('node "$TRUSTED_SOURCE_DIR/scripts/verifyDeploymentConfig.cjs"');
  const rotationCallIndex = text.indexOf("\nrotate_fixed_recovery_helper \\");
  const tlsActionIndex = text.indexOf(
    '\nTLS_ACTION_DIR="${TRUSTED_SOURCE_DIR}/.release-actions"',
    rotationCallIndex + 1
  );
  const trapIndex = text.indexOf("\ntrap release_exit_trap EXIT", tlsActionIndex + 1);
  const topologyIndex = text.indexOf(
    "\nprepare_managed_tree_topology_for_transaction",
    trapIndex + 1
  );
  const recoverySnapshotIndex = text.indexOf(
    "\ninitialize_release_recovery_snapshot",
    topologyIndex + 1
  );
  const runtimeEnvIndex = text.indexOf("\nprepare_runtime_env ", recoverySnapshotIndex + 1);
  const stopWorkerIndex = text.indexOf("\nstop_worker_for_release_window", runtimeEnvIndex + 1);
  const orderIndexes = [
    treeValidationIndex,
    configValidationIndex,
    rotationCallIndex,
    tlsActionIndex,
    trapIndex,
    topologyIndex,
    recoverySnapshotIndex,
    runtimeEnvIndex,
    stopWorkerIndex
  ];
  const orderingOk = orderIndexes.every((index) => index >= 0)
    && orderIndexes.every((index, position) => position === 0 || orderIndexes[position - 1] < index);

  const ok = declarationsOk
    && missingImplementationTokens.length === 0
    && definitionCount === 1
    && callCount === 1
    && orderingOk;
  return {
    ok,
    contract: declarationsOk ? FIXED_RECOVERY_HELPER_ROTATION_CONTRACT : null,
    source: declarationsOk ? FIXED_RECOVERY_HELPER_ROTATION_SOURCE : null,
    target: declarationsOk ? FIXED_RECOVERY_HELPER_ROTATION_TARGET : null,
    declarationDiagnostics,
    missingImplementationTokens,
    definitionCount,
    callCount,
    orderingOk,
    orderIndexes
  };
}

module.exports = {
  FIXED_RECOVERY_HELPER_ROTATION_CONTRACT,
  FIXED_RECOVERY_HELPER_ROTATION_SOURCE,
  FIXED_RECOVERY_HELPER_ROTATION_TARGET,
  RELEASE_SHELL_ENTRY,
  parseFixedRecoveryHelperRotationContract
};
