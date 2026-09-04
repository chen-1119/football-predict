"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  externalSignalMatchesEvent,
  stampSignalEvent,
} = require("./externalSignalEventIdentity.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const EXTERNAL_FILE = path.join(ROOT_DIR, "public", "data", "external-signals.json");
const VERSION = "k-league-official-standings-v1";
const ENDPOINT = "https://www.kleague.com/record/teamRank.do";
const SCHEDULE_ENDPOINT = "https://www.kleague.com/getScheduleList.do";
const FIXTURE_VERSION = "k-league-official-fixture-v1";
const RESULT_SOURCE = "k-league:official-schedule-api";
const MIN_FINAL_ELAPSED_MINUTES = 100;

const TEAM_ALIASES = Object.freeze({
  "金泉尚武": "GIMCHEON",
  "全北现代": "JEONBUK",
  "济州SK": "JEJU",
  "济州联": "JEJU",
  "浦项制铁": "POHANG",
  "浦项钢铁": "POHANG",
  "大田市民": "DAEJEON HANA",
  "大田韩亚市民": "DAEJEON HANA",
  "蔚山现代": "ULSAN",
  "蔚山HD": "ULSAN",
  "安养FC": "ANYANG",
  "安养": "ANYANG",
  "仁川联": "INCHEON",
  "仁川联合": "INCHEON",
  "首尔FC": "SEOUL",
  "首尔": "SEOUL",
  "江原FC": "GANGWON",
  "江原": "GANGWON",
  "光州FC": "GWANGJU",
  "光州": "GWANGJU",
  "富川FC": "BUCHEON",
  "富川": "BUCHEON",
});

const TEAM_IDS = Object.freeze({
  "蔚山现代": "K01",
  "蔚山HD": "K01",
  "蔚山": "K01",
  "浦项制铁": "K03",
  "浦项钢铁": "K03",
  "浦项": "K03",
  "济州SK": "K04",
  "济州联": "K04",
  "全北现代": "K05",
  "首尔FC": "K09",
  "首尔": "K09",
  "大田市民": "K10",
  "大田韩亚市民": "K10",
  "仁川联": "K18",
  "仁川联合": "K18",
  "江原FC": "K21",
  "江原": "K21",
  "光州FC": "K22",
  "光州": "K22",
  "富川FC": "K26",
  "富川": "K26",
  "安养FC": "K27",
  "安养": "K27",
  "金泉尚武": "K35",
});

const norm = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const normalizeTeam = (value) => norm(value).toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fff]+/g, "");
const sha256 = (value) => require("node:crypto").createHash("sha256").update(value).digest("hex");

const resolveTeamId = (displayName) => {
  const direct = TEAM_IDS[norm(displayName)];
  if (direct) return direct;
  const alias = TEAM_ALIASES[norm(displayName)] || norm(displayName);
  const target = normalizeTeam(alias);
  const byOfficialName = Object.entries(TEAM_ALIASES).find(([, officialName]) => (
    normalizeTeam(officialName) === target
  ));
  return byOfficialName ? TEAM_IDS[byOfficialName[0]] || null : null;
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
    void error;
  }
};

const compactStanding = (row) => {
  const recent = [row?.game01, row?.game02, row?.game03, row?.game04, row?.game05, row?.game06]
    .map((value) => norm(value).toUpperCase())
    .filter((value) => ["W", "D", "L"].includes(value));
  return {
    teamId: norm(row?.teamId),
    teamName: norm(row?.teamName).toUpperCase(),
    rank: Number(row?.rank || 0),
    points: Number(row?.gainPoint || 0),
    played: Number(row?.gameCount || 0),
    wins: Number(row?.winCnt || 0),
    draws: Number(row?.tieCnt || 0),
    losses: Number(row?.lossCnt || 0),
    goalsFor: Number(row?.gainGoal || 0),
    goalsAgainst: Number(row?.lossGoal || 0),
    recent,
  };
};

const resolveStanding = (rows, displayName) => {
  const alias = TEAM_ALIASES[norm(displayName)] || norm(displayName);
  const target = normalizeTeam(alias);
  const teamId = resolveTeamId(displayName);
  const found = (Array.isArray(rows) ? rows : []).find((row) => (
    (teamId && norm(row?.teamId) === teamId)
    || normalizeTeam(row?.teamName) === target
    || normalizeTeam(row?.teamId) === target
  ));
  return found ? compactStanding(found) : null;
};

