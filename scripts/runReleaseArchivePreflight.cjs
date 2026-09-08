"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { buildPinnedSshBaseOptions, resolveReleaseSshHostKeyPin } = require("./releaseSshHostKeyPin.cjs");
const { DEFAULT_PATH } = require("./frozenArchiveRestoration.cjs");
const { buildReadOnlyArchiveProbe, evaluateArchivePreflight } = require("./releaseArchivePreflight.cjs");
function controlledObservationStderr(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/((?:proxy-)?authorization["']?\s*[:=]\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:["']?)(?:[a-z0-9_-]*token|password|passwd|api[_-]?key|[a-z0-9_-]*secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:[a-z0-9_-]*token|password|passwd|api[_-]?key|[a-z0-9_-]*secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]/g, " ");
}
function runLiveArchivePreflight() {
  const rootDir = path.resolve(__dirname, ".."), tmpDir = path.join(rootDir, ".codex-tmp");
  const host = process.env.RELEASE_DEPLOY_HOST || "134.175.132.183", user = process.env.RELEASE_DEPLOY_USER || "ubuntu";
  assert.match(user, /^[a-z_][a-z0-9_-]*$/i);
  const port = Number(process.env.RELEASE_DEPLOY_PORT || 22);
  const keyPath = path.resolve(process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, "football.pem"));
  assert.ok(fs.statSync(keyPath).isFile());
  const pin = resolveReleaseSshHostKeyPin({ rootDir, tmpDir, host, port });
  const manifest = JSON.parse(fs.readFileSync(DEFAULT_PATH));
  const args = ["-p", String(port), ...buildPinnedSshBaseOptions({ keyPath, pin }), `${user}@${host}`,
    "sudo", "-n", "/opt/node-v22.22.1/bin/node", "-"];
  const child = spawnSync("ssh", args, { input: buildReadOnlyArchiveProbe(manifest), encoding: "utf8",
    windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (child.status !== 0) {
    const controlledStderr = controlledObservationStderr(child.stderr);
    const observationDiagnostics = {
      status: Number.isInteger(child.status) ? child.status : null,
      signal: /^SIG[A-Z0-9]{1,16}$/.test(child.signal || "") ? child.signal : null,
      transportErrorCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(child.error?.code || "") ? child.error.code : null,
      stderr: controlledStderr.slice(0, 1500),
      stderrTruncated: controlledStderr.length > 1500
    };
    const error = new Error(`read-only archive observation failed: status=${observationDiagnostics.status}; signal=${observationDiagnostics.signal || "none"}; transport=${observationDiagnostics.transportErrorCode || "none"}; ${observationDiagnostics.stderr || "no remote stderr"}`);
    error.observationDiagnostics = observationDiagnostics;
    throw error;
  }
  const observation = JSON.parse(child.stdout), report = evaluateArchivePreflight(observation, manifest);
  return { report, observation };
}
module.exports = { runLiveArchivePreflight };
if (require.main === module) {
  try { const { report } = runLiveArchivePreflight(); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message).slice(0, 700), ...(error.observationDiagnostics ? { observationDiagnostics: error.observationDiagnostics } : {}), productionWrites: 0 })); process.exitCode = 1; }
}
