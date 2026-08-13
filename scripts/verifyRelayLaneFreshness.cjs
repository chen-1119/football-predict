const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { summarizeRelayLanes } = require("./relayLaneFreshness.cjs");
const { boundedRuntimeEnv, boundedRuntimeNumber } = require("./boundedRuntimeNumber.cjs");

const rootDir = path.resolve(__dirname, "..");

const nowMs = Date.parse("2026-07-12T12:00:00.000Z");
const payload = { value: { matchInfoList: [{ subMatchList: [{ id: "m1" }] }] } };
const endpoint = (method, fetchedAt, page = 1) => ({ method, page, fetchedAt, ok: true, payload });

const composite = {
  version: 1,
  source: "sporttery-relay",
  capturedAt: "2026-07-12T11:55:00.000Z",
  endpoints: [
    endpoint("current", "2026-07-12T11:55:00.000Z"),
    endpoint("calculator", "2026-07-12T11:54:00.000Z"),
    endpoint("result", "2026-07-12T11:58:00.000Z", 1),
    endpoint("result", "2026-07-10T12:39:00.000Z", 2),
  ],
};

const mixed = summarizeRelayLanes(composite, {
  nowMs,
  currentMaxAgeMinutes: 20,
  historyMaxAgeMinutes: 180,
});
assert.equal(mixed.current.stale, false, "fresh current/calculator lane must remain serviceable");
assert.equal(mixed.result.stale, false, "fresh result page 1 must remain independently serviceable");
assert.equal(mixed.result.capturedAt, "2026-07-12T11:58:00.000Z", "result freshness uses only the latest result page 1 capture");
assert.equal(mixed.result.rows, 1, "result rows represent the latest page 1 payload only");
assert.equal(mixed.history.stale, true, "fresh result page 1 must not make the complete history lane fresh");
assert.equal(mixed.history.capturedAt, "2026-07-10T12:39:00.000Z", "history completeness uses the oldest required result page timestamp");
assert.equal(mixed.current.capturedAt, "2026-07-12T11:54:00.000Z", "current completeness reports the older usable current endpoint");

const fresh = summarizeRelayLanes({
  endpoints: [
    endpoint("current", "2026-07-12T11:55:00.000Z"),
    endpoint("result", "2026-07-12T11:30:00.000Z"),
  ],
}, { nowMs, currentMaxAgeMinutes: 20, historyMaxAgeMinutes: 180 });
assert.equal(fresh.current.stale, false);
assert.equal(fresh.history.stale, false);
assert.equal(fresh.result.stale, true, "a 30-minute result page is stale under the 20-minute result-lane SLA");

const latestResultPageOne = summarizeRelayLanes({
  endpoints: [
    endpoint("result", "2026-07-12T11:42:00.000Z"),
    endpoint("result", "2026-07-12T11:57:00.000Z", 1),
    endpoint("result", "2026-07-12T11:59:00.000Z", 2),
  ],
}, { nowMs, currentMaxAgeMinutes: 20, historyMaxAgeMinutes: 180 });
assert.equal(latestResultPageOne.result.capturedAt, "2026-07-12T11:57:00.000Z", "missing page is page 1 and the newest page 1 capture wins");
assert.equal(latestResultPageOne.result.rows, 1, "older duplicate page 1 captures are not double counted");
assert.equal(latestResultPageOne.history.latestCapturedAt, "2026-07-12T11:59:00.000Z", "history still observes every result page");

const currentOnly = summarizeRelayLanes({
  endpoints: [endpoint("current", "2026-07-12T11:55:00.000Z")],
}, { nowMs, currentMaxAgeMinutes: 20, historyMaxAgeMinutes: 180 });
assert.equal(currentOnly.current.stale, false);
assert.equal(currentOnly.result.stale, true, "missing result page 1 fails closed independently");
assert.equal(currentOnly.history.stale, true, "missing paged/history lane fails closed without breaking current");

const futureClock = summarizeRelayLanes({
  endpoints: [
    endpoint("current", "2026-07-12T12:10:01.000Z"),
    endpoint("result", "2026-07-12T12:10:01.000Z"),
  ],
}, {
  nowMs,
  currentMaxAgeMinutes: 20,
  historyMaxAgeMinutes: 180,
  maxFutureSkewMinutes: 5,
});
assert.equal(futureClock.current.futureClock, true, "future current capture is identified explicitly");
assert.equal(futureClock.current.stale, true, "future current capture fails closed instead of receiving age zero");
assert.equal(futureClock.result.futureClock, true, "future result capture is identified explicitly");
assert.equal(futureClock.result.stale, true, "future result capture cannot open the correction lane");

