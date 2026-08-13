const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "public", "data", "uefa-official-results.json");
const DEFAULT_STORE_DIR = path.resolve(
  process.env.SERVER_STORE_DIR
  || process.env.DATA_STORE_DIR
  || path.join(ROOT_DIR, "server-data")
);
const UNRESOLVED_ARCHIVE_FILE = path.resolve(
  process.env.UNRESOLVED_MATCH_ARCHIVE_PATH
  || path.join(DEFAULT_STORE_DIR, "matches-unresolved-archive.json")
);
const DEFAULT_API_URL = "https://match.uefa.com/v5/matches";
const VERSION = "uefa-official-results-v1";
const RESULT_PROVIDER = "uefa";
const RESULT_SOURCE = "uefa:official-match-api";
const MAX_KICKOFF_DELTA_MS = 2 * 60 * 1000;
const LOOKBACK_HOURS = Math.max(24, Number(process.env.UEFA_RESULT_LOOKBACK_HOURS || 120));
const FUTURE_GRACE_MINUTES = Math.max(0, Number(process.env.UEFA_RESULT_FUTURE_GRACE_MINUTES || 15));
const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.UEFA_RESULT_TIMEOUT_MS || 20_000));
const MAX_RESPONSE_BYTES = Math.max(1024 * 1024, Number(process.env.UEFA_RESULT_MAX_BYTES || 8 * 1024 * 1024));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const rowsFromUnresolvedArchivePayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
};

const canonicalCandidateKey = (match) => String(
  match?.sourceMatchId
  || match?.id
  || ""
).replace(/^sporttery_/, "").replace(/^fivehundred_/, "").trim();

const mergeUefaCandidateRows = (currentRows, archiveRows) => {
  const merged = new Map();
  for (const row of Array.isArray(currentRows) ? currentRows : []) {
    const key = canonicalCandidateKey(row);
    if (key) merged.set(key, row);
  }
  for (const row of Array.isArray(archiveRows) ? archiveRows : []) {
    const key = canonicalCandidateKey(row);
    if (key && !merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()];
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
};

const dateOnlyUtc = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};

const normalizeTeamName = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  // Sporttery, 500.com and UEFA use different Chinese transliterations for
  // Lech Poznan. Canonicalize the complete and shortened forms before fuzzy
  // matching so an exact-away-team match can still prove the event uniquely.
  .replace(/\u6ce2\u65af\u5357\u83b1\u65bd/g, "\u6ce2\u5179\u5357")
  .replace(/\u6ce2\u5179\u5357\u83b1\u8d6b/g, "\u6ce2\u5179\u5357")
  .replace(/格拉兹/g, "格拉茨")
  .replace(/古比斯/g, "库奥皮奥")
  .replace(/\b(football club|futbol club|soccer club|sporting club|fc|cf|afc|sc|sk)\b/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, "");

const levenshteinDistance = (left, right) => {
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      const substitution = diagonal + (left[row - 1] === right[column - 1] ? 0 : 1);
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, substitution);
      diagonal = above;
    }
  }
  return previous[right.length];
};

const normalizedNameSimilarity = (leftValue, rightValue) => {
  const left = normalizeTeamName(leftValue);
  const right = normalizeTeamName(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left))) {
    return 0.9;
  }
  const maximum = Math.max(left.length, right.length);
  return maximum > 0 ? Math.max(0, 1 - levenshteinDistance(left, right) / maximum) : 0;
};

const localTeamNames = (match, side) => {
  const prefix = side === "home" ? "home" : "away";
  return [
    match?.[`${prefix}TeamName`],
    match?.[`${prefix}TeamNameEn`],
    match?.[`${prefix}Team`],
  ].filter(Boolean);
};

const uefaTeamNames = (team) => {
  const translations = team?.translations || {};
  return [
    team?.internationalName,
    translations.displayName?.ZH,
    translations.displayOfficialName?.ZH,
    translations.shortName?.ZH,
    translations.displayName?.EN,
    translations.displayOfficialName?.EN,
    translations.shortName?.EN,
  ].filter(Boolean);
};

const bestTeamSimilarity = (leftNames, rightNames) => {
  let best = 0;
  for (const left of leftNames) {
    for (const right of rightNames) {
      best = Math.max(best, normalizedNameSimilarity(left, right));
    }
  }
  return Number(best.toFixed(4));
};

