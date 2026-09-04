const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const releaseShellPath = path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh");
const deployClientPath = path.join(rootDir, "scripts", "deployReleaseBundle.cjs");
const releaseStatusPath = path.join(rootDir, "scripts", "checkReleaseStatus.cjs");
const contractModulePath = path.join(rootDir, "scripts", "releaseRecoveryHelperRotation.cjs");

const CONTRACT = Object.freeze({
  contract: 'readonly FIXED_RECOVERY_HELPER_ROTATION_CONTRACT="football-fixed-recovery-helper-rotation-v1"',
  source: 'readonly FIXED_RECOVERY_HELPER_ROTATION_SOURCE="deploy/light-server/football-release-recovery.cjs"',
  target: 'readonly FIXED_RECOVERY_HELPER_ROTATION_TARGET="/usr/local/libexec/football-release-recovery.cjs"'
});

const CONTRACT_NAMES = Object.freeze([
  "FIXED_RECOVERY_HELPER_ROTATION_CONTRACT",
  "FIXED_RECOVERY_HELPER_ROTATION_SOURCE",
  "FIXED_RECOVERY_HELPER_ROTATION_TARGET"
]);

const checks = [];

function check(name, callback) {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function countOccurrences(source, token) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = source.indexOf(token, cursor);
    if (found < 0) return count;
    count += 1;
    cursor = found + token.length;
  }
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function assertBefore(source, earlier, later, label) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `${label}: missing earlier token: ${earlier}`);
  assert.notEqual(laterIndex, -1, `${label}: missing later token: ${later}`);
  assert.ok(earlierIndex < laterIndex, `${label}: expected ${earlier} before ${later}`);
}

