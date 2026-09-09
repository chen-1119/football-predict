"use strict";
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { PROFILES, hashValue, success } = require("./staticVerificationReceipts.cjs");
const attest = require("./rootStaticVerificationAttestations.cjs");
const { openRootResultCache } = require("./rootStaticResultCache.cjs");

function unitArguments({ rootDir, command, unit, user }) {
  if (!Object.hasOwn(PROFILES, command) || user !== undefined || !/^football-static-check-[a-f0-9]{24}\.service$/.test(unit)
    || !/^\/[A-Za-z0-9_./-]+$/.test(rootDir)) throw new Error("isolated-command-arguments");
  const dynamicUser = `fbst${unit.match(/[a-f0-9]{24}/)[0]}`;
  const properties = ["DynamicUser=yes", `User=${dynamicUser}`, "UMask=0077", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes",
    "PrivateTmp=yes", "PrivateDevices=yes", "PrivateNetwork=yes", "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes",
    "ProtectHostname=yes", "LockPersonality=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes",
    "RestrictNamespaces=yes", "SystemCallArchitectures=native", "RestrictAddressFamilies=AF_UNIX",
    "CapabilityBoundingSet=", "AmbientCapabilities=", "KillMode=control-group", "TimeoutStopSec=15s",
    "Nice=10", "CPUWeight=50", "IOWeight=25", "MemoryHigh=600M", "MemoryMax=768M", "MemorySwapMax=128M",
    "OOMPolicy=stop", "RuntimeMaxSec=120s", `ReadOnlyPaths=${rootDir}`,
    "InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release"];
  return ["--quiet", "--wait", "--collect", "--pipe", "--service-type=exec", `--unit=${unit}`,
    `--working-directory=${rootDir}`, ...properties.map(p => `--property=${p}`),
    "--", "/usr/bin/env", "-i", ...Object.entries(attest.controlledEnvironment()).map(([k, v]) => `${k}=${v}`),
    process.execPath, command];
}

function unitQuiescent(state, readCgroup) {
  if (!state.observed || !["inactive", "failed"].includes(state.ActiveState)
    || !["loaded", "not-found"].includes(state.LoadState)
    || state.MainPID !== "0" || state.ControlPID !== "0") return false;
  if (!state.ControlGroup) return true;
  if (!/^\/system.slice\/football-static-check-[a-f0-9]{24}\.service$/.test(state.ControlGroup)) return false;
  try { return readCgroup(state.ControlGroup) === true; } catch { return false; }
}

function cgroupV2Available() {
  try { return fs.statfsSync("/sys/fs/cgroup").type === 0x63677270
    && fs.lstatSync("/sys/fs/cgroup/cgroup.controllers").isFile(); } catch { return false; }
}

function cgroupEmpty(group) {
  // An absent unified path says nothing about tasks in a v1/hybrid controller.
  if (!cgroupV2Available()) return false;
  const root = `/sys/fs/cgroup${group}`; let visited = 0;
  function walk(directory) {
    if (++visited > 64) return false;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if (fs.readFileSync(path.join(directory, "cgroup.procs"), "utf8").trim()) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !walk(path.join(directory, entry.name))) return false;
    return true;
  }
  try { return walk(root); } catch (error) { if (error.code === "ENOENT" && !fs.existsSync(root)) return true; throw error; }
}

function runIsolated({ rootDir, command }) {
  if (!cgroupV2Available()) throw new Error("unified-cgroup-v2-required");
  const unit = `football-static-check-${crypto.randomBytes(12).toString("hex")}.service`;
  const started = Date.now();
  const child = spawnSync("/usr/bin/systemd-run", unitArguments({ rootDir, command, unit }), {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, encoding: "utf8",
    timeout: 140000, maxBuffer: 2 * attest.MAX_BYTES, windowsHide: true });
  let body = null; try { body = JSON.parse(child.stdout); } catch { /* A partial result is not proof. */ }
  const show = () => {
    const probe = spawnSync("/usr/bin/systemctl", ["show", "--property=ActiveState", "--property=LoadState", "--property=MainPID", "--property=ControlPID", "--property=ControlGroup", unit],
      { encoding: "utf8", timeout: 5000 });
    const state = Object.fromEntries((probe.stdout || "").trim().split("\n").map(line => line.split("=")));
    return { observed: probe.status === 0 && !probe.error, ...state };
  };
  const cleared = state => unitQuiescent(state, cgroupEmpty);
  let state = show();
  if (!cleared(state)) {
    spawnSync("/usr/bin/systemctl", ["stop", unit], { encoding: "utf8", timeout: 20000 }); state = show();
  }
  const quiescent = cleared(state);
  return { result: { status: quiescent ? child.status : -1, body, stdout: child.stdout || "", stderr: "",
    timedOut: Boolean(child.error) || !quiescent }, elapsedMs: Date.now() - started,
    unit, quiescent, error: child.error?.code || (quiescent ? null : "UNIT_NOT_CLEARED") };
}

