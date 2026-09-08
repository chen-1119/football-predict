"use strict";
const path = require("node:path"), { spawnSync } = require("node:child_process");
const { buildPinnedSshBaseOptions, resolveReleaseSshHostKeyPin } = require("./releaseSshHostKeyPin.cjs");
const { buildReadOnlyProgressProbe } = require("./releaseProgress.cjs");

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--sha" || !/^[a-f0-9]{64}$/.test(argv[1])) {
    throw new Error("usage: npm.cmd run release:progress -- --sha <exact-bundle-sha256>");
  }
  const sha = argv[1], rootDir = path.resolve(__dirname, ".."), tmpDir = path.join(rootDir, ".codex-tmp");
  const host = process.env.RELEASE_STATUS_HOST || process.env.RELEASE_DEPLOY_HOST || "134.175.132.183";
  const user = process.env.RELEASE_STATUS_USER || process.env.RELEASE_DEPLOY_USER || "ubuntu";
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error("invalid SSH user");
  const port = Number(process.env.RELEASE_STATUS_PORT || process.env.RELEASE_DEPLOY_PORT || 22);
  const keyPath = path.resolve(process.env.RELEASE_STATUS_KEY || process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, "football.pem"));
  const pin = resolveReleaseSshHostKeyPin({ rootDir, tmpDir, host, port, statusMode: true });
  const result = spawnSync("ssh", ["-p", String(port), ...buildPinnedSshBaseOptions({ keyPath, pin }), user + "@" + host,
    "sudo", "-n", "/opt/node-v22.22.1/bin/node", "-"], { input: buildReadOnlyProgressProbe(sha), encoding: "utf8",
    windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error("release progress observation unavailable; do not restart from an observation error");
  const report = JSON.parse(result.stdout);
  if (report.sha !== sha || report.version !== "release-progress-observation-v1" || report.observationOk !== true) throw new Error("invalid progress observation");
  console.log(JSON.stringify(report, null, 2));
}
module.exports = { main };
if (require.main === module) {
  try { main(); }
  catch (error) { console.error(JSON.stringify({ observationOk: false, error: error.message, productionWrites: 0 })); process.exitCode = 1; }
}