const uefaKickoff = (event) => (
  event?.kickOffTime?.dateTime
  || event?.kickOffTime?.date
  || event?.kickoffTime
  || null
);

const regularTimeScore = (event) => {
  const score = event?.score?.regular;
  const home = Number(score?.home);
  const away = Number(score?.away);
  return Number.isInteger(home) && home >= 0 && Number.isInteger(away) && away >= 0
    ? { home, away }
    : null;
};

const isUefaCompetitionMatch = (match) => {
  const values = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.leagueShortName,
    match?.leagueShortNameEn,
  ].map((value) => String(value || "").toLowerCase());
  return values.some((value) => (
    value.includes("\u6b27\u51a0")
    || value.includes("\u6b27\u6d32\u51a0\u519b\u8054\u8d5b")
    || value.includes("\u6b27\u8054")
    || value.includes("\u6b27\u7f57\u5df4")
    || value.includes("\u6b27\u534f\u8054")
    || value.includes("\u6b27\u6d32\u534f\u4f1a\u8054\u8d5b")
    ||
    value.includes("欧冠")
    || value.includes("uefa champions")
    || value.includes("champions league")
    || value.includes("uefa europa")
    || value.includes("europa league")
    || value.includes("uefa conference")
    || value.includes("conference league")
    || value.includes("欧罗巴")
    || value.includes("欧联")
    || value.includes("欧协联")
  ));
};

const isChampionsLeagueMatch = (match) => isUefaCompetitionMatch(match);

const eligibleUnresolvedMatches = (rows, nowMs = Date.now()) => rows.filter((match) => {
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  const status = String(match?.status || "").toUpperCase();
  return status !== "FINISHED"
    && status !== "CANCELLED"
    && status !== "VOID"
    && isUefaCompetitionMatch(match)
    && Number.isFinite(kickoffMs)
    && kickoffMs >= nowMs - LOOKBACK_HOURS * 60 * 60 * 1000
    && kickoffMs <= nowMs + FUTURE_GRACE_MINUTES * 60 * 1000;
});

const eventStatus = (event) => String(event?.status || event?.matchStatus || "").toUpperCase();

const candidateEvidence = (match, event) => {
  const matchKickoffMs = Date.parse(match?.kickoffTime || "");
  const eventKickoffValue = uefaKickoff(event);
  const eventKickoffMs = Date.parse(eventKickoffValue || "");
  const score = regularTimeScore(event);
  if (
    eventStatus(event) !== "FINISHED"
    || !score
    || !Number.isFinite(matchKickoffMs)
    || !Number.isFinite(eventKickoffMs)
    || Math.abs(matchKickoffMs - eventKickoffMs) > MAX_KICKOFF_DELTA_MS
  ) {
    return null;
  }

  const homeSimilarity = bestTeamSimilarity(localTeamNames(match, "home"), uefaTeamNames(event?.homeTeam));
  const awaySimilarity = bestTeamSimilarity(localTeamNames(match, "away"), uefaTeamNames(event?.awayTeam));
  const swappedHomeSimilarity = bestTeamSimilarity(localTeamNames(match, "home"), uefaTeamNames(event?.awayTeam));
  const swappedAwaySimilarity = bestTeamSimilarity(localTeamNames(match, "away"), uefaTeamNames(event?.homeTeam));
  const orderedScore = homeSimilarity + awaySimilarity;
  const swappedScore = swappedHomeSimilarity + swappedAwaySimilarity;

  return {
    event,
    score,
    eventKickoffValue,
    kickoffDeltaMs: Math.abs(matchKickoffMs - eventKickoffMs),
    homeSimilarity,
    awaySimilarity,
    orderedScore: Number(orderedScore.toFixed(4)),
    swappedScore: Number(swappedScore.toFixed(4)),
    orderMargin: Number((orderedScore - swappedScore).toFixed(4)),
  };
};

