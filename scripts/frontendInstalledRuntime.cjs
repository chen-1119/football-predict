"use strict";

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const boundary = require("./frontendRuntimeBoundary.cjs");
const VERSION = "frontend-installed-runtime-v1";
const APP = "/opt/football-predict", NODE = "/opt/node-v22.22.1/bin/node";
const NPM_ROOT = "/opt/node-v22.22.1/lib/node_modules/npm";
const FIXED_PATH = "/opt/node-v22.22.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const RUNTIME_ENV = "/etc/football-predict/env";
const UNITS = Object.freeze(Object.keys({ ...boundary.ENTRYPOINTS, ...boundary.EXTERNAL_UNITS }).sort());
const COMMANDS = Object.freeze(["node", "npm", "curl", "systemctl", "busctl", "pgrep", "df", "bash", "env", "python3", "tar", "gzip",
  "psql", "openssl", "ps", "scp", "ssh", "pg_dump", "pg_restore", "sha256sum", "awk", "stat", "basename", "mv", "find",
  "date", "rm", "mkdir", "chmod", "cat"]);
const TRANSIENT_ENV = Object.freeze(["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"]);
const CONFIG_FIELDS = Object.freeze(["Id", "LoadState", "NeedDaemonReload", "FragmentPath", "DropInPaths", "ExecStart", "ExecStartPre",
  "ExecStartPost", "ExecCondition", "ExecReload", "ExecStop", "ExecStopPost", "User", "Group", "WorkingDirectory", "Environment",
  "EnvironmentFiles", "PassEnvironment", "UnsetEnvironment", "RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths",
  "TemporaryFileSystem", "ExtensionDirectories", "ExtensionImages", "PAMName", "LoadCredential", "LoadCredentialEncrypted",
  "SetCredential", "SetCredentialEncrypted", "ExecSearchPath", "DynamicUser", "StandardInput", "StandardOutput", "StandardError",
  "ReadOnlyPaths", "ReadWritePaths", "InaccessiblePaths", "ProtectSystem", "ProtectHome", "PrivateTmp", "PrivateDevices",
  "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities"]);
const OBSERVATION_FIELDS = Object.freeze(["ActiveState", "SubState", "MainPID", "InvocationID"]);
const CREDENTIAL_SIGNATURES = Object.freeze({ LoadCredential: "a(ss)", LoadCredentialEncrypted: "a(ss)",
  SetCredential: "a(say)", SetCredentialEncrypted: "a(say)" });
// systemctl omits empty command arrays even with --all on the live host.
// Missing is never assumed empty: typed D-Bus zero-length proof is required.
const OMITTED_ARRAY_SIGNATURES = Object.freeze({ ExecStartPre: "a(sasbttttuii)", ExecStartPost: "a(sasbttttuii)",
  ExecCondition: "a(sasbttttuii)", ExecReload: "a(sasbttttuii)", ExecStop: "a(sasbttttuii)", ExecStopPost: "a(sasbttttuii)", EnvironmentFiles: "a(sb)" });
const FRAGMENT_ROOTS = Object.freeze(["/etc/systemd/system/", "/run/systemd/system/", "/usr/lib/systemd/system/"]);
const CONTROL_DROPIN_ROOT = "/run/systemd/system.control/";
// Reviewed host alternative, not a general /etc or alternatives allowlist.
// Both hops and the resolved binary are included in the runtime commitment.
const AWK_ALTERNATIVE = Object.freeze({ entry: "/usr/bin/awk", link: "/etc/alternatives/awk", target: "/usr/bin/gawk" });
const CONDITIONAL_UPLOAD = Object.freeze({ unit: "football-postgres-cos-upload.service", file: "/etc/football-predict/cos-backup.env",
  conditionPrefix: 'a(sbbsi) 1 "ConditionPathExists" false false "/etc/football-predict/cos-backup.env" ' });
const STABLE_UNIT_POLICY = "all-config-fields-exec-start-normalized-active-primary-observations-v1";
const LIMITS = Object.freeze({ entries: 100000, fileBytes: 160 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024,
  configBytes: 1024 * 1024, procBytes: 1024 * 1024, deadlineMs: 120000 });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = value => sha(JSON.stringify(value));
const POLICY_HASH = digest({ VERSION, APP, NODE, NPM_ROOT, FIXED_PATH, RUNTIME_ENV, UNITS, COMMANDS,
  TRANSIENT_ENV, CONFIG_FIELDS, OBSERVATION_FIELDS, CREDENTIAL_SIGNATURES, FRAGMENT_ROOTS, CONTROL_DROPIN_ROOT, STABLE_UNIT_POLICY,
  LIMITS, AWK_ALTERNATIVE, OMITTED_ARRAY_SIGNATURES, CONDITIONAL_UPLOAD, boundaryPolicy: boundary.POLICY_HASH });
const metadata = stat => ({ mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid) });
const statIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const fail = code => { const error = new Error(code); error.runtimeCode = code; throw error; };
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