const isKLeagueMatch = (match) => /韩职|K\s*League/i.test([
  match?.leagueName,
  match?.leagueNameEn,
  match?.leagueShortName,
  match?.leagueShortNameEn,
].filter(Boolean).join(" "));

const matchKeys = (match) => Array.from(new Set([
  norm(match?.sourceMatchId),
  norm(match?.id),
  norm(match?.matchNo),
].filter(Boolean)));

const fetchOfficialStandings = async ({ year, leagueId = 1, fetchImpl = global.fetch } = {}) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation unavailable");
  const url = new URL(ENDPOINT);
  url.searchParams.set("leagueId", String(leagueId));
  url.searchParams.set("year", String(year));
  url.searchParams.set("stadium", "all");
  url.searchParams.set("recordType", "rank");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      "user-agent": "football-predict/k-league-official-standings-v1",
    },
  });
  if (!response.ok) throw new Error(`K League standings request failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (String(payload?.resultCode || "") !== "200") {
    throw new Error(`K League standings payload rejected: ${payload?.resultCode || "missing-code"}`);
  }
  const rows = payload?.data?.teamRank;
  if (!Array.isArray(rows) || rows.length < 10) throw new Error("K League standings payload is incomplete");
  return { url: url.toString(), rows };
};

const officialKickoffInstant = (row) => {
  const date = norm(row?.gameDate).replace(/\./g, "-");
  const time = norm(row?.gameTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const iso = `${date}T${time}:00+09:00`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
};

const seoulMonthForMatch = (match) => {
  const kickoffMs = Date.parse(match?.kickoffTime || match?.eventVersion || "");
  if (!Number.isFinite(kickoffMs)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(kickoffMs)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: parts.month };
};

const fetchOfficialSchedule = async ({ year, month, leagueId = 1, fetchImpl = global.fetch } = {}) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation unavailable");
  const response = await fetchImpl(SCHEDULE_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      "content-type": "application/json;charset=UTF-8",
      referer: `https://www.kleague.com/schedule.do?leagueId=${leagueId}`,
      "user-agent": "football-predict/k-league-official-fixture-v1",
    },
    body: JSON.stringify({
      leagueId: Number(leagueId),
      teamId: "",
      ticketStatus: "",
      year: Number(year),
      month: String(month).padStart(2, "0"),
      ticketYn: "",
    }),
  });
  if (!response.ok) throw new Error(`K League schedule request failed: HTTP ${response.status}`);
  const raw = await response.text();
  const payload = JSON.parse(raw);
  if (String(payload?.resultCode || "") !== "200") {
    throw new Error(`K League schedule payload rejected: ${payload?.resultCode || "missing-code"}`);
  }
  const rows = payload?.data?.scheduleList;
  if (!Array.isArray(rows)) throw new Error("K League schedule payload is incomplete");
  return {
    url: SCHEDULE_ENDPOINT,
    rows,
    responseSha256: sha256(raw),
  };
};

const resolveOfficialFixture = (rows, match) => {
  const homeTeamId = resolveTeamId(match?.homeTeamName || match?.homeTeam);
  const awayTeamId = resolveTeamId(match?.awayTeamName || match?.awayTeam);
  const matchKickoffMs = Date.parse(match?.eventVersion || match?.kickoffTime || "");
  if (!homeTeamId || !awayTeamId || !Number.isFinite(matchKickoffMs)) return null;
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => (
    norm(row?.homeTeam) === homeTeamId
    && norm(row?.awayTeam) === awayTeamId
    && Number.isFinite(Date.parse(officialKickoffInstant(row) || ""))
    && Math.abs(Date.parse(officialKickoffInstant(row)) - matchKickoffMs) <= 30 * 60 * 1000
  ));
  return candidates.length === 1 ? candidates[0] : null;
};

const fixtureEvidenceHash = (record) => sha256(JSON.stringify({
  provider: "k-league",
  providerMatchId: norm(record?.providerMatchId),
  sourceMatchId: norm(record?.sourceMatchId),
  eventVersion: record?.eventVersion || null,
  providerKickoffTime: record?.providerKickoffTime || null,
  homeTeamId: record?.homeTeamId || null,
  awayTeamId: record?.awayTeamId || null,
  scoreHome: Number(record?.scoreHome),
  scoreAway: Number(record?.scoreAway),
  scoreKind: "regular-time",
  responseSha256: record?.responseSha256 || null,
}));

