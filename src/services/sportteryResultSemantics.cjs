"use strict";

const {
  officialVoidDisposition,
  statusFromSporttery,
} = require("./sportteryStatus.cjs");

// Keep the raw provider inputs that can alter the normalized result candidate
// in one contract. Both the publisher normalizer and the relay semantic digest
// consume this module, so adding a provider alias cannot silently make the
// watcher suppress a result transition.
const SPORTTERY_RESULT_SECTION_SCORE_FIELDS = Object.freeze([
  "sectionsNo999",
  "sectionsNo1",
  "fullScore",
  "finalScore",
  "matchScore",
  "currentScore",
  "liveScore",
  "score",
]);
const SPORTTERY_RESULT_HOME_SCORE_FIELDS = Object.freeze([
  "homeScore",
  "homeTeamScore",
  "homeGoals",
  "homeGoal",
  "homeFullScore",
  "homeLiveScore",
]);
const SPORTTERY_RESULT_AWAY_SCORE_FIELDS = Object.freeze([
  "awayScore",
  "awayTeamScore",
  "awayGoals",
  "awayGoal",
  "awayFullScore",
  "awayLiveScore",
]);
const SPORTTERY_RESULT_STATUS_FIELDS = Object.freeze([
  "matchStatus",
  "sellStatus",
  "matchStatusName",
  "matchResultStatus",
  "poolStatus",
]);
const SPORTTERY_RESULT_HOME_TEAM_CODE_FIELDS = Object.freeze([
  "homeTeamCode",
  "homeTeamAbbEnName",
]);
const SPORTTERY_RESULT_AWAY_TEAM_CODE_FIELDS = Object.freeze([
  "awayTeamCode",
  "awayTeamAbbEnName",
]);
const SPORTTERY_RESULT_IDENTITY_FIELDS = Object.freeze([
  "matchId",
  "matchNum",
  "matchNumDate",
  "matchNumStr",
  "businessDate",
  "matchDate",
  "matchTime",
  "homeTeamAllName",
  "homeTeamAbbName",
  "awayTeamAllName",
  "awayTeamAbbName",
  ...SPORTTERY_RESULT_HOME_TEAM_CODE_FIELDS,
  ...SPORTTERY_RESULT_AWAY_TEAM_CODE_FIELDS,
]);
const SPORTTERY_RESULT_METADATA_FIELDS = Object.freeze([
  "sectionsNo2",
  "sectionsNo3",
  "sectionsNo4",
  "sectionsNo5",
  "result",
  "sourceUpdatedAt",
  "updatedAt",
  "updateTime",
  "lastUpdateTime",
  "matchUpdateTime",
  "officialResultIdentity",
  "officialPayoutSp",
]);
const SPORTTERY_RESULT_OBSERVATION_FIELDS = Object.freeze([...new Set([
  ...SPORTTERY_RESULT_IDENTITY_FIELDS,
  ...SPORTTERY_RESULT_STATUS_FIELDS,
  ...SPORTTERY_RESULT_SECTION_SCORE_FIELDS,
  ...SPORTTERY_RESULT_HOME_SCORE_FIELDS,
  ...SPORTTERY_RESULT_AWAY_SCORE_FIELDS,
  ...SPORTTERY_RESULT_METADATA_FIELDS,
])]);

const scoreFromSections = (section) => {
  const match = String(section ?? "").trim().match(/(\d+)\s*[:\-]\s*(\d+)/);
  if (!match) return { home: null, away: null };
  return { home: Number(match[1]), away: Number(match[2]) };
};

const firstFiniteScore = (row, fields, fallback = null) => {
  for (const field of fields) {
    const value = row?.[field];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const scoreFromSportteryRow = (row = {}) => {
  const sectionValue = SPORTTERY_RESULT_SECTION_SCORE_FIELDS
    .map((field) => row?.[field])
    .find(Boolean);
  const sectionScore = scoreFromSections(sectionValue);
  return {
    home: firstFiniteScore(row, SPORTTERY_RESULT_HOME_SCORE_FIELDS, sectionScore.home),
    away: firstFiniteScore(row, SPORTTERY_RESULT_AWAY_SCORE_FIELDS, sectionScore.away),
  };
};

const teamCodeFromSportteryRow = (row = {}, side) => {
  const fields = side === "home"
    ? SPORTTERY_RESULT_HOME_TEAM_CODE_FIELDS
    : side === "away"
      ? SPORTTERY_RESULT_AWAY_TEAM_CODE_FIELDS
      : [];
  const value = fields.map((field) => row?.[field]).find(Boolean);
  return String(value ?? "").trim();
};

const officialVoidDispositionFromSportteryRow = (row = {}) => officialVoidDisposition(
  row.matchStatus,
  row.sellStatus,
  row.matchStatusName,
);

// Result publication must never infer a terminal state from the local clock.
// Keep this predicate limited to status fields explicitly carried by the
// official response. The broader UI normalizer may still use kickoff time to
// display SCHEDULED/LIVE, but the settlement writer is intentionally stricter.
const isExplicitSportteryTerminalRow = (row = {}) => {
  const matchStatus = String(row?.matchStatus ?? "").trim().toLowerCase();
  const matchResultStatus = String(row?.matchResultStatus ?? "").trim().toLowerCase();
  const statusText = [
    row?.matchStatus,
    row?.sellStatus,
    row?.matchStatusName,
    row?.matchResultStatus,
    row?.poolStatus,
  ].map((value) => String(value ?? "").trim().toLowerCase()).join(" ");
  return ["11", "12", "13"].includes(matchStatus)
    || ["2", "finished", "result", "ended", "completed", "final"]
      .includes(matchResultStatus)
    || /\b(?:finished|result|ended|completed|final|payout)\b/i.test(statusText);
};

const statusFromSportteryRow = (row = {}, kickoffTime = "", now = Date.now()) => {
  // A cancellation remains stronger than a payout-like companion field. For
  // every other explicit official terminal marker, finish immediately and do
  // not let normalizeStatusWithScore depend on the local 125-minute clock.
  if (officialVoidDispositionFromSportteryRow(row)) return "PENDING_RESULT";
  if (isExplicitSportteryTerminalRow(row)) return "FINISHED";
  return statusFromSporttery(
    row.matchStatus,
    row.sellStatus,
    row.matchStatusName,
    kickoffTime,
    now,
  );
};

const sportteryResultObservation = (row = {}) => {
  const observation = {};
  for (const field of SPORTTERY_RESULT_OBSERVATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) observation[field] = row[field];
  }
  return observation;
};

module.exports = {
  SPORTTERY_RESULT_AWAY_SCORE_FIELDS,
  SPORTTERY_RESULT_AWAY_TEAM_CODE_FIELDS,
  SPORTTERY_RESULT_HOME_SCORE_FIELDS,
  SPORTTERY_RESULT_HOME_TEAM_CODE_FIELDS,
  SPORTTERY_RESULT_IDENTITY_FIELDS,
  SPORTTERY_RESULT_OBSERVATION_FIELDS,
  SPORTTERY_RESULT_SECTION_SCORE_FIELDS,
  SPORTTERY_RESULT_STATUS_FIELDS,
  isExplicitSportteryTerminalRow,
  officialVoidDispositionFromSportteryRow,
  scoreFromSportteryRow,
  sportteryResultObservation,
  statusFromSportteryRow,
  teamCodeFromSportteryRow,
};
