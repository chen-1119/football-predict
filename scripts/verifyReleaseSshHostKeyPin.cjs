const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildPinnedSshBaseOptions,
  releaseKnownHostToken,
  validateReleaseSshHostKeyPin
} = require("./releaseSshHostKeyPin.cjs");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-host-pin-"));
const checks = [];
const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });

const expectFailure = (name, run, pattern) => {
  let error = null;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  push(name, Boolean(error) && pattern.test(error.message || String(error)), {
    error: error?.message || null
  });
};

try {
  const generatedKeyPath = path.join(tempDir, "fixture-host-ed25519");
  const generator = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "release-host-pin-fixture",
    "-f",
    generatedKeyPath
  ], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (generator.status !== 0) {
    throw new Error(`ssh-keygen fixture failed: ${generator.error?.message || generator.stderr || generator.status}`);
  }

  const publicFields = fs.readFileSync(`${generatedKeyPath}.pub`, "utf8").trim().split(/\s+/);
  const keyType = publicFields[0];
  const keyBlob = publicFields[1];
  const expectedFingerprint = `SHA256:${crypto.createHash("sha256")
    .update(Buffer.from(keyBlob, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
  const host = "134.175.132.183";
  const port = 18789;
  const hostToken = releaseKnownHostToken(host, port);
  const knownHostsPath = path.join(tempDir, "release.known_hosts");
  const dummyDeployKeyPath = path.join(tempDir, "operator-key-fixture");
  fs.writeFileSync(knownHostsPath, `${hostToken} ${keyType} ${keyBlob}\n`, { mode: 0o600 });
  fs.writeFileSync(dummyDeployKeyPath, "dry-run fixture only\n", { mode: 0o600 });

  const pin = validateReleaseSshHostKeyPin({
    knownHostsPath,
    host,
    port,
    expectedFingerprint,
    expectedKeyType: keyType
  });
  push("one exact ED25519 known_hosts entry validates against the explicit fingerprint",
    pin.hostToken === hostToken
      && pin.keyType === "ssh-ed25519"
      && pin.fingerprint === expectedFingerprint);

  const options = buildPinnedSshBaseOptions({
    keyPath: dummyDeployKeyPath,
    pin,
    serverAliveCountMax: 2
  });
  const optionText = options.join(" ");
  push("SSH options fail closed on the dedicated pinned host key", [
    "-F none",
    "IdentitiesOnly=yes",
    "StrictHostKeyChecking=yes",
    "UserKnownHostsFile=",
    "GlobalKnownHostsFile=",
    "UpdateHostKeys=no",
    "HostKeyAlgorithms=ssh-ed25519"
  ].every((token) => optionText.includes(token))
    && !optionText.includes("accept-new")
    && !optionText.includes("StrictHostKeyChecking=no"), {
    options: options.filter((value) => !String(value).includes(dummyDeployKeyPath))
  });

  const integration = spawnSync(process.execPath, ["scripts/deployReleaseBundle.cjs", "--recover", "--dry-run"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      RELEASE_DEPLOY_HOST: host,
      RELEASE_DEPLOY_PORT: String(port),
      RELEASE_DEPLOY_USER: "ubuntu",
      RELEASE_DEPLOY_KEY: dummyDeployKeyPath,
      RELEASE_DEPLOY_KNOWN_HOSTS: knownHostsPath,
      RELEASE_DEPLOY_HOST_KEY_SHA256: expectedFingerprint,
      RELEASE_DEPLOY_HOST_KEY_TYPE: keyType
    }
  });
  let integrationBody = null;
  try {
    integrationBody = JSON.parse(integration.stdout || "");
  } catch {
    integrationBody = null;
  }
  push("bundle deploy and recovery entrypoint consume the validated host-key pin",
    integration.status === 0
      && integrationBody?.ok === true
      && integrationBody?.sshHostKeyPin?.fingerprint === expectedFingerprint
      && integrationBody?.step?.args?.includes("StrictHostKeyChecking=yes"), {
    status: integration.status,
    stderrTail: String(integration.stderr || "").slice(-500)
  });

  const wrongFingerprint = `${expectedFingerprint.slice(0, -1)}${expectedFingerprint.endsWith("A") ? "B" : "A"}`;
  expectFailure("a mismatched explicit fingerprint is rejected before SSH", () => {
    validateReleaseSshHostKeyPin({
      knownHostsPath,
      host,
      port,
      expectedFingerprint: wrongFingerprint,
      expectedKeyType: keyType
    });
  }, /fingerprint does not match/);

  const wrongHostPath = path.join(tempDir, "wrong-host.known_hosts");
  fs.writeFileSync(wrongHostPath, `[134.175.132.183]:22 ${keyType} ${keyBlob}\n`, { mode: 0o600 });
  expectFailure("a known_hosts entry for the wrong port is rejected", () => {
    validateReleaseSshHostKeyPin({
      knownHostsPath: wrongHostPath,
      host,
      port,
      expectedFingerprint,
      expectedKeyType: keyType
    });
  }, /host token must be exactly/);

  const multiplePath = path.join(tempDir, "multiple.known_hosts");
  fs.writeFileSync(multiplePath,
    `${hostToken} ${keyType} ${keyBlob}\n${hostToken} ${keyType} ${keyBlob}\n`,
    { mode: 0o600 });
  expectFailure("ambiguous multiple known_hosts entries are rejected", () => {
    validateReleaseSshHostKeyPin({
      knownHostsPath: multiplePath,
      host,
      port,
      expectedFingerprint,
      expectedKeyType: keyType
    });
  }, /exactly one non-comment entry/);

  const missingPin = spawnSync(process.execPath, ["scripts/deployReleaseBundle.cjs", "--recover", "--dry-run"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      RELEASE_DEPLOY_HOST: host,
      RELEASE_DEPLOY_PORT: String(port),
      RELEASE_DEPLOY_KEY: dummyDeployKeyPath,
      RELEASE_DEPLOY_KNOWN_HOSTS: knownHostsPath,
      RELEASE_DEPLOY_HOST_KEY_SHA256: "",
      RELEASE_STATUS_HOST_KEY_SHA256: ""
    }
  });
  push("the deploy entrypoint fails closed when no explicit fingerprint is supplied",
    missingPin.status !== 0
      && /host-key pin validation failed/.test(`${missingPin.stdout}\n${missingPin.stderr}`), {
    status: missingPin.status
  });
} catch (error) {
  push("host-key pin verifier setup", false, { error: error.message || String(error) });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  checks
}, null, 2));
if (!ok) process.exitCode = 1;
