const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const releasePath = path.join(rootDir, "deploy", "light-server", "release.sh");
const deployPowerShellPath = path.join(rootDir, "deploy", "light-server", "deploy.ps1");
const readmePath = path.join(rootDir, "README.md");
const deploymentDocPath = path.join(rootDir, "docs", "light-server-deployment.md");
const packagePath = path.join(rootDir, "package.json");

const read = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
const release = read(releasePath);
const deployPowerShell = read(deployPowerShellPath);
const readme = read(readmePath);
const deploymentDoc = read(deploymentDocPath);
const packageJson = JSON.parse(read(packagePath));
const checks = [];
const pushCheck = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const hasAll = (text, tokens) => tokens.every((token) => text.includes(token));

const signedCommands = [
  "npm run release:bundle",
  "npm run verify:release-bundle",
  "npm run release:deploy-bundle"
];

const releaseGuard = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  "builtin printf '%s\\n' 'deploy/light-server/release.sh is disabled: unsigned Git-based production releases are not permitted.' >&2",
  "builtin printf '%s\\n' 'Use only the signed path: npm run release:bundle && npm run verify:release-bundle && npm run release:deploy-bundle' >&2",
  "builtin exit 64",
  ""
].join("\n");
const releaseExitIndex = release.indexOf("builtin exit 64");
const releaseRiskIndexes = [
  'APP_DIR="${APP_DIR:-',
  'REPO_URL="${REPO_URL:-',
  "git clone",
  "npm ci",
  "systemctl",
  "curl -"
].map((token) => ({ token, index: release.indexOf(token) }));
pushCheck("legacy Bash release has an unconditional fail-closed prologue", release.startsWith(releaseGuard)
  && releaseExitIndex >= 0
  && releaseRiskIndexes.every(({ index }) => index < 0 || releaseExitIndex < index), {
  releaseExitIndex,
  releaseRiskIndexes
});
pushCheck("legacy Bash release has no override switch", !/(ALLOW|ENABLE|FORCE|BYPASS)_[A-Z_]*LEGACY|LEGACY_[A-Z_]*(ALLOW|ENABLE|FORCE|BYPASS)/.test(release));

const powerShellGuard = "throw 'deploy/light-server/deploy.ps1 is disabled: unsigned deployment is not permitted. Use only the signed path: npm run release:bundle; npm run verify:release-bundle; npm run release:deploy-bundle.'";
const powerShellGuardIndex = deployPowerShell.indexOf(powerShellGuard);
const powerShellParamEndIndex = deployPowerShell.indexOf("\n)\n");
const powerShellRiskIndexes = [
  '$ErrorActionPreference = "Stop"',
  "function New-RandomToken",
  "$resolvedKey = Resolve-Path",
  "$target =",
  "$sshBase =",
  "scp -i",
  "ssh @sshBase"
].map((token) => ({ token, index: deployPowerShell.indexOf(token) }));
pushCheck("legacy PowerShell deploy fails before key, token, or SSH handling", powerShellGuardIndex >= 0
  && powerShellParamEndIndex >= 0
  && deployPowerShell.slice(powerShellParamEndIndex + 3, powerShellGuardIndex).trim() === ""
  && powerShellRiskIndexes.every(({ index }) => index < 0 || powerShellGuardIndex < index), {
  powerShellGuardIndex,
  powerShellParamEndIndex,
  powerShellRiskIndexes
});
pushCheck("legacy PowerShell deploy has no override switch", !/(Allow|Enable|Force|Bypass)Legacy|Legacy(Allow|Enable|Force|Bypass)/i.test(deployPowerShell));

const bashCandidates = [
  process.env.BASH_EXE,
  "bash",
  "D:\\app\\Git\\bin\\bash.exe"
].filter(Boolean);
let bashCommand = null;
for (const candidate of bashCandidates) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    bashCommand = candidate;
    break;
  }
}
pushCheck("Bash runtime is available for the legacy guard test", Boolean(bashCommand), { bashCommand });
if (bashCommand) {
  const bashResult = spawnSync(bashCommand, [releasePath], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      BASH_ENV: "",
      ENV: "",
      ALLOW_LEGACY_RELEASE: "1",
      FORCE_LEGACY_RELEASE: "1",
      REPO_URL: "https://invalid.example/must-not-be-used.git"
    }
  });
  const output = `${bashResult.stdout || ""}\n${bashResult.stderr || ""}`;
  pushCheck("legacy Bash release exits 64 and points only to signed commands", bashResult.status === 64
    && hasAll(output, ["release.sh is disabled", ...signedCommands]), {
    status: bashResult.status,
    output: output.trim().slice(-1000)
  });
}

const powerShellCandidates = process.platform === "win32"
  ? ["pwsh.exe", "powershell.exe", "pwsh", "powershell"]
  : ["pwsh", "powershell"];
let powerShellCommand = null;
for (const candidate of powerShellCandidates) {
  const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    encoding: "utf8"
  });
  if (probe.status === 0) {
    powerShellCommand = candidate;
    break;
  }
}
pushCheck("PowerShell runtime availability is enforced on Windows", process.platform !== "win32" || Boolean(powerShellCommand), {
  platform: process.platform,
  powerShellCommand
});
if (powerShellCommand) {
  const powerShellResult = spawnSync(powerShellCommand, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    deployPowerShellPath,
    "-KeyPath",
    path.join(rootDir, ".codex-tmp", "must-not-be-read"),
    "-AdminToken",
    "must-not-be-processed"
  ], { cwd: rootDir, encoding: "utf8" });
  const output = `${powerShellResult.stdout || ""}\n${powerShellResult.stderr || ""}`;
  pushCheck("legacy PowerShell deploy rejects before resolving the supplied key", powerShellResult.status !== 0
    && hasAll(output, ["deploy.ps1 is disabled", ...signedCommands])
    && !output.includes("Resolve-Path"), {
    status: powerShellResult.status,
    output: output.trim().slice(-1000)
  });
}

const oldReleaseExecutionPattern = /(?:sudo\s+[^\n]*\s+)?bash\s+deploy\/light-server\/release\.sh/;
const oldPowerShellExecutionPattern = /(?:pwsh|powershell|\.\\)[^\n`]*deploy(?:\/|\\)light-server(?:\/|\\)deploy\.ps1/i;
for (const [label, text] of [["README", readme], ["deployment guide", deploymentDoc]]) {
  const fencedCode = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const legacyEntrypointInCode = fencedCode.some((block) => /deploy(?:\/|\\)light-server(?:\/|\\)(?:release\.sh|deploy\.ps1)\b/i.test(block));
  pushCheck(`${label} documents only the signed production update path`, hasAll(text, signedCommands)
    && !oldReleaseExecutionPattern.test(text)
    && !oldPowerShellExecutionPattern.test(text)
    && !legacyEntrypointInCode, { legacyEntrypointInCode });
  pushCheck(`${label} preserves legacy-entry migration history`, text.includes("Migration history")
    && text.includes("deploy/light-server/release.sh")
    && text.includes("deploy/light-server/deploy.ps1")
    && /fail(?:s|ed)? closed|fail-closed/i.test(text));
}

pushCheck("package exposes the standalone legacy-release guard verifier",
  packageJson.scripts?.["verify:legacy-release-disabled"] === "node scripts/verifyLegacyReleaseDisabled.cjs");

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  failed: checks.filter((check) => !check.ok)
}, null, 2));
if (!ok) process.exit(1);
