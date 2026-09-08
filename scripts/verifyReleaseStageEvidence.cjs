"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const stage = require("./releaseStageEvidence.cjs");

async function verifyReleaseStageEvidence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-stage-evidence-")), checks = [], cleanupPids = new Set();
  const release = { sha256: "a".repeat(64), sequence: 712, runId: "dispatch-20260908-one" };
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  let serial = 0;
  function options(extra = {}) {
    const storeDir = path.join(root, "case-" + ++serial); fs.mkdirSync(storeDir, { mode: 0o700 });
    const input = path.join(root, "input-" + serial + ".txt"); fs.writeFileSync(input, "fixed-source\n", { mode: 0o600 });
    return { storeDir, release, phase: "candidate-readiness", attemptId: "first", command: process.execPath,
      args: ["-e", "process.exit(0)"], cwd: root, inputFiles: [{ name: "source", file: input }], timeoutMs: 10000,
      stdio: "ignore", ...extra };
  }
  function observation(opts, boundary, extra = {}) {
    return stage.recordCheckpoint({ ...opts, boundary, eventId: boundary + "-" + opts.attemptId,
      inputIdentity: { generation: "b".repeat(64) }, ...extra });
  }
  async function until(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("fixture deadline expired");
  }
  function fixtureProcess(source, args = []) {
    const child = spawn(process.execPath, ["-e", source, ...args], { stdio: "ignore", windowsHide: true });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    return { child, closed };
  }
  try {
    await check("real subprocess success requires start child-close and unchanged input files", async () => {
      const opts = options(), result = await stage.runStage(opts), report = stage.reportStages(opts);
      assert.equal(result.commandSucceeded, true); assert.equal(result.reusable, false);
      assert.equal(report.eventCount, 3); assert.equal(report.attempts[0].state, "succeeded");
      assert.ok(report.attempts[0].elapsedMs >= 0); assert.equal(report.attempts[0].elapsedIsFinal, true);
      assert.equal(report.liveAcceptanceProven, false); assert.equal(report.productionWrites, 0);
      assert.equal(stage.readJournal(opts).events[2].closeObserved, true);
    });
    await check("nonzero real child exit cannot become a successful phase", async () => {
      const opts = options({ args: ["-e", "process.exit(23)"] }), result = await stage.runStage(opts);
      assert.equal(result.result, "failed"); assert.equal(result.exitCode, 23); assert.equal(stage.reportStages(opts).attempts[0].commandSucceeded, false);
    });
    await check("real command timeout is distinct from a live wait", async () => {
      const opts = options({ args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 80, category: "wait" });
      const result = await stage.runStage(opts);
      assert.equal(result.result, "timed-out"); assert.equal(stage.readJournal(opts).events.at(-1).timedOut, true);
      assert.equal(stage.reportStages(opts).attempts[0].runningConfirmed, false);
    });
    await check("a command mutating a committed source is not a pass despite exit zero", async () => {
      const opts = options(); opts.args = ["-e", "require('node:fs').appendFileSync(process.argv[1],'changed')", opts.inputFiles[0].file];
      const result = await stage.runStage(opts);
      assert.equal(result.result, "input-drift"); assert.equal(result.commandSucceeded, false);
      const journal = stage.readJournal(opts); assert.notEqual(journal.events[0].inputHash, journal.events.at(-1).observedInputHash);
    });
    await check("deleted input evidence after command exit is not a pass", async () => {
      const opts = options(); opts.args = ["-e", "require('node:fs').unlinkSync(process.argv[1])", opts.inputFiles[0].file];
      assert.equal((await stage.runStage(opts)).result, "input-unavailable");
    });
    await check("real spawn error is retained and never creates a child pass", async () => {
      const command = path.join(root, "not-an-executable.txt"); fs.writeFileSync(command, "plain text", { mode: 0o600 });
      const opts = options({ command, args: [] }), result = await stage.runStage(opts);
      assert.equal(result.result, "spawn-failed"); assert.equal(result.commandSucceeded, false);
      assert.equal(stage.readJournal(opts).events.length, 2);
    });
    await check("repeated phase names retain separate numbered attempts without overwriting", async () => {
      const opts = options(); await stage.runStage(opts);
      await stage.runStage({ ...opts, attemptId: "second" });
      const report = stage.reportStages(opts); assert.deepEqual(report.attempts.map(a => a.attempt), [1, 2]);
      assert.equal(report.eventCount, 6); assert.notEqual(report.attempts[0].attemptId, report.attempts[1].attemptId);
      await assert.rejects(() => stage.runStage(opts), /attempt already exists/);
      assert.equal(stage.readJournal(opts).events.length, 6);
    });
    await check("same phase cannot start concurrently while an actual child is alive", async () => {
      const opts = options({ args: ["-e", "setTimeout(()=>{},300)"], category: "wait" });
      const running = stage.runStage(opts);
      await until(() => stage.readJournal(opts).events.length === 2);
      const live = stage.reportStages(opts);
      assert.equal(live.attempts[0].state, process.platform === "linux" ? "waiting" : "unconfirmed-running");
      assert.equal(live.attempts[0].runningConfirmed, process.platform === "linux");
      await assert.rejects(() => stage.runStage({ ...opts, attemptId: "concurrent" }), /remains unresolved/);
      assert.equal((await running).commandSucceeded, true); assert.equal(stage.readJournal(opts).events.length, 3);
    });
    await check("independent concurrent phases share a hash chain without losing records", async () => {
      const opts = options({ args: ["-e", "setTimeout(()=>{},80)"] });
      const result = await Promise.all([stage.runStage(opts), stage.runStage({ ...opts, phase: "sqlite-preparation", attemptId: "other" })]);
      assert.ok(result.every(r => r.commandSucceeded)); assert.equal(stage.readJournal(opts).events.length, 6);
      assert.equal(stage.reportStages(opts).attempts.length, 2);
    });
    await check("competing actual recorder processes cannot append two active attempts for one phase", async () => {
      const opts = options(), source = "try { require(process.argv[1]).recordCheckpoint(JSON.parse(process.argv[2])); } catch(e) { process.exit(/append busy|remains unresolved|invalid phase attempt/.test(e.message)?42:99); }";
      const request = { ...opts, boundary: "begin", eventId: "process-one", inputIdentity: { source: "c".repeat(64) } };
      const one = fixtureProcess(source, [path.join(__dirname, "releaseStageEvidence.cjs"), JSON.stringify(request)]);
      const two = fixtureProcess(source, [path.join(__dirname, "releaseStageEvidence.cjs"), JSON.stringify({ ...request, attemptId: "two", eventId: "process-two" })]);
      const results = await Promise.all([one.closed, two.closed]);
      assert.deepEqual(results.map(r => r.code).sort((a, b) => a - b), [0, 42]);
      assert.equal(stage.readJournal(opts).events.length, 1);
    });
    await check("observations may close a measured span but never certify a successful command", () => {
      const opts = options(); observation(opts, "begin"); observation(opts, "end", { observedOutcome: "ok" });
      const report = stage.reportStages(opts), item = report.attempts[0];
      assert.equal(item.state, "observed-closed"); assert.equal(item.evidenceKind, "checkpoint-observation");
      assert.equal(item.observedOutcome, "ok"); assert.equal(item.commandSucceeded, false); assert.equal(item.reusable, false);
    });
    await check("exact duplicate observation is idempotent while conflicting duplicate is rejected", () => {
      const opts = options(), first = observation(opts, "begin"), second = observation(opts, "begin");
      assert.equal(first.eventHash, second.eventHash); assert.equal(stage.readJournal(opts).events.length, 1);
      assert.throws(() => observation(opts, "begin", { category: "wait" }), /conflicts/);
      observation(opts, "end"); observation(opts, "end"); assert.equal(stage.readJournal(opts).events.length, 2);
    });
    await check("checkpoint input or release identity drift cannot close an earlier span", () => {
      const opts = options(); observation(opts, "begin");
      assert.throws(() => observation(opts, "end", { inputIdentity: { generation: "c".repeat(64) } }), /drifted/);
      assert.throws(() => observation({ ...opts, release: { ...release, sequence: 713 } }, "end"), /identity/);
      assert.throws(() => observation({ ...opts, release: { ...release, runId: "other-dispatch" } }, "end"), /no start/);
      assert.equal(stage.readJournal(opts).events.length, 1);
    });
    await check("real recorder crash leaves unresolved command and does not authorize another attempt", async () => {
      const opts = options({ args: ["-e", "setInterval(()=>{},1000)"] });
      const worker = fixtureProcess("require(process.argv[1]).runStage(JSON.parse(process.argv[2])).catch(()=>process.exit(2))", [__dirname + "/releaseStageEvidence.cjs", JSON.stringify(opts)]);
      cleanupPids.add(worker.child.pid);
      await until(() => { try { return stage.readJournal(opts).events.length === 2; } catch { return false; } });
      const childPid = stage.readJournal(opts).events[1].child.pid; cleanupPids.add(childPid);
      worker.child.kill("SIGKILL"); await worker.closed; cleanupPids.delete(worker.child.pid);
      const report = stage.reportStages(opts);
      assert.equal(report.attempts[0].state, "unconfirmed-running"); assert.equal(report.attempts[0].commandSucceeded, false);
      await assert.rejects(() => stage.runStage({ ...opts, attemptId: "unsafe-retry" }), /remains unresolved/);
      try { process.kill(childPid, "SIGKILL"); } catch { /* already closed */ } cleanupPids.delete(childPid);
    });
    await check("an interrupted append lock is not expired or removed by a status read", () => {
      const opts = options(); observation(opts, "begin");
      const directory = stage.readJournal(opts).directory, lock = path.join(directory, ".append-lock");
      fs.mkdirSync(lock, { mode: 0o700 });
      assert.equal(stage.reportStages(opts).attempts[0].state, "observed-open");
      assert.throws(() => observation(opts, "end"), /append busy or interrupted/);
      assert.equal(fs.existsSync(lock), true);
    });
    await check("a live recorder without a live stage child is not a verified wait", async () => {
      const opts = options(); await stage.runStage(opts);
      const journal = stage.readJournal(opts); fs.unlinkSync(path.join(journal.directory, "000003.json"));
      const result = stage.reportStages(opts).attempts[0];
      assert.equal(result.state, "unconfirmed-running"); assert.equal(result.runningConfirmed, false);
      assert.equal(result.commandSucceeded, false);
    });
    await check("a partial crash record makes observation unavailable rather than completed", () => {
      const opts = options(); observation(opts, "begin");
      const journal = stage.readJournal(opts); fs.writeFileSync(path.join(journal.directory, "000002.json"), '{"incomplete":', { mode: 0o600 });
      assert.throws(() => stage.reportStages(opts)); assert.throws(() => observation(opts, "end"));
      assert.equal(fs.readFileSync(path.join(journal.directory, "000002.json"), "utf8"), '{"incomplete":');
    });
    await check("hash tampering and record gaps are refused by actual filesystem reads", () => {
      const opts = options(); observation(opts, "begin"); observation(opts, "end");
      const journal = stage.readJournal(opts), file = path.join(journal.directory, "000002.json");
      const event = JSON.parse(fs.readFileSync(file, "utf8")); event.observedOutcome = "ok"; fs.writeFileSync(file, JSON.stringify(event));
      assert.throws(() => stage.reportStages(opts), /hash chain/);
      fs.renameSync(file, path.join(journal.directory, "000003.json")); assert.throws(() => stage.reportStages(opts), /sequence gap/);
    });
    await check("deterministic monotonic duration is retained even when wall time steps backwards", async () => {
      const opts = options(); await stage.runStage(opts);
      const journal = stage.readJournal(opts);
      for (const [index, event] of journal.events.entries()) {
        event.clock = { at: index === 0 ? "2026-01-01T00:00:10.000Z" : "2026-01-01T00:00:09.000Z", monotonicMs: 1000 + index * 250, domain: "fixture-boot" };
        event.previousHash = index ? journal.events[index - 1].eventHash : "0".repeat(64);
        const { eventHash, ...body } = event; void eventHash; event.eventHash = stage.hash(body);
        fs.writeFileSync(path.join(journal.directory, String(index + 1).padStart(6, "0") + ".json"), JSON.stringify(event));
      }
      const result = stage.reportStages(opts).attempts[0]; assert.equal(result.elapsedMs, 500); assert.equal(result.wallClockConsistent, false);
    });
    await check("a clock-domain change does not invent elapsed duration from wall observations", () => {
      const opts = options(); observation(opts, "begin"); observation(opts, "end");
      const journal = stage.readJournal(opts), event = journal.events[1]; event.clock.domain = "different-boot";
      const { eventHash, ...body } = event; void eventHash; event.eventHash = stage.hash(body);
      fs.writeFileSync(path.join(journal.directory, "000002.json"), JSON.stringify(event));
      assert.equal(stage.reportStages(opts).attempts[0].elapsedMs, null);
    });
    await check("fabricated success without actual child-start evidence is rejected even with a rehashed record", () => {
      const opts = options(); observation(opts, "begin");
      const journal = stage.readJournal(opts), start = journal.events[0];
      start.kind = "command-start"; start.commandHash = "d".repeat(64); start.owner = stage.processIdentity(process.pid);
      const { eventHash, ...body } = start; void eventHash; start.eventHash = stage.hash(body);
      const end = { ...start, eventId: "fake-end", kind: "command-end", ordinal: 2, previousHash: start.eventHash,
        exitCode: 0, signal: null, timedOut: false, cancelled: false, closeObserved: true, result: "succeeded", observedInputHash: start.inputHash };
      delete end.commandHash; const { eventHash: ignored, ...endBody } = end; void ignored; end.eventHash = stage.hash(endBody);
      fs.writeFileSync(path.join(journal.directory, "000001.json"), JSON.stringify(start));
      fs.writeFileSync(path.join(journal.directory, "000002.json"), JSON.stringify(end), { mode: 0o600 });
      assert.throws(() => stage.reportStages(opts), /child-close evidence/);
    });
    await check("bounded evidence files and unrecognized entries fail without truncating history", () => {
      const opts = options(); observation(opts, "begin"); const journal = stage.readJournal(opts);
      const file = path.join(journal.directory, "000001.json"); fs.appendFileSync(file, " ".repeat(stage.LIMITS.eventBytes));
      assert.throws(() => stage.reportStages(opts), /oversized/);
      assert.ok(fs.statSync(file).size > stage.LIMITS.eventBytes);
      fs.writeFileSync(path.join(journal.directory, "unrelated.log"), "no", { mode: 0o600 });
      assert.throws(() => stage.reportStages(opts), /unexpected/);
    });
    await check("invalid path identity or source memberships are refused before execution", () => {
      for (const runId of ["../escape", "", "run;command"]) assert.throws(() => stage.releaseIdentity({ ...release, runId }));
      assert.throws(() => stage.fingerprintFiles([]));
      const opts = options(); assert.throws(() => stage.fingerprintFiles([opts.inputFiles[0], opts.inputFiles[0]]), /duplicate/);
      assert.throws(() => stage.recordCheckpoint({ ...opts, boundary: "begin", eventId: "unsafe", inputIdentity: { token: "private-secret" } }), /commitment/);
    });
    await check("hard-linked journal entries cannot become trusted evidence", () => {
      const opts = options(); observation(opts, "begin"); const journal = stage.readJournal(opts), file = path.join(journal.directory, "000001.json");
      fs.linkSync(file, path.join(root, "linked-evidence")); assert.throws(() => stage.reportStages(opts), /unsafe/);
    });
    await check("CLI preserves child stdout and emits structured evidence separately", () => {
      const opts = options({ args: ["-e", "process.stdout.write('fixture-output')"], stdio: "inherit" }), request = path.join(root, "request.json");
      fs.writeFileSync(request, JSON.stringify(opts), { mode: 0o600 });
      const result = spawnSync(process.execPath, [path.join(__dirname, "releaseStageEvidence.cjs"), "run", request], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "fixture-output");
      assert.equal(JSON.parse(result.stderr.trim()).commandSucceeded, true);
      const report = spawnSync(process.execPath, [path.join(__dirname, "releaseStageEvidence.cjs"), "report", request], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(report.status, 0, report.stderr); assert.equal(JSON.parse(report.stdout).attempts[0].state, "succeeded");
    });
    if (process.platform === "linux") {
      await check("Linux liveness binds PID boot and start ticks rather than a PID alone", () => {
        const identity = stage.processIdentity(process.pid); assert.equal(stage.processAlive(identity), true);
        assert.equal(stage.processAlive({ ...identity, startTicks: String(Number(identity.startTicks) + 1) }), false);
        assert.equal(stage.processAlive({ ...identity, bootId: "different-boot" }), false);
      });
      await check("Linux writable journal permissions and symlink entries are refused", () => {
        const opts = options(); observation(opts, "begin"); const journal = stage.readJournal(opts);
        fs.chmodSync(journal.directory, 0o755); assert.throws(() => stage.reportStages(opts), /private/); fs.chmodSync(journal.directory, 0o700);
        const file = path.join(journal.directory, "000001.json"), target = path.join(root, "moved-event");
        fs.renameSync(file, target); fs.symlinkSync(target, file); assert.throws(() => stage.reportStages(opts), /unsafe/);
      });
    }
  } finally {
    for (const pid of cleanupPids) { try { process.kill(pid, "SIGKILL"); } catch { /* fixture exited */ } }
    if (!root.startsWith(path.join(os.tmpdir(), "football-stage-evidence-")) || fs.lstatSync(root).isSymbolicLink()) throw new Error("unsafe fixture cleanup target");
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { ok: true, suite: stage.VERSION, platform: process.platform, node: process.version,
    passed: checks.length, checks, realFilesystem: true, fixtureRemoved: !fs.existsSync(root), productionWrites: 0 };
}
module.exports = { verifyReleaseStageEvidence };
if (require.main === module) verifyReleaseStageEvidence().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
