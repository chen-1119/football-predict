"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const runtime = require("./frontendInstalledRuntime.cjs");
const boundary = require("./frontendRuntimeBoundary.cjs");
const { captureReleaseSourceInventory } = require("./releaseChangeClassification.cjs");

function verifyInstalledSystemdContracts() {
  const source = fs.readFileSync(path.join(__dirname, "frontendInstalledRuntime.cjs"), "utf8"), unit = "football-sync-worker.service";
  const expectedObject = "/org/freedesktop/systemd1/unit/football_2dsync_2dworker_2eservice";
  const values = Object.fromEntries([...runtime.CONFIG_FIELDS, ...runtime.OBSERVATION_FIELDS].map(key => [key, ""]));
  Object.assign(values, { Id: unit, LoadState: "loaded", NeedDaemonReload: "no", FragmentPath: "/etc/systemd/system/" + unit,
    ExecStart: "{ path=" + runtime.NODE + " ; argv[]=" + runtime.NODE + " " + runtime.APP + "/scripts/runSyncWorker.cjs --loop ; ignore_errors=no ; pid=101 ; }",
    User: "football", Group: "football", WorkingDirectory: runtime.APP, DynamicUser: "no" });
  for (const key of Object.keys(runtime.CREDENTIAL_SIGNATURES)) values[key] = "[unprintable]";
  let credentialOverride = null, objectOverride = null, showOverride = null, showTextOverride = null, arrayOverride = null, calls = [], files = [];
  const context = { module: { exports: {} }, __dirname, process, Buffer, setTimeout, clearTimeout,
    require: name => name === "node:child_process" ? { spawnSync(command, args) {
      calls.push({ command, args }); assert.equal(args.includes("--no-pager"), true);
      if (command === "/usr/bin/systemctl") {
        assert.equal(args.includes("--all"), true); assert.equal(args.at(-1), unit);
        return { status: 0, stdout: showTextOverride ?? Object.entries(showOverride || values).map(([k, v]) => k + "=" + v).join("\n") + "\n" };
      }
      assert.equal(command, "/usr/bin/busctl"); assert.equal(args[0], "--system");
      if (args[2] === "call") { assert.deepEqual(Array.from(args.slice(3)), ["org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit]);
        return { status: 0, stdout: objectOverride || 'o "' + expectedObject + '"\n' }; }
      assert.deepEqual(Array.from(args.slice(2, -1)), ["get-property", "org.freedesktop.systemd1", expectedObject, "org.freedesktop.systemd1.Service"]);
      if (Object.hasOwn(runtime.OMITTED_ARRAY_SIGNATURES, args.at(-1)) && arrayOverride) return arrayOverride;
      return credentialOverride || { status: 0, stdout: { ...runtime.CREDENTIAL_SIGNATURES, ...runtime.OMITTED_ARRAY_SIGNATURES }[args.at(-1)] + " 0\n" };
    } } : require(name),
  };
  vm.runInNewContext(source + "\nmodule.exports.unitForFixture=readUnit;module.exports.inspectForFixture=inspectUnit;module.exports.sameForFixture=sameUnitObservation;", context);
  const ctx = { fixture: false, readFile: file => { files.push(file); return { path: file, sha256: "a".repeat(64), content: Buffer.from("") }; } };
  const read = () => context.module.exports.unitForFixture(ctx, unit);
  const inspect = state => context.module.exports.inspectForFixture(ctx, unit, state, new Map(), new Map());
  const checks = [];
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  check("actual systemd transport requires --all and typed empty credentials resolved through the exact manager unit", () => {
    const observed = read(); assert.equal(calls.length, 6); inspect(observed);
    for (const [key, signature] of Object.entries(runtime.CREDENTIAL_SIGNATURES)) assert.equal(observed[key], signature + " 0");
    for (const override of [{ status: 0, stdout: 'a(ss) 1 "secret-id" "private-secret-content"\n' },
      { status: 0, stdout: "as 0\n" }, { status: 0, stdout: "a(say) 0\n" }, { status: 1, stdout: "private-error-content" }]) {
      credentialOverride = override; assert.throws(read, error => !error.message.includes("private") && /credentials|credential-observation/.test(error.message));
    }
    credentialOverride = null; objectOverride = 'o "/org/freedesktop/systemd1/unit/unknown"\n';
    assert.throws(read, /unit-object-mismatch/); objectOverride = null;
    showOverride = { ...values }; delete showOverride.User; assert.throws(read, /missing-systemd-show-field/); showOverride = null;
  });
  check("omitted command and environment-file arrays require exact typed D-Bus emptiness, never inferred defaults", () => {
    showOverride = { ...values };
    for (const key of Object.keys(runtime.OMITTED_ARRAY_SIGNATURES)) delete showOverride[key];
    const result = read();
    for (const key of Object.keys(runtime.OMITTED_ARRAY_SIGNATURES)) assert.equal(result[key], "");
    inspect(result);
    for (const response of [{ status: 0, stdout: 'a(sasbttttuii) 1 "private-command"\n' },
      { status: 0, stdout: "as 0\n" }, { status: 0, stdout: "a(sb) 0\n" }, { status: 1, stdout: "private-error" }]) {
      arrayOverride = response; assert.throws(read, error => !error.message.includes("private") && /credential/.test(error.message));
    }
    arrayOverride = null; showOverride = { ...values }; delete showOverride.EnvironmentFiles;
    assert.equal(read().EnvironmentFiles, "");
    arrayOverride = { status: 0, stdout: "a(sasbttttuii) 0\n" }; assert.throws(read, /credential/);
    arrayOverride = null; showOverride = null;
  });
  check("systemctl repeated EnvironmentFiles preserve order while other duplicates and repeated paths fail", () => {
    const prefix = Object.entries(values).filter(([key]) => key !== "EnvironmentFiles").map(([key, value]) => key + "=" + value).join("\n") + "\n";
    showTextOverride = prefix + "EnvironmentFiles=/etc/football-predict/env (ignore_errors=no)\nEnvironmentFiles=/etc/football-predict/worker.env (ignore_errors=no)\n";
    const value = read(); assert.equal(value.EnvironmentFiles, "/etc/football-predict/env (ignore_errors=no) /etc/football-predict/worker.env (ignore_errors=no)");
    assert.deepEqual(Array.from(inspect(value).record.environmentFiles), ["/etc/football-predict/env", "/etc/football-predict/worker.env"]);
    showTextOverride += "EnvironmentFiles=/etc/football-predict/env (ignore_errors=no)\n"; assert.throws(() => inspect(read()), /duplicate-environment-file/);
    showTextOverride = prefix + "EnvironmentFiles=\nEnvironmentFiles=/etc/football-predict/env (ignore_errors=no)\n"; assert.throws(read, /invalid-systemd-show-contract/);
    showTextOverride = prefix + "EnvironmentFiles=\nUser=football\n"; assert.throws(read, /invalid-systemd-show-contract/);
    showTextOverride = null;
  });
  check("actual unit parser binds only exact root-owned system.control unit dropins and rejects adjacent or nested paths", () => {
    const state = read(), root = "/run/systemd/system.control/" + unit + ".d/";
    state.DropInPaths = ["50-MemoryHigh.conf", "50-MemoryMax.conf", "50-MemorySwapMax.conf"].map(name => root + name).join(" ");
    files = []; const accepted = inspect(state); assert.equal(accepted.record.fragments.length, 4); assert.equal(files.length, 4);
    for (const file of [root + "nested/bad.conf", root.replace(unit, "other.service") + "50-MemoryMax.conf",
      root.replace("/run/", "/tmp/") + "50-MemoryMax.conf", root + "../50-MemoryMax.conf"])
      assert.throws(() => inspect({ ...state, DropInPaths: file }), /fragment-path/);
    assert.throws(() => inspect({ ...state, FragmentPath: "/run/systemd/system.control/" + unit }), /fragment-path/);
  });
  check("oneshot observation churn is excluded but every configuration field and primary process observation stays bound", () => {
    const before = read(), after = { ...before, MainPID: "202", InvocationID: "b".repeat(32), ActiveState: "active", SubState: "running",
      ExecStart: before.ExecStart.replace("pid=101", "pid=202 ; start_time=[new time]") };
    const same = context.module.exports.sameForFixture;
    assert.equal(same("football-monitor.service", before, after), true);
    for (const key of runtime.CONFIG_FIELDS) {
      const changed = { ...after, [key]: key === "ExecStart" ? after.ExecStart.replace("ignore_errors=no", "ignore_errors=yes") : after[key] + "changed" };
      assert.equal(same("football-monitor.service", before, changed), false, key);
    }
    for (const active of ["football-predict.service", "football-sync-worker.service"]) {
      assert.equal(same(active, before, after), false);
      for (const key of runtime.OBSERVATION_FIELDS) assert.equal(same(active, before, { ...before, [key]: before[key] + "changed" }), false, key);
      assert.equal(same(active, before, { ...before, ExecStart: after.ExecStart }), true);
    }
  });
  return { ok: true, verifier: "frontend-installed-systemd-contracts-v1", checks: checks.length, results: checks,
    verificationScope: "systemd-vm-contracts-only", platform: process.platform, linuxFilesystemProof: false,
    fullInstalledRuntimeProofRequired: true, signingEligible: false, realSystemdExecuted: false,
    actualTransportAndParserExecuted: true, transportMocked: true, productionWrites: 0 };
}

function verifyFrontendInstalledRuntime() {
  const startedAt = Date.now(), fixture = runtime.createInstalledFrontendRuntimeFixture(), checks = [], skipped = [];
  const repository = path.resolve(__dirname, ".."), baselineRoot = path.join(fixture.root, "baseline");
  const mkdir = directory => fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const write = (file, bytes, mode = 0o644) => { mkdir(path.dirname(file)); fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); };
  const logicalWrite = (file, bytes, mode) => write(fixture.at(file), bytes, mode);
  const copy = (from, to) => {
    const stat = fs.lstatSync(from); if (stat.isSymbolicLink()) throw new Error("fixture-source-is-linked");
    if (stat.isDirectory()) { mkdir(to); for (const name of fs.readdirSync(from)) if (!["node_modules", "outputs", ".git"].includes(name)) copy(path.join(from, name), path.join(to, name)); }
    else if (stat.isFile() && /\.(cjs|js|mjs|ts|tsx|json|css|service|sh)$/.test(from) && stat.size <= 8 * 1024 * 1024) write(to, fs.readFileSync(from));
  };
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const states = new Map();
  const saveUnit = (unit, state) => logicalWrite("/fixture/units/" + unit + ".show", Object.entries(state).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  const saveProcess = (unit, pid, invocation, secret = "secret-that-must-not-be-printed") => {
    const entry = boundary.ENTRYPOINTS[unit], prefix = "/fixture/proc/" + pid;
    logicalWrite(prefix + "/exe", runtime.NODE);
    logicalWrite(prefix + "/cmdline", Buffer.from([runtime.NODE, runtime.APP + "/" + entry.script,
      ...(entry.args.trim() ? entry.args.trim().split(" ") : [])].join("\0") + "\0"));
    logicalWrite(prefix + "/environ", Buffer.from(["PATH=" + runtime.FIXED_PATH, "APP_SECRET=" + secret,
      "INVOCATION_ID=" + invocation, "SYSTEMD_EXEC_PID=" + pid, "JOURNAL_STREAM=9:" + pid].join("\0") + "\0"));
    logicalWrite(prefix + "/stat", pid + " (node) S " + Array(18).fill("0").join(" ") + " " + (10000 + pid) + " 0 0\n");
  };
  try {
    mkdir(baselineRoot);
    for (const directory of ["server", "scripts", "src", "deploy/light-server", "cloudflare/sync-trigger/src"])
      copy(path.join(repository, directory), path.join(baselineRoot, directory));
    for (const file of ["package.json", "package-lock.json"]) write(path.join(baselineRoot, file), fs.readFileSync(path.join(repository, file)));
    fs.cpSync(baselineRoot, fixture.at(runtime.APP), { recursive: true });
    const baselineInventory = captureReleaseSourceInventory(baselineRoot), input = { baselineRoot, baselineInventory };
    for (const entry of Object.values(boundary.EXTERNAL_UNITS)) logicalWrite(entry.executable, fs.readFileSync(path.join(baselineRoot, entry.source)), 0o755);
    for (const name of runtime.COMMANDS) if (!["node", "npm"].includes(name)) logicalWrite("/usr/bin/" + name, "fixture-binary-" + name, 0o755);
    logicalWrite(runtime.NODE, "fixture-pinned-node-binary", 0o755);
    logicalWrite("/usr/local/bin/coscli", "fixture-coscli-binary", 0o755);
    logicalWrite(runtime.NPM_ROOT + "/package.json", JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }));
    logicalWrite(runtime.NPM_ROOT + "/bin/npm-cli.js", "fixture-npm-cli", 0o755);
    // A real npm launcher symlink, never a fixture-only pretend resolution.
    try { fs.symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", fixture.at("/opt/node-v22.22.1/bin/npm"), "file"); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
      return { ok: false, requiresLinuxOrWindowsSymlinkPrivilege: true, checks: 0,
        reason: "real npm launcher symlink fixture cannot be created; no fake production success emitted", productionWrites: 0 };
    }
    logicalWrite(runtime.APP + "/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0", bin: { example: "cli.js" } }));
    logicalWrite(runtime.APP + "/node_modules/example/cli.js", "fixture-cli-byte-1", 0o755);
    logicalWrite(runtime.APP + "/node_modules/example/nested/empty.txt", "");
    mkdir(fixture.at(runtime.APP + "/node_modules/.bin"));
    fs.symlinkSync("../example/cli.js", fixture.at(runtime.APP + "/node_modules/.bin/example"), "file");
    logicalWrite(runtime.RUNTIME_ENV, "APP_SECRET=runtime-private-value\nPATH=" + runtime.FIXED_PATH + "\n");
    logicalWrite("/etc/football-predict/cos-backup.env", "COS_SECRET_KEY=private-cos-value\n");
    let nextPid = 101;
    for (const unit of runtime.UNITS) {
      const entry = boundary.ENTRYPOINTS[unit], external = boundary.EXTERNAL_UNITS[unit];
      const active = ["football-predict.service", "football-sync-worker.service"].includes(unit), pid = active ? nextPid++ : 0;
      const state = Object.fromEntries([...runtime.CONFIG_FIELDS, ...runtime.OBSERVATION_FIELDS].map(key => [key, ""]));
      Object.assign(state, { Id: unit, LoadState: "loaded", NeedDaemonReload: "no", FragmentPath: "/etc/systemd/system/" + unit,
        ExecStart: "{ path=" + (entry ? runtime.NODE : external.executable) + " ; argv[]=" +
          (entry ? runtime.NODE + " " + runtime.APP + "/" + entry.script + entry.args : external.executable) +
          " ; ignore_errors=no ; start_time=[fixture] ; stop_time=[n/a] ; pid=" + pid + " ; code=(null) ; status=0/0 }",
        User: entry ? "football" : "postgres", Group: "football", WorkingDirectory: entry ? runtime.APP : "", DynamicUser: "no",
        Environment: "PATH=" + runtime.FIXED_PATH, ActiveState: active ? "active" : "inactive", SubState: active ? "running" : "dead",
        MainPID: String(pid), InvocationID: active ? "a".repeat(32) : "", StandardInput: "null", StandardOutput: "journal", StandardError: "inherit" });
      if (active) state.EnvironmentFiles = runtime.RUNTIME_ENV + " (ignore_errors=no)";
      if (unit === "football-postgres-cos-upload.service") state.EnvironmentFiles = "/etc/football-predict/cos-backup.env (ignore_errors=no)";
      logicalWrite(state.FragmentPath, fs.readFileSync(path.join(baselineRoot, "deploy/light-server", unit)));
      for (const [key, signature] of Object.entries(runtime.CREDENTIAL_SIGNATURES)) {
        state[key] = "[unprintable]";
        logicalWrite("/fixture/units/" + unit + "." + key + ".bus", signature + " 0\n");
      }
      if (unit === "football-sync-worker.service") {
        state.DropInPaths = "/run/systemd/system.control/" + unit + ".d/50-MemoryMax.conf";
        logicalWrite(state.DropInPaths, "[Service]\nMemoryMax=805306368\n");
      }
      states.set(unit, state); saveUnit(unit, state); if (active) saveProcess(unit, pid, state.InvocationID);
    }
    const capture = () => fixture.capture(input);
    let original;
    check("real reviewed source closure and complete installed fixture dependency members produce a stable nonauthorizing binding", () => {
      original = capture(); assert.equal(original.ok, true, JSON.stringify(original));
      assert.ok(original.observations.runtimeSourceFiles > 100); assert.equal(original.authorizationGranted, false);
      assert.equal(original.externalProgramBehaviorVerified, false); assert.equal(original.observations.fixtureOnly, true);
      assert.equal(capture().installedRuntimeSha256, original.installedRuntimeSha256);
    });
    check("PID InvocationID journal stream process start and observation time never become long-lived identity", () => {
      const unit = "football-predict.service", state = states.get(unit);
      state.MainPID = "303"; state.InvocationID = "b".repeat(32);
      state.ExecStart = state.ExecStart.replace("pid=101", "pid=303").replace("[fixture]", "[new-observed-time]");
      saveUnit(unit, state); saveProcess(unit, 303, state.InvocationID);
      const result = capture(); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.installedRuntimeSha256, original.installedRuntimeSha256);
      assert.equal(result.observations.services.find(row => row.unit === unit).pid, 303);
    });
    check("business environment changes alter the binding without exposing values", () => {
      saveProcess("football-predict.service", 303, "b".repeat(32), "changed-private-business-value");
      const result = capture(); assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.installedRuntimeSha256, original.installedRuntimeSha256);
      assert.equal(JSON.stringify(result).includes("changed-private-business-value"), false);
      saveProcess("football-predict.service", 303, "b".repeat(32));
    });
    const mutate = (logical, change, fn) => {
      const file = fixture.at(logical), before = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
      write(file, change(before), mode); try { fn(capture()); } finally { write(file, before, mode); }
    };
    check("installed source drift fails rather than redefining the original baseline", () => mutate(runtime.APP + "/server/index.cjs",
      bytes => Buffer.concat([bytes, Buffer.from("\n// unauthorized runtime change\n")]), result => {
        assert.equal(result.ok, false); assert.equal(result.installedRuntimeSha256, null);
        assert.ok(result.blockers.includes("installed-runtime-source-differs-from-original-baseline"));
      }));
    check("external operational script bytes remain bound to original source", () => mutate("/usr/local/sbin/football-postgres-backup",
      bytes => Buffer.concat([bytes, Buffer.from("\n# changed\n")]), result => assert.ok(result.blockers.includes("installed-external-unit-script-drift"))));
    check("entire installed dependency tree file bytes and membership affect identity", () => {
      mutate(runtime.APP + "/node_modules/example/cli.js", () => Buffer.from("fixture-cli-byte-2"), result => {
        assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.installedRuntimeSha256, original.installedRuntimeSha256);
      });
      const added = runtime.APP + "/node_modules/example/unexpected.js"; logicalWrite(added, "added-module");
      const result = capture(); assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.installedRuntimeSha256, original.installedRuntimeSha256);
      fs.unlinkSync(fixture.at(added));
    });
    check("legal npm bin targets must agree with the containing package declaration", () => mutate(runtime.APP + "/node_modules/example/package.json",
      () => Buffer.from(JSON.stringify({ name: "example", bin: { other: "cli.js" } })), result => assert.ok(result.blockers.includes("npm-bin-not-declared-by-package"))));
    check("all EnvironmentFiles and inline resolved configuration affect binding without plaintext output", () => {
      mutate("/etc/football-predict/cos-backup.env", () => Buffer.from("COS_SECRET_KEY=changed-cos-private-value\n"), result => {
        assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.installedRuntimeSha256, original.installedRuntimeSha256);
        assert.equal(JSON.stringify(result).includes("changed-cos-private-value"), false);
      });
      const unit = "football-monitor.service", state = states.get(unit), previous = state.Environment;
      state.Environment += ' "MONITOR_LABEL=reviewed stable label"'; saveUnit(unit, state);
      assert.notEqual(capture().installedRuntimeSha256, original.installedRuntimeSha256); state.Environment = previous; saveUnit(unit, state);
    });
    check("unknown startup paths and exec hooks stale units and missing resolved fields fail closed", () => {
      const unit = "football-monitor.service", before = states.get(unit);
      for (const change of [{ ExecStart: before.ExecStart.replace(runtime.NODE, "/tmp/unknown-node") }, { ExecStartPre: "/usr/bin/unknown" },
        { NeedDaemonReload: "yes" }, { User: "root" }, { Environment: "PATH=/tmp:/usr/bin" }, { Environment: '"NODE_OPTIONS=--require /tmp/loader.cjs"' }]) {
        saveUnit(unit, { ...before, ...change }); assert.equal(capture().ok, false, JSON.stringify(change));
      }
      const missing = { ...before }; delete missing.ExecSearchPath; saveUnit(unit, missing);
      assert.equal(capture().ok, false); saveUnit(unit, before);
    });
    check("optional-marked missing EnvironmentFiles and nonrunning primary service remain blockers", () => {
      const unit = "football-monitor.service", before = states.get(unit);
      saveUnit(unit, { ...before, EnvironmentFiles: "/etc/football-predict/missing.env (ignore_errors=yes)" }); assert.equal(capture().ok, false); saveUnit(unit, before);
      const active = "football-predict.service", state = states.get(active);
      saveUnit(active, { ...state, ActiveState: "inactive", SubState: "dead" }); assert.equal(capture().ok, false); saveUnit(active, state);
    });
    check("only the exact inactive condition-gated COS unit can bind absent configuration, never inventing credentials", () => {
      const unit = "football-postgres-cos-upload.service", logical = "/etc/football-predict/cos-backup.env";
      const file = fixture.at(logical), before = fs.readFileSync(file), state = states.get(unit);
      const conditionPath = "/fixture/units/" + unit + ".Conditions.bus";
      const condition = 'a(sbbsi) 1 "ConditionPathExists" false false "/etc/football-predict/cos-backup.env" 0\n';
      logicalWrite(conditionPath, condition); fs.unlinkSync(file);
      try {
        const absent = capture(); assert.equal(absent.ok, true, JSON.stringify(absent));
        assert.deepEqual(absent.observations.inactiveConditionalUnits, [unit]);
        assert.notEqual(absent.installedRuntimeSha256, original.installedRuntimeSha256);
        for (const invalid of [condition.replace('false false', 'false true'), condition.replace(' 1 ', ' 2 '),
          condition.replace('cos-backup.env', 'other.env'), 'a(sbbsi) 0\n']) {
          logicalWrite(conditionPath, invalid); assert.equal(capture().ok, false);
        }
        logicalWrite(conditionPath, condition);
        saveUnit(unit, { ...state, ActiveState: "active", MainPID: "404" }); assert.equal(capture().ok, false); saveUnit(unit, state);
        logicalWrite(logical, before); const configured = capture(); assert.equal(configured.ok, true, JSON.stringify(configured));
        assert.notEqual(configured.installedRuntimeSha256, absent.installedRuntimeSha256);
      } finally { logicalWrite(logical, before); saveUnit(unit, state); }
    });
    check("fixed root production API cannot accept caller policy or paths", () => {
      assert.equal(runtime.captureInstalledFrontendRuntime({ ...input, app: fixture.at(runtime.APP) }).ok, false);
      assert.throws(() => runtime.createInstalledFrontendRuntimeFixture({ root: "/opt" }));
      if (process.platform !== "linux" || process.getuid() !== 0 || process.execPath !== runtime.NODE)
        assert.ok(runtime.captureInstalledFrontendRuntime(input).blockers.includes("fixed-root-linux-node-required"));
    });
    if (process.platform !== "win32") {
      check("actual POSIX writable modes hardlinks and linked installed source reject", () => {
        const file = fixture.at(runtime.APP + "/server/index.cjs"), alias = fixture.at(runtime.APP + "/source-alias");
        fs.chmodSync(file, 0o664); assert.equal(capture().ok, false); fs.chmodSync(file, 0o644);
        fs.chmodSync(file, 0o444); const normalized = capture(); assert.equal(normalized.ok, true, JSON.stringify(normalized));
        assert.notEqual(normalized.installedRuntimeSha256, original.installedRuntimeSha256); fs.chmodSync(file, 0o644);
        if (process.getuid() === 0) { fs.chownSync(file, 65534, 65534); assert.equal(capture().ok, false); fs.chownSync(file, 0, 0); }
        fs.linkSync(file, alias); assert.equal(capture().ok, false); fs.unlinkSync(alias);
        fs.renameSync(file, alias); fs.symlinkSync(alias, file); assert.equal(capture().ok, false); fs.unlinkSync(file); fs.renameSync(alias, file);
      });
    } else skipped.push("POSIX root-owner and permission enforcement require a Linux fixture run");
    return { ok: true, checks: checks.length, results: checks, skipped, elapsedMs: Date.now() - startedAt,
      verificationScope: "installed-runtime-filesystem-fixture", platform: process.platform,
      linuxFilesystemProof: process.platform === "linux", signingEligible: false,
      productionWrites: 0, realSystemdExecuted: false, fixtureOnly: true, externalProgramBehaviorVerified: false };
  } finally { fixture.dispose(); }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 1 && args[0] === "--systemd-contracts-only", "unknown installed runtime verifier arguments");
    const contracts = verifyInstalledSystemdContracts();
    const result = args.length === 1 ? contracts : { ...verifyFrontendInstalledRuntime(), systemdContracts: contracts,
      ...(process.platform === "linux" ? { alternatives: require("./verifyFrontendRuntimeAlternatives.cjs").verifyFrontendRuntimeAlternatives() } : {}) };
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { verifyFrontendInstalledRuntime, verifyInstalledSystemdContracts };