const selectUefaEventForMatch = (match, events) => {
  const candidates = events.map((event) => candidateEvidence(match, event)).filter(Boolean);
  if (!candidates.length) return { matched: false, reason: "no-finished-event-at-exact-kickoff", candidates: 0 };

  const ranked = candidates.sort((left, right) => (
    right.orderedScore - left.orderedScore
    || right.orderMargin - left.orderMargin
    || left.kickoffDeltaMs - right.kickoffDeltaMs
  ));
  const best = ranked[0];
  const runnerUp = ranked[1] || null;
  const atLeastOneTeamVerified = Math.max(best.homeSimilarity, best.awaySimilarity) >= 0.55;
  const bothTeamsVerified = best.homeSimilarity >= 0.72 && best.awaySimilarity >= 0.72;
  const orderVerified = best.orderMargin >= 0.2;
  const uniquenessVerified = ranked.length === 1
    || (
      bothTeamsVerified
      && best.orderedScore - Number(runnerUp?.orderedScore || 0) >= 0.2
    );
  if (!atLeastOneTeamVerified || !orderVerified || !uniquenessVerified) {
    return {
      matched: false,
      reason: "team-identity-or-uniqueness-not-proven",
      candidates: ranked.length,
      best: {
        providerMatchId: best.event?.id || null,
        homeSimilarity: best.homeSimilarity,
        awaySimilarity: best.awaySimilarity,
        orderMargin: best.orderMargin,
      },
    };
  }
  return { matched: true, evidence: best, candidates: ranked.length };
};

const buildEvidenceRecord = (match, selection, observedAt, responseSha256, previous = null) => {
  const { event, score } = selection.evidence;
  const samePreviousScore = previous
    && Number(previous.scoreHome) === score.home
    && Number(previous.scoreAway) === score.away;
  const priorRevision = Math.max(0, Number(previous?.resultRevision || 0));
  const resultRevision = samePreviousScore ? Math.max(1, priorRevision) : Math.max(1, priorRevision + 1);
  const providerKickoff = new Date(Date.parse(selection.evidence.eventKickoffValue)).toISOString();
  return {
    version: VERSION,
    provider: RESULT_PROVIDER,
    source: RESULT_SOURCE,
    sourceKind: "official-competition-organizer",
    competitionId: String(event?.competition?.id || event?.matchday?.competitionId || "1"),
    providerMatchId: String(event?.id || ""),
    sourceMatchId: String(match?.sourceMatchId || match?.id || "").replace(/^sporttery_/, ""),
    matchId: match?.id || null,
    kickoffTime: match?.kickoffTime || null,
    eventVersion: match?.eventVersion || match?.kickoffTime || null,
    providerKickoffTime: providerKickoff,
    homeTeamName: match?.homeTeamName || null,
    awayTeamName: match?.awayTeamName || null,
    providerHomeTeamName: event?.homeTeam?.internationalName || null,
    providerAwayTeamName: event?.awayTeam?.internationalName || null,
    scoreHome: score.home,
    scoreAway: score.away,
    scoreText: `${score.home}:${score.away}`,
    scoreKind: "regular-time",
    status: "FINISHED",
    observedAt,
    firstObservedAt: samePreviousScore ? (previous?.firstObservedAt || previous?.observedAt || observedAt) : observedAt,
    sourceUpdatedAt: null,
    observationSource: "uefa-official-response-received-at",
    resultObservationFallback: false,
    official: true,
    trusted: true,
    settlementEligible: true,
    resultRevision,
    mapping: {
      version: "uefa-result-event-mapping-v1",
      kickoffDeltaMs: selection.evidence.kickoffDeltaMs,
      exactEventClock: selection.evidence.kickoffDeltaMs === 0,
      homeSimilarity: selection.evidence.homeSimilarity,
      awaySimilarity: selection.evidence.awaySimilarity,
      orderedScore: selection.evidence.orderedScore,
      swappedScore: selection.evidence.swappedScore,
      orderMargin: selection.evidence.orderMargin,
      candidatesAtKickoff: selection.candidates,
    },
    responseSha256,
    evidenceHash: sha256(JSON.stringify({
      provider: RESULT_PROVIDER,
      providerMatchId: String(event?.id || ""),
      sourceMatchId: String(match?.sourceMatchId || match?.id || "").replace(/^sporttery_/, ""),
      eventVersion: match?.eventVersion || match?.kickoffTime || null,
      providerKickoff,
      scoreHome: score.home,
      scoreAway: score.away,
      scoreKind: "regular-time",
      responseSha256,
    })),
  };
};

const canonicalSourceMatchId = (value) => String(value || "").replace(/^sporttery_/, "").trim();

