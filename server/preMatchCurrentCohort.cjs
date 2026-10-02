"use strict";

const COMPONENTS = Object.freeze([
  "referee", "teamCards", "lineup", "injuries", "xg", "weather",
  "market", "motivation", "strength", "form",
]);
const STATUSES = Object.freeze([
  "verified", "partial", "estimated", "missing", "not_yet_publishable",
  "published_after_cutoff", "stale_or_unverified",
]);
const CONNECTED = new Set(["verified", "partial", "estimated"]);
const sameKickoff = (left, right) => {
  const leftTime = Date.parse(String(left || ""));
  const rightTime = Date.parse(String(right || ""));
  return Number.isFinite(leftTime) && leftTime === rightTime;
};

const matchRow = (match, snapshotRows) => {
  const matchId = String(match?.id || "");
  const sourceId = String(match?.sourceMatchId || matchId).replace(/^(sporttery|fivehundred)_/, "");
  for (const key of [sourceId, matchId]) {
    const row = snapshotRows[key];
    if (row?.matchId === matchId && sameKickoff(row?.kickoffTime, match?.kickoffTime)) {
      return row;
    }
  }
  return null;
};

const summarizeCurrentPreMatchCohort = (currentMatches, snapshotRows, snapshotCoverage = {}) => {
  const matches = Array.isArray(currentMatches) ? currentMatches : [];
  const rows = snapshotRows && typeof snapshotRows === "object" && !Array.isArray(snapshotRows)
    ? snapshotRows : {};
  const aligned = matches.map((match) => matchRow(match, rows));
  const coverageByComponent = {};
  for (const key of COMPONENTS) {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of aligned) {
      const rawStatus = row?.quality?.components?.[key]?.status;
      counts[STATUSES.includes(rawStatus) ? rawStatus : "missing"] += 1;
    }
    const connected = [...CONNECTED].reduce((sum, status) => sum + counts[status], 0);
    coverageByComponent[key] = {
      rows: matches.length,
      ...counts,
      connected,
      coverage: matches.length ? Number((connected / matches.length).toFixed(4)) : 0,
      nextSource: snapshotCoverage?.[key]?.nextSource || null,
    };
  }
  const gapPriorities = Object.entries(coverageByComponent)
    .map(([key, value]) => ({
      key,
      missing: value.missing,
      estimated: value.estimated,
      rows: value.rows,
      coverage: value.coverage,
      nextSource: value.nextSource,
    }))
    .filter((value) => value.missing || value.estimated)
    .sort((left, right) => right.missing - left.missing
      || right.estimated - left.estimated
      || left.coverage - right.coverage
      || left.key.localeCompare(right.key));
  const alignedRows = aligned.filter(Boolean).length;
  return {
    matchCount: matches.length,
    snapshotRows: Object.keys(rows).length,
    alignedRows,
    missingRows: matches.length - alignedRows,
    high: aligned.filter((row) => row?.quality?.sourceQuality === "high").length,
    medium: aligned.filter((row) => row?.quality?.sourceQuality === "medium").length,
    low: aligned.filter((row) => row?.quality?.sourceQuality === "low").length,
    recommendationUsable: aligned.filter((row) => row?.quality?.recommendationUsable === true).length,
    analysisComplete: aligned.filter((row) => row?.quality?.analysisComplete === true).length,
    coverageByComponent,
    gapPriorities,
  };
};

module.exports = { summarizeCurrentPreMatchCohort };
