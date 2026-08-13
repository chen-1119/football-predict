const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS,
  isMatchEligibleForCurrent,
  reconcileArchivedUnsettled,
  resolveCurrentUnsettledRetentionHours,
  splitMatchesForOutput,
} = require("./currentMatchRetention.cjs");

const capturedAt = "2026-07-13T06:00:00.000Z"; // 14:00 Asia/Shanghai
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
const row = (id, status, kickoffTime, extra = {}) => ({
  id: `sporttery_${id}`,
  sourceMatchId: id,
  status,
  kickoffTime,
  homeTeamName: `Home ${id}`,
  awayTeamName: `Away ${id}`,
  ...extra,
});

const todayFinished = row("today-finished", "FINISHED", "2026-07-13T01:00:00.000Z", {
  scoreHome: 2,
  scoreAway: 1,
});
const oldFinished = row("old-finished", "FINISHED", "2026-07-10T01:00:00.000Z", {
  scoreHome: 0,
  scoreAway: 0,
});
const recentPending = row("recent-pending", "PENDING_RESULT", "2026-07-12T06:30:00.000Z");
const boundaryPending = row("boundary-pending", "PENDING_RESULT", "2026-07-11T06:00:00.000Z");
const oldPending = row("old-pending", "PENDING_RESULT", "2026-07-11T05:59:59.999Z");
const oldScheduled = row("old-scheduled", "SCHEDULED", "2026-07-01T06:00:00.000Z");
const oldLive = row("old-live", "LIVE", "2026-07-01T06:00:00.000Z");
const futureScheduled = row("future", "SCHEDULED", "2026-07-14T06:00:00.000Z");
const invalidKickoff = row("invalid", "PENDING_RESULT", "not-a-date");
const input = [
  todayFinished,
  oldFinished,
  recentPending,
  boundaryPending,
  oldPending,
  oldScheduled,
  oldLive,
  futureScheduled,
  invalidKickoff,
];
const original = JSON.stringify(input);
const split = splitMatchesForOutput(input, capturedAt, { retentionHours: 48 });
const currentIds = new Set(split.current.map((match) => match.sourceMatchId));
const historyIds = new Set(split.history.map((match) => match.sourceMatchId));
const archiveIds = new Set(split.archivedUnsettled.map((match) => match.sourceMatchId));

check("default retention is 48 hours", () => {
  assert.equal(DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS, 48);
  assert.equal(resolveCurrentUnsettledRetentionHours(null), 48);
  assert.equal(split.retentionHours, 48);
});

check("invalid retention values fail safely to the default", () => {
  assert.equal(resolveCurrentUnsettledRetentionHours("0"), 48);
  assert.equal(resolveCurrentUnsettledRetentionHours("not-a-number"), 48);
});

check("same Shanghai-day FINISHED rows remain in current and history", () => {
  assert.equal(currentIds.has("today-finished"), true);
  assert.equal(historyIds.has("today-finished"), true);
});

check("older FINISHED rows remain in history and leave current", () => {
  assert.equal(currentIds.has("old-finished"), false);
  assert.equal(historyIds.has("old-finished"), true);
});

check("recent and exact-boundary pending results remain visible", () => {
  assert.equal(currentIds.has("recent-pending"), true);
  assert.equal(currentIds.has("boundary-pending"), true);
  assert.equal(archiveIds.has("recent-pending"), false);
});

check("pending results older than the window leave current without becoming FINISHED", () => {
  assert.equal(currentIds.has("old-pending"), false);
  assert.equal(historyIds.has("old-pending"), false);
  assert.equal(archiveIds.has("old-pending"), true);
  assert.equal(split.archivedUnsettled.find((match) => match.sourceMatchId === "old-pending")?.status, "PENDING_RESULT");
});

check("stale scheduled/live rows are archived without fabricated settlement", () => {
  assert.equal(archiveIds.has("old-scheduled"), true);
  assert.equal(archiveIds.has("old-live"), true);
  assert.deepEqual(
    split.archivedUnsettled.filter((match) => ["old-scheduled", "old-live"].includes(match.sourceMatchId)).map((match) => match.status),
    ["SCHEDULED", "LIVE"]
  );
});

check("future fixtures stay current", () => {
  assert.equal(currentIds.has("future"), true);
});

check("invalid kickoff timestamps fail open instead of hiding a fixture", () => {
  assert.equal(currentIds.has("invalid"), true);
});

check("retention hours are configurable", () => {
  assert.equal(isMatchEligibleForCurrent(recentPending, capturedAt, { retentionHours: 12 }), false);
  assert.equal(isMatchEligibleForCurrent(recentPending, capturedAt, { retentionHours: 24 }), true);
});

check("split does not mutate source records", () => {
  assert.equal(JSON.stringify(input), original);
});

check("archive reconciliation retains absent unresolved rows and removes settled replacements", () => {
  const retained = row("retained", "PENDING_RESULT", "2026-06-01T00:00:00.000Z");
  const settled = row("old-pending", "FINISHED", "2026-07-11T05:59:59.999Z", { scoreHome: 1, scoreAway: 0 });
  const reconciled = reconcileArchivedUnsettled(
    [retained, oldPending],
    [settled, oldScheduled],
    capturedAt,
    { retentionHours: 48 }
  );
  const reconciledIds = new Set(reconciled.map((match) => match.sourceMatchId));
  assert.equal(reconciledIds.has("retained"), true);
  assert.equal(reconciledIds.has("old-pending"), false);
  assert.equal(reconciledIds.has("old-scheduled"), true);
  assert.equal(reconciled.some((match) => match.status === "FINISHED"), false);
});

check("provider-dropped stale current rows are carried into the private archive", () => {
  const providerDropped = row("provider-dropped", "PENDING_RESULT", "2026-06-20T00:00:00.000Z");
  const reconciled = reconcileArchivedUnsettled(
    [providerDropped],
    [futureScheduled],
    capturedAt,
    { retentionHours: 48 }
  );
  assert.equal(reconciled.some((match) => match.sourceMatchId === "provider-dropped"), true);
  assert.equal(reconciled.some((match) => match.sourceMatchId === "future"), false);
});

check("private unresolved archive is persisted before public current payloads", () => {
  const syncSource = fs.readFileSync(path.join(__dirname, "syncData.cjs"), "utf8");
  const archiveWrite = syncSource.indexOf("writeJson(UNRESOLVED_MATCH_ARCHIVE_PATH");
  const currentWrite = syncSource.indexOf('writeJson(path.join(dataDir, "matches-current.json")');
  assert.match(
    syncSource,
    /reconcileArchivedUnsettled\(\s*\/\/[\s\S]*?\[\.\.\.existingUnresolvedArchive, \.\.\.existingMatches\],\s*output,/,
    "pre-sync current rows must participate in private archive reconciliation"
  );
  assert.ok(archiveWrite >= 0, "sync must persist the private unresolved archive");
  assert.ok(currentWrite >= 0, "sync must publish the current payload");
  assert.ok(archiveWrite < currentWrite, "private archive must be durable before current rows are removed");
});

console.log(JSON.stringify({
  ok: true,
  summary: {
    checks: checks.length,
    retentionHours: split.retentionHours,
    current: split.current.length,
    history: split.history.length,
    archivedUnsettled: split.archivedUnsettled.length,
  },
  checks,
}, null, 2));