const evidenceHashForRecord = (record) => sha256(JSON.stringify({
  provider: RESULT_PROVIDER,
  providerMatchId: String(record?.providerMatchId || ""),
  sourceMatchId: canonicalSourceMatchId(record?.sourceMatchId),
  eventVersion: record?.eventVersion || record?.kickoffTime || null,
  providerKickoff: record?.providerKickoffTime || null,
  scoreHome: Number(record?.scoreHome),
  scoreAway: Number(record?.scoreAway),
  scoreKind: "regular-time",
  responseSha256: record?.responseSha256 || null,
}));

const validUefaEvidenceForMatch = (match, record) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const recordSourceMatchId = canonicalSourceMatchId(record?.sourceMatchId);
  const matchEventMs = Date.parse(match?.eventVersion || match?.kickoffTime || "");
  const recordEventMs = Date.parse(record?.eventVersion || record?.kickoffTime || "");
  const providerKickoffMs = Date.parse(record?.providerKickoffTime || "");
  const observedMs = Date.parse(record?.observedAt || "");
  const scoreHome = Number(record?.scoreHome);
  const scoreAway = Number(record?.scoreAway);
  return Boolean(
    match
    && record
    && record.version === VERSION
    && record.provider === RESULT_PROVIDER
    && record.source === RESULT_SOURCE
    && record.sourceKind === "official-competition-organizer"
    && record.status === "FINISHED"
    && record.scoreKind === "regular-time"
    && record.official === true
    && record.trusted === true
    && record.settlementEligible === true
    && record.resultObservationFallback === false
    && sourceMatchId
    && sourceMatchId === recordSourceMatchId
    && Number.isFinite(matchEventMs)
    && Number.isFinite(recordEventMs)
    && matchEventMs === recordEventMs
    && Number.isFinite(providerKickoffMs)
    && Math.abs(matchEventMs - providerKickoffMs) <= MAX_KICKOFF_DELTA_MS
    && Number.isFinite(observedMs)
    && observedMs >= matchEventMs
    && Number.isInteger(scoreHome)
    && scoreHome >= 0
    && Number.isInteger(scoreAway)
    && scoreAway >= 0
    && /^[a-f0-9]{64}$/.test(String(record.responseSha256 || ""))
    && record.evidenceHash === evidenceHashForRecord(record)
  );
};

const loadUefaOfficialResults = (file = OUTPUT_FILE) => {
  const payload = readJson(file, { version: VERSION, matches: {} });
  return payload?.version === VERSION && payload?.matches && typeof payload.matches === "object"
    ? payload
    : { version: VERSION, matches: {} };
};

const applyUefaOfficialResult = (match, store) => {
  if (!match || match?.resultProvenance?.provider === "sporttery") return match;
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const record = store?.matches?.[sourceMatchId];
  if (!validUefaEvidenceForMatch(match, record)) return match;
  const scoreHome = Number(record.scoreHome);
  const scoreAway = Number(record.scoreAway);
  return {
    ...match,
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    statusReason: "trusted-uefa-official-result",
    scoreHome,
    scoreAway,
    resultSource: RESULT_SOURCE,
    resultSourceUpdatedAt: record.sourceUpdatedAt || null,
    resultObservedAt: record.observedAt,
    resultObservationSource: record.observationSource,
    resultObservationFallback: false,
    resultUpdatedAt: record.observedAt,
    settledAt: match?.settledAt || record.observedAt,
    resultProvenance: {
      version: "trusted-official-result-provenance-v2",
      provider: RESULT_PROVIDER,
      source: RESULT_SOURCE,
      sourceKind: "official-competition-organizer",
      providerMatchId: record.providerMatchId,
      sourceMatchId,
      eventVersion: record.eventVersion,
      providerKickoffTime: record.providerKickoffTime,
      scoreKind: "regular-time",
      official: true,
      trusted: true,
      observedAt: record.observedAt,
      observationSource: record.observationSource,
      resultObservationFallback: false,
      sourceUpdatedAt: record.sourceUpdatedAt || null,
      responseSha256: record.responseSha256,
      evidenceHash: record.evidenceHash,
      resultRevision: record.resultRevision,
      mapping: record.mapping,
    },
  };
};

