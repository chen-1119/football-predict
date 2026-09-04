"use strict";

const {
  SPORTTERY_RESULT_URL,
} = require("./sportteryEndpointContract.cjs");

const normText = (value) => String(value ?? "").trim();

const providerInstant = (value) => {
  const raw = normText(value);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const scoreIsFinal = (value) => /^\d+\s*:\s*\d+$/.test(normText(value));

const scoreIsVoid = (value) => /无效场次|取消/.test(normText(value));

const normalizedResultRow = (row, lastUpdateTime = "") => {
  const {
    h,
    d,
    a,
    ...sourceRow
  } = row && typeof row === "object" ? row : {};
  const finalScore = normText(sourceRow.sectionsNo999);
  const voidResult = scoreIsVoid(finalScore);
  const settled = scoreIsFinal(finalScore);
  const sourceUpdatedAt = providerInstant(lastUpdateTime);
  return {
    ...sourceRow,
    homeTeamAllName: normText(sourceRow.allHomeTeam || sourceRow.homeTeam),
    homeTeamAbbName: normText(sourceRow.homeTeam || sourceRow.allHomeTeam),
    awayTeamAllName: normText(sourceRow.allAwayTeam || sourceRow.awayTeam),
    awayTeamAbbName: normText(sourceRow.awayTeam || sourceRow.allAwayTeam),
    leagueAllName: normText(sourceRow.leagueName || sourceRow.leagueNameAbbr),
    leagueAbbName: normText(sourceRow.leagueNameAbbr || sourceRow.leagueName),
    matchStatus: voidResult ? "12" : settled ? "11" : "10",
    matchStatusName: voidResult ? "比赛取消" : settled ? "赛果" : "等待官方赛果",
    sellStatus: normText(sourceRow.poolStatus),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    officialResultIdentity: {
      provider: "sporttery",
      endpoint: "getUniformMatchResultV1",
      matchId: normText(sourceRow.matchId),
      matchResultStatus: normText(sourceRow.matchResultStatus),
      poolStatus: normText(sourceRow.poolStatus),
      providerUpdatedAt: sourceUpdatedAt,
      // This payout endpoint identifies the event and final score but does not
      // publish an authoritative kickoff clock. Its matchDate must never
      // replace the pre-match fixture eventVersion.
      scheduleTimeAuthority: "omitted-by-official-result-feed",
    },
    // The payout page exposes post-match SP values. Keep them available for
    // result auditing but never place them in the pre-match HAD/HHAD fields.
    officialPayoutSp: {
      h: normText(h) || null,
      d: normText(d) || null,
      a: normText(a) || null,
    },
  };
};

const normalizeOfficialUniformResultPayload = (payload) => {
  const rows = Array.isArray(payload?.value?.matchResult)
    ? payload.value.matchResult
    : null;
  if (!rows) return payload;
  const lastUpdateTime = normText(payload?.value?.lastUpdateTime);
  const grouped = new Map();
  for (const row of rows) {
    const businessDate = normText(row?.matchDate) || "unknown";
    if (!grouped.has(businessDate)) grouped.set(businessDate, []);
    grouped.get(businessDate).push(normalizedResultRow(row, lastUpdateTime));
  }
  return {
    ...payload,
    value: {
      ...payload.value,
      matchInfoList: Array.from(grouped.entries()).map(([businessDate, subMatchList]) => ({
        businessDate,
        subMatchList,
      })),
      officialResultFeed: {
        endpoint: SPORTTERY_RESULT_URL,
        resultCount: rows.length,
        lastUpdateTime: lastUpdateTime || null,
        scope: "latest-official-payout-results",
      },
    },
  };
};

const isOfficialUniformResultUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === "webapi.sporttery.cn"
      && parsed.pathname === "/gateway/uniform/football/getUniformMatchResultV1.qry"
      && parsed.searchParams.get("matchPage") === "0";
  } catch {
    return false;
  }
};

module.exports = {
  isOfficialUniformResultUrl,
  normalizeOfficialUniformResultPayload,
  normalizedResultRow,
  providerInstant,
  scoreIsFinal,
  scoreIsVoid,
};