function create({ rootDir, releaseSha, commands = Object.keys(PROFILES), user }) {
  if (process.getuid?.() !== 0 || process.platform !== "linux" || process.execArgv.length
    || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error("clean-root-runtime-required");
  if (user !== undefined) throw new Error("dedicated-dynamic-user-required");
  rootDir = attest.protectedRootPath(path.resolve(rootDir), { directory: true });
  if (!Array.isArray(commands) || !commands.length || new Set(commands).size !== commands.length
    || commands.some(command => !Object.hasOwn(PROFILES, command))) throw new Error("audited-command-required");
  attest.protectedRootPath("/usr/bin/systemd-run");
  const env = attest.controlledEnvironment(), store = attest.createRootStore({ releaseSha }), checks = [];
  const cache = openRootResultCache();
  try { for (const command of commands) {
    const identity = attest.buildIdentity(rootDir, [command], releaseSha, env);
    if (!identity) { checks.push({ command, eligible: false, reason: "source-requires-reaudit" }); continue; }
    for (const [file] of identity.inputs.files) if (file !== "receipt-policy") attest.protectedRootPath(path.join(rootDir, file));
    const cached = cache?.read(identity);
    const run = cached ? { result: cached.result, elapsedMs: cached.elapsedMs, checkedAt: cached.checkedAt,
      unit: null, quiescent: true, error: null } : runIsolated({ rootDir, command });
    const ok = success(run.result, identity.inputs) && run.quiescent
      && hashValue(attest.buildIdentity(rootDir, [command], releaseSha, env)) === hashValue(identity);
    checks.push({ command, eligible: true, ok, elapsedMs: cached ? 0 : run.elapsedMs,
      executionReused: Boolean(cached), originalElapsedMs: run.elapsedMs,
      reuseReason: cached ? "same-audited-source-runtime-and-root-receipt" : "no-valid-root-result-cache",
      unit: run.unit,
      quiescent: run.quiescent, status: run.result.status, timedOut: run.result.timedOut, error: run.error });
    if (!ok) return { ok: false, verificationFailed: true, directory: store.directory, checks };
    const checkedAt = cached ? run.checkedAt : Date.now();
    if (!cached) cache?.write(identity, run.result, run.elapsedMs, checkedAt);
    store.add({ identity, result: run.result, checkedAt, elapsedMs: run.elapsedMs });
  }
  if (!checks.some(check => check.ok)) return { ok: false, verificationFailed: false, directory: store.directory, checks };
  return { ok: true, version: attest.VERSION, releaseSha, ...store.complete(), checks };
  } catch (error) { return { ok: false, verificationFailed: false, directory: store.directory, checks, error: error.message }; }
}

module.exports = { create, unitArguments, unitQuiescent, cgroupV2Available, runIsolated };
if (require.main === module) {
  try {
    if (process.argv[2] === "cleanup") {
      const [directory, device, inode, releaseSha] = process.argv.slice(3);
      console.log(JSON.stringify(attest.removeRootStore({ directory, device, inode, releaseSha })));
      return;
    }
    const shell = process.argv[2] === "--shell";
    if (shell) process.argv.splice(2, 1);
    const [rootDir, releaseSha, ...commands] = process.argv.slice(2);
    const report = create({ rootDir, releaseSha, ...(commands.length ? { commands } : {}) });
    if (shell) { console.error(JSON.stringify(report)); if (report.directory) console.log(report.directory); }
    else console.log(JSON.stringify(report));
    process.exitCode = report.ok ? 0 : report.verificationFailed ? 3 : 2;
  } catch (error) { console.error(JSON.stringify({ ok: false, verificationFailed: false, error: error.message })); process.exitCode = 2; }
}