const buildFixtureSignal = ({ match, rows, observedAt, sourceUrl, responseSha256 }) => {
  const row = resolveOfficialFixture(rows, match);
  if (!row) return null;
  const providerKickoffTime = officialKickoffInstant(row);
  const observedMs = Date.parse(observedAt || "");
  const kickoffMs = Date.parse(providerKickoffTime || "");
  const scoreHome = Number(row?.homeGoal);
  const scoreAway = Number(row?.awayGoal);
  const plausibleFinal = String(row?.gameStatus || "").toUpperCase() === "FE"
    && Number.isInteger(scoreHome)
    && scoreHome >= 0
    && Number.isInteger(scoreAway)
    && scoreAway >= 0
    && Number.isFinite(observedMs)
    && Number.isFinite(kickoffMs)
    && observedMs >= kickoffMs + MIN_FINAL_ELAPSED_MINUTES * 60 * 1000;
  const record = {
    version: FIXTURE_VERSION,
    provider: "k-league",
    source: RESULT_SOURCE,
    sourceKind: "official-competition-organizer",
    sourceUrl,
    sourceMatchId: norm(match?.sourceMatchId || String(match?.id || "").replace(/^(?:sporttery|fivehundred)_/, "")),
    providerMatchId: norm(row?.gameId),
    eventVersion: match?.eventVersion || match?.kickoffTime || null,
    providerKickoffTime,
    officialLocalKickoff: `${norm(row?.gameDate)} ${norm(row?.gameTime)}`,
    officialTimeZone: "Asia/Seoul",
    homeTeamId: norm(row?.homeTeam),
    awayTeamId: norm(row?.awayTeam),
    homeTeamName: norm(row?.homeTeamName),
    awayTeamName: norm(row?.awayTeamName),
    venue: norm(row?.fieldNameFull || row?.fieldName) || null,
    referee: norm(row?.refreeName1) || null,
    roundId: Number(row?.roundId || 0) || null,
    providerStatus: norm(row?.gameStatus).toUpperCase() || null,
    status: plausibleFinal ? "FINISHED" : "SCHEDULED",
    scoreHome: plausibleFinal ? scoreHome : null,
    scoreAway: plausibleFinal ? scoreAway : null,
    scoreKind: "regular-time",
    observedAt,
    receivedAt: observedAt,
    observationSource: "k-league-json-response-received-at",
    responseSha256,
    official: true,
    trusted: plausibleFinal,
    settlementEligible: plausibleFinal,
    resultObservationFallback: false,
    promotionEligible: false,
    mapping: {
      method: "official-team-id-and-kickoff",
      kickoffToleranceMinutes: 30,
      unique: true,
    },
  };
  return {
    ...record,
    evidenceHash: fixtureEvidenceHash(record),
  };
};

const validKLeagueFixtureEvidenceForMatch = (match, record) => {
  const matchSourceMatchId = norm(match?.sourceMatchId || String(match?.id || "").replace(/^(?:sporttery|fivehundred)_/, ""));
  const matchEventMs = Date.parse(match?.eventVersion || match?.kickoffTime || "");
  const recordEventMs = Date.parse(record?.eventVersion || "");
  const providerKickoffMs = Date.parse(record?.providerKickoffTime || "");
  const observedMs = Date.parse(record?.observedAt || "");
  return Boolean(
    match
    && record?.version === FIXTURE_VERSION
    && record?.provider === "k-league"
    && record?.source === RESULT_SOURCE
    && record?.sourceKind === "official-competition-organizer"
    && record?.status === "FINISHED"
    && record?.scoreKind === "regular-time"
    && record?.official === true
    && record?.trusted === true
    && record?.settlementEligible === true
    && record?.resultObservationFallback === false
    && matchSourceMatchId
    && matchSourceMatchId === norm(record?.sourceMatchId)
    && Number.isFinite(matchEventMs)
    && Number.isFinite(recordEventMs)
    && matchEventMs === recordEventMs
    && Number.isFinite(providerKickoffMs)
    && Math.abs(providerKickoffMs - matchEventMs) <= 30 * 60 * 1000
    && Number.isFinite(observedMs)
    && observedMs >= providerKickoffMs + MIN_FINAL_ELAPSED_MINUTES * 60 * 1000
    && Number.isInteger(record?.scoreHome)
    && record.scoreHome >= 0
    && Number.isInteger(record?.scoreAway)
    && record.scoreAway >= 0
    && /^https:\/\/www\.kleague\.com\/getScheduleList\.do$/.test(String(record?.sourceUrl || ""))
    && /^[a-f0-9]{64}$/.test(String(record?.responseSha256 || ""))
    && record?.evidenceHash === fixtureEvidenceHash(record)
  );
};