const isTrustedUefaOfficialResult = (match) => {
  const provenance = match?.resultProvenance;
  const matchEventMs = Date.parse(match?.eventVersion || match?.kickoffTime || "");
  const provenanceEventMs = Date.parse(provenance?.eventVersion || "");
  const observedMs = Date.parse(provenance?.observedAt || match?.resultObservedAt || "");
  const scoreHome = Number(match?.scoreHome);
  const scoreAway = Number(match?.scoreAway);
  return Boolean(
    match
    && (match.status === "FINISHED" || match.effectiveStatus === "FINISHED")
    && provenance?.provider === RESULT_PROVIDER
    && provenance?.source === RESULT_SOURCE
    && provenance?.sourceKind === "official-competition-organizer"
    && provenance?.scoreKind === "regular-time"
    && provenance?.official === true
    && provenance?.trusted === true
    && provenance?.resultObservationFallback === false
    && canonicalSourceMatchId(provenance?.sourceMatchId)
      === canonicalSourceMatchId(match?.sourceMatchId || match?.id)
    && Number.isFinite(matchEventMs)
    && Number.isFinite(provenanceEventMs)
    && matchEventMs === provenanceEventMs
    && Number.isFinite(Date.parse(provenance?.providerKickoffTime || ""))
    && Math.abs(matchEventMs - Date.parse(provenance.providerKickoffTime)) <= MAX_KICKOFF_DELTA_MS
    && Number.isFinite(observedMs)
    && observedMs >= matchEventMs
    && Number.isInteger(scoreHome)
    && scoreHome >= 0
    && Number.isInteger(scoreAway)
    && scoreAway >= 0
    && /^[a-f0-9]{64}$/.test(String(provenance?.responseSha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(provenance?.evidenceHash || ""))
    && provenance.evidenceHash === evidenceHashForRecord({
      providerMatchId: provenance.providerMatchId,
      sourceMatchId: provenance.sourceMatchId,
      eventVersion: provenance.eventVersion,
      providerKickoffTime: provenance.providerKickoffTime,
      scoreHome,
      scoreAway,
      scoreKind: provenance.scoreKind,
      responseSha256: provenance.responseSha256,
    })
  );
};

const requestJson = (target) => new Promise((resolve, reject) => {
  let bytes = 0;
  const chunks = [];
  const req = https.get(target, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      accept: "application/json",
      "user-agent": "football-predict/uefa-official-results-v1",
    },
  }, (res) => {
    res.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        req.destroy(new Error("UEFA response exceeded configured byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (Number(res.statusCode || 0) !== 200) {
        const diagnostic = raw.toString("utf8").replace(/\s+/g, " ").slice(0, 240);
        reject(new Error(
          `UEFA endpoint returned HTTP ${res.statusCode || 0} for ${target.toString()}${diagnostic ? `: ${diagnostic}` : ""}`
        ));
        return;
      }
      try {
        resolve({ raw, body: JSON.parse(raw.toString("utf8")) });
      } catch (error) {
        reject(new Error(`UEFA endpoint returned invalid JSON: ${error.message}`));
      }
    });
  });
  req.on("timeout", () => req.destroy(new Error("UEFA request timeout")));
  req.on("error", reject);
});