function bashSubshellFunctionBody(source, functionName) {
  const declaration = `${functionName}() (`;
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing Bash function ${functionName}`);
  assert.equal(source.indexOf(declaration, start + declaration.length), -1, `duplicate Bash function ${functionName}`);
  const bodyStart = start + declaration.length;
  const endMatch = /\r?\n\)\r?\n/g;
  endMatch.lastIndex = bodyStart;
  const match = endMatch.exec(source);
  assert.ok(match, `unterminated Bash function ${functionName}`);
  return source.slice(bodyStart, match.index);
}

function assertContractRejected(parseContract, name, text) {
  const parsed = parseContract(text);
  assert.equal(parsed?.ok, false, `${name}: malformed contract was accepted`);
}

for (const filePath of [releaseShellPath, deployClientPath, releaseStatusPath, contractModulePath]) {
  assert.ok(fs.existsSync(filePath), `required file is missing: ${filePath}`);
}

const releaseShell = fs.readFileSync(releaseShellPath, "utf8");
const deployClient = fs.readFileSync(deployClientPath, "utf8");
const releaseStatus = fs.readFileSync(releaseStatusPath, "utf8");
const {
  FIXED_RECOVERY_HELPER_ROTATION_CONTRACT,
  FIXED_RECOVERY_HELPER_ROTATION_SOURCE,
  FIXED_RECOVERY_HELPER_ROTATION_TARGET,
  RELEASE_SHELL_ENTRY,
  parseFixedRecoveryHelperRotationContract
} = require(contractModulePath);

assert.equal(
  typeof parseFixedRecoveryHelperRotationContract,
  "function",
  "releaseRecoveryHelperRotation.cjs must export parseFixedRecoveryHelperRotationContract(text)"
);

check("the signed release shell declares exactly one canonical v1 rotation contract", () => {
  const parsed = parseFixedRecoveryHelperRotationContract(releaseShell);
  assert.equal(parsed?.ok, true, `actual signed release shell contract rejected: ${JSON.stringify(parsed)}`);
  for (const expectedLine of Object.values(CONTRACT)) {
    assert.equal(countOccurrences(releaseShell, expectedLine), 1, `expected exactly one declaration: ${expectedLine}`);
  }
  for (const name of CONTRACT_NAMES) {
    const assignments = countMatches(
      releaseShell,
      new RegExp(`^\\s*(?:readonly\\s+)?${name}=.*$`, "gm")
    );
    assert.equal(assignments, 1, `expected one and only one assignment for ${name}`);
  }
});

check("the contract parser rejects absence, unknown versions, duplicates, and malformed declarations", () => {
  const valid = releaseShell;
  assert.equal(parseFixedRecoveryHelperRotationContract(valid)?.ok, true, "actual canonical signed shell must be accepted");

  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "no contract",
    "#!/usr/bin/env bash\nset -euo pipefail\n"
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "unknown version",
    valid.replace("football-fixed-recovery-helper-rotation-v1", "football-fixed-recovery-helper-rotation-v2")
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "duplicate contract declaration",
    `${valid}${CONTRACT.contract}\n`
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "duplicate source declaration",
    `${valid}${CONTRACT.source}\n`
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "duplicate target declaration",
    `${valid}${CONTRACT.target}\n`
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "single quoted version",
    valid.replace(CONTRACT.contract, "readonly FIXED_RECOVERY_HELPER_ROTATION_CONTRACT='football-fixed-recovery-helper-rotation-v1'")
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "non-readonly declaration",
    valid.replace(CONTRACT.source, 'FIXED_RECOVERY_HELPER_ROTATION_SOURCE="deploy/light-server/football-release-recovery.cjs"')
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "path traversal source",
    valid.replace("deploy/light-server/football-release-recovery.cjs", "../football-release-recovery.cjs")
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "alternate target",
    valid.replace("/usr/local/libexec/football-release-recovery.cjs", "/tmp/football-release-recovery.cjs")
  );
  assertContractRejected(
    parseFixedRecoveryHelperRotationContract,
    "trailing shell payload",
    valid.replace(CONTRACT.target, `${CONTRACT.target}; touch /tmp/unsafe`)
  );
});

check("rotation is called once after signed-source validation and before every host mutation", () => {
  assert.equal(countMatches(releaseShell, /^rotate_fixed_recovery_helper\(\) \($/gm), 1, "rotation function must be defined exactly once");
  const callMatches = [...releaseShell.matchAll(/^rotate_fixed_recovery_helper \\$/gm)];
  assert.equal(callMatches.length, 1, "rotation function must have one standalone main-flow call");
  const callIndex = callMatches[0].index;
  const configVerificationIndex = releaseShell.indexOf('node "$TRUSTED_SOURCE_DIR/scripts/verifyDeploymentConfig.cjs"');
  assert.ok(configVerificationIndex >= 0 && configVerificationIndex < callIndex, "rotation must follow trusted deployment config verification");

  for (const mutationToken of [
    'TLS_ACTION_DIR="${TRUSTED_SOURCE_DIR}/.release-actions"',
    "trap release_exit_trap EXIT",
    "prepare_managed_tree_topology_for_transaction",
    "initialize_release_recovery_snapshot",
    'prepare_runtime_env "$TRUSTED_SOURCE_DIR/deploy/light-server/env.example"'
  ]) {
    const mutationIndex = releaseShell.indexOf(mutationToken, callIndex);
    assert.notEqual(mutationIndex, -1, `missing post-rotation main-flow token: ${mutationToken}`);
    assert.ok(callIndex < mutationIndex, `rotation must precede: ${mutationToken}`);
  }

  const workerStopIndex = releaseShell.indexOf("stop_worker_for_release_window", callIndex);
  assert.notEqual(workerStopIndex, -1, "main flow must still contain worker stop operation");
  assert.ok(callIndex < workerStopIndex, "rotation must precede the first subsequent worker stop");
});

check("rotation uses the signed fixed source and a root-owned single-link 0644 target", () => {
  const body = bashSubshellFunctionBody(releaseShell, "rotate_fixed_recovery_helper");
  assert.match(body, /TRUSTED_SOURCE_DIR[^\n]*FIXED_RECOVERY_HELPER_ROTATION_SOURCE|FIXED_RECOVERY_HELPER_ROTATION_SOURCE[^\n]*TRUSTED_SOURCE_DIR/);
  assert.match(body, /FIXED_RECOVERY_HELPER_ROTATION_TARGET/);
  assert.match(body, /RECOVERY_DIR/);
  assert.match(body, /\[ -e "\$RECOVERY_DIR" \] \|\| \[ -L "\$RECOVERY_DIR" \]/);
  assert.match(body, /realpath -e/);
  assert.match(body, /! -L/);
  assert.match(body, /stat -c ['"]%u:%g:%a:%h['"]/);
  assert.ok(countOccurrences(body, "0:0:600:1") >= 1, "signed source must remain root:root 0600 with one hard link");
  assert.ok(countOccurrences(body, "0:0:644:1") >= 2, "temporary and installed targets must be root:root 0644 with one hard link");
  assert.ok(countMatches(body, /--check/g) >= 2, "candidate and installed helper syntax must both be checked");
  assert.ok(countMatches(body, /sha256sum/g) >= 3, "source, temporary, and installed helper hashes must be checked");
});

check("rotation performs same-directory install, fsync, atomic rename, directory fsync, and postcheck", () => {
  const body = bashSubshellFunctionBody(releaseShell, "rotate_fixed_recovery_helper");
  const mktempIndex = body.indexOf("mktemp");
  const installIndex = body.indexOf("install -o root -g root -m 0644");
  const fileSyncIndex = body.indexOf("sync -f", installIndex);
  const renameIndex = body.indexOf("mv -fT --", fileSyncIndex);
  const directorySyncIndex = body.indexOf("sync -f", renameIndex);
  assert.ok(mktempIndex >= 0, "rotation must allocate a temporary file");
  assert.match(body.slice(mktempIndex, body.indexOf("\n", mktempIndex)), /target_dir|target_parent/, "temporary file must be created in the target directory");
  assert.match(body.slice(mktempIndex, body.indexOf("\n", mktempIndex)), /XXXXXX\.cjs/, "temporary helper must retain a .cjs suffix for Node syntax validation");
  assert.ok(installIndex > mktempIndex, "root-owned 0644 install must follow same-directory mktemp");
  assert.ok(fileSyncIndex > installIndex, "temporary file must be fsynced before rename");
  assert.ok(renameIndex > fileSyncIndex, "atomic mv -fT must follow temporary file fsync");
  assert.ok(directorySyncIndex > renameIndex, "target directory must be fsynced after rename");
  assert.match(body.slice(renameIndex), /stat -c ['"]%u:%g:%a:%h['"]/, "installed target metadata must be checked after rename");
  assert.match(body.slice(renameIndex), /sha256sum/, "installed target digest must be checked after rename");
  assert.match(body.slice(renameIndex), /--check/, "installed target syntax must be checked after rename");
  assert.match(body, /rm -f --/, "temporary file must have an explicit cleanup path");
  assert.doesNotMatch(body, /\bcp\b[^\n]*FIXED_RECOVERY_HELPER_ROTATION_TARGET/, "fixed helper replacement must not use a non-atomic direct copy");
});

check("the same-directory temporary helper keeps a Node-recognized CommonJS suffix", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-recovery-helper-"));
  const temporaryHelper = path.join(temporaryRoot, ".football-release-recovery.rotate.fixture.cjs");
  try {
    fs.copyFileSync(path.join(rootDir, FIXED_RECOVERY_HELPER_ROTATION_SOURCE), temporaryHelper);
    const syntax = spawnSync(process.execPath, ["--check", temporaryHelper], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout || "temporary helper syntax check failed");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

check("deploy client derives rotation permission only from the inspected signed tgz entry", () => {
  assert.equal(FIXED_RECOVERY_HELPER_ROTATION_CONTRACT, "football-fixed-recovery-helper-rotation-v1");
  assert.equal(FIXED_RECOVERY_HELPER_ROTATION_SOURCE, "deploy/light-server/football-release-recovery.cjs");
  assert.equal(FIXED_RECOVERY_HELPER_ROTATION_TARGET, "/usr/local/libexec/football-release-recovery.cjs");
  assert.equal(RELEASE_SHELL_ENTRY, "deploy/light-server/release-from-bundle.sh");
  assert.match(deployClient, /require\(["']\.\/releaseRecoveryHelperRotation\.cjs["']\)/);
  assert.match(deployClient, /parseFixedRecoveryHelperRotationContract/);
  assert.match(deployClient, /RELEASE_SHELL_ENTRY/);
  assert.match(deployClient, /tar/);
  assert.match(deployClient, /-xOzf/);
  assert.match(deployClient, /bundlePath/);
  assert.doesNotMatch(
    deployClient,
    /readFileSync\([^\n]*deploy[\\/]light-server[\\/]release-from-bundle\.sh/,
    "workspace release shell must never authorize a remote helper mismatch"
  );

  const signatureIndex = deployClient.indexOf("verifyManifestSignature");
  const hashValidationIndex = deployClient.indexOf("actualSha256 !== sidecarSha256");
  const manifestOkIndex = deployClient.indexOf("manifest.ok !== true");
  const parseCalls = [...deployClient.matchAll(/parseFixedRecoveryHelperRotationContract\s*\(/g)];
  assert.ok(parseCalls.length >= 1, "deploy client must parse the extracted signed release shell contract");
  const parseIndex = parseCalls.at(-1).index;
  assert.ok(signatureIndex >= 0 && signatureIndex < parseIndex, "signature verification must precede contract authorization");
  assert.ok(hashValidationIndex >= 0 && hashValidationIndex < parseIndex, "bundle/sidecar/manifest hash equality must precede contract authorization");
  assert.ok(manifestOkIndex >= 0 && manifestOkIndex < parseIndex, "manifest ok validation must precede contract authorization");
});

check("remote mismatch allowance keeps wrapper, key, recovery, and application preflights mandatory", () => {
  const start = deployClient.indexOf("const buildRemotePreflightCommand");
  const end = deployClient.indexOf('].join("; ");', start);
  assert.ok(start >= 0 && end > start, "remote preflight command builder is missing");
  const preflightBody = deployClient.slice(start, end);
  assert.match(preflightBody, /rotationContractReady/);
  assert.match(preflightBody, /release-recovery-helper-mismatch/);
  assert.match(preflightBody, /sudo -n/);
  assert.match(preflightBody, /--check/);
  assert.match(preflightBody, /recoveryPending=0/);
  assert.match(preflightBody, /appPresent=1/);
  assert.match(preflightBody, /preflight-ok/);
  assertBefore(preflightBody, "entrypoint_check", "release-recovery-helper-mismatch", "remote wrapper check before mismatch allowance");

  assert.match(deployClient, /remoteTrustedKeyMatches/);
  assert.match(deployClient, /remoteRecoveryHelperMatches/);
  assert.match(deployClient, /recoveryHelperRotationContract/);
  assert.match(deployClient, /remoteRecoveryHelperRotationRequired/);
  assert.match(
    deployClient,
    /remoteRecoveryHelperMatches\s*\|\|\s*\(recoveryHelperRotationContract\.ok === true && remoteRecoveryHelperRotationRequired\)/,
    "preflight may accept mismatch only through the validated contract flag"
  );
});

check("successful deployment requires the installed fixed helper to match the bundle helper", () => {
  assert.match(deployClient, /release-recovery-helper-postcheck-mismatch/);
  const releaseCommandIndex = deployClient.indexOf("const releaseCommand");
  const finalOkIndex = deployClient.indexOf("const ok = steps.every", releaseCommandIndex);
  assert.ok(releaseCommandIndex >= 0 && finalOkIndex > releaseCommandIndex, "release completion flow is missing");
  const completionFlow = deployClient.slice(releaseCommandIndex, finalOkIndex);
  assert.match(completionFlow, /sha256sum/);
  assert.match(completionFlow, /expectedRecoveryHelperSha256/);
  assert.match(completionFlow, /remoteRecoveryHelperPath/);
});

check("release status permits only a signed fixed-helper rotation for deploy preflight", () => {
  assert.match(releaseStatus, /require\(["']\.\/releaseRecoveryHelperRotation\.cjs["']\)/);
  assert.match(releaseStatus, /inspectBundleEntryBytes\(bundlePath, RELEASE_SHELL_ENTRY\)/);
  assert.match(releaseStatus, /parseFixedRecoveryHelperRotationContract\(releaseShellInspection\.bytes\)/);
  assert.match(releaseStatus, /rotationRequired = !matchesCandidate && rotationContract\?\.ok === true/);
  assert.match(releaseStatus, /remoteRecoveryHelper\.acceptableForDeploy === true/);
  assert.match(releaseStatus, /remoteRecoveryHelper\.ok[\s\S]{0,240}remoteRelease\.committed/);
});

const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  version: "recovery-helper-rotation-verification-v1",
  checks: checks.map((entry) => ({
    name: entry.name,
    ok: entry.ok,
    ...(entry.error ? { error: entry.error } : {})
  }))
}, null, 2));

if (failed.length > 0) process.exit(1);