function shellWords(text) {
  if (typeof text !== "string" || /[\r\n\0]/.test(text)) fail("invalid-systemd-word-list");
  const words = []; let word = "", quote = null, active = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") {
      const next = text[++at];
      if (next === "x" && /^[0-9a-fA-F]{2}$/.test(text.slice(at + 1, at + 3))) {
        word += String.fromCharCode(parseInt(text.slice(at + 1, at + 3), 16)); at += 2;
      } else if (next && "\\\"' ".includes(next)) word += next;
      else fail("unreviewed-systemd-escape");
      active = true;
    } else if (quote) { if (char === quote) quote = null; else word += char; active = true; }
    else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) { if (active) { words.push(word); word = ""; active = false; } }
    else { word += char; active = true; }
  }
  if (quote) fail("unclosed-systemd-quote");
  if (active) words.push(word);
  return words;
}
function environmentPairs(words) {
  const result = {};
  for (const word of words) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
    if (!match || Object.hasOwn(result, match[1]) || /\0/.test(match[2])) fail("invalid-or-duplicate-environment-key");
    result[match[1]] = match[2];
  }
  return result;
}
function environmentFile(bytes) {
  const words = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || /\\$/.test(line)) fail("unreviewed-environment-file-grammar");
    const raw = match[2].trim();
    const value = /^["']/.test(raw) ? shellWords(raw) : [raw];
    if (value.length !== 1) fail("unreviewed-environment-file-value");
    words.push(match[1] + "=" + value[0]);
  }
  return environmentPairs(words);
}
function stableEnvironment(env, pid) {
  for (const key of TRANSIENT_ENV) if (Object.hasOwn(env, key)) {
    if (key === "INVOCATION_ID" && !/^[0-9a-f]{32}$/.test(env[key]) || key === "JOURNAL_STREAM" && !/^\d+:\d+$/.test(env[key]) ||
        key === "SYSTEMD_EXEC_PID" && env[key] !== String(pid)) fail("invalid-systemd-transient-environment");
  }
  return Object.keys(env).filter(key => !TRANSIENT_ENV.includes(key)).sort().map(key => [key, env[key]]);
}
function validateEnvironment(env) {
  for (const key of ["NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME"])
    if (env[key]) fail("unreviewed-runtime-loader-environment");
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) && env[key]) fail("unreviewed-npm-environment-override");
  for (const key of Object.keys(env)) if (/(?:_BIN|_EXECUTABLE|_COMMAND)$/.test(key) && env[key] &&
      !["CURL_BIN", "NODE_BIN", "COSCLI_BIN"].includes(key)) fail("unknown-runtime-command-override");
  if (env.NODE_OPTIONS && env.NODE_OPTIONS.split(/\s+/).some(word => !/^(?:--max-old-space-size=[1-9][0-9]{0,4}|--expose-gc)$/.test(word)))
    fail("unreviewed-node-options");
  if (env.CURL_BIN && !["curl", "/usr/bin/curl"].includes(env.CURL_BIN) ||
      env.NODE_BIN && env.NODE_BIN !== NODE || env.COSCLI_BIN && env.COSCLI_BIN !== "/usr/local/bin/coscli" ||
      env.SPORTTERY_BROWSER_EXECUTABLE) fail("unreviewed-executable-environment-override");
  if (env.PATH) {
    const dirs = env.PATH.split(":");
    if (!dirs.length || new Set(dirs).size !== dirs.length || dirs.some(dir => !FIXED_PATH.split(":").includes(dir)))
      fail("unreviewed-runtime-path");
  }
}

