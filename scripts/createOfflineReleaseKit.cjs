const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { collectFilesNewerThan } = require("./releaseWorkspaceFreshness.cjs");
const {
  RELEASE_BUNDLE_POLICY_VERSION,
  findSensitiveReleaseEntries
} = require("./releaseBundlePolicy.cjs");
const {
  resolvePublicKeyPath,
  verifyManifestSignature
} = require("./releaseSigning.cjs");

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.REMOTE_BASE_URL || "https://134.175.132.183";
const allowStaleBundle = process.env.RELEASE_OFFLINE_ALLOW_STALE_BUNDLE === "1";
const restoreKeyBundleEntry = "deploy/light-server/restore-ubuntu-operator-key.sh";

const latestBundlePath = () => {
  if (process.env.RELEASE_BUNDLE_PATH) return path.resolve(process.env.RELEASE_BUNDLE_PATH);
  if (!fs.existsSync(tmpDir)) return "";
  return fs.readdirSync(tmpDir)
    .filter((name) => /^football-release-.+\.tgz$/.test(name))
    .map((name) => {
      const filePath = path.join(tmpDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || "";
};

const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const fail = (message, details = {}) => {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
};

const bundlePath = latestBundlePath();
if (!bundlePath || !fs.existsSync(bundlePath)) fail("release bundle not found", { bundlePath: bundlePath || null });

const shaPath = `${bundlePath}.sha256`;
const manifestPath = `${bundlePath}.manifest.json`;
const signaturePath = `${bundlePath}.manifest.sig`;
const signingPublicKeyPath = resolvePublicKeyPath();
const releaseScriptPath = path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh");
const restoreKeyScriptPath = path.join(rootDir, "deploy", "light-server", "restore-ubuntu-operator-key.sh");
const missingFiles = [shaPath, manifestPath, signaturePath, signingPublicKeyPath, releaseScriptPath, restoreKeyScriptPath]
  .filter((filePath) => !fs.existsSync(filePath));
if (missingFiles.length) fail("release bundle sidecars or offline helpers missing", { missingFiles });

let manifest = null;
try {
  manifest = verifyManifestSignature({
    manifestPath,
    signaturePath,
    publicKeyPath: signingPublicKeyPath
  }).manifest;
} catch (error) {
  fail("release manifest signature verification failed", { manifestPath, signaturePath, reason: error.message || String(error) });
}

const bundleStat = fs.statSync(bundlePath);
const actualSha256 = sha256File(bundlePath);
const bundleList = spawnSync("tar", ["-tzf", bundlePath], {
  cwd: rootDir,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});
if (bundleList.status !== 0) {
  fail("release bundle contents could not be inspected", {
    bundlePath,
    status: bundleList.status,
    stderr: bundleList.stderr
  });
}
const sensitiveEntries = findSensitiveReleaseEntries(bundleList.stdout.split(/\r?\n/).filter(Boolean));
if (sensitiveEntries.length) {
  fail("release bundle contains sensitive files and is quarantined from offline release", {
    bundlePath,
    policyVersion: RELEASE_BUNDLE_POLICY_VERSION,
    sensitiveEntries: sensitiveEntries.slice(0, 20)
  });
}
const restoreKeyFromBundle = spawnSync("tar", ["-xOzf", bundlePath, `./${restoreKeyBundleEntry}`], {
  cwd: rootDir,
  encoding: null,
  maxBuffer: 1024 * 1024
});
if (restoreKeyFromBundle.status !== 0 || !Buffer.isBuffer(restoreKeyFromBundle.stdout) || restoreKeyFromBundle.stdout.length === 0) {
  fail("signed release bundle does not contain the SSH operator-key recovery entrypoint", {
    bundlePath,
    entry: restoreKeyBundleEntry,
    status: restoreKeyFromBundle.status,
    tarError: restoreKeyFromBundle.error?.message || String(restoreKeyFromBundle.stderr || "").slice(-1000)
  });
}
const bundledRestoreKeySha256 = crypto.createHash("sha256").update(restoreKeyFromBundle.stdout).digest("hex");
const localRestoreKeySha256 = sha256File(restoreKeyScriptPath);
if (bundledRestoreKeySha256 !== localRestoreKeySha256) {
  fail("signed release bundle SSH recovery entrypoint does not match the reviewed workspace", {
    bundlePath,
    entry: restoreKeyBundleEntry,
    bundledRestoreKeySha256,
    localRestoreKeySha256
  });
}
// An offline kit cannot fetch the live generation; retain its stricter data gate.
const newerWorkspaceFiles = collectFilesNewerThan(rootDir, bundleStat.mtimeMs, { includeGeneratedData: true })
  .sort((a, b) => a.path.localeCompare(b.path));
if (newerWorkspaceFiles.length && !allowStaleBundle) {
  fail("release bundle is older than current workspace changes", {
    bundlePath,
    createdAt: manifest.createdAt || null,
    newerWorkspaceFileCount: newerWorkspaceFiles.length,
    newerWorkspaceFiles: newerWorkspaceFiles.slice(0, 30)
  });
}
if (manifest.ok !== true || manifest.sha256 !== actualSha256 || Number(manifest.bytes) !== bundleStat.size) {
  fail("release bundle manifest does not match bundle", {
    bundlePath,
    manifestOk: manifest.ok === true,
    manifestSha256: manifest.sha256 || null,
    actualSha256,
    manifestBytes: manifest.bytes ?? null,
    actualBytes: bundleStat.size
  });
}

const kitDir = path.join(tmpDir, `football-offline-release-kit-${stamp}`);
const kitArchivePath = `${kitDir}.tgz`;
fs.rmSync(kitDir, { recursive: true, force: true });
fs.mkdirSync(kitDir, { recursive: true });

const bundleName = path.basename(bundlePath);
const shaName = path.basename(shaPath);
const manifestName = path.basename(manifestPath);
const signatureName = path.basename(signaturePath);
const releaseScriptName = "release-from-bundle.sh";
const restoreKeyScriptName = "restore-ubuntu-operator-key.sh";

fs.copyFileSync(bundlePath, path.join(kitDir, bundleName));
fs.copyFileSync(shaPath, path.join(kitDir, shaName));
fs.copyFileSync(manifestPath, path.join(kitDir, manifestName));
fs.copyFileSync(signaturePath, path.join(kitDir, signatureName));
fs.copyFileSync(releaseScriptPath, path.join(kitDir, releaseScriptName));
fs.writeFileSync(path.join(kitDir, restoreKeyScriptName), restoreKeyFromBundle.stdout, { mode: 0o600 });

const readme = `# Football Offline Release Kit

Created at: ${new Date().toISOString()}
Public base URL: ${publicBaseUrl}
Bundle: ${bundleName}
SHA256: ${actualSha256}

Use this kit only when the public website still answers /api/v1/health but
operator SSH cannot complete its banner/auth handshake. The existing service
continues serving until release-from-bundle.sh finishes candidate preflight,
SQLite readiness, production checks, the public swap, and public-origin
verification. If any required gate fails, the script rolls back to the previous
app directory.

Server-console/VNC steps:

First authenticate the signed bundle and confirm both runnable helpers are the
exact copies carried by that bundle:

\`\`\`bash
set -euo pipefail
mkdir -p /tmp/football-offline-release
cd /tmp/football-offline-release
# Upload or copy every file from this kit into the current directory.
sha256sum -c ${shaName}
openssl dgst -sha256 \
  -verify /etc/football-release/signing-public.pem \
  -signature ${signatureName} \
  ${manifestName}
python3 - "${bundleName}" "${manifestName}" <<'PY'
import hashlib
import json
import os
import sys

bundle_path, manifest_path = sys.argv[1:3]
with open(bundle_path, "rb") as handle:
    digest = hashlib.file_digest(handle, "sha256").hexdigest()
with open(manifest_path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("sha256") != digest or int(manifest.get("bytes", -1)) != os.path.getsize(bundle_path):
    raise SystemExit("signed manifest does not match the uploaded bundle")
print("signed bundle identity verified")
PY
tar -xOzf ${bundleName} ./${restoreKeyBundleEntry} | cmp - ${restoreKeyScriptName}
tar -xOzf ${bundleName} ./deploy/light-server/release-from-bundle.sh | cmp - ${releaseScriptName}
\`\`\`

Optional narrow SSH-key repair, before the release steps below:

This kit contains only the reviewed recovery program. It does not contain an operator public or private key.
On the reviewed operator workstation, export
the public half of the existing deployment identity into a separate file and
record its SHA-256 fingerprint. Never upload the private-key file to the server.
Upload only that one-line public-key file to the server as
\`/tmp/football-operator.pub\`, then run:

\`\`\`bash
chmod 700 ${restoreKeyScriptName}
sudo FOOTBALL_OPERATOR_KEY_FINGERPRINT='SHA256:replace-with-reviewed-fingerprint' \\
  bash ./${restoreKeyScriptName}
\`\`\`

The repair rejects anything except one valid RSA public-key line, preserves
other authorized keys, de-duplicates by key blob, atomically enforces
\`ubuntu:ubuntu\` permissions on \`~ubuntu/.ssh\` and \`authorized_keys\`, and
validates \`sshd -t\`. It does not modify sshd configuration, firewall rules, or
password authentication. Remove \`/tmp/football-operator.pub\` after an external
SSH test succeeds.

Guarded offline release:

\`\`\`bash
chmod 700 ${releaseScriptName}
sudo PUBLIC_BASE_URL="${publicBaseUrl}" \\
  BUNDLE_SHA256="${actualSha256}" \\
  bash ./${releaseScriptName} ./${bundleName}
\`\`\`

After the script reports success, verify from the server:

\`\`\`bash
curl -fsS http://127.0.0.1:8788/api/v1/health | head -c 1000
curl -fsS ${publicBaseUrl.replace(/\/+$/, "")}/api/v1/health | head -c 1000
\`\`\`

Then verify from the operator machine:

\`\`\`bash
REMOTE_BASE_URL="${publicBaseUrl}" REMOTE_REQUIRE_SQLITE=1 npm run verify:remote-public
\`\`\`
`;
fs.writeFileSync(path.join(kitDir, "README-server-console.md"), readme);

const tar = spawnSync("tar", ["-czf", kitArchivePath, "-C", path.dirname(kitDir), path.basename(kitDir)], {
  cwd: rootDir,
  encoding: "utf8"
});
if (tar.status !== 0) {
  fail("offline release kit archive failed", {
    command: "tar",
    status: tar.status,
    stdout: tar.stdout,
    stderr: tar.stderr
  });
}

const archiveStat = fs.statSync(kitArchivePath);
const payload = {
  ok: true,
  createdAt: new Date().toISOString(),
  kitDir,
  kitArchivePath,
  archiveBytes: archiveStat.size,
  publicBaseUrl,
  bundle: {
    path: bundlePath,
    name: bundleName,
    bytes: bundleStat.size,
    sha256: actualSha256,
    manifestPath,
    createdAt: manifest.createdAt || null,
    workspaceFresh: newerWorkspaceFiles.length === 0,
    newerWorkspaceFileCount: newerWorkspaceFiles.length
  },
  serverCommand: `sudo PUBLIC_BASE_URL=${JSON.stringify(publicBaseUrl)} BUNDLE_SHA256=${JSON.stringify(actualSha256)} bash ./${releaseScriptName} ./${bundleName}`,
  files: [
    bundleName,
    shaName,
    manifestName,
    signatureName,
    releaseScriptName,
    restoreKeyScriptName,
    "README-server-console.md"
  ]
};

console.log(JSON.stringify(payload, null, 2));
