"use strict";

// Root is the observer; source-controlled JavaScript never becomes the issuer.
// In particular, no child JSON/stdout or caller-supplied `ok` authorizes evidence.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const build = require("./frontendBuildEvidence.cjs");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
const VERSION = "frontend-systemd-rootfs-build-v1";
const NODE = "/opt/node-v22.22.1/bin/node";
const ASSURANCE = "linux-systemd-rootfs-cgroup-v1";
const PREFIX = "/run/football-frontend-sandbox-";
const CACHE_FILES = ["tsconfig.app.tsbuildinfo", "tsconfig.node.tsbuildinfo"];
const NATIVE_COMPAT_LIBRARIES = Object.freeze(["librt.so.1"]);
const COMMANDS = Object.freeze([
  Object.freeze(["node_modules/typescript/bin/tsc", "-b"]),
  Object.freeze(["node_modules/vite/bin/vite.js", "build"]),
  Object.freeze(["scripts/stripLargeStaticPayloads.cjs"]),
]);
const MAX_ENTRIES = 100000, MAX_FILE = 160 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const digest = v => crypto.createHash("sha256").update(v).digest("hex"), hash = v => digest(JSON.stringify(v));
const identity = s => [s.dev, s.ino, s.size, s.nlink, s.mode, s.uid, s.gid, s.mtimeMs, s.ctimeMs].join(":");
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ENV = Object.freeze({ PATH: path.posix.dirname(NODE) + ":/workspace/node_modules/.bin", NODE_ENV: "production",
  VITE_BASE_PATH: "/", TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/build-home", STATIC_DIST_STRIP_SETTLE_MS: "0" });

function rootPath(filename, { directory = false, fixtureRoot = null } = {}) {
  if (process.platform !== "linux" || !path.isAbsolute(filename) || fs.realpathSync(filename) !== path.resolve(filename)) throw new Error("sandbox-root-path-required");
  let cursor = filename, first = true;
  for (;;) {
    const s = fs.lstatSync(cursor);
    if (s.uid !== 0 || s.isSymbolicLink() || (s.mode & 0o022)
      || ((first && !directory) ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) throw new Error("sandbox-root-path-permissions");
    if (cursor === "/" || cursor === fixtureRoot) break;
    cursor = path.dirname(cursor); first = false;
  }
  return filename;
}
function readFile(filename, max = MAX_FILE) {
  const prior = fs.lstatSync(filename);
  if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || prior.size > max) throw new Error("sandbox-nonplain-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (identity(prior) !== identity(fs.fstatSync(fd))) throw new Error("sandbox-file-open-drift");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== prior.size || identity(prior) !== identity(fs.fstatSync(fd))
      || identity(prior) !== identity(fs.lstatSync(filename))) throw new Error("sandbox-file-read-drift");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeNew(filename, bytes, mode = 0o400) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function runtimeFiles() {
  rootPath(NODE);
  const binary = readFile(NODE), ldd = fs.realpathSync("/usr/bin/ldd"); rootPath(ldd);
  const result = spawnSync(ldd, [NODE], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 32768 });
  if (result.status !== 0 || result.error || /not found/.test(result.stdout || "")) throw new Error("sandbox-runtime-resolution-failed");
  const files = [{ path: NODE, source: NODE, bytes: binary.length, sha256: digest(binary) }];
  for (const line of result.stdout.trim().split("\n")) {
    if (/^\s*linux-vdso\.so/.test(line)) continue;
    const m = line.match(/^\s*(?:[A-Za-z0-9_.+-]+\s+=>\s+)?(\/(?:usr\/)?lib(?:64)?\/[A-Za-z0-9_./+-]+)\s+\(0x[a-f0-9]+\)\s*$/);
    if (!m) throw new Error("sandbox-unreviewed-runtime-library");
    const source = fs.realpathSync(m[1]); rootPath(source); const bytes = readFile(source);
    if (!files.some(f => f.path === m[1])) files.push({ path: m[1], source, bytes: bytes.length, sha256: digest(bytes) });
  }
  // Node's own ldd closure does not include every glibc compatibility library
  // used by reviewed native addons. Never execute ldd on candidate addon code.
  const libc = files.find(f => path.posix.basename(f.path) === "libc.so.6");
  if (!libc) throw new Error("sandbox-reviewed-glibc-runtime-required");
  for (const name of NATIVE_COMPAT_LIBRARIES) {
    const destination = path.posix.join(path.posix.dirname(libc.path), name), source = fs.realpathSync(destination);
    rootPath(source); const bytes = readFile(source);
    if (!files.some(f => f.path === destination)) files.push({ path: destination, source, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (files.length < 2 || files.length > 32) throw new Error("sandbox-runtime-count-limit");
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function sandboxPathAllowed(sandbox, token) {
  return new RegExp("^/var/lib/football-release/frontend-builds/[a-f0-9]{24}/sandbox-" + token + "/rootfs$").test(sandbox || "")
    || new RegExp("^/tmp/football-frontend-sandbox-fixture-[A-Za-z0-9]+/sandbox-" + token + "/rootfs$").test(sandbox || "");
}
function unitArguments({ directory, sandbox, unit, commandIndex, timeoutMs }) {
  if (!/^\/run\/football-frontend-sandbox-[a-f0-9]{24}$/.test(directory)
    || !/^football-frontend-build-[a-f0-9]{24}-[123]\.service$/.test(unit)
    || !Number.isInteger(commandIndex) || !COMMANDS[commandIndex]
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error("sandbox-unit-arguments");
  const token = unit.slice("football-frontend-build-".length).slice(0, 24);
  if (!sandboxPathAllowed(sandbox, token) || unit !== "football-frontend-build-" + token + "-" + (commandIndex + 1) + ".service"
    || directory !== PREFIX + token) throw new Error("sandbox-unit-identity");
  const properties = ["DynamicUser=yes", "User=fbui" + token, "UMask=0022", "Type=exec", "RemainAfterExit=yes",
    "RootDirectory=" + sandbox, "WorkingDirectory=/workspace", "ProtectSystem=strict", "ProtectHome=yes",
    "NoNewPrivileges=yes", "PrivateDevices=yes", "PrivateNetwork=yes", "PrivateTmp=no", "PrivateIPC=yes", "MountAPIVFS=yes",
    "InaccessiblePaths=-+/tmp -+/var/tmp -+/dev/shm", "ReadOnlyPaths=+/",
    "ProtectProc=invisible", "ProcSubset=pid", "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes", "ProtectClock=yes", "ProtectHostname=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes",
    "RestrictNamespaces=yes", "LockPersonality=yes", "SystemCallArchitectures=native", "RestrictAddressFamilies=AF_UNIX",
    "SystemCallFilter=~@debug @mount @reboot @swap @privileged", "SystemCallErrorNumber=EPERM", "CapabilityBoundingSet=", "AmbientCapabilities=",
    "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=3s", "RuntimeMaxSec=" + Math.ceil(timeoutMs / 1000) + "s",
    "TimeoutStartSec=" + Math.ceil(timeoutMs / 1000) + "s", "TasksMax=128", "MemoryHigh=768M", "MemoryMax=1G",
    "MemorySwapMax=0", "OOMPolicy=stop", "LimitFSIZE=167772160", "LimitCORE=0", "CPUWeight=50", "IOWeight=25",
    "ReadWritePaths=+/workspace/dist +/workspace/node_modules/.vite-temp +/workspace/node_modules/.tmp/tsconfig.app.tsbuildinfo +/workspace/node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "StandardInput=null", "StandardOutput=file:" + directory + "/stdout-" + commandIndex + ".log",
    "StandardError=file:" + directory + "/stderr-" + commandIndex + ".log",
    ...Object.entries(ENV).map(([k, v]) => "Environment=" + k + "=" + v),
    "UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"];
  return ["--quiet", "--no-block", "--service-type=exec", "--unit=" + unit, ...properties.map(p => "--property=" + p),
    "--", NODE, ...COMMANDS[commandIndex]];
}
function hostCommand(binary, args, timeout = 5000) {
  return spawnSync(binary, args, { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout, maxBuffer: 65536, windowsHide: true });
}
const SHOW_FIELDS = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "ExecMainPID",
  "ExecMainCode", "ExecMainStatus", "Result", "InvocationID", "DynamicUser", "User", "RootDirectory", "PrivateNetwork",
  "ProtectSystem", "NoNewPrivileges", "KillMode"];
function showUnit(unit) {
  const result = hostCommand("/usr/bin/systemctl", ["show", ...SHOW_FIELDS.map(k => "--property=" + k), unit]);
  const state = Object.fromEntries((result.stdout || "").trim().split("\n").filter(Boolean).map(line => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
  }));
  return { observed: result.status === 0 && !result.error, ...state };
}
function cgroupEmpty(unit) {
  if (!/^football-frontend-build-[a-f0-9]{24}-[123]\.service$/.test(unit)
    || fs.statfsSync("/sys/fs/cgroup").type !== 0x63677270 || !fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) return false;
  const group = "/sys/fs/cgroup/system.slice/" + unit; let count = 0;
  function walk(dir) {
    if (++count > 256) throw new Error("sandbox-cgroup-count-limit");
    const s = fs.lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("sandbox-cgroup-path");
    if (fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim()) return false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !walk(path.join(dir, e.name))) return false;
    return true;
  }
  try { return walk(group); } catch (e) { if (e.code === "ENOENT" && !fs.existsSync(group)) return true; return false; }
}
function unitQuiescent(state, empty) {
  return state.observed && ["inactive", "failed"].includes(state.ActiveState) && ["loaded", "not-found"].includes(state.LoadState)
    && state.MainPID === "0" && state.ControlPID === "0" && empty === true;
}
function clearUnit(unit) {
  hostCommand("/usr/bin/systemctl", ["stop", unit], 5000);
  let state = showUnit(unit), empty = cgroupEmpty(unit);
  if (!unitQuiescent(state, empty)) {
    hostCommand("/usr/bin/systemctl", ["kill", "--kill-whom=all", "--signal=KILL", unit]);
    hostCommand("/usr/bin/systemctl", ["stop", unit], 5000); state = showUnit(unit); empty = cgroupEmpty(unit);
  }
  const quiescent = unitQuiescent(state, empty);
  if (quiescent) hostCommand("/usr/bin/systemctl", ["reset-failed", unit]);
  return { quiescent, cgroupEmpty: empty, state };
}
function runCommand({ directory, sandbox, token, index, timeoutMs }) {
  const unit = "football-frontend-build-" + token + "-" + (index + 1) + ".service";
  const start = Date.now(), create = hostCommand("/usr/bin/systemd-run", unitArguments({ directory, sandbox, unit, commandIndex: index, timeoutMs }));
  let state = null, uid = null, deadline = false, unexpected = false, cleanup;
  try {
    if (create.status !== 0 || create.error) throw new Error("sandbox-unit-create-failed:" + String(create.stderr).slice(0, 2048));
    do {
      state = showUnit(unit);
      if (!state.observed || state.Id !== unit || state.DynamicUser !== "yes" || state.User !== "fbui" + token
        || state.RootDirectory !== sandbox || state.PrivateNetwork !== "yes"
        || state.ProtectSystem !== "strict" || state.NoNewPrivileges !== "yes" || state.KillMode !== "control-group") {
        unexpected = true; break;
      }
      if (uid === null && state.ActiveState !== "failed") {
        const user = hostCommand("/usr/bin/getent", ["passwd", state.User]);
        if (user.status === 0 && !user.error) {
          const fields = user.stdout.trim().split(":"); const value = Number(fields[2]);
          if (fields[0] === state.User && Number.isInteger(value) && value >= 61184 && value <= 65519) uid = value;
        }
      }
      if (state.ActiveState === "failed" || state.SubState === "exited" || state.ActiveState === "inactive") break;
      if (Date.now() - start >= timeoutMs) { deadline = true; break; }
      pause(50);
    } while (true);
  } finally { cleanup = clearUnit(unit); }
  const ok = !unexpected && !deadline && state?.observed && state.ActiveState === "active" && state.SubState === "exited"
    && state.ExecMainCode === "1" && state.ExecMainStatus === "0" && state.Result === "success" && uid !== null
    && /^[a-f0-9]{32}$/.test(state.InvocationID || "") && cleanup.quiescent;
  return { unit, command: [NODE, ...COMMANDS[index]], dynamicUid: uid, startedAt: start, finishedAt: Date.now(),
    elapsedMs: Date.now() - start, ok, timedOut: deadline || state?.Result === "timeout", unexpectedState: unexpected,
    exit: state, cleanup, outputHashes: ["stdout", "stderr"].map(kind => {
      const file = path.join(directory, kind + "-" + index + ".log");
      return { stream: kind, sha256: fs.existsSync(file) ? digest(readFile(file, 8 * 1024 * 1024)) : null };
    }) };
}
function mirrorInputs(root, destination, inputs) {
  fs.mkdirSync(destination, { mode: 0o755 });
  for (const row of [...inputs.source, ...inputs.dependencies].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    const target = path.join(destination, row.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    if (row.kind === "directory") { fs.mkdirSync(target, { recursive: true, mode: 0o755 }); continue; }
    if (row.kind === "bin-alias") {
      fs.symlinkSync(path.relative(path.dirname(target), path.join(destination, row.target)), target); continue;
    }
    const bytes = readFile(path.join(root, row.path));
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error("sandbox-input-copy-drift");
    // Mount-level readonly + root ownership is the input boundary. Preserve
    // normal owner-write semantics in copied outputs (copyFile preserves mode).
    writeNew(target, bytes, row.mode & 0o111 ? 0o755 : 0o644);
  }
  fs.mkdirSync(path.join(destination, "dist"), { mode: 0o777 }); fs.chmodSync(path.join(destination, "dist"), 0o777);
  for (const name of [".tmp", ".vite-temp"]) {
    const target = path.join(destination, "node_modules", name); fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    fs.chmodSync(target, name === ".tmp" ? 0o555 : 0o777);
  }
  for (const name of CACHE_FILES) writeNew(path.join(destination, "node_modules/.tmp", name), "", 0o666);
}
function normalizeRootfsDirectories(sandbox) {
  // The signed release controller normally has umask 077. Give the dedicated
  // UID traversal inside its private chroot without loosening the host parent.
  let count = 0;
  function walk(dir, relative) {
    if (++count > MAX_ENTRIES + 2000) throw new Error("sandbox-directory-count-limit");
    const s = fs.lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0) throw new Error("sandbox-directory-before-execution");
    const mode = ["workspace/dist", "workspace/node_modules/.vite-temp"].includes(relative) ? 0o777
      : relative === "workspace/node_modules/.tmp" ? 0o555 : 0o755;
    fs.chmodSync(dir, mode);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative ? relative + "/" + entry.name : entry.name);
  }
  walk(sandbox, "");
}
function inspectWritableTree(directory, { normalize = false } = {}) {
  let count = 0, total = 0; const files = [], directories = [];
  function walk(dir, relative) {
    const s = fs.lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("sandbox-linked-output-directory");
    if (++count > 4096) throw new Error("sandbox-output-count-limit");
    directories.push({ path: dir, identity: identity(s) });
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = relative ? relative + "/" + name : name, full = path.join(dir, name), st = fs.lstatSync(full);
      if (/[\\:\x00-\x1f]/.test(name)) throw new Error("sandbox-output-name");
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full, rel);
      else {
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("sandbox-nonplain-file");
        total += st.size;
        if (++count > 4096 || st.size > 128 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error("sandbox-output-size-limit");
        files.push({ path: rel, full, bytes: st.size, identity: identity(st) });
      }
    }
  }
  walk(directory, "");
  // Budget the whole tree from metadata before allocating a single file body.
  const result = files.map(file => {
    if (identity(fs.lstatSync(file.full)) !== file.identity) throw new Error("sandbox-output-drift");
    return { path: file.path, bytes: file.bytes, sha256: digest(readFile(file.full, file.bytes)) };
  });
  if (directories.some(d => identity(fs.lstatSync(d.path)) !== d.identity)) throw new Error("sandbox-output-directory-drift");
  if (normalize) {
    for (const file of files) { fs.chownSync(file.full, 0, 0); fs.chmodSync(file.full, 0o666); }
    for (const dir of directories) { fs.chownSync(dir.path, 0, 0); fs.chmodSync(dir.path, 0o777); }
  }
  return result;
}
function checkedRemove(directory, expectedInode) {
  const token = path.basename(path.dirname(directory)).replace(/^sandbox-/, "");
  if (!/^[a-f0-9]{24}$/.test(token) || !sandboxPathAllowed(directory, token)
    || fs.realpathSync(directory) !== directory || String(fs.lstatSync(directory).ino) !== String(expectedInode)) throw new Error("sandbox-cleanup-target");
  let count = 0; const paths = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (++count > MAX_ENTRIES + 2000) throw new Error("sandbox-cleanup-count-limit");
      const full = path.join(dir, name), s = fs.lstatSync(full);
      if (s.isDirectory() && !s.isSymbolicLink()) { walk(full); paths.push([full, true]); } else paths.push([full, false]);
    }
  }
  walk(directory);
  for (const [file, dir] of paths) if (dir) fs.rmdirSync(file); else fs.unlinkSync(file);
  fs.rmdirSync(directory); fs.rmdirSync(path.dirname(directory)); return !fs.existsSync(directory);
}
function mirrorCommitment(workspace, inputs) {
  const expected = new Map([...inputs.source, ...inputs.dependencies].map(row => [row.path, row]));
  for (const name of ["node_modules/.tmp", "node_modules/.vite-temp", "dist"]) expected.delete(name);
  let count = 0;
  function walk(directory, relative = "") {
    const s = fs.lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o777) !== 0o755) throw new Error("sandbox-mirror-directory-drift");
    for (const name of fs.readdirSync(directory)) {
      const rel = relative ? relative + "/" + name : name, file = path.join(directory, name);
      if (["dist", "node_modules/.tmp", "node_modules/.vite-temp"].includes(rel)) continue;
      if (++count > MAX_ENTRIES) throw new Error("sandbox-mirror-count-limit");
      const row = expected.get(rel), st = fs.lstatSync(file); if (!row) throw new Error("sandbox-mirror-extra-member");
      expected.delete(rel);
      if (row.kind === "directory") walk(file, rel);
      else if (row.kind === "bin-alias") {
        if (!st.isSymbolicLink() || path.relative(workspace, fs.realpathSync(file)).replaceAll(path.sep, "/") !== row.target) throw new Error("sandbox-mirror-alias-drift");
      } else if (st.uid !== 0 || (st.mode & 0o777) !== (row.mode & 0o111 ? 0o755 : 0o644)
        || digest(readFile(file)) !== row.sha256) throw new Error("sandbox-mirror-input-drift");
    }
  }
  walk(workspace); if (expected.size) throw new Error("sandbox-mirror-missing-member");
}
function execute(options, fixtureRoot = null) {
  const { rootDir, baselineDist, baselineReleaseSha256, timeoutMs = 300000 } = options;
  if (Object.keys(options).some(k => !["rootDir", "baselineDist", "baselineReleaseSha256", "timeoutMs"].includes(k))) throw new Error("sandbox-unknown-option");
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.execPath !== NODE || process.version !== "v22.22.1"
    || process.execArgv.length || process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.LD_PRELOAD || process.env.LD_LIBRARY_PATH) throw new Error("sandbox-fixed-clean-linux-root-required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("sandbox-timeout-policy");
  if (!fixtureRoot && !/^\/var\/lib\/football-release\/frontend-builds\/[a-f0-9]{24}\/source$/.test(rootDir || "")) throw new Error("sandbox-production-stage-root-required");
  if (!/^[a-f0-9]{64}$/.test(baselineReleaseSha256 || "")) throw new Error("sandbox-baseline-sha-required");
  if (fs.statfsSync("/sys/fs/cgroup").type !== 0x63677270 || !fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) throw new Error("sandbox-cgroup-v2-required");
  rootPath(rootDir, { directory: true, fixtureRoot }); rootPath("/run", { directory: true });
  for (const file of ["/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/getent"]) rootPath(fs.realpathSync(file));
  const policies = [__filename, require.resolve("./frontendBuildEvidence.cjs"), require.resolve("./releasePrebuiltDist.cjs")].map(file => {
    rootPath(file, { fixtureRoot }); return { name: path.basename(file), file, sha256: digest(readFile(file)) };
  });
  const baseline = build.validateDistManifest(baselineDist), before = build.snapshotBuildInputs(rootDir, { beforeBuild: true });
  const pkg = JSON.parse(readFile(path.join(rootDir, "package.json"), 1024 * 1024));
  if (pkg.scripts?.build !== build.BUILD_SCRIPT || pkg.scripts?.prebuild || pkg.scripts?.postbuild
    || hash(COMMANDS) !== hash(build.COMMANDS)) throw new Error("sandbox-unreviewed-build-command");
  if ([...before.source, ...before.dependencies].filter(r => r.kind === "file").reduce((n, r) => n + r.bytes, 0) > MAX_TOTAL) throw new Error("sandbox-input-size-limit");
  const sourceIdentity = { dev: fs.lstatSync(rootDir).dev, ino: fs.lstatSync(rootDir).ino };
  const checkSourceIdentity = () => {
    rootPath(rootDir, { directory: true, fixtureRoot }); const current = fs.lstatSync(rootDir);
    if (current.dev !== sourceIdentity.dev || current.ino !== sourceIdentity.ino) throw new Error("sandbox-source-stage-identity-drift");
  };
  const runtime = runtimeFiles(), token = crypto.randomBytes(12).toString("hex"), directory = PREFIX + token;
  fs.mkdirSync(directory, { mode: 0o700 });
  const sandboxParent = path.join(fixtureRoot || path.dirname(rootDir), "sandbox-" + token), sandbox = path.join(sandboxParent, "rootfs");
  fs.mkdirSync(sandboxParent, { mode: 0o700 });
  fs.mkdirSync(sandbox, { mode: 0o755 }); const sandboxInode = fs.lstatSync(sandbox).ino;
  const startedAt = Date.now(), runs = []; let record = null, failure = null, rootfsRemoved = false;
  try {
    for (const name of ["proc", "dev", "sys", "etc", "run", "tmp", "build-home"]) fs.mkdirSync(path.join(sandbox, name), { mode: 0o555 });
    for (const file of runtime) {
      const bytes = readFile(file.source); if (digest(bytes) !== file.sha256) throw new Error("sandbox-runtime-copy-drift");
      const target = path.join(sandbox, file.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 }); writeNew(target, bytes, 0o555);
    }
    const workspace = path.join(sandbox, "workspace"); mirrorInputs(rootDir, workspace, before); normalizeRootfsDirectories(sandbox);
    for (let index = 0; index < COMMANDS.length; index++) {
      const remaining = timeoutMs - (Date.now() - startedAt); if (remaining <= 0) throw new Error("sandbox-build-deadline");
      const run = runCommand({ directory, sandbox, token, index, timeoutMs: remaining }); runs.push(run);
      if (!run.ok) throw new Error("sandbox-build-command-failed:" + index);
      // A new dedicated UID owns the next command. Only the now-quiescent output
      // tree is normalized; never loosen any source/dependency or cache parent.
      inspectWritableTree(path.join(workspace, "dist"), { normalize: true });
      if (fs.readdirSync(path.join(workspace, "node_modules/.vite-temp")).length) throw new Error("sandbox-vite-temp-not-empty");
      const cache = path.join(workspace, "node_modules/.tmp");
      if (fs.readdirSync(cache).sort().join() !== CACHE_FILES.slice().sort().join()) throw new Error("sandbox-cache-members");
      for (const name of CACHE_FILES) readFile(path.join(cache, name), 8 * 1024 * 1024);
    }
    checkSourceIdentity(); const after = build.snapshotBuildInputs(rootDir, { beforeBuild: true });
    if (before.sourceHash !== after.sourceHash || before.dependencyHash !== after.dependencyHash) throw new Error("sandbox-original-input-drift");
    mirrorCommitment(workspace, before);
    if (runtime.some(r => digest(readFile(r.source)) !== r.sha256)
      || policies.some(p => digest(readFile(p.file)) !== p.sha256)) throw new Error("sandbox-controller-runtime-drift");
    const artifact = inspectPrebuiltDist(path.join(workspace, "dist")), overlay = build.inspectOverlayArtifacts(baseline, artifact);
    checkSourceIdentity(); const exportDir = path.join(rootDir, "dist"); fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
    rootPath(exportDir, { directory: true, fixtureRoot }); const exportIdentity = fs.lstatSync(exportDir);
    if (fs.readdirSync(exportDir).length) throw new Error("sandbox-export-must-be-empty");
    for (const row of artifact.files) {
      const target = path.join(exportDir, row.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = readFile(path.join(workspace, "dist", row.path)); if (digest(bytes) !== row.sha256) throw new Error("sandbox-export-drift"); writeNew(target, bytes, 0o600);
    }
    checkSourceIdentity(); rootPath(exportDir, { directory: true, fixtureRoot });
    if (fs.lstatSync(exportDir).dev !== exportIdentity.dev || fs.lstatSync(exportDir).ino !== exportIdentity.ino
      || inspectPrebuiltDist(exportDir).treeHash !== artifact.treeHash) throw new Error("sandbox-export-tree-drift");
    const cacheOutputs = CACHE_FILES.map(name => { const bytes = readFile(path.join(workspace, "node_modules/.tmp", name)); return { path: "node_modules/.tmp/" + name, bytes: bytes.length, sha256: digest(bytes) }; });
    record = { version: VERSION, executionAssurance: ASSURANCE, scope: fixtureRoot ? "isolated-fixture" : "isolated-frontend-build",
      signingEligible: false, deploymentAuthorized: false, baseline: { releaseSha256: baselineReleaseSha256, distTreeHash: baseline.treeHash,
        manifestHash: hash(baseline), authentication: "must-be-independently-proven-by-release-controller" },
      sourceHash: before.sourceHash, dependencyHash: before.dependencyHash, artifact, overlay, cacheOutputs,
      controllerPolicies: policies.map(({ name, sha256 }) => ({ name, sha256 })), runtime, environment: ENV,
      inputMirror: "bounded-byte-identical-membership-alias-mode-verified-readonly-mirror", commandPolicyHash: hash(COMMANDS),
      startedAt, finishedAt: Date.now(), runs, descendantsQuiescent: true, externalInputIsolation: true,
      productionWrites: 0, providerRequests: 0 };
  } catch (error) { failure = error; }
  finally {
    // If cgroup state is uncertain, preserve its rootfs instead of deleting
    // underneath a live process. The record remains failed and cannot attest.
    const allQuiet = [0, 1, 2].every(i => cgroupEmpty("football-frontend-build-" + token + "-" + (i + 1) + ".service"));
    if (allQuiet) rootfsRemoved = checkedRemove(sandbox, sandboxInode);
    else if (!failure) failure = new Error("sandbox-descendants-not-cleared");
  }
  const report = record && !failure ? { ...record, rootfsRemoved } : { version: VERSION, ok: false, signingEligible: false,
    scope: fixtureRoot ? "isolated-fixture" : "isolated-frontend-build", error: failure?.message || "sandbox-unknown-failure", runs, rootfsRemoved };
  const evidenceHash = hash(report); writeNew(path.join(directory, "evidence.json"), JSON.stringify(report));
  writeNew(path.join(directory, "complete.json"), JSON.stringify({ version: VERSION, evidenceHash }));
  const dfd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  const result = { ...report, directory, evidenceHash };
  if (failure) { failure.evidence = result; throw failure; }
  return result;
}
function runSandboxedFrontendBuild(options) { return execute(options); }
function runSandboxFixture({ fixtureRoot, ...options }) {
  if (!/^\/tmp\/football-frontend-sandbox-fixture-[A-Za-z0-9]+$/.test(fixtureRoot || "")
    || !__filename.startsWith(fixtureRoot + "/") || !options.rootDir?.startsWith(fixtureRoot + "/")) throw new Error("sandbox-fixture-boundary-required");
  rootPath(fixtureRoot, { directory: true, fixtureRoot });
  if ((fs.lstatSync(fixtureRoot).mode & 0o777) !== 0o700) throw new Error("sandbox-fixture-private-root-required");
  return execute(options, fixtureRoot);
}
function readSandboxEvidence({ directory, evidenceHash }) {
  if (!/^\/run\/football-frontend-sandbox-[a-f0-9]{24}$/.test(directory || "") || !/^[a-f0-9]{64}$/.test(evidenceHash || "")) throw new Error("sandbox-evidence-identity");
  rootPath(directory, { directory: true });
  if ((fs.lstatSync(directory).mode & 0o777) !== 0o700) throw new Error("sandbox-evidence-private-root");
  for (const name of ["complete.json", "evidence.json"]) rootPath(path.join(directory, name));
  const complete = JSON.parse(readFile(path.join(directory, "complete.json"), 4096)), bytes = readFile(path.join(directory, "evidence.json"), 1024 * 1024);
  if (complete.version !== VERSION || complete.evidenceHash !== evidenceHash || digest(bytes) !== evidenceHash) throw new Error("sandbox-evidence-drift");
  const record = JSON.parse(bytes);
  if (record.version !== VERSION || record.executionAssurance !== ASSURANCE || record.scope !== "isolated-frontend-build"
    || record.descendantsQuiescent !== true || record.rootfsRemoved !== true || record.runs?.length !== 3
    || record.runs.some(r => !r.ok || !r.cleanup?.quiescent || !cgroupEmpty(r.unit))) throw new Error("sandbox-evidence-not-production-build-proof");
  return record;
}
module.exports = { VERSION, NODE, ASSURANCE, COMMANDS, ENV, CACHE_FILES, NATIVE_COMPAT_LIBRARIES, unitArguments, unitQuiescent, cgroupEmpty,
  inspectWritableTree, runSandboxedFrontendBuild, runSandboxFixture, readSandboxEvidence };
