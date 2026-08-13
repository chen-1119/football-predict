const DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS = 48;
const { canonicalSourceMatchId } = require("../src/services/matchLifecycle.cjs");

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveCurrentUnsettledRetentionHours(value = process.env.CURRENT_UNSETTLED_RETENTION_HOURS) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS;
}

function shanghaiDateKey(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(new Date(time))
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function outputDateCandidates(match) {
  return Array.from(new Set([
    match?.businessDate,
    match?.kickoffDate,
    match?.matchDate,
    shanghaiDateKey(match?.kickoffTime),
  ].map((value) => String(value || "").trim()).filter(Boolean)));
}

function isSameOutputDay(match, capturedAt) {
  const today = shanghaiDateKey(capturedAt);
  return Boolean(today && outputDateCandidates(match).includes(today));
}

function isFinished(match) {
  return String(match?.status || "").toUpperCase() === "FINISHED";
}

function isMatchEligibleForCurrent(match, capturedAt = new Date().toISOString(), options = {}) {
  if (isFinished(match)) return isSameOutputDay(match, capturedAt);

  const capturedMs = Date.parse(capturedAt);
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  // Invalid timestamps fail open: an uncertain fixture must not disappear from
  // the customer list until a later sync supplies a trustworthy kickoff time.
  if (!Number.isFinite(capturedMs) || !Number.isFinite(kickoffMs)) return true;
  if (kickoffMs > capturedMs) return true;

  const retentionHours = resolveCurrentUnsettledRetentionHours(options.retentionHours);
  return capturedMs - kickoffMs <= retentionHours * 60 * 60 * 1000;
}

function splitMatchesForOutput(matches, capturedAt = new Date().toISOString(), options = {}) {
  const rows = Array.isArray(matches) ? matches : [];
  const retentionHours = resolveCurrentUnsettledRetentionHours(options.retentionHours);
  const current = [];
  const history = [];
  const archivedUnsettled = [];

  for (const match of rows) {
    if (isFinished(match)) history.push(match);
    if (isMatchEligibleForCurrent(match, capturedAt, { retentionHours })) {
      current.push(match);
    } else if (!isFinished(match)) {
      archivedUnsettled.push(match);
    }
  }

  return { current, history, archivedUnsettled, retentionHours };
}

function matchIdentity(match) {
  return canonicalSourceMatchId(match?.sourceMatchId || match?.id);
}

function reconcileArchivedUnsettled(existingRows, matches, capturedAt = new Date().toISOString(), options = {}) {
  const retentionHours = resolveCurrentUnsettledRetentionHours(options.retentionHours);
  const archivedById = new Map();

  for (const match of Array.isArray(existingRows) ? existingRows : []) {
    const key = matchIdentity(match);
    if (!key || isFinished(match) || isMatchEligibleForCurrent(match, capturedAt, { retentionHours })) continue;
    archivedById.set(key, match);
  }

  for (const match of Array.isArray(matches) ? matches : []) {
    const key = matchIdentity(match);
    if (!key) continue;
    if (isFinished(match) || isMatchEligibleForCurrent(match, capturedAt, { retentionHours })) {
      archivedById.delete(key);
    } else {
      archivedById.set(key, match);
    }
  }

  return Array.from(archivedById.values()).sort((a, b) => {
    const aTime = Date.parse(a?.kickoffTime || "");
    const bTime = Date.parse(b?.kickoffTime || "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    return matchIdentity(a).localeCompare(matchIdentity(b));
  });
}

module.exports = {
  DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS,
  isMatchEligibleForCurrent,
  isSameOutputDay,
  matchIdentity,
  reconcileArchivedUnsettled,
  resolveCurrentUnsettledRetentionHours,
  shanghaiDateKey,
  splitMatchesForOutput,
};
