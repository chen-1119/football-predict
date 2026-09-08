"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { buildPinnedSshBaseOptions, resolveReleaseSshHostKeyPin } = require("./releaseSshHostKeyPin.cjs");
const { DEFAULT_PATH } = require("./frozenArchiveRestoration.cjs");
const { buildReadOnlyArchiveProbe, evaluateArchivePreflight } = require("./releaseArchivePreflight.cjs");
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
  assert.equal(child.status, 0, `read-only archive observation failed: ${child.error?.code || "remote-read-failed"}`);
  const observation = JSON.parse(child.stdout), report = evaluateArchivePreflight(observation, manifest);
  return { report, observation };
}
module.exports = { runLiveArchivePreflight };
if (require.main === module) {
  try { const { report } = runLiveArchivePreflight(); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message).slice(0, 700), productionWrites: 0 })); process.exitCode = 1; }
}