const syncUefaOfficialResults = async (options = {}) => {
  const currentFile = path.resolve(options.currentFile || process.env.UEFA_RESULT_CURRENT_FILE || CURRENT_FILE);
  const unresolvedArchiveFile = path.resolve(
    options.unresolvedArchiveFile
    || process.env.UNRESOLVED_MATCH_ARCHIVE_PATH
    || UNRESOLVED_ARCHIVE_FILE
  );
  const outputFile = path.resolve(options.outputFile || process.env.UEFA_RESULT_OUTPUT_FILE || OUTPUT_FILE);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const currentPayload = options.currentRows ?? readJson(currentFile, []);
  const currentRows = Array.isArray(currentPayload) ? currentPayload : [];
  const archivePayload = options.archiveRows ?? readJson(unresolvedArchiveFile, { rows: [] });
  const archiveRows = Array.isArray(options.archiveRows)
    ? options.archiveRows
    : rowsFromUnresolvedArchivePayload(archivePayload);
  const rows = mergeUefaCandidateRows(currentRows, archiveRows);
  const eligible = eligibleUnresolvedMatches(rows, nowMs);
  const existing = readJson(outputFile, { version: VERSION, matches: {} });
  if (!eligible.length) {
    const payload = {
      ...existing,
      version: VERSION,
      source: RESULT_SOURCE,
      checkedAt: new Date(nowMs).toISOString(),
      summary: {
        currentRows: currentRows.length,
        archiveRows: archiveRows.length,
        combinedRows: rows.length,
        eligible: 0,
        fetchedEvents: 0,
        matched: 0,
        rejected: 0,
        preserved: Object.keys(existing?.matches || {}).length,
      },
    };
    writeJsonAtomic(outputFile, payload);
    return payload;
  }

  const dates = eligible.map((match) => dateOnlyUtc(match.kickoffTime)).filter(Boolean).sort();
  const fromDate = dates[0];
  // UEFA rejects a zero-length date range. Keep the query half-open by ending
  // one UTC day after the latest eligible kickoff date.
  const toDate = new Date(
    Date.parse(`${dates.at(-1)}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
  ).toISOString().slice(0, 10);
  const apiUrl = new URL(options.apiUrl || process.env.UEFA_RESULT_API_URL || DEFAULT_API_URL);
  const competitionId = String(
    options.competitionId
    || process.env.UEFA_RESULT_COMPETITION_ID
    || ""
  ).trim();
  if (competitionId) apiUrl.searchParams.set("competitionId", competitionId);
  apiUrl.searchParams.set("fromDate", fromDate);
  apiUrl.searchParams.set("toDate", toDate);
  apiUrl.searchParams.set("limit", "250");
  apiUrl.searchParams.set("offset", "0");
  const response = options.response || await requestJson(apiUrl);
  const events = Array.isArray(response.body) ? response.body : [];
  const observedAt = new Date(nowMs).toISOString();
  const responseSha256 = sha256(response.raw);
  const nextMatches = { ...(existing?.matches || {}) };
  const rejections = [];
  let matched = 0;
  for (const match of eligible) {
    const sourceMatchId = String(match?.sourceMatchId || match?.id || "").replace(/^sporttery_/, "");
    const selection = selectUefaEventForMatch(match, events);
    if (!selection.matched) {
      rejections.push({ sourceMatchId, reason: selection.reason, candidates: selection.candidates });
      continue;
    }
    nextMatches[sourceMatchId] = buildEvidenceRecord(
      match,
      selection,
      observedAt,
      responseSha256,
      nextMatches[sourceMatchId] || null,
    );
    matched += 1;
  }

  const payload = {
    version: VERSION,
    source: RESULT_SOURCE,
    sourceKind: "official-competition-organizer",
    sourceUrl: `${apiUrl.origin}${apiUrl.pathname}`,
    checkedAt: observedAt,
    fetchedRange: { fromDate, toDate },
    responseSha256,
    summary: {
      currentRows: currentRows.length,
      archiveRows: archiveRows.length,
      combinedRows: rows.length,
      eligible: eligible.length,
      fetchedEvents: events.length,
      matched,
      rejected: rejections.length,
      preserved: Object.keys(nextMatches).length - matched,
    },
    rejections: rejections.slice(0, 50),
    matches: nextMatches,
  };
  writeJsonAtomic(outputFile, payload);
  return payload;
};

if (require.main === module) {
  syncUefaOfficialResults()
    .then((payload) => {
      console.log(JSON.stringify({
        ok: true,
        verifier: VERSION,
        checkedAt: payload.checkedAt,
        summary: payload.summary,
        fetchedRange: payload.fetchedRange || null,
        outputFile: path.relative(ROOT_DIR, OUTPUT_FILE).replace(/\\/g, "/"),
      }, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        verifier: VERSION,
        checkedAt: new Date().toISOString(),
        error: error.message || String(error),
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  RESULT_PROVIDER,
  RESULT_SOURCE,
  VERSION,
  applyUefaOfficialResult,
  bestTeamSimilarity,
  buildEvidenceRecord,
  evidenceHashForRecord,
  eligibleUnresolvedMatches,
  isChampionsLeagueMatch,
  isUefaCompetitionMatch,
  isTrustedUefaOfficialResult,
  loadUefaOfficialResults,
  mergeUefaCandidateRows,
  normalizeTeamName,
  regularTimeScore,
  rowsFromUnresolvedArchivePayload,
  selectUefaEventForMatch,
  syncUefaOfficialResults,
  uefaKickoff,
  validUefaEvidenceForMatch,
};