const applyKLeagueOfficialResult = (match) => {
  if (!match || match?.resultProvenance?.provider === "sporttery") return match;
  const record = match?.externalSignals?.kLeagueOfficial?.fixture;
  if (!validKLeagueFixtureEvidenceForMatch(match, record)) return match;
  return {
    ...match,
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    statusReason: "trusted-k-league-official-result",
    scoreHome: record.scoreHome,
    scoreAway: record.scoreAway,
    resultSource: RESULT_SOURCE,
    resultObservedAt: record.observedAt,
    resultObservationSource: record.observationSource,
    resultObservationFallback: false,
    resultUpdatedAt: record.observedAt,
    settledAt: match?.settledAt || record.observedAt,
    resultProvenance: {
      version: "trusted-official-result-provenance-v2",
      provider: "k-league",
      source: RESULT_SOURCE,
      sourceKind: "official-competition-organizer",
      sourceUrl: record.sourceUrl,
      providerMatchId: record.providerMatchId,
      sourceMatchId: record.sourceMatchId,
      eventVersion: record.eventVersion,
      providerKickoffTime: record.providerKickoffTime,
      homeTeamId: record.homeTeamId,
      awayTeamId: record.awayTeamId,
      scoreKind: "regular-time",
      official: true,
      trusted: true,
      observedAt: record.observedAt,
      observationSource: record.observationSource,
      resultObservationFallback: false,
      responseSha256: record.responseSha256,
      evidenceHash: record.evidenceHash,
      mapping: record.mapping,
      promotionEligible: false,
    },
  };
};

const buildStandingSignal = ({ match, rows, observedAt, sourceUrl, year, leagueId = 1 }) => {
  const home = resolveStanding(rows, match?.homeTeamName);
  const away = resolveStanding(rows, match?.awayTeamName);
  if (!home || !away) return null;
  return {
    version: VERSION,
    source: "K League official JSON",
    sourceUrl,
    observedAt,
    receivedAt: observedAt,
    season: Number(year),
    leagueId: Number(leagueId),
    home,
    away,
    modelUse: "official-standings-and-recent-form-reference",
  };
};

