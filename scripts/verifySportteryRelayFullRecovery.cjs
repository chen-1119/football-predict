"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const verifierPath = path.join(rootDir, "scripts", "verifySportteryRelayDualLaneServer.cjs");

const result = spawnSync(process.execPath, [verifierPath], {
  cwd: rootDir,
  encoding: "utf8",
  windowsHide: true,
  timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024,
});

let payload = null;
try {
  payload = JSON.parse(result.stdout || "null");
} catch {
  payload = null;
}

const byName = new Map((payload?.checks || []).map((check) => [check.name, check]));
const passed = (name) => byName.get(name)?.ok === true;

const checks = [
  {
    name: "complete full upload restores archive in its independent file",
    ok: result.status === 0
      && payload?.ok === true
      && passed("complete full snapshot accepted")
      && passed("full upload is an atomic replacement without merge")
      && passed("full file written and fast file not synthesized")
      && passed("health reports full history independently"),
  },
  {
    name: "fast upload after full keeps the full archive byte-identical",
    ok: result.status === 0
      && payload?.ok === true
      && passed("single-cycle atomic fast snapshot accepted")
      && passed("fast upload cannot modify full file")
      && passed("upload-merge still leaves full archive byte-identical")
      && passed("health prefers fresh fast current lane"),
  },
];

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  verifier: "sporttery-relay-full-recovery",
  summary: {
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
  dualLaneVerifier: {
    status: result.status,
    signal: result.signal || null,
    checks: Array.isArray(payload?.checks) ? payload.checks.length : 0,
    stderr: String(result.stderr || "").slice(-1000),
  },
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