function makeContext(fixtureRoot = null) {
  const fixture = fixtureRoot !== null, windows = fixture && process.platform === "win32";
  const owner = fixture ? (process.platform === "win32" ? 0 : process.getuid()) : 0;
  const local = logical => {
    if (typeof logical !== "string" || !logical.startsWith("/") || /[\u0000-\u001f\\]/.test(logical) ||
        path.posix.normalize(logical) !== logical || logical.includes("/../")) fail("unsafe-runtime-path");
    return fixture ? path.join(fixtureRoot, "host", ...logical.slice(1).split("/")) : logical;
  };
  const observations = new Map(), readCache = new Map(), startedAt = Date.now(); let totalBytes = 0, count = 0;
  const checkBudget = () => { if (Date.now() - startedAt > LIMITS.deadlineMs) fail("installed-runtime-deadline"); };
  const safeStat = (file, directory = false) => {
    checkBudget(); const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || stat.uid !== BigInt(owner) || (!windows && (stat.mode & 0o7022n) !== 0n) ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail("unsafe-runtime-owner-mode-or-type");
    return stat;
  };
  const ancestors = file => {
    let cursor = path.dirname(file);
    for (;;) {
      const stat = safeStat(cursor, true);
      // Directory mtimes may change for unrelated data. The exact members of
      // dependency trees and unit fragments are separately recaptured below.
      observations.set(cursor, { directory: true, identity: [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String).join(":") });
      if (cursor === (fixture ? fixtureRoot : path.parse(cursor).root)) break;
      const parent = path.dirname(cursor); if (parent === cursor) fail("runtime-fixture-ancestor-escape"); cursor = parent;
    }
  };
  const readFile = (logical, maxBytes = LIMITS.fileBytes, keepBytes = false) => {
    const cached = readCache.get(logical);
    if (cached && (!keepBytes || cached.content)) {
      if (cached.bytes > maxBytes) fail("installed-runtime-size-limit");
      const result = { ...cached }; if (!keepBytes) delete result.content; return result;
    }
    const file = local(logical); ancestors(file); const before = safeStat(file);
    if (before.size > BigInt(maxBytes) || totalBytes + Number(before.size) > LIMITS.totalBytes || ++count > LIMITS.entries)
      fail("installed-runtime-size-limit");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const hasher = crypto.createHash("sha256"), chunks = []; let bytes = 0;
    try {
      if (statIdentity(fs.fstatSync(fd, { bigint: true })) !== statIdentity(before)) fail("runtime-open-race");
      const buffer = Buffer.alloc(Math.min(1024 * 1024, Number(before.size) + 1));
      for (;;) {
        checkBudget(); const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
        if (!size) break; bytes += size; if (bytes > maxBytes || bytes > Number(before.size)) fail("runtime-file-growth");
        hasher.update(buffer.subarray(0, size)); if (keepBytes) chunks.push(Buffer.from(buffer.subarray(0, size)));
      }
      if (bytes !== Number(before.size) || statIdentity(fs.fstatSync(fd, { bigint: true })) !== statIdentity(before) ||
          statIdentity(fs.lstatSync(file, { bigint: true })) !== statIdentity(before)) fail("runtime-file-read-race");
    } finally { fs.closeSync(fd); }
    totalBytes += bytes; observations.set(file, { identity: statIdentity(before) });
    const result = { path: logical, bytes, sha256: hasher.digest("hex"), ...metadata(before), ...(keepBytes ? { content: Buffer.concat(chunks) } : {}) };
    readCache.set(logical, result); return { ...result };
  };
  function resolveExecutable(logical) {
    if (logical === NODE || logical === "/usr/local/bin/coscli" || logical.startsWith("/usr/local/sbin/football-")) return logical;
    let current = logical;
    const links = [];
    for (let hop = 0; hop < 12; hop++) {
      // The fixed merged-/usr aliases are reviewed, rather than allowing any
      // arbitrary linked ancestor into mutable application/user directories.
      for (const [alias, target] of [["/bin", "/usr/bin"], ["/sbin", "/usr/sbin"]]) if (current.startsWith(alias + "/")) {
        const file = local(alias), stat = fs.lstatSync(file, { bigint: true });
        if (stat.isSymbolicLink()) {
          if (stat.uid !== BigInt(owner) || path.posix.resolve("/", fs.readlinkSync(file).replace(/\\/g, "/")) !== target)
            fail("unreviewed-system-executable-alias");
          links.push({ path: alias, target }); observations.set(file, { identity: statIdentity(stat) }); current = target + current.slice(alias.length);
        }
      }
      const file = local(current); ancestors(file); const stat = fs.lstatSync(file, { bigint: true });
      if (current === AWK_ALTERNATIVE.link && (!stat.isSymbolicLink() ||
          links.at(-1)?.path !== AWK_ALTERNATIVE.entry || links.at(-1)?.target !== AWK_ALTERNATIVE.link ||
          links.slice(0, -1).some(link => link.path !== "/bin" || link.target !== "/usr/bin")))
        fail("unreviewed-system-alternative-entry");
      if (current === AWK_ALTERNATIVE.target && links.some(link => link.path === AWK_ALTERNATIVE.link) && stat.isSymbolicLink())
        fail("unreviewed-system-alternative-target");
      if (!stat.isSymbolicLink()) { const result = readFile(current); if (!windows && !(result.mode & 0o111)) fail("nonexecutable-runtime-command"); return { ...result, requestedPath: logical, links }; }
      if (stat.uid !== BigInt(owner)) fail("unsafe-command-link-owner");
      const target = fs.readlinkSync(file).replace(/\\/g, "/");
      const next = path.posix.resolve(path.posix.dirname(current), target);
      if (current === AWK_ALTERNATIVE.link && target !== AWK_ALTERNATIVE.target) fail("unreviewed-system-alternative-target");
      const reviewedAlternative = current === AWK_ALTERNATIVE.entry && target === AWK_ALTERNATIVE.link;
      if (!(next.startsWith("/usr/") || next.startsWith("/opt/node-v22.22.1/") || reviewedAlternative)) fail("runtime-command-link-escape");
      links.push({ path: current, target }); observations.set(file, { identity: statIdentity(stat) }); current = next;
    }
    fail("runtime-command-link-depth");
  }
  const command = (name, envPath = FIXED_PATH) => {
    if (!COMMANDS.includes(name)) fail("unknown-runtime-command");
    for (const directory of envPath.split(":")) {
      const candidate = directory + "/" + name;
      try {
        fs.lstatSync(local(candidate));
        let result = resolveExecutable(candidate);
        if (typeof result === "string") result = readFile(result);
        if (name === "node" && result.path !== NODE || name === "npm" && result.path !== NPM_ROOT + "/bin/npm-cli.js")
          fail("runtime-node-npm-resolution-drift");
        return { name, ...result };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    fail("missing-required-runtime-command");
  };
  const recordAbsent = logical => {
    const file = local(logical); ancestors(file);
    try { fs.lstatSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      observations.set(file, { absent: true }); return { path: logical, absent: true };
    }
    fail("conditional-environment-appeared");
  };
  const recheck = () => {
    for (const [file, before] of observations) {
      if (before.absent) {
        try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        fail("conditional-environment-appeared");
      }
      const stat = fs.lstatSync(file, { bigint: true });
      const identity = before.directory ? [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String).join(":") : statIdentity(stat);
      if (identity !== before.identity) fail("installed-runtime-changed-during-capture");
    }
  };
  return { fixture, windows, owner, local, readFile, safeStat, ancestors, command, resolveExecutable, recordAbsent, recheck, checkBudget, observations,
    counts: () => ({ capturedFiles: count, capturedBytes: totalBytes }) };
}

function captureDependencyTree(ctx, root) {
  const rows = [], directories = [], links = [], manifests = new Map();
  const visit = logical => {
    ctx.checkBudget(); const file = ctx.local(logical); ctx.ancestors(file); const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) {
      if (path.posix.basename(path.posix.dirname(logical)) !== ".bin" || stat.uid !== BigInt(ctx.owner)) fail("unreviewed-installed-dependency-link");
      const target = fs.readlinkSync(file).replace(/\\/g, "/");
      if (path.posix.isAbsolute(target)) fail("absolute-npm-bin-link");
      const resolved = path.posix.resolve(path.posix.dirname(logical), target);
      if (!resolved.startsWith(root + "/") || resolved.includes("/.bin/")) fail("npm-bin-link-escape");
      links.push({ path: logical, target, resolved, ...metadata(stat) }); ctx.observations.set(file, { identity: statIdentity(stat) }); return;
    }
    if (stat.isDirectory()) {
      ctx.safeStat(file, true); const names = fs.readdirSync(file).sort();
      if (rows.length + links.length + directories.length + names.length > LIMITS.entries) fail("dependency-entry-limit");
      directories.push({ logical, names }); rows.push({ path: logical, kind: "directory", ...metadata(stat) });
      for (const name of names) {
        if (!name || [".", ".."].includes(name) || /[\u0000-\u001f/\\]/.test(name)) fail("unreviewed-dependency-member-name");
        visit(logical + "/" + name);
      }
    } else {
      const row = ctx.readFile(logical, LIMITS.fileBytes, path.posix.basename(logical) === "package.json");
      if (row.content) { const content = JSON.parse(row.content.toString("utf8")); manifests.set(path.posix.dirname(logical), content); delete row.content; }
      rows.push({ kind: "file", ...row });
    }
  };
  visit(root);
  const index = new Map(rows.filter(row => row.kind === "file").map(row => [row.path, row]));
  for (const link of links) {
    const target = index.get(link.resolved); if (!target || (!ctx.windows && !(target.mode & 0o111))) fail("npm-bin-target-not-plain-executable");
    let directory = path.posix.dirname(link.resolved), pkg;
    while (directory.startsWith(root + "/") || directory === root) {
      if (manifests.has(directory)) { pkg = manifests.get(directory); break; } directory = path.posix.dirname(directory);
    }
    const bins = typeof pkg?.bin === "string" ? { [String(pkg.name).split("/").at(-1)]: pkg.bin } : pkg?.bin;
    const declared = bins?.[path.posix.basename(link.path)];
    if (typeof declared !== "string" || path.posix.resolve(directory, declared) !== link.resolved) fail("npm-bin-not-declared-by-package");
    rows.push({ ...link, kind: "npm-bin-link", targetSha256: target.sha256 });
  }
  return { rows: rows.sort((a, b) => a.path.localeCompare(b.path, "en")), recheck() {
    for (const entry of directories) if (JSON.stringify(fs.readdirSync(ctx.local(entry.logical)).sort()) !== JSON.stringify(entry.names))
      fail("dependency-members-changed-during-capture");
  } };
}

function readEmptyCredentials(ctx, unit, signatures = CREDENTIAL_SIGNATURES) {
  // systemctl renders these arrays as [unprintable] even when empty. Resolve
  // the exact fixed unit through the manager, then require typed zero-length
  // values. Nonempty/unknown responses fail without emitting credential data.
  const bus = args => {
    const result = spawnSync("/usr/bin/busctl", ["--system", "--no-pager", ...args],
      { env: { PATH: FIXED_PATH, LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: LIMITS.configBytes, windowsHide: true });
    if (result.error || result.status !== 0) fail("systemd-credential-observation-failed");
    return result.stdout;
  };
  let object;
  if (!ctx.fixture) {
    const response = bus(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit]);
    object = "/org/freedesktop/systemd1/unit/" + unit.replace(/[^A-Za-z0-9]/g, char => "_" + char.charCodeAt(0).toString(16));
    if (response !== 'o "' + object + '"\n') fail("systemd-credential-unit-object-mismatch");
  }
  const result = {};
  for (const [key, signature] of Object.entries(signatures)) {
    const response = ctx.fixture ? fs.readFileSync(ctx.local("/fixture/units/" + unit + "." + key + ".bus"), "utf8")
      : bus(["get-property", "org.freedesktop.systemd1", object, "org.freedesktop.systemd1.Service", key]);
    if (response !== signature + " 0\n") fail("nonempty-or-unreviewed-systemd-credentials");
    result[key] = signature + " 0";
  }
  return result;
}
function readUnit(ctx, unit) {
  let text;
  if (ctx.fixture) text = fs.readFileSync(ctx.local("/fixture/units/" + unit + ".show"), "utf8");
  else {
    const result = spawnSync("/usr/bin/systemctl", ["show", "--all", "--no-pager", ...[...CONFIG_FIELDS, ...OBSERVATION_FIELDS].map(key => "--property=" + key), unit],
      { env: { PATH: FIXED_PATH, LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: LIMITS.configBytes, windowsHide: true });
    if (result.error || result.status !== 0) fail("systemd-runtime-observation-failed"); text = result.stdout;
  }
  if (Buffer.byteLength(text) > LIMITS.configBytes) fail("systemd-observation-size-limit");
  const result = {};
  for (const line of text.trimEnd().split("\n")) {
    const at = line.indexOf("="); const key = line.slice(0, at);
    if (at < 1 || ![...CONFIG_FIELDS, ...OBSERVATION_FIELDS].includes(key)) fail("invalid-systemd-show-contract");
    if (Object.hasOwn(result, key)) {
      // systemctl renders multiple EnvironmentFile entries on separate lines.
      // Preserve order; inspectUnit still rejects duplicate paths and bad syntax.
      if (key !== "EnvironmentFiles" || !result[key] || !line.slice(at + 1)) fail("invalid-systemd-show-contract");
      result[key] += " " + line.slice(at + 1); continue;
    }
    result[key] = line.slice(at + 1);
  }
  const missing = [...CONFIG_FIELDS, ...OBSERVATION_FIELDS].filter(key => !Object.hasOwn(result, key));
  if (missing.some(key => !Object.hasOwn(OMITTED_ARRAY_SIGNATURES, key))) fail("missing-systemd-show-field");
  for (const key of Object.keys(CREDENTIAL_SIGNATURES)) if (!["", "[unprintable]"].includes(result[key]))
    fail("unreviewed-systemd-credential-rendering");
  const proved = readEmptyCredentials(ctx, unit, { ...CREDENTIAL_SIGNATURES,
    ...Object.fromEntries(missing.map(key => [key, OMITTED_ARRAY_SIGNATURES[key]])) });
  for (const key of missing) result[key] = "";
  for (const key of Object.keys(CREDENTIAL_SIGNATURES)) result[key] = proved[key];
  if (!exactKeys(result, [...CONFIG_FIELDS, ...OBSERVATION_FIELDS])) fail("missing-systemd-show-field");
  return result;
}
function stableUnitConfiguration(observed) {
  const executable = /^\{ path=([^;]+) ; argv\[\]=([^;]+) ; ignore_errors=(yes|no) ;[^{}]*\}$/.exec(observed.ExecStart);
  if (!executable) fail("unreviewed-installed-exec-start");
  return Object.fromEntries(CONFIG_FIELDS.map(key => [key, key === "ExecStart"
    ? { executable: executable[1], argv: executable[2], ignoreErrors: executable[3] === "yes" } : observed[key]]));
}
function sameUnitObservation(unit, before, after) {
  if (JSON.stringify(stableUnitConfiguration(before)) !== JSON.stringify(stableUnitConfiguration(after))) return false;
  // A timer's start/exit is not a configuration change. Primary processes must
  // remain the exact live observations and are independently rechecked in /proc.
  return !["football-predict.service", "football-sync-worker.service"].includes(unit)
    || OBSERVATION_FIELDS.every(key => before[key] === after[key]);
}
function proveInactiveConditionalUpload(ctx, unit, observed) {
  if (unit !== CONDITIONAL_UPLOAD.unit || observed.ActiveState !== "inactive" || observed.MainPID !== "0")
    fail("missing-environment-without-inactive-condition");
  let response;
  if (ctx.fixture) response = fs.readFileSync(ctx.local("/fixture/units/" + unit + ".Conditions.bus"), "utf8");
  else {
    const result = spawnSync("/usr/bin/busctl", ["--system", "--no-pager", "get-property", "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/football_2dpostgres_2dcos_2dupload_2eservice", "org.freedesktop.systemd1.Unit", "Conditions"],
      { env: { PATH: FIXED_PATH, LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: LIMITS.configBytes, windowsHide: true });
    if (result.error || result.status !== 0) fail("conditional-upload-observation-failed"); response = result.stdout;
  }
  // Final integer is only the previous condition evaluation, not configuration.
  if (!["-1", "0", "1"].some(value => response === CONDITIONAL_UPLOAD.conditionPrefix + value + "\n"))
    fail("unreviewed-conditional-upload-configuration");
  return { condition: "ConditionPathExists", path: CONDITIONAL_UPLOAD.file, absent: true };
}
function inspectUnit(ctx, unit, observed, envFiles, envValues) {
  if (observed.Id !== unit || observed.LoadState !== "loaded" || observed.NeedDaemonReload !== "no") fail("unloaded-or-stale-systemd-unit");
  const entry = boundary.ENTRYPOINTS[unit], external = boundary.EXTERNAL_UNITS[unit];
  const expectedPath = entry ? NODE : external.executable;
  const expectedArgv = entry ? NODE + " " + APP + "/" + entry.script + entry.args : external.executable;
  const executable = /^\{ path=([^;]+) ; argv\[\]=([^;]+) ; ignore_errors=(yes|no) ;[^{}]*\}$/.exec(observed.ExecStart);
  if (!executable || executable[1] !== expectedPath || executable[2] !== expectedArgv || executable[3] !== "no") fail("unreviewed-installed-exec-start");
  for (const key of ["ExecStartPre", "ExecStartPost", "ExecCondition", "ExecReload", "ExecStop", "ExecStopPost", "PassEnvironment",
    "RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "ExtensionDirectories", "ExtensionImages",
    "PAMName", "ExecSearchPath"])
    if (observed[key]) fail("unreviewed-systemd-command-or-loader-configuration");
  for (const [key, signature] of Object.entries(CREDENTIAL_SIGNATURES)) if (observed[key] !== signature + " 0")
    fail("nonempty-or-unreviewed-systemd-credentials");
  if (observed.User !== (entry ? "football" : "postgres") || observed.Group !== "football" ||
      observed.WorkingDirectory !== (entry ? APP : "") || observed.DynamicUser !== "no") fail("unreviewed-systemd-runtime-identity");
  const fragments = [observed.FragmentPath, ...shellWords(observed.DropInPaths)];
  if (new Set(fragments).size !== fragments.length || fragments.length > 32) fail("systemd-fragment-count-or-duplicates");
  const fileRows = fragments.map((file, at) => {
    const roots = at === 0 ? FRAGMENT_ROOTS : [...FRAGMENT_ROOTS, CONTROL_DROPIN_ROOT];
    const root = roots.find(prefix => file.startsWith(prefix));
    if (!root || (at === 0 ? file !== root + unit : !file.startsWith(root + unit + ".d/")
      || !/^[A-Za-z0-9_.@+-]+\.conf$/.test(file.slice((root + unit + ".d/").length))))
      fail("unreviewed-systemd-fragment-path");
    return ctx.readFile(file, LIMITS.configBytes);
  });
  const env = environmentPairs(shellWords(observed.Environment)); validateEnvironment(env);
  const environmentPaths = []; let position = 0, conditionalEnvironment = null;
  const grammar = /(\/[A-Za-z0-9_.+@/-]+) \(ignore_errors=(yes|no)\)(?: |$)/y;
  while (position < observed.EnvironmentFiles.length) {
    grammar.lastIndex = position; const match = grammar.exec(observed.EnvironmentFiles);
    if (!match) fail("unreviewed-environment-files-grammar"); position = grammar.lastIndex;
    const file = match[1]; if (environmentPaths.includes(file)) fail("duplicate-environment-file");
    environmentPaths.push(file);
    if (!envFiles.has(file)) {
      let row;
      try { row = ctx.readFile(file, LIMITS.configBytes, true); }
      catch (error) {
        if (error.code !== "ENOENT" || file !== CONDITIONAL_UPLOAD.file) throw error;
        conditionalEnvironment = proveInactiveConditionalUpload(ctx, unit, observed);
        row = ctx.recordAbsent(file);
      }
      const parsed = row.absent ? {} : environmentFile(row.content); validateEnvironment(parsed);
      delete row.content; envFiles.set(file, row); envValues.set(file, parsed);
    }
    if (envFiles.get(file).absent) conditionalEnvironment = proveInactiveConditionalUpload(ctx, unit, observed);
  }
  const config = stableUnitConfiguration(observed);
  const record = { unit, configurationSha256: digest(config), fragments: fileRows, environmentFiles: environmentPaths,
    environmentSha256: digest(Object.keys(env).sort().map(key => [key, env[key]])),
    ...(conditionalEnvironment ? { conditionalEnvironment } : {}) };
  const effectiveEnvironment = Object.assign({}, env, ...environmentPaths.map(file => envValues.get(file)));
  validateEnvironment(effectiveEnvironment);
  return { record, environment: effectiveEnvironment, conditionalEnvironment };
}
function captureProcess(ctx, unit, state) {
  const pid = Number(state.MainPID), entry = boundary.ENTRYPOINTS[unit];
  if (state.ActiveState !== "active" || state.SubState !== "running" || !Number.isSafeInteger(pid) || pid < 1 ||
      !/^[0-9a-f]{32}$/.test(state.InvocationID)) fail("required-runtime-service-not-running");
  const procRead = (name, max = LIMITS.procBytes) => {
    if (ctx.fixture) {
      const data = fs.readFileSync(ctx.local("/fixture/proc/" + pid + "/" + name)); if (data.length > max) fail("proc-byte-limit"); return data;
    }
    const file = "/proc/" + pid + "/" + name, fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const buffer = Buffer.alloc(max + 1); let offset = 0, count;
      while (offset < buffer.length && (count = fs.readSync(fd, buffer, offset, buffer.length - offset, null)) > 0) offset += count;
      if (offset > max) fail("proc-byte-limit"); return buffer.subarray(0, offset);
    } finally { fs.closeSync(fd); }
  };
  const exe = ctx.fixture ? procRead("exe").toString("utf8") : fs.readlinkSync("/proc/" + pid + "/exe");
  if (exe !== NODE) fail("active-runtime-node-executable-mismatch");
  const argsBytes = procRead("cmdline"), expectedArgs = [NODE, APP + "/" + entry.script, ...(entry.args.trim() ? entry.args.trim().split(" ") : [])];
  if (!argsBytes.equals(Buffer.from(expectedArgs.join("\0") + "\0"))) fail("active-runtime-command-line-mismatch");
  const envBytes = procRead("environ");
  if (!envBytes.length || envBytes.at(-1) !== 0) fail("invalid-proc-environment");
  const env = environmentPairs(envBytes.toString("utf8").slice(0, -1).split("\0")); validateEnvironment(env);
  const statBefore = procRead("stat").toString("utf8"), parts = statBefore.slice(statBefore.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(parts[19] || "")) fail("invalid-proc-start-identity");
  const stable = { unit, exeSha256: ctx.readFile(NODE).sha256, cmdlineSha256: sha(argsBytes), environmentSha256: digest(stableEnvironment(env, pid)) };
  return { stable, environment: env, observation: { unit, pid, invocationId: state.InvocationID, processStartTicks: parts[19],
    rawEnvironmentSha256: sha(envBytes) }, recheck() {
    if (!procRead("cmdline").equals(argsBytes) || !procRead("environ").equals(envBytes) ||
        procRead("stat").toString("utf8").slice(statBefore.lastIndexOf(")") + 2).trim().split(/\s+/)[19] !== parts[19] ||
        (ctx.fixture ? procRead("exe").toString("utf8") : fs.readlinkSync("/proc/" + pid + "/exe")) !== NODE)
      fail("active-runtime-process-changed-during-capture");
  } };
}

function capture(input, fixtureRoot = null) {
  const observations = { checkedAt: new Date().toISOString(), fixtureOnly: fixtureRoot !== null, services: [],
    excludedTransientEnvironmentKeys: [...TRANSIENT_ENV], productionWrites: 0 };
  try {
    if (!exactKeys(input, ["baselineInventory", "baselineRoot"])) fail("exact-installed-runtime-input-required");
    if (!fixtureRoot && (process.platform !== "linux" || process.getuid() !== 0 || process.execPath !== NODE)) fail("fixed-root-linux-node-required");
    const ctx = makeContext(fixtureRoot);
    if (!path.isAbsolute(input.baselineRoot) || fs.realpathSync(input.baselineRoot) !== path.resolve(input.baselineRoot)) fail("plain-sealed-baseline-required");
    if (!fixtureRoot) { ctx.ancestors(path.join(input.baselineRoot, "sentinel")); ctx.safeStat(input.baselineRoot, true); }
    const inspected = boundary.inspectFrontendRuntimeBoundary({ root: input.baselineRoot, inventory: input.baselineInventory,
      authenticatedInventoryHash: input.baselineInventory.treeHash });
    if (!inspected.ok) fail("reviewed-baseline-runtime-boundary-failed");
    const runtimeClosureHash = digest(Object.fromEntries(["files", "imports", "npmEdges", "commands", "dynamicImports", "workers", "externalImports"].map(key => [key, inspected[key]])));
    const sources = inspected.files.map(expected => {
      const actual = ctx.readFile(APP + "/" + expected.path, 8 * 1024 * 1024);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail("installed-runtime-source-differs-from-original-baseline");
      return actual;
    });
    const externalScripts = Object.values(boundary.EXTERNAL_UNITS).map(entry => {
      const original = inspected.files.find(row => row.path === entry.source), actual = ctx.readFile(entry.executable, 1024 * 1024);
      if (!original || actual.sha256 !== original.sha256 || actual.bytes !== original.bytes) fail("installed-external-unit-script-drift"); return actual;
    });
    const node = ctx.readFile(NODE); if (!ctx.windows && !(node.mode & 0o111)) fail("fixed-node-not-executable");
    const dependencies = captureDependencyTree(ctx, APP + "/node_modules"), npm = captureDependencyTree(ctx, NPM_ROOT);
    const commandRows = COMMANDS.map(name => ctx.command(name));
    const systemctl = ctx.readFile("/usr/bin/systemctl"), busctl = ctx.readFile("/usr/bin/busctl");
    commandRows.push({ name: "coscli", ...ctx.readFile("/usr/local/bin/coscli") });
    const runtimeEnv = ctx.readFile(RUNTIME_ENV, LIMITS.configBytes, true), runtimeEnvValues = environmentFile(runtimeEnv.content);
    validateEnvironment(runtimeEnvValues); delete runtimeEnv.content;
    const envFiles = new Map([[RUNTIME_ENV, runtimeEnv]]), envValues = new Map([[RUNTIME_ENV, runtimeEnvValues]]);
    const unitStates = [], units = [], processes = [], environments = [];
    for (const unit of UNITS) {
      const state = readUnit(ctx, unit), inspectedUnit = inspectUnit(ctx, unit, state, envFiles, envValues);
      unitStates.push({ unit, state, conditionalEnvironment: inspectedUnit.conditionalEnvironment }); units.push(inspectedUnit.record); environments.push(inspectedUnit.environment);
      if (["football-predict.service", "football-sync-worker.service"].includes(unit)) {
        const process = captureProcess(ctx, unit, state); processes.push(process); environments.push(process.environment); observations.services.push(process.observation);
      }
    }
    const pathResolutions = [];
    for (const envPath of [...new Set(environments.map(env => env.PATH || FIXED_PATH))].sort()) {
      pathResolutions.push({ pathSha256: sha(envPath), commands: COMMANDS.map(name => ctx.command(name, envPath)) });
    }
    for (const { unit, state, conditionalEnvironment } of unitStates) {
      const after = readUnit(ctx, unit);
      if (!sameUnitObservation(unit, state, after)) fail("systemd-runtime-changed-during-capture");
      if (conditionalEnvironment) proveInactiveConditionalUpload(ctx, unit, after);
    }
    for (const process of processes) process.recheck(); dependencies.recheck(); npm.recheck(); ctx.recheck();
    const binding = { version: VERSION, assurance: fixtureRoot ? "isolated-filesystem-fixture" : "fixed-root-systemd-proc-v1",
      policyHash: POLICY_HASH, runtimeClosureHash, baselineInventoryHash: input.baselineInventory.treeHash,
      sources, externalScripts, node, systemctl, busctl, dependenciesSha256: digest(dependencies.rows), npmSha256: digest(npm.rows), commands: commandRows,
      units, environmentFiles: [...envFiles.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
      activeProcesses: processes.map(process => process.stable), pathResolutions };
    observations.runtimeSourceFiles = sources.length; observations.installedDependencyMembers = dependencies.rows.length;
    observations.installedNpmMembers = npm.rows.length; observations.capture = ctx.counts();
    observations.inactiveConditionalUnits = unitStates.filter(row => row.conditionalEnvironment).map(row => row.unit);
    observations.componentHashes = { sourceSha256: digest(sources), dependencySha256: binding.dependenciesSha256,
      npmSha256: binding.npmSha256, systemdSha256: digest(units), environmentFilesSha256: digest(binding.environmentFiles),
      activeEnvironmentSha256: digest(binding.activeProcesses), commandsSha256: digest({ commandRows, pathResolutions }) };
    return { version: VERSION, ok: true, installedRuntimeSha256: digest(binding), runtimeClosureHash, observations, blockers: [],
      authorizationGranted: false, externalProgramBehaviorVerified: false };
  } catch (error) {
    // Bounded path-only diagnostics; never emit environment contents, command
    // output or arbitrary exception text from an installed-runtime capture.
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code) && typeof error.path === "string"
        && /^\/(?:etc|usr|opt|run|var)\/[A-Za-z0-9_.+@/-]{1,240}$/.test(error.path))
      observations.failedPath = error.path;
    return { version: VERSION, ok: false, installedRuntimeSha256: null, runtimeClosureHash: null, observations,
      blockers: [error.runtimeCode || (typeof error.code === "string" ? error.code : "installed-runtime-invalid-input-or-observation")],
      authorizationGranted: false, externalProgramBehaviorVerified: false };
  }
}
function captureInstalledFrontendRuntime(input) {
  if (arguments.length !== 1) fail("exact-installed-runtime-input-required");
  return capture(input);
}
function createInstalledFrontendRuntimeFixture() {
  if (arguments.length) fail("installed-runtime-fixture-does-not-accept-paths");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "football-installed-runtime-")); fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, "host"), { mode: 0o755 });
  const original = fs.lstatSync(root, { bigint: true });
  const at = logical => makeContext(root).local(logical);
  return Object.freeze({ root, at, capture: input => capture(input, root), posixMetadataEnforced: process.platform !== "win32",
    dispose() {
      const stat = fs.lstatSync(root, { bigint: true });
      if (stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino || fs.realpathSync(root) !== root) fail("fixture-root-changed");
      fs.rmSync(root, { recursive: true, force: false });
    } });
}
module.exports = { VERSION, POLICY_HASH, APP, NODE, NPM_ROOT, FIXED_PATH, RUNTIME_ENV, UNITS, COMMANDS,
  TRANSIENT_ENV, CONFIG_FIELDS, OBSERVATION_FIELDS, CREDENTIAL_SIGNATURES, OMITTED_ARRAY_SIGNATURES, LIMITS, AWK_ALTERNATIVE, captureInstalledFrontendRuntime, createInstalledFrontendRuntimeFixture };
