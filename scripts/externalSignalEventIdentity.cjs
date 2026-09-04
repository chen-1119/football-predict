"use strict";

const norm = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, "")
  .trim();

const parseInstant = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(" ", "T")}${text.length === 16 ? ":00" : ""}+08:00`
    : text;
  return Date.parse(normalized);
};

const firstValue = (rows, keys) => {
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
  }
  return null;
};

const identityRows = (value) => [
  value,
  value?.preMatch,
  value?.freeFootball,
  value?.fiveHundred,
  value?.apiFootball,
].filter(Boolean);

const eventIdentity = (value) => {
  const rows = identityRows(value);
  return {
    sourceMatchId: norm(firstValue(rows, ["sourceMatchId", "matchId", "fixtureId", "infoMatchId"])),
    kickoffMs: parseInstant(firstValue(rows, ["kickoffTime", "fixtureDate", "eventVersion"])),
    homeTeam: norm(firstValue(rows, ["homeTeamName", "homeName"])),
    awayTeam: norm(firstValue(rows, ["awayTeamName", "awayName"])),
  };
};

const namesClearlyConflict = (left, right) => {
  if (!left || !right || left === right) return false;
  return !left.includes(right) && !right.includes(left);
};

const externalSignalMatchesEvent = (existing, incoming, { toleranceMinutes = 45 } = {}) => {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return true;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return true;
  const left = eventIdentity(existing);
  const right = eventIdentity(incoming);
  if (Number.isFinite(left.kickoffMs) && Number.isFinite(right.kickoffMs)) {
    if (Math.abs(left.kickoffMs - right.kickoffMs) > toleranceMinutes * 60 * 1000) return false;
  }
  if (namesClearlyConflict(left.homeTeam, right.homeTeam)
    && namesClearlyConflict(left.awayTeam, right.awayTeam)) return false;
  return true;
};

const eventSafeExistingSignal = (existing, incoming, options) => (
  externalSignalMatchesEvent(existing, incoming, options) ? existing : {}
);

const stampSignalEvent = (signal, match) => ({
  ...(signal && typeof signal === "object" && !Array.isArray(signal) ? signal : {}),
  sourceMatchId: match?.sourceMatchId || signal?.sourceMatchId || null,
  matchId: match?.id || signal?.matchId || null,
  matchNo: match?.matchNo || signal?.matchNo || null,
  kickoffTime: match?.kickoffTime || signal?.kickoffTime || null,
  homeTeamName: match?.homeTeamName || match?.homeTeamNameEn || signal?.homeTeamName || null,
  awayTeamName: match?.awayTeamName || match?.awayTeamNameEn || signal?.awayTeamName || null,
});

module.exports = {
  eventIdentity,
  eventSafeExistingSignal,
  externalSignalMatchesEvent,
  stampSignalEvent,
};
