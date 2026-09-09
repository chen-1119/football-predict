const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { stopVerificationChild } = require("./stopVerificationChild.cjs");

const rootDir = path.resolve(__dirname, "..");
const workerSource = fs.readFileSync(path.join(rootDir, "scripts", "runSyncWorker.cjs"), "utf8");
const { fastEventVisibilityMs } = require("./runSyncWorker.cjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-sync-event-"));
const statusPath = path.join(tempDir, "sync-worker-status.json");
const eventPath = path.join(tempDir, "events.jsonl");

const writeStatus = (eventCycle, options = {}) => {
  fs.writeFileSync(statusPath, JSON.stringify({
    version: 1,
    worker: "football-sync-worker",
    cycleState: options.cycleState || "sleeping",
    checkedAt: options.checkedAt || eventCycle.finishedAt,
    phase: options.phase || eventCycle.phase || null,
    eventCycle,
    lastCycle: options.lastCycle || eventCycle,
  }), "utf8");
};

const rows = () => {
  if (!fs.existsSync(eventPath)) return [];
  return fs.readFileSync(eventPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const waitFor = async (predicate, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
};

const initialCycle = {
  ok: true,
  phase: "official-result-published",
  startedAt: "2026-07-13T00:00:00.000Z",
  finishedAt: "2026-07-13T00:00:10.000Z",
  durationMs: 10_000,
};
writeStatus(initialCycle);

const child = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    SERVER_STORE_DIR: tempDir,
    ENABLE_SYNC_CRON: "0",
    ENABLE_GPT_CRON: "0",
    SYNC_WORKER_EVENT_BRIDGE: "1",
    SYNC_WORKER_EVENT_POLL_MS: "500",
    RELAY_FAST_WATCHER_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

const stopChild = async () => {
  await stopVerificationChild(child);
};

(async () => {
  try {
    await waitFor(() => output.includes("[football-server] listening"));
    await waitFor(() => output.includes("[football-server] sync worker event bridge primed"));
    assert.equal(rows().length, 0, "the bridge must prime without replaying an old worker cycle");

    assert.ok(fastEventVisibilityMs >= 1250, "fast events must remain visible beyond the default 1s server poll");
    assert.match(
      workerSource,
      /onFastPublished:[\s\S]*await waitForFastEventVisibility\(\)/,
      "the worker must hold the fast event before starting the full sync"
    );

    const fastCycle = {
      ok: true,
      phase: "official-result-fast-published",
      startedAt: "2026-07-13T00:00:30.000Z",
      finishedAt: "2026-07-13T00:00:31.000Z",
      durationMs: 1_000,
    };
    writeStatus(fastCycle, {
      cycleState: "running",
      phase: "official-result",
      lastCycle: initialCycle,
    });
    const fast = await waitFor(() => rows().find((row) => row.phase === "official-result-fast-published"));
    assert.equal(fast.type, "sync_completed");
    assert.equal(fast.ok, true);

    const publishedCycle = {
      ok: true,
      phase: "official-result-published",
      startedAt: "2026-07-13T00:01:30.000Z",
      finishedAt: "2026-07-13T00:01:50.000Z",
      durationMs: 20_000,
    };
    writeStatus(publishedCycle, {
      cycleState: "running",
      phase: "slow-enrichment",
      lastCycle: initialCycle,
    });
    const completed = await waitFor(() => rows().find((row) => row.phase === "official-result-published"));
    assert.equal(completed.type, "sync_completed");
    assert.equal(completed.ok, true);
    assert.equal(completed.phase, "official-result-published");

    const reconciledCycle = {
      ...publishedCycle,
      phase: "complete",
      finishedAt: "2026-07-13T00:02:20.000Z",
      durationMs: 50_000,
    };
    const eventsBeforeReconciliation = rows().length;
    writeStatus(reconciledCycle, {
      lastCycle: reconciledCycle,
    });
    const reconciled = await waitFor(() => rows().find((row) => (
      row.phase === "complete"
      && row.startedAt === publishedCycle.startedAt
      && row.finishedAt === reconciledCycle.finishedAt
    )));
    assert.equal(reconciled.type, "sync_completed");
    assert.equal(
      rows().length,
      eventsBeforeReconciliation + 1,
      "finishing model reconciliation must publish one final refresh for the new immutable generation"
    );

    const eventsAfterReconciliation = rows().length;
    writeStatus(reconciledCycle, {
      lastCycle: reconciledCycle,
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      rows().length,
      eventsAfterReconciliation,
      "an unchanged reconciled cycle must not be published twice"
    );

    writeStatus({
      ok: true,
      degraded: true,
      phase: "official-result-published",
      warnings: ["optional source unavailable"],
      startedAt: "2026-07-13T00:03:00.000Z",
      finishedAt: "2026-07-13T00:03:25.000Z",
      durationMs: 25_000,
    });
    const warning = await waitFor(() => rows().find((row) => row.type === "sync_completed_with_warnings"));
    assert.equal(warning.degraded, true);

    writeStatus({
      ok: false,
      phase: "official-result-failed",
      startedAt: "2026-07-13T00:04:30.000Z",
      finishedAt: "2026-07-13T00:04:35.000Z",
      durationMs: 5_000,
    });
    const failed = await waitFor(() => rows().find((row) => row.type === "sync_failed"));
    assert.equal(failed.ok, false);

    console.log(JSON.stringify({
      ok: true,
      verifier: "sync-worker-event-bridge",
      events: rows().map((row) => row.type),
    }, null, 2));
  } finally {
    await stopChild();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(output);
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
