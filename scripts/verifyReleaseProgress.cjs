"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { evaluateReleaseProgress: evaluate, buildReadOnlyProgressProbe } = require("./releaseProgress.cjs");

function verifyReleaseProgress() {
  const sha = "a".repeat(64), checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const baseline = { sha, checkedAt: "2026-01-01T01:00:00Z", statusStable: true,
    status: { status: "running", ok: "0", bundleSha256: sha, startedAt: "2026-01-01T00:00:00Z" },
    processes: [{ pid: 123, alive: true }], markers: { app: "b".repeat(64), liveComplete: "b".repeat(64) }, recoveryPending: true,
    services: [], logBytesRead: 300, logTotalBytes: 9000000, logTail: "[football-bundle-release] build candidate inside disposable transient cgroups\n" };
  check("live process plus exact running identity is a verified wait", () => {
    const report = evaluate(baseline); assert.equal(report.runningConfirmed, true); assert.equal(report.state, "running");
    assert.equal(report.transactionComplete, false); assert.equal(report.elapsedSeconds, 3600); assert.equal(report.nextAction, "observe-existing-process");
  });
  check("status and lock alone never prove a running process", () => {
    const report = evaluate({ ...baseline, processes: [] }); assert.equal(report.state, "unconfirmed-running");
    assert.equal(report.runningConfirmed, false); assert.match(report.nextAction, /no-auto-restart/);
  });
  check("dead matching handle is not confirmed live", () => assert.equal(evaluate({ ...baseline, processes: [{ pid: 123, alive: false }] }).runningConfirmed, false));
  check("observation crossing a status change requires another read", () => {
    const report = evaluate({ ...baseline, statusStable: false }); assert.equal(report.state, "observation-changed"); assert.equal(report.runningConfirmed, false);
  });
  check("missing transaction is not successful or permission to dispatch", () => {
    const report = evaluate({ ...baseline, status: null }); assert.equal(report.state, "not-found"); assert.equal(report.transactionComplete, false);
  });
  check("wrong release identity cannot borrow an active process", () => {
    const report = evaluate({ ...baseline, status: { ...baseline.status, bundleSha256: "b".repeat(64) } });
    assert.equal(report.state, "identity-conflict"); assert.equal(report.runningConfirmed, false);
  });
  const complete = { ...baseline, recoveryPending: false, processes: [], markers: { app: sha, liveComplete: sha },
    status: { ...baseline.status, status: "complete", ok: "1", exitCode: "0", finishedAt: "2026-01-01T00:50:00Z" } };
  check("terminal success needs complete identity and still does not prove live acceptance", () => {
    const report = evaluate(complete); assert.equal(report.transactionComplete, true); assert.equal(report.elapsedSeconds, 3000);
    assert.equal(report.liveAcceptanceProven, false); assert.equal(report.sourceValidationExecuted, false); assert.equal(report.nextAction, "run-live-acceptance");
  });
  check("UI completion uses accepted frontend candidate and keeps both runtime markers unchanged", () => {
    const runtimeSha = "b".repeat(64), frontendRelease = { version: "frontend-release-state-v1", kind: "frontend-only", phase: "accepted",
      available: true, consistent: true, runtimeSha256: runtimeSha, runtimeSequence: 711, frontendSha256: sha, frontendSequence: 712,
      indexSha256: "c".repeat(64), distTreeHash: "d".repeat(64), acceptanceSha256: "e".repeat(64) };
    const ui = { ...complete, status: { ...complete.status, releaseKind: "frontend-only", releaseSequence: "712" },
      markers: { app: runtimeSha, liveComplete: runtimeSha }, frontendRelease };
    const report = evaluate(ui); assert.equal(report.transactionComplete, true); assert.equal(report.liveAcceptanceProven, true);
    assert.equal(report.nextAction, "accepted-frontend-no-business-revalidation");
    for (const change of [{ phase: "pending" }, { consistent: false }, { available: false }, { frontendSha256: runtimeSha },
      { frontendSequence: 713 }, { acceptanceSha256: null }]) assert.equal(evaluate({ ...ui, frontendRelease: { ...frontendRelease, ...change } }).transactionComplete, false);
    assert.equal(evaluate({ ...ui, markers: { app: sha, liveComplete: sha } }).transactionComplete, false);
    assert.equal(evaluate({ ...ui, status: { ...ui.status, releaseSequence: undefined } }).transactionComplete, false);
    assert.equal(evaluate({ ...ui, status: { ...ui.status, releaseKind: "unknown" }, markers: { app: sha, liveComplete: sha } }).transactionComplete, false);
  });
  for (const [name, mutate] of [
    ["missing live marker", b => { b.markers.liveComplete = null; }],
    ["wrong application marker", b => { b.markers.app = "b".repeat(64); }],
    ["recovery pending", b => { b.recoveryPending = true; }],
    ["nonzero terminal exit", b => { b.status.exitCode = "1"; }],
    ["unsuccessful terminal flag", b => { b.status.ok = "0"; }],
    ["future terminal clock", b => { b.status.finishedAt = "2026-01-01T02:00:00Z"; }],
    ["reversed terminal clock", b => { b.status.finishedAt = "2025-12-31T23:00:00Z"; }],
  ]) check(name + " cannot certify completion", () => { const changed = structuredClone(complete); mutate(changed); assert.equal(evaluate(changed).transactionComplete, false); });
  check("failed release remains terminal failure", () => {
    const report = evaluate({ ...complete, status: { ...complete.status, status: "failed", exitCode: "1", ok: "0" } });
    assert.equal(report.state, "failed"); assert.equal(report.transactionComplete, false);
  });
  check("script arguments and arbitrary log payloads never reach progress output", () => {
    const report = evaluate({ ...baseline, logTail: 'authorization=secret-value\n[production-readiness] child-start scripts/verifyApi.cjs --token secret-value\n[production-readiness] child-end scripts/verifyApi.cjs status=0 elapsedMs=42 timedOut=0\n' });
    assert.equal(report.phase, "readiness"); assert.deepEqual(report.lastCheck, { name: "verifyApi.cjs", event: "end", elapsedMs: 42, status: 0 });
    assert.equal(JSON.stringify(report).includes("secret-value"), false);
  });
  check("SQLite timings are measured, not invented percentages", () => {
    const report = evaluate({ ...baseline, logTail: "[release-live-sqlite-prebuild] stage=quick_check event=finish at=2026-01-01T00:30:00Z elapsedSeconds=158 status=ok exitCode=0\n" });
    assert.equal(report.phase, "sqlite-prebuild"); assert.equal(report.lastDatabaseStage.elapsedSeconds, 158);
    assert.equal(Object.hasOwn(report, "percentComplete"), false);
  });
  check("later worker wait supersedes earlier readiness stage", () => {
    const report = evaluate({ ...baseline, logTail: "[production-readiness] child-end scripts/verifyApi.cjs status=0 elapsedMs=12\n[football-bundle-release] wait for this release worker cycle to finish slow enrichment and enter readiness-safe idle\n" });
    assert.equal(report.phase, "enrichment-wait");
  });
  check("invalid SHA cannot form a remote filesystem path", () => {
    for (const invalid of ["../status", "A".repeat(64), sha + ";id", ""]) assert.throws(() => buildReadOnlyProgressProbe(invalid));
  });
  check("serialized probe is bounded and has only read/process-check capabilities", () => {
    const statusPath = "/var/lib/football-release/status/" + sha + ".status";
    const files = new Map([[statusPath, "status=running\nok=0\nstartedAt=2020-01-01T00:00:00Z\nbundleSha256=" + sha + "\n"],
      ["/var/lib/football-release/logs/" + sha + ".log", "private-payload\n".repeat(20000) + "[football-bundle-release] swap release\n"],
      ["/opt/football-predict/.release-bundle-sha256", sha + "\n"],
      ["/opt/football-predict/.release-live-complete", "b".repeat(64) + "\n"]]);
    const descriptors = new Map(); let nextFd = 10, output, maxRead = 0, closed = 0, livenessChecks = 0, execCalls = 0;
    const readonlyFs = {
      constants: fs.constants,
      openSync(file, flags) { assert.ok(files.has(file), file); assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); descriptors.set(++nextFd, Buffer.from(files.get(file))); return nextFd; },
      fstatSync(fd) { return { isFile: () => true, size: descriptors.get(fd).length, uid: 0, nlink: 1, mode: 0o644 }; },
      readSync(fd, buf, start, size, pos) { maxRead = Math.max(maxRead, size); return descriptors.get(fd).copy(buf, start, pos, pos + size); },
      closeSync(fd) { assert.ok(descriptors.delete(fd)); closed++; },
      existsSync(file) { assert.equal(file, "/var/lib/football-release/recovery/current"); return true; },
      readdirSync(file) { assert.equal(file, "/proc"); return ["123", "124", "self"]; },
      readFileSync(file) { assert.ok(["/proc/123/cmdline", "/proc/124/cmdline"].includes(file)); return file.includes("123")
        ? "/bin/bash\0/usr/local/sbin/football-release\0" + sha + "\0" : "node\0unrelated-command\0" + sha + "\0"; },
    };
    vm.runInNewContext(buildReadOnlyProgressProbe(sha), { Buffer, process: { kill(pid, signal) { assert.equal(pid, 123); assert.equal(signal, 0); livenessChecks++; } },
      require(name) {
        if (name === "node:fs") return readonlyFs;
        if (name === "node:child_process") return { execFileSync(command, args) { execCalls++; assert.equal(command, "systemctl");
          assert.deepEqual(Array.from(args), ["show", "football-predict.service", "football-sync-worker.service", "--property=Id,ActiveState,MainPID", "--no-pager"]);
          return "Id=football-predict.service\nActiveState=active\nMainPID=42\n\nId=football-sync-worker.service\nActiveState=active\nMainPID=43\n"; } };
        throw new Error("forbidden capability " + name);
      }, console: { log(value) { output = JSON.parse(value); } } }, { timeout: 1000 });
    assert.equal(maxRead, 65536); assert.equal(output.logBytesRead, 65536); assert.ok(output.logTotalBytes > output.logBytesRead);
    assert.equal(descriptors.size, 0); assert.equal(closed, 5); assert.equal(livenessChecks, 1); assert.equal(execCalls, 1);
    assert.equal(output.runningConfirmed, true); assert.equal(output.phase, "cutover");
    assert.equal(JSON.stringify(output).includes("private-payload"), false); assert.equal(output.productionWrites, 0);
  });
  check("CLI is separate from archive verification and never retries deployment", () => {
    const source = fs.readFileSync(path.join(__dirname, "checkReleaseProgress.cjs"), "utf8");
    assert.ok(source.includes("resolveReleaseSshHostKeyPin")); assert.ok(source.includes("buildPinnedSshBaseOptions"));
    for (const forbidden of ["createReleaseBundle", "deployReleaseBundle", "verifyReleaseBundleSafety", 'spawnSync("tar"', "setInterval", "writeFileSync"]) assert.equal(source.includes(forbidden), false);
  });
  return { ok: true, verifier: "release-progress-v1", checks, productionWrites: 0, networkCalls: 0 };
}
module.exports = { verifyReleaseProgress };
if (require.main === module) console.log(JSON.stringify(verifyReleaseProgress(), null, 2));
