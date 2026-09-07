"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { acquirePointerCommitLock } = require("../server/dataGenerationStore.cjs");
const { SCRIPT, VERSION, INTERVAL_MS, observationDirectory, seasonAt, runOpenFootballObservationSchedule: execute } = require("./openFootballObservationSchedule.cjs");
const { syncObservations, writeStatus } = require("./runOpenFootballObservationSync.cjs");
const { auditObservationStore } = require("./openFootballObservationStore.cjs");
const { LEAGUES } = require("./auditOpenFootballCurrentSeason.cjs");
const { describePostEnrichmentPublicationNeed } = require("./runSyncWorker.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-community-schedule-"));
const root = path.join(temp, "server-store"), directory = observationDirectory(root);
const statusFile = path.join(directory, "sync-status.json");
const attemptFile = path.join(directory, "schedule-attempt-2026-27.json");
let now = Date.parse("2026-09-08T00:00:00.000Z"), calls = 0, sourceCalls = 0, failSource = null;
const checks = [];
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const raw = league => JSON.stringify({ name: `${LEAGUES[league]} 2026/27`, matches: [
  { date: "2026-08-31", team1: "Alpha", team2: "Beta", score: { ft: [1, 0] } },
] });
const run = async env => {
  calls++;
  const status = await syncObservations({ storeDir: env.OPENFOOTBALL_OBSERVATION_STORE_DIR,
    season: env.OPENFOOTBALL_OBSERVATION_SEASON, requestId: env.OPENFOOTBALL_OBSERVATION_REQUEST_ID,
    clock: () => new Date(now).toISOString(), fetchImpl: async url => {
      sourceCalls++;
      const league = Object.keys(LEAGUES).find(key => url.endsWith(`/${key}.json`));
      return failSource === "all" || failSource === league ? new Response("unavailable", { status: 503 }) : new Response(raw(league));
    } });
  return { ok: status.ok, ...(status.ok ? {} : { error: "source unavailable", errorCode: "SOURCE_FAILED" }) };
};
const options = { enabled: true, storeDir: root, read, write: writeStatus, run, clock: () => now };
async function check(name, action) { await action(); checks.push({ name, ok: true }); }
async function main() {
  try {
    await check("disabled makes no directory, command or network request", async () => {
      const result = await execute({ ...options, enabled: false });
      assert.equal(result.reason, "disabled"); assert.equal(calls, 0); assert.equal(fs.existsSync(directory), false);
    });
    await check("actual collector stores all five sources and operational status", async () => {
      const result = await execute(options);
      assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(sourceCalls, 5);
      assert.equal(auditObservationStore(directory).observations, 5);
      assert.equal(result.communityReceipts.adoptedByModel, false);
      assert.equal(result.communityReceipts.officialSettlementAllowed, false);
      assert.equal(result.communityReceipts.sourceResults.length, 5);
      assert.equal(result.communityReceipts.nextScheduledAt, new Date(now + INTERVAL_MS).toISOString());
      assert.equal(read(attemptFile).version, VERSION); assert.equal(read(attemptFile).script, SCRIPT);
    });
    await check("restart-style reread respects six-hour successful interval", async () => {
      now += 3600000; const before = fs.readFileSync(statusFile);
      const result = await execute(options); assert.equal(result.reason, "successful-snapshot-min-interval");
      assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(statusFile), before);
    });
    await check("partial failure retains last successful time and previous raw bytes", async () => {
      now += INTERVAL_MS; failSource = "en.1"; const before = read(statusFile).lastSuccessfulCollectionAt;
      const result = await execute(options);
      assert.equal(result.ok, false); assert.equal(result.fatal, false); assert.equal(calls, 2);
      assert.equal(read(statusFile).successfulSources, 4); assert.equal(read(statusFile).failedSources, 1);
      assert.equal(read(statusFile).lastSuccessfulCollectionAt, before);
      assert.equal(auditObservationStore(directory).sourceContents, 5);
      assert.equal(result.retry.nextAttemptAt, new Date(now + 30 * 60000).toISOString());
    });
    await check("failed cooldown stays visibly degraded without another request", async () => {
      const before = sourceCalls; const result = await execute(options);
      assert.equal(result.reason, "failed-source-cooldown"); assert.equal(result.ok, false);
      assert.equal(result.communityReceipts.collectionOk, false); assert.equal(sourceCalls, before);
    });
    await check("failure delay doubles, caps at six hours, and full recovery resets it", async () => {
      failSource = "all";
      for (const minutes of [60, 120, 240, 360, 360]) {
        now = Date.parse(read(attemptFile).nextAttemptAt);
        const result = await execute(options); assert.equal(Date.parse(result.retry.nextAttemptAt) - now, minutes * 60000);
      }
      now = Date.parse(read(attemptFile).nextAttemptAt); failSource = null;
      const result = await execute(options); assert.equal(result.ok, true); assert.equal(result.retry.failures, 0);
      assert.equal(read(statusFile).lastSuccessfulCollectionAt, new Date(now).toISOString());
    });
    await check("signed release reuse does not request source or stamp successful time", async () => {
      now += INTERVAL_MS; const before = fs.readFileSync(statusFile), count = sourceCalls;
      const result = await execute({ ...options, run: async () => ({ ok: true, skipped: true, reused: true }) });
      assert.equal(result.reused, true); assert.equal(sourceCalls, count); assert.deepEqual(fs.readFileSync(statusFile), before);
    });
    await check("command success with stale status is not receipt success", async () => {
      const result = await execute({ ...options, run: async () => ({ ok: true }) });
      assert.equal(result.ok, false); assert.equal(result.errorCode, "COMMUNITY_STATUS_NOT_ADVANCED");
    });
    await check("same-time but mismatched request identity cannot clear a failure", async () => {
      now = Date.parse(read(attemptFile).nextAttemptAt);
      const result = await execute({ ...options, run: async () => {
        writeStatus(statusFile, { ...read(statusFile), completedAt: new Date(now).toISOString(), lastSuccessfulCollectionAt: new Date(now).toISOString() });
        return { ok: true };
      } });
      assert.equal(result.ok, false); assert.equal(result.errorCode, "COMMUNITY_STATUS_NOT_ADVANCED");
    });
    await check("thrown cancellation preserves running lease and propagates identity", async () => {
      now = Date.parse(read(attemptFile).nextAttemptAt); const stop = new Error("stop");
      await assert.rejects(execute({ ...options, run: async () => { throw stop; } }), error => error === stop);
      assert.equal(read(attemptFile).state, "running");
      const result = await execute(options); assert.equal(result.reason, "previous-attempt-incomplete-cooldown");
      assert.equal(result.communityReceipts.latestAttemptState, "running");
      assert.equal(result.communityReceipts.collectionOk, false);
      assert.equal(result.communityReceipts.lastCompletedCollectionOk, true);
    });
    await check("active schedule lock rejects parallel callers without source access", async () => {
      const count = sourceCalls, lock = acquirePointerCommitLock({ lockDir: path.join(directory, ".schedule.lock"), timeoutMs: 0 });
      try { const result = await execute(options); assert.equal(result.reason, "community-schedule-busy"); assert.equal(result.fatal, false); assert.equal(sourceCalls, count); }
      finally { lock.release(); }
    });
    await check("incomplete lease expires into a bounded retry, not permanent blocking", async () => {
      now = Date.parse(read(attemptFile).nextAttemptAt); const count = sourceCalls;
      const result = await execute(options); assert.equal(result.ok, true); assert.equal(sourceCalls, count + 5);
    });
    await check("operational state write failure prevents request", async () => {
      now += INTERVAL_MS; const count = sourceCalls;
      const result = await execute({ ...options, write: () => { throw new Error("readonly"); } });
      assert.equal(result.ok, false); assert.equal(result.reason, "retry-state-write-failed"); assert.equal(sourceCalls, count);
    });
    await check("season boundary uses UTC July and does not reuse old-season cooldown", async () => {
      assert.equal(seasonAt(Date.parse("2026-06-30T23:59:59Z")), "2025-26");
      assert.equal(seasonAt(Date.parse("2026-07-01T00:00:00Z")), "2026-27");
      assert.equal(seasonAt(Date.parse("2027-01-01T00:00:00Z")), "2026-27");
      const previousNow = now; now = Date.parse("2027-07-01T00:00:00.000Z");
      writeStatus(attemptFile, { version: VERSION, script: SCRIPT, state: "failed", failures: 1,
        startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
        nextAttemptAt: new Date(now + 30 * 60000).toISOString(), errorCode: "SOURCE_FAILED" });
      let newSeasonInvoked = false;
      await execute({ ...options, run: async env => {
        assert.equal(env.OPENFOOTBALL_OBSERVATION_SEASON, "2027-28"); newSeasonInvoked = true;
        return { ok: true, skipped: true, reused: true };
      } });
      assert.equal(newSeasonInvoked, true); assert.equal(read(attemptFile).state, "failed"); now = previousNow;
    });
    await check("actual worker wiring keeps research step outside base-publication inputs", async () => {
      const source = fs.readFileSync(path.join(__dirname, "runSyncWorker.cjs"), "utf8");
      const start = source.indexOf("    const communityReceiptStep = await runOpenFootballObservationSchedule(");
      const end = source.indexOf("    const footballDataFixturesStatus =", start); assert.ok(start > 0 && end > start);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const executeWiring = new AsyncFunction("runOpenFootballObservationSchedule", "process", "storeDir", "readJson", "writeJsonAtomic", "runEnrichment", source.slice(start, end) + "return communityReceiptStep;");
      let invoked;
      const result = await executeWiring(async options => { invoked = options; return execute({ ...options, clock: () => now }); },
        { env: { ENABLE_OPENFOOTBALL_OBSERVATIONS: "0" } }, root, read, writeStatus, () => { throw new Error("disabled source invoked"); });
      assert.equal(invoked.enabled, false); assert.equal(result.reason, "disabled");
      const beforeCalls = sourceCalls;
      const active = await executeWiring(async options => execute({ ...options, clock: () => now }),
        { env: {} }, root, read, writeStatus, async (enabled, script, env) => {
          assert.equal(enabled, true); assert.equal(script, SCRIPT); return run(env);
        });
      assert.equal(active.ok, true); assert.equal(sourceCalls, beforeCalls + 5);
      const block = source.slice(start, end); assert.ok(!block.includes("enrichmentSteps.push"));
      assert.match(source, /const slowSteps = \[\s*communityReceiptStep,/);
      assert.match(source, /enrichmentSteps,\s*communityReceiptStep,/);
      assert.equal(describePostEnrichmentPublicationNeed([]).required, false);
    });
    await check("invalid final completion clock cannot replace last successful status", async () => {
      const previous = fs.readFileSync(statusFile); let ticks = 0;
      await assert.rejects(syncObservations({ storeDir: directory, season: "2026-27",
        clock: () => ++ticks > 10 ? "2026-02-30T00:00:00Z" : new Date(now).toISOString(),
        fetchImpl: async url => new Response(raw(Object.keys(LEAGUES).find(key => url.endsWith(`/${key}.json`)))),
      }), /Invalid collection completion clock/);
      assert.deepEqual(fs.readFileSync(statusFile), previous);
    });
    await check("failed final status rename preserves success metadata and valid raw receipts", async () => {
      const previous = fs.readFileSync(statusFile), rename = fs.renameSync;
      fs.renameSync = (source, target) => { if (target === statusFile) throw new Error("injected status storage failure"); return rename(source, target); };
      try {
        await assert.rejects(syncObservations({ storeDir: directory, season: "2026-27", clock: () => new Date(now).toISOString(),
          fetchImpl: async url => new Response(raw(Object.keys(LEAGUES).find(key => url.endsWith(`/${key}.json`)))),
        }), /injected status storage failure/);
      } finally { fs.renameSync = rename; }
      assert.deepEqual(fs.readFileSync(statusFile), previous); assert.equal(auditObservationStore(directory).ok, true);
    });
    console.log(JSON.stringify({ ok: true, verifier: VERSION, checks, providerRequests: 0, productionDataTouched: false,
      scope: "actual synthetic-response collector, SQLite/locks, persisted cooldown and actual worker wiring" }));
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-community-schedule-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
