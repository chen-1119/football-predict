"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const shellBridge = require("./releaseStageShellBridge.cjs"), evidence = require("./releaseStageEvidence.cjs");

async function verifyReleaseStageShellBridge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-stage-bridge-")), checks = [], sha = "a".repeat(64), releaseSequence = 712;
  const uid = process.platform === "win32" ? 0 : process.getuid(), children = new Set(); let counter = 0;
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  function fixture() {
    const sourceRoot = path.join(root, "source-" + ++counter), storeRoot = path.join(root, "store-" + counter);
    fs.mkdirSync(sourceRoot, { mode: 0o700 });
    for (const name of shellBridge.SOURCE_FILES) {
      const file = path.join(sourceRoot, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.resolve(__dirname, "..", name), file); fs.chmodSync(file, 0o600);
    }
    const options = { storeRoot, sourceRoot, expectedUid: uid, controllerPid: process.pid, requireLinux: false, fixtureTrustBoundary: root };
    return { ...options, bridge: shellBridge.createBridge(options) };
  }
  function identity(f) { return JSON.parse(fs.readFileSync(path.join(f.storeRoot, "identities", sha + ".json"), "utf8")); }
  try {
    await check("private atomic identity initialization persists an independent exact run and is idempotent", () => {
      const f = fixture(), first = f.bridge.init(sha, releaseSequence), second = f.bridge.init(sha, releaseSequence);
      assert.equal(first.release.runId, second.release.runId); assert.notEqual(first.release.runId, sha);
      assert.equal(f.bridge.report(sha, releaseSequence).eventCount, 1);
      const record = identity(f); assert.equal(record.release.sha256, sha); assert.equal(record.release.sequence, releaseSequence);
      assert.equal(record.controller.pid, process.pid); assert.equal(record.sourceHash, shellBridge.sourceCommitment(f.sourceRoot, uid, root));
      assert.deepEqual(fs.readdirSync(path.join(f.storeRoot, "identities")), [sha + ".json"]);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(path.join(f.storeRoot, "identities", sha + ".json")).mode & 0o777, 0o600);
        assert.equal(fs.statSync(f.storeRoot).mode & 0o777, 0o700);
      }
    });
    await check("readiness and DB observations retain distinct spans without certifying success", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence);
      for (const phase of ["candidate-readiness", "sqlite-prebuild", "post-swap-readiness"]) {
        f.bridge.begin(sha, releaseSequence, phase); f.bridge.end(sha, releaseSequence, phase, "ok");
      }
      const report = f.bridge.report(sha, releaseSequence);
      assert.equal(report.attempts.length, 4); assert.equal(report.attempts.every(a => a.commandSucceeded === false), true);
      assert.equal(report.reusable, false); assert.equal(report.liveAcceptanceProven, false);
      assert.ok(report.attempts.slice(1).every(a => a.state === "observed-closed" && a.observedOutcome === "ok"));
    });
    await check("repeated begin and end are idempotent while later deliberate attempts append history", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence);
      f.bridge.begin(sha, releaseSequence, "sqlite-prebuild"); f.bridge.begin(sha, releaseSequence, "sqlite-prebuild");
      f.bridge.end(sha, releaseSequence, "sqlite-prebuild", "error"); f.bridge.end(sha, releaseSequence, "sqlite-prebuild", "error");
      assert.throws(() => f.bridge.end(sha, releaseSequence, "sqlite-prebuild", "ok"), /conflicting/);
      f.bridge.begin(sha, releaseSequence, "sqlite-prebuild"); f.bridge.end(sha, releaseSequence, "sqlite-prebuild", "ok");
      assert.deepEqual(f.bridge.report(sha, releaseSequence).attempts.filter(a => a.phase === "sqlite-prebuild").map(a => a.attempt), [1, 2]);
    });
    await check("recovery phase transitions close prior spans only as unknown and never mutate recovery files", () => {
      const f = fixture(), recovery = path.join(root, "recovery-sentinel"); fs.writeFileSync(recovery, "swap-starting\n");
      f.bridge.init(sha, releaseSequence); f.bridge.recovery(sha, releaseSequence, "prepared");
      f.bridge.recovery(sha, releaseSequence, "runtime-env-updated"); f.bridge.recovery(sha, releaseSequence, "runtime-env-updated");
      const report = f.bridge.report(sha, releaseSequence);
      assert.equal(report.attempts.find(a => a.phase === "recovery-prepared").observedOutcome, "unknown");
      assert.equal(report.attempts.filter(a => a.phase === "recovery-runtime-env-updated").length, 1);
      assert.equal(fs.readFileSync(recovery, "utf8"), "swap-starting\n");
    });
    await check("final close preserves the declared observation outcome and marks abandoned phases unknown", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence); f.bridge.begin(sha, releaseSequence, "candidate-readiness");
      f.bridge.finish(sha, releaseSequence, "error"); f.bridge.finish(sha, releaseSequence, "error");
      const report = f.bridge.report(sha, releaseSequence);
      assert.equal(report.attempts[0].observedOutcome, "error"); assert.equal(report.attempts[1].observedOutcome, "unknown");
      assert.equal(report.attempts.every(a => a.finishedAt !== null), true);
      assert.throws(() => f.bridge.begin(sha, releaseSequence, "candidate-readiness"), /already-closed/);
      assert.throws(() => f.bridge.init(sha, releaseSequence), /already-closed/);
      assert.throws(() => f.bridge.finish(sha, releaseSequence, "ok"), /conflicting/);
    });
    await check("wrong SHA sequence and source drift cannot borrow a persisted release identity", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence); const before = identity(f);
      assert.throws(() => f.bridge.begin("b".repeat(64), releaseSequence, "candidate-readiness"), /ENOENT/);
      assert.throws(() => f.bridge.init(sha, releaseSequence + 1), /identity-mismatch/);
      fs.appendFileSync(path.join(f.sourceRoot, "scripts/releaseStageEvidence.cjs"), "\n// changed\n");
      assert.throws(() => f.bridge.begin(sha, releaseSequence, "candidate-readiness"), /drift/);
      assert.deepEqual(identity(f), before); assert.equal(f.bridge.report(sha, releaseSequence).eventCount, 1);
    });
    await check("historical report remains readable after source cleanup without revalidating or writing", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence); f.bridge.finish(sha, releaseSequence, "ok");
      fs.rmSync(f.sourceRoot, { recursive: true });
      const report = f.bridge.report(sha, releaseSequence); assert.equal(report.observationOk, true); assert.equal(report.productionWrites, 0);
      assert.equal(report.attempts[0].state, "observed-closed"); assert.equal(report.liveAcceptanceProven, false);
    });
    await check("interrupted initialization lock remains present and cannot silently create a new run", () => {
      const f = fixture(); fs.mkdirSync(f.storeRoot, { mode: 0o700 }); const identities = path.join(f.storeRoot, "identities"); fs.mkdirSync(identities, { mode: 0o700 });
      const lock = path.join(identities, sha + ".init-lock"); fs.mkdirSync(lock, { mode: 0o700 });
      assert.throws(() => f.bridge.init(sha, releaseSequence), /busy-or-interrupted/);
      assert.equal(fs.existsSync(lock), true); assert.equal(fs.existsSync(path.join(identities, sha + ".json")), false);
    });
    await check("partial or altered identity files are retained and refused instead of overwritten", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence); const file = path.join(f.storeRoot, "identities", sha + ".json");
      const record = identity(f); record.release.sequence++; fs.writeFileSync(file, JSON.stringify(record));
      assert.throws(() => f.bridge.init(sha, releaseSequence), /identity-mismatch/);
      fs.writeFileSync(file, '{"partial":'); assert.throws(() => f.bridge.init(sha, releaseSequence));
      assert.equal(fs.readFileSync(file, "utf8"), '{"partial":');
    });
    await check("exact phase allowlists and strict identifiers reject injected arguments", () => {
      const f = fixture(); f.bridge.init(sha, releaseSequence);
      for (const invalid of ["../../etc/passwd", "phase;echo secret", "", "unknown"]) {
        assert.throws(() => f.bridge.begin(sha, releaseSequence, invalid)); assert.throws(() => f.bridge.recovery(sha, releaseSequence, invalid));
      }
      assert.throws(() => f.bridge.init("A".repeat(64), releaseSequence)); assert.throws(() => f.bridge.init(sha, "0712"));
      assert.throws(() => f.bridge.end(sha, releaseSequence, "candidate-readiness", "succeeded"));
      assert.equal(f.bridge.report(sha, releaseSequence).eventCount, 1);
    });
    await check("CLI fail-open warning does not echo secrets paths arguments or change exit status", () => {
      const secret = "private-token-do-not-print";
      const result = spawnSync(process.execPath, [path.join(__dirname, "releaseStageShellBridge.cjs"), "begin", secret, "712", "/sensitive/path"],
        { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(result.status, 0); const warning = JSON.parse(result.stderr);
      assert.equal(warning.observationOk, false); assert.equal(warning.releaseActionChanged, false);
      assert.equal((result.stdout + result.stderr).includes(secret), false); assert.equal(result.stderr.includes("/sensitive/path"), false);
      assert.equal(warning.reusable, false);
    });
    const releaseShell = fs.readFileSync(path.resolve(__dirname, "../deploy/light-server/release-from-bundle.sh"), "utf8").replace(/\r\n/g, "\n");
    function shellFunction(name) {
      const start = releaseShell.indexOf("\n" + name + "() {");
      assert.ok(start >= 0, name + " missing");
      const end = releaseShell.indexOf("\n}\n", start);
      assert.ok(end > start); return releaseShell.slice(start + 1, end + 2);
    }
    await check("actual shell connects all fixed phase spans and initializes only after its original EXIT trap", () => {
      const beginnings = [...releaseShell.matchAll(/^release_stage_observe begin ([a-z-]+)$/gm)].map(m => m[1]);
      // The PostgreSQL block is indented; include it without accepting arbitrary phase expressions.
      if (/^\s+release_stage_observe begin postgres-projection$/m.test(releaseShell)) beginnings.push("postgres-projection");
      assert.deepEqual([...new Set(beginnings)].sort(), [...shellBridge.PHASES].sort());
      for (const phase of shellBridge.PHASES) assert.match(releaseShell, new RegExp("release_stage_observe end " + phase + " (ok|error)"));
      const init = releaseShell.indexOf('release_stage_observe init "$TRUSTED_SOURCE_DIR"');
      assert.ok(init > releaseShell.indexOf("trap release_exit_trap EXIT"));
      assert.ok(init < releaseShell.lastIndexOf("\ninitialize_release_recovery_snapshot\n"));
      assert.match(shellFunction("release_stage_observe"), /env -i PATH=.*\n\s+"\$NODE_HOME\/bin\/node"/);
      assert.match(shellFunction("release_stage_observe"), /\|\| log "warning: release stage observation unavailable"[\s\S]*return 0/);
      for (const prohibited of ["timeout ", "bash -c", "eval ", "$("]) assert.equal(shellFunction("release_stage_observe").includes(prohibited), false);
    });
    await check("phase telemetry does not replace the readiness database or worker failure branches", () => {
      for (const [phase, required] of [
        ["candidate-readiness", ["scripts/verifyProductionReadiness.cjs", '|| abort_before_swap "candidate production readiness failed"']],
        ["postgres-projection", ["postgres:migrate-schema", "postgres:backfill", '|| rollback "PostgreSQL order-preserving backfill failed"']],
        ["worker-official-wait", ["wait_for_worker_official_publish_after", '|| rollback "sync worker failed to publish official results for this release"']],
        ["worker-enrichment-wait", ["wait_for_worker_readiness_idle_after", '|| rollback "sync worker failed to reach readiness-safe idle for this release"']],
        ["post-swap-readiness", ["scripts/verifyProductionReadiness.cjs", '|| rollback "post-swap production readiness failed"']],
      ]) {
        const start = releaseShell.indexOf("release_stage_observe begin " + phase), end = releaseShell.indexOf("release_stage_observe end " + phase, start);
        assert.ok(start >= 0 && end > start);
        for (const marker of required) assert.ok(releaseShell.slice(start, end).includes(marker), phase + ": " + marker);
      }
      assert.match(shellFunction("write_recovery_phase"), /sync -f "\$RECOVERY_DIR" \|\| return 1\n\s+release_stage_observe recovery "\$phase"/);
      const exitTrap = shellFunction("release_exit_trap");
      assert.ok(exitTrap.indexOf('local status="$?"') < exitTrap.indexOf("release_stage_observe finish"));
      assert.ok(releaseShell.lastIndexOf("release_stage_observe finish ok") > releaseShell.lastIndexOf("commit_release_transaction ||"));
    });
    if (process.platform === "linux") {
      const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
      await check("actual shell helper keeps the same parent PID and leaves a failed original gate failed", () => {
        const sourceRoot = path.join(root, "mock-source"); fs.mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(sourceRoot, "scripts/releaseStageShellBridge.cjs"),
          "console.log(JSON.stringify({ppid:process.ppid,operation:process.argv[2]}));\n", { mode: 0o600 });
        const script = 'set -euo pipefail\nlog() { printf "%s\\n" "$*"; }\n' + shellFunction("release_stage_observe") +
          "\nNODE_HOME=" + quote(path.dirname(path.dirname(process.execPath))) + "\nTRUSTED_SOURCE_DIR=" + quote(sourceRoot) +
          "\nBUNDLE_SHA256=" + quote(sha) + "\nRELEASE_SEQUENCE=712\n" +
          'printf "controller=%s\\n" "$$"\nrelease_stage_observe begin candidate-readiness\nrelease_stage_observe end candidate-readiness ok\n' +
          'false || { printf "original-gate-failed\\n"; exit 23; }\nprintf "unsafe-success\\n"\n';
        const child = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 10000 });
        assert.equal(child.status, 23, child.stderr);
        const lines = child.stdout.trim().split("\n"), controller = Number(lines[0].split("=")[1]);
        assert.equal(JSON.parse(lines[1]).ppid, controller); assert.equal(JSON.parse(lines[2]).ppid, controller);
        assert.equal(lines.at(-1), "original-gate-failed"); assert.equal(child.stdout.includes("unsafe-success"), false);
      });
      await check("actual recovery function still fails before telemetry when durable phase sync fails", () => {
        const recovery = path.join(root, "mock-recovery"); fs.mkdirSync(recovery, { mode: 0o700 });
        const script = 'set -euo pipefail\n' + shellFunction("write_recovery_phase") +
          '\nrelease_stage_observe() { printf "unexpected-observation\\n"; }\nsync() { return 31; }\nchown() { :; }\nchmod() { :; }\nmv() { :; }\n' +
          'mktemp() { printf "%s/temporary\\n" "$RECOVERY_DIR"; }\nRECOVERY_ACTIVE=1\nRECOVERY_DIR=' + quote(recovery) +
          '\nif write_recovery_phase runtime-env-updated; then printf "unsafe-success\\n"; exit 99; else exit 17; fi\n';
        const child = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 10000 });
        assert.equal(child.status, 17, child.stderr); assert.equal(child.stdout, "");
      });
      await check("a different live process cannot impersonate the original root-shell controller", async () => {
        const f = fixture(); f.bridge.init(sha, releaseSequence);
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); children.add(child.pid);
        const closed = new Promise(resolve => child.once("close", resolve)); await new Promise(resolve => child.once("spawn", resolve));
        const other = shellBridge.createBridge({ ...f, controllerPid: child.pid });
        assert.throws(() => other.begin(sha, releaseSequence, "candidate-readiness"), /controller-drift/);
        child.kill("SIGKILL"); await closed; children.delete(child.pid);
      });
      await check("untrusted writable source and journal permissions cannot produce observations", () => {
        const f = fixture(), source = path.join(f.sourceRoot, "scripts/releaseStageShellBridge.cjs");
        fs.chmodSync(source, 0o666); assert.throws(() => f.bridge.init(sha, releaseSequence), /untrusted-source/); fs.chmodSync(source, 0o600);
        f.bridge.init(sha, releaseSequence); fs.chmodSync(f.storeRoot, 0o777);
        assert.throws(() => f.bridge.begin(sha, releaseSequence, "candidate-readiness"), /private/);
      });
      await check("source ancestor outside the source root must also be protected", () => {
        const f = fixture(), ancestor = path.join(root, "unsafe-parent"); fs.mkdirSync(ancestor, { mode: 0o700 });
        const relocated = path.join(ancestor, "source"); fs.renameSync(f.sourceRoot, relocated); fs.chmodSync(ancestor, 0o777);
        const bridge = shellBridge.createBridge({ ...f, sourceRoot: relocated });
        assert.throws(() => bridge.init(sha, releaseSequence), /untrusted-source-directory/);
        assert.throws(() => shellBridge.sourceCommitment(relocated, uid), /untrusted-source-directory/);
      });
      if (uid !== 0) await check("production CLI rejects non-root even with otherwise valid input before creating storage", () => {
        assert.throws(() => shellBridge.createBridge(), /root-recorder-required/);
        const result = spawnSync(process.execPath, [path.join(__dirname, "releaseStageShellBridge.cjs"), "report", sha, "712"], { encoding: "utf8", timeout: 10000 });
        assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).observationOk, false);
      });
    }
    await check("bridge uses no command execution or test reuse and fixed CLI storage outside app trees", () => {
      const source = fs.readFileSync(path.join(__dirname, "releaseStageShellBridge.cjs"), "utf8");
      assert.equal(shellBridge.STORE_ROOT, "/var/lib/football-release/stages");
      for (const forbidden of ["node:child_process", "process.env", "runStage(", "write_recovery_phase(", "clear_release_recovery_snapshot("]) assert.equal(source.includes(forbidden), false);
      assert.equal(evidence.reportStages instanceof Function, true);
    });
  } finally {
    for (const pid of children) { try { process.kill(pid, "SIGKILL"); } catch { /* fixture exited */ } }
    if (!root.startsWith(path.join(os.tmpdir(), "football-stage-bridge-")) || fs.lstatSync(root).isSymbolicLink()) throw new Error("unsafe bridge fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { ok: true, suite: shellBridge.VERSION, platform: process.platform, node: process.version,
    passed: checks.length, checks, realFilesystem: true, productionWrites: 0, fixtureRemoved: !fs.existsSync(root) };
}
module.exports = { verifyReleaseStageShellBridge };
if (require.main === module) verifyReleaseStageShellBridge().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