const main = async () => {
  const matches = readJson(CURRENT_FILE, []);
  const current = Array.isArray(matches) ? matches : matches?.matches || [];
  const targets = current.filter(isKLeagueMatch);
  if (!targets.length) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "no-k-league-matches", rows: 0 }));
    return;
  }
  const observedAt = new Date().toISOString();
  const year = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).format(new Date()));
  const official = await fetchOfficialStandings({ year, leagueId: 1 });
  const scheduleMonths = Array.from(new Map(targets
    .map((match) => seoulMonthForMatch(match))
    .filter(Boolean)
    .map((value) => [`${value.year}-${value.month}`, value])).values());
  const schedules = await Promise.all(scheduleMonths.map(async ({ year: scheduleYear, month }) => ({
    key: `${scheduleYear}-${month}`,
    ...(await fetchOfficialSchedule({ year: scheduleYear, month, leagueId: 1 })),
  })));
  const schedulesByMonth = new Map(schedules.map((value) => [value.key, value]));
  const external = readJson(EXTERNAL_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const externalMatches = { ...(external.matches || {}) };
  let updated = 0;
  let matchedFixtures = 0;
  let officialFinals = 0;
  const unresolved = [];
  for (const match of targets) {
    const standingSignal = buildStandingSignal({
      match,
      rows: official.rows,
      observedAt,
      sourceUrl: official.url,
      year,
      leagueId: 1,
    });
    const scheduleMonth = seoulMonthForMatch(match);
    const schedule = scheduleMonth ? schedulesByMonth.get(`${scheduleMonth.year}-${scheduleMonth.month}`) : null;
    const fixtureSignal = schedule ? buildFixtureSignal({
      match,
      rows: schedule.rows,
      observedAt,
      sourceUrl: schedule.url,
      responseSha256: schedule.responseSha256,
    }) : null;
    if (!standingSignal && !fixtureSignal) {
      unresolved.push({ sourceMatchId: match?.sourceMatchId || null, home: match?.homeTeamName, away: match?.awayTeamName });
      continue;
    }
    const keys = matchKeys(match);
    const existing = keys.map((key) => externalMatches[key]).find((value) => (
      value && externalSignalMatchesEvent(value, match)
    )) || {};
    const cutoffMs = Date.parse(match?.buyEndTime || match?.kickoffTime || "");
    const existingStanding = existing?.kLeagueOfficial;
    const existingObservedMs = Date.parse(existingStanding?.observedAt || "");
    const preservePreCutoffStanding = existingStanding?.version === VERSION
      && Number.isFinite(existingObservedMs)
      && Number.isFinite(cutoffMs)
      && existingObservedMs <= cutoffMs
      && Date.parse(observedAt) > cutoffMs;
    const signal = {
      ...(preservePreCutoffStanding ? existingStanding : standingSignal || {
        version: VERSION,
        source: "K League official JSON",
        sourceUrl: official.url,
        observedAt,
        receivedAt: observedAt,
        season: Number(year),
        leagueId: 1,
        modelUse: "official-fixture-reference-only",
      }),
      ...(fixtureSignal ? { fixture: fixtureSignal } : {}),
    };
    const next = stampSignalEvent({
      ...existing,
      source: Array.from(new Set(String(existing?.source || "external-signals").split("+").concat("k-league-official")))
        .filter(Boolean).join("+"),
      updatedAt: observedAt,
      kLeagueOfficial: signal,
    }, match);
    if (!externalSignalMatchesEvent(next, match)) {
      throw new Error(`K League official standings event identity mismatch for ${match?.sourceMatchId || "unknown"}`);
    }
    for (const key of keys) externalMatches[key] = next;
    updated += 1;
    if (fixtureSignal) matchedFixtures += 1;
    if (fixtureSignal?.status === "FINISHED") officialFinals += 1;
  }
  const nextExternal = {
    ...external,
    updatedAt: observedAt,
    source: Array.from(new Set(String(external?.source || "external-signals").split("+").concat("k-league-official")))
      .filter(Boolean).join("+"),
    matches: externalMatches,
    sources: {
      ...(external.sources || {}),
      "k-league-official": {
        version: VERSION,
        updatedAt: observedAt,
        sourceUrl: official.url,
        rows: official.rows.length,
        matchedStandings: targets.filter((match) => Boolean(buildStandingSignal({
          match,
          rows: official.rows,
          observedAt,
          sourceUrl: official.url,
          year,
          leagueId: 1,
        }))).length,
        matchedFixtures,
        officialFinals,
        unresolvedFixtures: unresolved.length,
      },
    },
  };
  writeJsonAtomic(EXTERNAL_FILE, nextExternal);
  console.log(JSON.stringify({
    ok: updated > 0 && unresolved.length === 0,
    updated,
    matchedFixtures,
    officialFinals,
    unresolved,
    sourceRows: official.rows.length,
  }));
  if (!updated || unresolved.length) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  ENDPOINT,
  FIXTURE_VERSION,
  MIN_FINAL_ELAPSED_MINUTES,
  RESULT_SOURCE,
  SCHEDULE_ENDPOINT,
  TEAM_ALIASES,
  TEAM_IDS,
  VERSION,
  applyKLeagueOfficialResult,
  buildFixtureSignal,
  buildStandingSignal,
  compactStanding,
  fetchOfficialSchedule,
  fetchOfficialStandings,
  fixtureEvidenceHash,
  isKLeagueMatch,
  officialKickoffInstant,
  resolveOfficialFixture,
  resolveStanding,
  resolveTeamId,
  seoulMonthForMatch,
  validKLeagueFixtureEvidenceForMatch,
};
