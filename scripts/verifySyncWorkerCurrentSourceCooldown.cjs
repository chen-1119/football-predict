"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Module initialization may inspect a status file. Give it an unused test
// store, so this verifier never uses local football records or live services.
const originalStoreDir = process.env.SERVER_STORE_DIR;
process.env.SERVER_STORE_DIR = path.join(os.tmpdir(), `football-worker-current-cooldown-${randomUUID()}`);
const { describeCurrentSourceFailureCooldown, nextCycleDelayMs, runCommand } = require("./runSyncWorker.cjs");
if (originalStoreDir === undefined) delete process.env.SERVER_STORE_DIR;
else process.env.SERVER_STORE_DIR = originalStoreDir;

let checks = 0;
const verify = (name, task) => { task(); checks += 1; };
const emptyError = () => ({
  code: "SYNC_WORKER_COMMAND_FAILED", command: "npm", args: ["run", "validate:data"],
  exitCode: 1, signal: null, stderr: "matches-current.json must contain a non-empty array.\n",
  stderrTruncated: false,
});
const emptyMeta = () => ({
  files: { current: 0, history: 2272 },
  api: {
    transport: "relay-history-only", currentStale: true,
    fallbackCoverage: { currentMatches: 0, currentSportteryMatches: 0, officialOddsMatches: 0, currentLaneFresh: false },
  },
});

const main = async () => {
  verify("confirmed current empty validation failure", () => assert.deepEqual(
    describeCurrentSourceFailureCooldown(emptyError(), emptyMeta()),
    { reason: "current-source-empty", minimumDelayMs: 300000, fromCompletion: true },
  ));
  verify("npm.cmd Windows validator", () => assert.ok(describeCurrentSourceFailureCooldown(
    { ...emptyError(), command: "C:\\node\\npm.cmd" }, emptyMeta(),
  )));
  const rejected = [
    ["unknown error", (e) => { e.code = "OTHER_FAILURE"; }],
    ["command timeout", (e) => { e.code = "SYNC_WORKER_COMMAND_TIMEOUT"; }],
    ["different command", (e) => { e.command = "node"; }],
    ["different validation stage", (e) => { e.args = ["run", "validate:results"]; }],
    ["extra validator argument", (e) => { e.args.push("--other"); }],
    ["different exit code", (e) => { e.exitCode = 2; }],
    ["terminated child", (e) => { e.signal = "SIGTERM"; }],
    ["unavailable stderr", (e) => { delete e.stderr; }],
    ["unproven complete capture", (e) => { delete e.stderrTruncated; }],
    ["truncated stderr", (e) => { e.stderrTruncated = true; }],
    ["additional data integrity error", (e) => { e.stderr += "abc: FINISHED match requires numeric final scores.\n"; }],
    ["other sole assertion", (e) => { e.stderr = "sync-meta archivedUnsettled count must match the private unresolved archive.\n"; }],
    ["missing metadata", (_e, m) => { delete m.api; }],
    ["nonempty current", (_e, m) => { m.files.current = 1; }],
    ["washed count string", (_e, m) => { m.files.current = "0"; }],
    ["missing history", (_e, m) => { m.files.history = 0; }],
    ["different transport", (_e, m) => { m.api.transport = "relay"; }],
    ["current fresh", (_e, m) => { m.api.currentStale = false; }],
    ["coverage has current", (_e, m) => { m.api.fallbackCoverage.currentMatches = 1; }],
    ["coverage has official current", (_e, m) => { m.api.fallbackCoverage.currentSportteryMatches = 1; }],
    ["coverage has official odds", (_e, m) => { m.api.fallbackCoverage.officialOddsMatches = 1; }],
    ["current lane is fresh", (_e, m) => { m.api.fallbackCoverage.currentLaneFresh = true; }],
    ["missing coverage", (_e, m) => { delete m.api.fallbackCoverage; }],
  ];
  for (const [name, mutate] of rejected) verify(name, () => {
    const error = emptyError(); const meta = emptyMeta(); mutate(error, meta);
    assert.equal(describeCurrentSourceFailureCooldown(error, meta), null);
  });
  const start = "2026-10-02T11:34:58.838Z";
  const finish = Date.parse(start) + 314482;
  const cooldown = describeCurrentSourceFailureCooldown(emptyError(), emptyMeta());
  verify("ordinary cycle remains start-based", () => assert.ok(nextCycleDelayMs(start, 300000, finish) < 300000));
  verify("confirmed failed long cycle waits full interval after completion", () => assert.equal(
    Math.max(cooldown.minimumDelayMs, nextCycleDelayMs(start, 300000, finish, cooldown)), 300000,
  ));
  verify("hot cadence still respects five minute minimum", () => assert.equal(
    Math.max(cooldown.minimumDelayMs, nextCycleDelayMs(start, 90000, finish, cooldown)), 300000,
  ));
  verify("longer configured interval is retained", () => assert.equal(
    Math.max(cooldown.minimumDelayMs, nextCycleDelayMs(start, 600000, finish, cooldown)), 600000,
  ));

  // Exercise the actual child process capture, including draining stderr before
  // rejection. These children only emit text and exit; they do not run sync.
  const originalWrite = process.stderr.write;
  let teeBytes = 0;
  process.stderr.write = (chunk) => { teeBytes += Buffer.byteLength(chunk); return true; };
  try {
    let single;
    try { await runCommand(process.execPath, ["-e", "process.stderr.write('matches-current.json must contain a non-empty array.\\n');process.exitCode=1"], {}, { captureStderr: true, timeoutMs: 5000 }); }
    catch (error) { single = error; }
    verify("actual child complete capture", () => {
      assert.equal(single.code, "SYNC_WORKER_COMMAND_FAILED"); assert.equal(single.stderrTruncated, false);
      assert.equal(single.stderr, emptyError().stderr); assert.equal(teeBytes, Buffer.byteLength(single.stderr));
      assert.ok(describeCurrentSourceFailureCooldown({ ...single, command: "npm", args: ["run", "validate:data"] }, emptyMeta()));
    });
    let long;
    try { await runCommand(process.execPath, ["-e", "process.stderr.write('x'.repeat(9000)+'\\nmatches-current.json must contain a non-empty array.\\n');process.exitCode=1"], {}, { captureStderr: true, timeoutMs: 5000 }); }
    catch (error) { long = error; }
    verify("bounded capture cannot hide an earlier validator error", () => {
      assert.equal(Buffer.byteLength(long.stderr), 8192); assert.equal(long.stderrTruncated, true);
      assert.equal(describeCurrentSourceFailureCooldown({ ...long, command: "npm", args: ["run", "validate:data"] }, emptyMeta()), null);
    });
  } finally { process.stderr.write = originalWrite; }
  console.log(JSON.stringify({ ok: true, checks, scope: "synthetic-worker-current-source-cooldown", productionWrites: false, localFootballDataUsed: false }));
};
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