for (const invalid of ["NaN", "Infinity", "-Infinity"]) {
  assert.equal(boundedRuntimeNumber(invalid, { fallback: 20, min: 1, max: 60 }), 20);
  assert.equal(boundedRuntimeEnv({ VALUE: invalid }, "VALUE", {
    fallback: 300, min: 0, max: 3600,
  }), 300);
}
const relayModulePath = path.join(rootDir, "scripts", "relayLaneFreshness.cjs");
const invalidEnvChild = spawnSync(process.execPath, ["-e", `
  const { summarizeRelayLanes } = require(${JSON.stringify(relayModulePath)});
  const payload = { value: { matchInfoList: [{ subMatchList: [{ id: "m1" }] }] } };
  const summary = summarizeRelayLanes({ endpoints: [{
    method: "result", page: 1, ok: true,
    fetchedAt: "2026-07-12T12:10:01.000Z", payload,
  }] }, { nowMs: Date.parse("2026-07-12T12:00:00.000Z") });
  process.stdout.write(JSON.stringify(summary.result));
`], {
  cwd: rootDir,
  encoding: "utf8",
  env: {
    ...process.env,
    TRUSTED_MAX_FUTURE_SKEW_SECONDS: "NaN",
    SPORTTERY_RELAY_MAX_AGE_MINUTES: "Infinity",
    SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES: "-Infinity",
  },
});
assert.equal(invalidEnvChild.status, 0, invalidEnvChild.stderr);
const invalidEnvResult = JSON.parse(invalidEnvChild.stdout);
assert.equal(invalidEnvResult.maxFutureSkewMinutes, 5);
assert.equal(invalidEnvResult.maxAgeMinutes, 20);
assert.equal(invalidEnvResult.futureClock, true);
assert.equal(invalidEnvResult.stale, true, "invalid env values must not disable future-clock rejection");

const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
const syncSource = fs.readFileSync(path.join(rootDir, "scripts", "syncData.cjs"), "utf8");
const typeSource = fs.readFileSync(path.join(rootDir, "src", "context", "AppContextCore.ts"), "utf8");
assert.ok(serverSource.includes("resultLane: lanes.result")
  && serverSource.includes("sportteryRelayFastLaneSnapshotPath")
  && serverSource.includes("resultLane: selectedResultLane")
  && serverSource.includes('fullHistorySource: relayFullSnapshotSummary ? "full-snapshot" : null'), "server validation and independent lane summaries expose resultLane");
assert.ok(serverSource.includes("resultLane: validation.resultLane || null"), "stored relay status exposes resultLane");
assert.ok(serverSource.includes("relayResultFresh") && serverSource.includes("relayResultRows") && serverSource.includes("relayResultFreshnessTime"), "source health exposes result lane metrics");
const syncMetaFreshnessSource = serverSource.slice(
  serverSource.indexOf("const syncMetaFreshness ="),
  serverSource.indexOf("const syncMetaLaneStale =")
);
const publicFreshnessSource = serverSource.slice(
  serverSource.indexOf("const buildPublicSyncMeta = async () =>"),
  serverSource.indexOf("const matchDetailSourceHealth =")
);
assert.ok(syncMetaFreshnessSource.includes('if (lane === "history")')
  && syncMetaFreshnessSource.includes("return latestIsoTime(...laneFreshness)"), "history sync-meta freshness has no generic or fast-lane fallback");
assert.ok(!publicFreshnessSource.slice(
  publicFreshnessSource.indexOf("const historyFreshnessTime ="),
  publicFreshnessSource.indexOf("const ageSecondsFor =")
).includes("fastResultFreshnessTime"), "public history freshness is not advanced by fast result publication");
assert.ok(syncSource.includes("resultLane: lanes.result")
  && syncSource.includes("sportteryRelayFastLaneSnapshotPaths")
  && syncSource.includes("runtimeLaneOverlay"), "dual-file relay loader summary exposes resultLane");
assert.ok(syncSource.includes("resultFreshnessTime") && syncSource.includes("resultAgeSeconds") && syncSource.includes("resultStale"), "sync metadata carries independent result freshness fields");
assert.ok(syncSource.includes("relayResultLaneCapturedAt") && syncSource.includes("relayResultLaneStale"), "sync attempt records the result relay lane");
assert.ok(typeSource.includes("resultLane?:") && typeSource.includes("relayResultFresh?:"), "frontend contract types the result lane");
assert.ok(typeSource.includes("resultFreshnessTime?:") && typeSource.includes("resultAgeSeconds?:"), "frontend sync summary types result freshness");

console.log(JSON.stringify({
  ok: true,
  checks: 38,
  mixed,
  futureClock,
}, null, 2));
