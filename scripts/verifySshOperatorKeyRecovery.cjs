const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const recoveryPath = path.join(rootDir, "deploy", "light-server", "restore-ubuntu-operator-key.sh");
const offlineKitPath = path.join(rootDir, "scripts", "createOfflineReleaseKit.cjs");
const deploymentDocPath = path.join(rootDir, "docs", "light-server-deployment.md");

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const recovery = readText(recoveryPath);
const offlineKit = readText(offlineKitPath);
const deploymentDoc = readText(deploymentDocPath);
const checks = [];

const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));

push("recovery entrypoint is fixed to the ubuntu operator key", hasAll(recovery, [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "umask 077",
  'readonly TARGET_USER="ubuntu"',
  'readonly KEY_SOURCE="/tmp/football-operator.pub"',
  'must run as root from the cloud console'
]));

push("input is one bounded non-symlink ssh-rsa public key", hasAll(recovery, [
  '[ -f "$KEY_SOURCE" ] && [ ! -L "$KEY_SOURCE" ]',
  "must have exactly one hard link",
  "key_source_bytes > 0 && key_source_bytes <= 16384",
  'mapfile -t key_lines <"$KEY_SOURCE"',
  '"${#key_lines[@]}" -eq 1',
  "^ssh-rsa[[:space:]][A-Za-z0-9+/]+={0,2}",
  "input must be one OpenSSH ssh-rsa public-key line"
]));

push("RSA identity is cryptographically parsed and optionally pinned", hasAll(recovery, [
  'FOOTBALL_OPERATOR_KEY_FINGERPRINT',
  'ssh-keygen -l -E sha256 -f "$key_check"',
  "key_bits >= 2048",
  "^SHA256:[A-Za-z0-9+/]{43}$",
  'actual_fingerprint" = "$EXPECTED_FINGERPRINT',
  "public-key fingerprint does not match"
]));

push("target paths reject links and unsafe account resolution", hasAll(recovery, [
  'getent passwd "$TARGET_USER"',
  'target_home" = /*',
  'target_home" != "/"',
  '[ -d "$target_home" ] && [ ! -L "$target_home" ]',
  '[ -d "$ssh_dir" ] && [ ! -L "$ssh_dir" ]',
  '[ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ]',
  '"$(stat -c \'%h\' -- "$authorized_keys")" = "1"'
]));

push("authorized_keys update is permissioned, deduplicated, and atomic", hasAll(recovery, [
  'install -d -o "$TARGET_USER" -g "$target_group" -m 0700 -- "$ssh_dir"',
  'mktemp "${ssh_dir}/.authorized_keys.XXXXXX"',
  'wanted_blob="$key_blob"',
  '$field == "ssh-rsa" && $(field + 1) == wanted_blob',
  'printf \'%s\\n\' "$key_line" >>"$authorized_tmp"',
  'chown "$TARGET_USER:$target_group" "$authorized_tmp"',
  'chmod 0600 "$authorized_tmp"',
  'sync -f "$authorized_tmp"',
  'mv -fT -- "$authorized_tmp" "$authorized_keys"',
  'sync -f "$ssh_dir"',
  '600:1'
]));

const sshdValidationCount = (recovery.match(/\/usr\/sbin\/sshd -t/g) || []).length;
push("sshd configuration is validated before and after key repair", sshdValidationCount >= 2, {
  sshdValidationCount
});

const forbiddenMutations = [
  /\/etc\/ssh\/sshd_config/,
  /systemctl\s+(restart|reload)\s+ssh/,
  /\bufw\b/,
  /PasswordAuthentication/,
  /passwd\s+ubuntu/,
  /usermod/,
  /chpasswd/
];
push("recovery does not loosen ssh, firewall, or password policy",
  forbiddenMutations.every((pattern) => !pattern.test(recovery)), {
    matched: forbiddenMutations.filter((pattern) => pattern.test(recovery)).map(String)
  });

const embeddedKeyPatterns = [
  /-----BEGIN (?:OPENSSH |RSA )?PRIVATE KEY-----/,
  /ssh-rsa\s+AAAA[0-9A-Za-z+/]{40,}/,
  /ssh-ed25519\s+AAAA[0-9A-Za-z+/]{20,}/
];
push("recovery entrypoint embeds no operator key material",
  embeddedKeyPatterns.every((pattern) => !pattern.test(recovery)), {
    matched: embeddedKeyPatterns.filter((pattern) => pattern.test(recovery)).map(String)
  });

push("offline kit carries the recovery program but never the operator key", hasAll(offlineKit, [
  'restore-ubuntu-operator-key.sh',
  'restoreKeyScriptPath',
  'restoreKeyFromBundle',
  'bundledRestoreKeySha256',
  'localRestoreKeySha256',
  'fs.writeFileSync(path.join(kitDir, restoreKeyScriptName), restoreKeyFromBundle.stdout',
  'signed manifest does not match the uploaded bundle',
  'tar -xOzf ${bundleName} ./${restoreKeyBundleEntry} | cmp - ${restoreKeyScriptName}',
  '/tmp/football-operator.pub',
  'FOOTBALL_OPERATOR_KEY_FINGERPRINT',
  'does not contain an operator public or private key'
])
  && !offlineKit.includes("football_server_ed25519.pub")
  && !offlineKit.includes('path.join(tmpDir, "football.pem")'));

push("deployment runbook documents narrow console recovery", hasAll(deploymentDoc, [
  "restore-ubuntu-operator-key.sh",
  "/tmp/football-operator.pub",
  "FOOTBALL_OPERATOR_KEY_FINGERPRINT",
  "does not modify sshd configuration",
  "firewall rules, or password authentication",
  "does not contain an operator key"
]));

const bashProbe = spawnSync("bash", ["-n", recoveryPath], {
  cwd: rootDir,
  encoding: "utf8"
});
// Windows may expose a Microsoft Store execution alias named bash.exe even
// when no WSL distribution or real shell is installed. That alias exits 1
// without stdout/stderr, so it cannot perform a syntax check and is equivalent
// to bash being unavailable. A real parser error still has diagnostic output
// and continues to fail this verifier.
const windowsExecutionAliasUnavailable = process.platform === "win32"
  && bashProbe.status !== 0
  && !bashProbe.error
  && !String(bashProbe.stderr || "").trim();
const bashDiagnostic = `${bashProbe.stdout || ""}\n${bashProbe.stderr || ""}`
  .replace(/\u0000/g, "");
const wslBashUnavailable = process.platform === "win32"
  && bashProbe.status !== 0
  && /WSL/i.test(bashDiagnostic)
  && /execvpe\(\/bin\/bash\) failed: No such file or directory/i.test(bashDiagnostic);
const bashUnavailable = bashProbe.error?.code === "ENOENT"
  || windowsExecutionAliasUnavailable
  || wslBashUnavailable;
push("recovery shell syntax is valid when bash is available",
  bashUnavailable || bashProbe.status === 0, {
    skipped: bashUnavailable,
    skipReason: windowsExecutionAliasUnavailable
      ? "windows-store-bash-alias"
      : wslBashUnavailable
        ? "wsl-bash-unavailable"
        : (bashUnavailable ? "bash-unavailable" : null),
    status: bashProbe.status,
    error: bashProbe.error?.message || null,
    stderr: String(bashProbe.stderr || "").trim().slice(-500)
  });

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  recoveryPath,
  checks
}, null, 2));
if (!ok) process.exitCode = 1;
