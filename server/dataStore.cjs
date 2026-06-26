const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const STATE_FILE = "state.json";
const CURRENT_MATCHES_FILE = "current-matches.json";
const HISTORY_LIST_FILE = "history-list.json";
const MATCH_INDEX_FILE = "latest-match-index.json";
const LATEST_MATCH_DIR = "latest-matches";
const TABLES = {
  syncRuns: "sync-runs",
  matchSnapshots: "match-snapshots",
  oddsSnapshots: "odds-snapshots",
  predictionRuns: "prediction-runs"
};

const TABLE_COUNT_KEYS = {
  [TABLES.syncRuns]: "syncRuns",
  [TABLES.matchSnapshots]: "matchSnapshots",
  [TABLES.oddsSnapshots]: "oddsSnapshots",
  [TABLES.predictionRuns]: "predictionRuns"
};

const HISTORY_SNAPSHOT_RETENTION_DAYS = Math.max(1, Number(process.env.DATASTORE_HISTORY_SNAPSHOT_RETENTION_DAYS || 14));
const STORE_FULL_MATCH_SNAPSHOTS = process.env.DATASTORE_STORE_FULL_MATCH_SNAPSHOTS === "1";
const ODDS_HISTORY_EVENT_RETENTION_DAYS = Math.max(1, Number(process.env.DATASTORE_ODDS_HISTORY_RETENTION_DAYS || 30));
const ODDS_HISTORY_EVENT_MAX_ROWS = Math.max(1000, Number(process.env.DATASTORE_ODDS_HISTORY_RECENT_ROWS || 12000));
const STATE_SIGNATURE_MAX_KEYS = Math.max(1000, Number(process.env.DATASTORE_STATE_SIGNATURE_MAX_KEYS || 60000));

const nowIso = () => new Date().toISOString();

const createState = () => ({
  version: 1,
  updatedAt: null,
  counts: {
    syncRuns: 0,
    matchSnapshots: 0,
    oddsSnapshots: 0,
    predictionRuns: 0
  },
  latestMatchSignatures: {},
  latestOddsSignatures: {},
  latestPredictionSignatures: {}
});

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const isPlainObject = (value) => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableJson(value[key])}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashPayload = (payload) => {
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 20);
};

const dbDirFor = (storeDir) => path.join(storeDir, "db");
const statePathFor = (storeDir) => path.join(dbDirFor(storeDir), STATE_FILE);
const tablePathFor = (storeDir, table) => path.join(dbDirFor(storeDir), `${table}.jsonl`);
const materializedPathFor = (storeDir, fileName) => path.join(dbDirFor(storeDir), fileName);
const latestMatchDirFor = (storeDir) => path.join(dbDirFor(storeDir), LATEST_MATCH_DIR);
const latestMatchFileFor = (storeDir, fileName) => path.join(latestMatchDirFor(storeDir), fileName);

const ensureDataStore = async (storeDir) => {
  const dbDir = dbDirFor(storeDir);
  await fsp.mkdir(dbDir, { recursive: true });
  const statePath = statePathFor(storeDir);
  if (!fs.existsSync(statePath)) {
    await fsp.writeFile(statePath, `${JSON.stringify(createState(), null, 2)}\n`);
  }
};

const readState = async (storeDir) => {
  await ensureDataStore(storeDir);
  const state = safeJsonParse(await fsp.readFile(statePathFor(storeDir), "utf8"), null);
  return state && state.version ? { ...createState(), ...state } : createState();
};

const writeState = async (storeDir, state) => {
  await ensureDataStore(storeDir);
  const nextState = {
    ...createState(),
    ...state,
    updatedAt: nowIso()
  };
  await fsp.writeFile(statePathFor(storeDir), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
};

const writeJsonAtomic = async (filePath, payload) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(payload)}\n`);
  await fsp.rename(tempPath, filePath);
};

const appendRow = async (storeDir, table, row) => {
  await ensureDataStore(storeDir);
  await fsp.appendFile(tablePathFor(storeDir, table), `${JSON.stringify(row)}\n`);
};

const countLines = async (filePath) => new Promise((resolve) => {
  let rows = 0;
  let hasBytes = false;
  let lastByte = null;
  const stream = fs.createReadStream(filePath);

  stream.on("data", (chunk) => {
    hasBytes = true;
    lastByte = chunk[chunk.length - 1];
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] === 10) rows += 1;
    }
  });
  stream.on("end", () => resolve(hasBytes && lastByte !== 10 ? rows + 1 : rows));
  stream.on("error", () => resolve(0));
});

const readJsonFile = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const clampLimit = (limit, max = 500) => Math.max(1, Math.min(max, Number(limit || 80)));

const readDataStoreRows = async (storeDir, table, options = {}) => {
  const limit = clampLimit(options.limit);
  const rows = [];
  try {
    const stream = fs.createReadStream(tablePathFor(storeDir, table), { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    const matchId = String(options.matchId || "").trim();
    const sourceMatchId = String(options.sourceMatchId || "").trim();
    const pool = String(options.pool || "").trim().toUpperCase();

    for await (const line of lines) {
      if (!line) continue;
      const row = safeJsonParse(line, null);
      if (!row) continue;
      if (matchId && String(row.matchId || "") !== matchId) continue;
      if (sourceMatchId && String(row.sourceMatchId || "") !== sourceMatchId) continue;
      if (pool && String(row.pool || "").toUpperCase() !== pool) continue;
      rows.push(row);
      if (rows.length > limit) rows.shift();
    }

    return rows;
  } catch {
    return [];
  }
};

const getDataStoreStatus = async (storeDir) => {
  await ensureDataStore(storeDir);
  const state = await readState(storeDir);
  const stateCounts = state.counts || createState().counts;
  const dbDir = dbDirFor(storeDir);
  const files = {};
  for (const table of Object.values(TABLES)) {
    const filePath = tablePathFor(storeDir, table);
    const countKey = TABLE_COUNT_KEYS[table];
    const storedRows = countKey ? stateCounts[countKey] : null;
    try {
      const stat = await fsp.stat(filePath);
      const actualRows = await countLines(filePath);
      files[table] = {
        exists: true,
        bytes: stat.size,
        rows: actualRows,
        stateRows: Number.isFinite(storedRows) ? storedRows : null,
        updatedAt: stat.mtime.toISOString()
      };
    } catch {
      files[table] = { exists: false, bytes: 0, rows: 0, updatedAt: null };
    }
  }
  for (const fileName of [CURRENT_MATCHES_FILE, HISTORY_LIST_FILE, MATCH_INDEX_FILE]) {
    const filePath = materializedPathFor(storeDir, fileName);
    try {
      const stat = await fsp.stat(filePath);
      const parsed = await readJsonFile(filePath, null);
      files[fileName] = {
        exists: true,
        bytes: stat.size,
        rows: Array.isArray(parsed?.rows) ? parsed.rows.length : parsed?.matches ? Object.keys(parsed.matches).length : 0,
        updatedAt: stat.mtime.toISOString()
      };
    } catch {
      files[fileName] = { exists: false, bytes: 0, rows: 0, updatedAt: null };
    }
  }
  return {
    ok: true,
    version: 1,
    checkedAt: nowIso(),
    storeDir,
    dbDir,
    stateUpdatedAt: state.updatedAt || null,
    counts: state.counts || createState().counts,
    files
  };
};

const compactNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : null;
};

const matchTimestamp = (match) => {
  const candidates = [
    match?.resultUpdatedAt,
    match?.oddsUpdatedAt,
    match?.handicapOddsUpdatedAt,
    match?.kickoffTime,
    match?.matchDate,
    match?.businessDate
  ];
  for (const value of candidates) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const shouldPersistHistorySnapshot = (match, capturedAt = nowIso()) => {
  const capturedTime = Date.parse(capturedAt);
  const matchTime = matchTimestamp(match);
  if (!Number.isFinite(capturedTime) || !Number.isFinite(matchTime)) return false;
  return matchTime >= capturedTime - HISTORY_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
};

const oddsHistoryTimestamp = (row) => {
  const candidates = [row?.capturedAt, row?.captureBucket, row?.oddsUpdatedAt, row?.updatedAt, row?.kickoffTime];
  for (const value of candidates) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const selectRecentOddsHistoryRows = (rows, capturedAt = nowIso()) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) return [];
  const capturedTime = Date.parse(capturedAt);
  const cutoff = Number.isFinite(capturedTime)
    ? capturedTime - ODDS_HISTORY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    : NaN;
  const recent = [];
  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index];
    const time = oddsHistoryTimestamp(row);
    if (Number.isFinite(cutoff) && (!Number.isFinite(time) || time < cutoff)) continue;
    recent.push({ row, index, time: Number.isFinite(time) ? time : 0 });
  }
  return recent
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .slice(-ODDS_HISTORY_EVENT_MAX_ROWS)
    .map((item) => item.row);
};

const pruneSignatureMap = (map, maxKeys = STATE_SIGNATURE_MAX_KEYS) => {
  if (!map || typeof map !== "object") return { map: {}, pruned: 0 };
  const entries = Object.entries(map);
  if (entries.length <= maxKeys) return { map, pruned: 0 };
  entries.sort((a, b) => {
    const aTime = Date.parse(a[1] || "");
    const bTime = Date.parse(b[1] || "");
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
  });
  const keptEntries = entries.slice(-maxKeys);
  return {
    map: Object.fromEntries(keptEntries),
    pruned: entries.length - keptEntries.length
  };
};

const pruneStateSignatures = (state) => {
  const odds = pruneSignatureMap(state.latestOddsSignatures);
  state.latestOddsSignatures = odds.map;
  return {
    latestOddsSignatures: odds.pruned
  };
};

const pickOdds = (odds) => {
  if (!odds) return null;
  const compact = {
    odds1: compactNumber(odds.odds1),
    oddsX: compactNumber(odds.oddsX),
    odds2: compactNumber(odds.odds2)
  };
  return Object.values(compact).some((value) => value !== null) ? compact : null;
};

const scoreFor = (match) => ({
  home: compactNumber(match.scoreHome ?? match.homeScore ?? match.fullScoreHome ?? match.result?.scoreHome),
  away: compactNumber(match.scoreAway ?? match.awayScore ?? match.fullScoreAway ?? match.result?.scoreAway)
});

const hasCompleteOdds = (odds) => {
  const compact = pickOdds(odds);
  return Boolean(compact && compact.odds1 !== null && compact.oddsX !== null && compact.odds2 !== null);
};

const resultFor = (match) => {
  const score = scoreFor(match);
  const hasScore = score.home !== null && score.away !== null;
  const totalGoals = hasScore ? compactNumber(score.home + score.away) : null;
  const goalDiff = hasScore ? compactNumber(score.home - score.away) : null;
  const resultCode = !hasScore ? null : score.home > score.away ? "1" : score.home < score.away ? "2" : "X";
  return {
    hasScore,
    resultCode,
    scoreText: hasScore ? `${score.home}:${score.away}` : null,
    totalGoals,
    goalDiff,
    bothTeamsScored: hasScore ? score.home > 0 && score.away > 0 : null
  };
};

const projectedScoreFor = (match) => ({
  home: compactNumber(match.projectedScoreHome ?? match.projectedHomeScore),
  away: compactNumber(match.projectedScoreAway ?? match.projectedAwayScore)
});

const metricPair = (stats, key) => {
  const metric = stats?.[key];
  if (!metric || typeof metric !== "object") return null;
  const pair = {
    home: compactNumber(metric.home),
    away: compactNumber(metric.away)
  };
  return pair.home !== null || pair.away !== null ? pair : null;
};

const statsSummaryFor = (match) => {
  const stats = match.stats;
  if (!stats || typeof stats !== "object") return null;
  return {
    xG: metricPair(stats, "xG"),
    possession: metricPair(stats, "possession"),
    shots: metricPair(stats, "shots"),
    shotsOnTarget: metricPair(stats, "shotsOnTarget"),
    corners: metricPair(stats, "corners"),
    fouls: metricPair(stats, "fouls"),
    yellowCards: metricPair(stats, "yellowCards"),
    redCards: metricPair(stats, "redCards")
  };
};

const normalizeMarketType = (value) => String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");

const predictionItemsFor = (match) => {
  if (Array.isArray(match.predictions)) {
    return match.predictions.filter((item) => item && typeof item === "object");
  }
  return [];
};

const findPredictionItem = (items, aliases) => {
  const normalizedAliases = aliases.map(normalizeMarketType);
  return items.find((item) => normalizedAliases.includes(normalizeMarketType(item.marketType || item.market || item.type))) || null;
};

const summarizePredictionItem = (item) => {
  if (!item || typeof item !== "object") return null;
  return {
    marketType: item.marketType || item.market || item.type || null,
    tipCode: item.tipCode || null,
    odds: compactNumber(item.odds),
    trustScore: compactNumber(item.trustScore),
    resultStatus: item.resultStatus || null,
    riskCount: Number.isFinite(Number(item.riskCount)) ? Number(item.riskCount) : null,
    visibilityStatus: item.visibilityStatus || null
  };
};

const predictionSummaryFor = (match) => {
  const predictions = match.predictions && !Array.isArray(match.predictions) ? match.predictions : {};
  const predictionItems = predictionItemsFor(match);
  const best = predictions.best
    || findPredictionItem(predictionItems, ["BEST", "MAIN", "RECOMMENDATION"])
    || predictionItems.find((item) => item.tipCode && item.tipCode !== "WATCH")
    || predictionItems[0]
    || null;
  const oneXTwo = predictions.oneXTwo
    || predictions["1X2"]
    || findPredictionItem(predictionItems, ["1X2", "HAD", "ONEXTWO"])
    || null;
  const goals = predictions.goals
    || predictions.totalGoals
    || findPredictionItem(predictionItems, ["GOALS", "TOTALGOALS", "TOTAL"])
    || null;
  const probabilityFinal = match.probabilityModel?.oneXTwo?.final || match.probabilityFinal || null;
  return {
    main: best?.tipCode || oneXTwo?.tipCode || null,
    oneXTwo: oneXTwo?.tipCode || null,
    goals: goals?.tipCode || null,
    trustScore: compactNumber(best?.trustScore ?? oneXTwo?.trustScore),
    confidence: match.predictionMeta?.confidence ?? match.probabilityModel?.confidence ?? null,
    probabilityFinal,
    modelVersion: match.probabilityModel?.version || match.predictionMeta?.modelVersion || null,
    details: {
      best: summarizePredictionItem(best),
      oneXTwo: summarizePredictionItem(oneXTwo),
      goals: summarizePredictionItem(goals)
    }
  };
};

const externalSummaryFor = (match) => {
  const signals = match.externalSignals;
  if (!signals || typeof signals !== "object") return null;
  return {
    source: signals.source || "external",
    updatedAt: signals.updatedAt || null,
    sourceMatchId: signals.sourceMatchId || null,
    fixtureId: signals.fixtureId || signals.apiFootball?.fixtureId || null,
    apiFootball: signals.apiFootball ? {
      fixtureId: signals.apiFootball.fixtureId || null,
      confidence: compactNumber(signals.apiFootball.confidence),
      leagueName: signals.apiFootball.leagueName || null,
      homeTeamName: signals.apiFootball.homeTeamName || null,
      awayTeamName: signals.apiFootball.awayTeamName || null
    } : null,
    buyEndTime: signals.buyEndTime || null,
    hasExternalOdds: Boolean(signals.externalOdds || signals.bookmakerOdds?.had || signals.bookmakerOdds?.hhad || signals.bookmakerOdds?.apiFootball),
    hasBookmakerHad: Boolean(signals.bookmakerOdds?.had),
    hasBookmakerHhad: Boolean(signals.bookmakerOdds?.hhad),
    hasApiFootballOdds: Boolean(signals.bookmakerOdds?.apiFootball),
    hasInjuries: Boolean(signals.injuries),
    hasLineups: Boolean(signals.lineups),
    handicapLine: signals.handicapLine ?? signals.bookmakerOdds?.hhad?.handicapLine ?? null
  };
};

const dataCompletenessFor = (match, prediction) => {
  const score = scoreFor(match);
  const hasBaseFixture = Boolean((match.id || match.sourceMatchId) && match.kickoffTime && match.homeTeamName && match.awayTeamName);
  const isResultLike = ["FINISHED", "LIVE", "PENDING_RESULT"].includes(String(match.status || "").toUpperCase());
  const bookmakerOdds = match.externalSignals?.bookmakerOdds || {};
  const checks = {
    hasBaseFixture,
    hasLeague: Boolean(match.leagueName || match.leagueId),
    hasScore: score.home !== null && score.away !== null,
    hasOfficialHadOdds: hasCompleteOdds(match.odds),
    hasOfficialHhadOdds: hasCompleteOdds(match.handicapOdds),
    hasExternalHadOdds: hasCompleteOdds(bookmakerOdds.had || bookmakerOdds.apiFootball?.had || match.externalSignals?.externalOdds),
    hasExternalHhadOdds: hasCompleteOdds(bookmakerOdds.hhad),
    hasPrediction: Boolean(prediction?.main || prediction?.oneXTwo || prediction?.goals),
    hasProbabilityModel: Boolean(match.probabilityModel || prediction?.probabilityFinal),
    hasStats: Boolean(match.stats && typeof match.stats === "object")
  };
  const missing = [];
  if (!checks.hasBaseFixture) missing.push("baseFixture");
  if (!checks.hasLeague) missing.push("league");
  if (isResultLike && !checks.hasScore) missing.push("score");
  if (!checks.hasOfficialHadOdds) missing.push("officialHadOdds");
  if (!checks.hasOfficialHhadOdds) missing.push("officialHhadOdds");
  if (!checks.hasPrediction) missing.push("prediction");
  if (!checks.hasProbabilityModel) missing.push("probabilityModel");
  return { ...checks, missing };
};

const buildMatchSnapshot = (match, source, dataset = "current") => {
  const score = scoreFor(match);
  const prediction = predictionSummaryFor(match);
  const result = resultFor(match);
  const stats = statsSummaryFor(match);
  const projectedScore = projectedScoreFor(match);
  const rawMatchSignature = dataset === "current" ? hashPayload(match) : null;
  const payload = {
    dataset,
    fixture: {
      matchId: match.id || null,
      sourceMatchId: match.sourceMatchId || null,
      matchNo: match.matchNo || null,
      businessDate: match.businessDate || match.matchDate || null,
      kickoffTime: match.kickoffTime || null,
      leagueName: match.leagueName || null,
      homeTeamName: match.homeTeamName || null,
      awayTeamName: match.awayTeamName || null
    },
    status: match.status || null,
    score,
    result,
    projectedScore,
    rawMatchSignature,
    odds: pickOdds(match.odds),
    handicapLine: match.handicapLine ?? match.handicap ?? null,
    handicapOdds: pickOdds(match.handicapOdds),
    oddsTrend: match.oddsTrend ? {
      sampleSize: match.oddsTrend.sampleSize || null,
      direction: match.oddsTrend.direction || null,
      odds1Change: compactNumber(match.oddsTrend.odds1Change),
      oddsXChange: compactNumber(match.oddsTrend.oddsXChange),
      odds2Change: compactNumber(match.oddsTrend.odds2Change)
    } : null,
    prediction,
    stats,
    external: externalSummaryFor(match)
  };
  const signature = hashPayload(payload);
  return {
    id: crypto.randomUUID(),
    at: nowIso(),
    source,
    dataset,
    matchId: match.id || null,
    sourceMatchId: match.sourceMatchId || null,
    matchNo: match.matchNo || null,
    matchDate: match.matchDate || null,
    kickoffDate: match.kickoffDate || null,
    businessDate: match.businessDate || match.matchDate || null,
    kickoffTime: match.kickoffTime || null,
    leagueId: match.leagueId || null,
    leagueName: match.leagueName || null,
    countryId: match.countryId || null,
    countryName: match.countryName || null,
    homeTeamId: match.homeTeamId || null,
    homeTeamName: match.homeTeamName || null,
    awayTeamId: match.awayTeamId || null,
    awayTeamName: match.awayTeamName || null,
    matchSource: match.source || null,
    sourceMethod: match.sourceMethod || null,
    sourceUrl: match.sourceUrl || null,
    status: match.status || null,
    scoreHome: score.home,
    scoreAway: score.away,
    result,
    projectedScore,
    odds: payload.odds,
    oddsSource: match.oddsSource || null,
    oddsUpdatedAt: match.oddsUpdatedAt || match.odds?.updatedAt || null,
    handicapLine: payload.handicapLine,
    handicapOdds: payload.handicapOdds,
    handicapOddsSource: match.handicapOddsSource || null,
    handicapOddsUpdatedAt: match.handicapOddsUpdatedAt || match.handicapOdds?.updatedAt || null,
    oddsTrend: payload.oddsTrend,
    prediction: payload.prediction,
    stats,
    external: payload.external,
    dataCompleteness: dataCompletenessFor(match, prediction),
    rawMatchSignature,
    ...(STORE_FULL_MATCH_SNAPSHOTS ? { match } : {}),
    signature
  };
};

const compactPredictionForList = (prediction) => {
  if (!prediction || typeof prediction !== "object") return null;
  return {
    marketType: prediction.marketType,
    oddsPoolCode: prediction.oddsPoolCode,
    handicapLine: prediction.handicapLine,
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel,
    odds: prediction.odds,
    trustScore: prediction.trustScore,
    resultStatus: prediction.resultStatus,
    recommendationAction: prediction.recommendationAction,
    recommendationTier: prediction.recommendationTier,
    valueLabel: prediction.valueLabel,
    riskTags: Array.isArray(prediction.riskTags) ? prediction.riskTags.slice(0, 3) : []
  };
};

const compactPredictionReviewRowForList = (row) => {
  if (!row || typeof row !== "object") return null;
  return {
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode,
    handicapLine: row.handicapLine,
    tipCode: row.tipCode,
    tipLabel: row.tipLabel,
    odds: row.odds,
    actualCode: row.actualCode,
    actualLabel: row.actualLabel,
    resultStatus: row.resultStatus,
    trustScore: row.trustScore,
    recommendationAction: row.recommendationAction,
    recommendationTier: row.recommendationTier,
    reviewRole: row.reviewRole
  };
};

const compactPostMatchReviewForList = (review) => {
  if (!review || typeof review !== "object") return null;
  return {
    version: review.version,
    generatedAt: review.generatedAt,
    matchId: review.matchId,
    sourceMatchId: review.sourceMatchId,
    matchNo: review.matchNo,
    teams: review.teams,
    finalScore: review.finalScore,
    actual: review.actual,
    predictionReview: {
      settled: review.predictionReview?.settled || 0,
      won: review.predictionReview?.won || 0,
      hitRate: review.predictionReview?.hitRate ?? null,
      mainSettled: review.predictionReview?.mainSettled || 0,
      mainWon: review.predictionReview?.mainWon || 0,
      allSettled: review.predictionReview?.allSettled || 0,
      allWon: review.predictionReview?.allWon || 0,
      referenceSettled: review.predictionReview?.referenceSettled || 0,
      referenceWon: review.predictionReview?.referenceWon || 0,
      bestStatus: review.predictionReview?.bestStatus || null,
      oneXTwoStatus: review.predictionReview?.oneXTwoStatus || null,
      handicapHit: Boolean(review.predictionReview?.handicapHit),
      missedHandicapLane: Boolean(review.predictionReview?.missedHandicapLane),
      rows: (review.predictionReview?.rows || []).map(compactPredictionReviewRowForList).filter(Boolean)
    },
    scoreReview: review.scoreReview,
    modelDiagnosis: review.modelDiagnosis || [],
    nextAdjustment: review.nextAdjustment || [],
    dataGaps: review.dataGaps || []
  };
};

const compactMatchForHistoryList = (match) => ({
  id: match.id,
  sourceMatchId: match.sourceMatchId,
  homeTeamId: match.homeTeamId,
  awayTeamId: match.awayTeamId,
  leagueId: match.leagueId,
  countryId: match.countryId,
  kickoffTime: match.kickoffTime,
  kickoffDate: match.kickoffDate,
  businessDate: match.businessDate,
  matchDate: match.matchDate,
  status: match.status,
  scoreHome: match.scoreHome,
  scoreAway: match.scoreAway,
  projectedScoreHome: match.projectedScoreHome,
  projectedScoreAway: match.projectedScoreAway,
  homeTeamName: match.homeTeamName,
  homeTeamNameEn: match.homeTeamNameEn,
  homeTeamLogo: match.homeTeamLogo,
  homeTeamLogoType: match.homeTeamLogoType,
  homeTeamCountryIso: match.homeTeamCountryIso,
  homeTeamColor: match.homeTeamColor,
  awayTeamName: match.awayTeamName,
  awayTeamNameEn: match.awayTeamNameEn,
  awayTeamLogo: match.awayTeamLogo,
  awayTeamLogoType: match.awayTeamLogoType,
  awayTeamCountryIso: match.awayTeamCountryIso,
  awayTeamColor: match.awayTeamColor,
  leagueName: match.leagueName,
  leagueNameEn: match.leagueNameEn,
  leagueShortName: match.leagueShortName,
  leagueShortNameEn: match.leagueShortNameEn,
  countryName: match.countryName,
  countryNameEn: match.countryNameEn,
  countryFlag: match.countryFlag,
  matchNo: match.matchNo,
  odds: match.odds,
  handicapOdds: match.handicapOdds,
  handicapLine: match.handicapLine,
  predictions: Array.isArray(match.predictions)
    ? match.predictions
      .filter((prediction) => prediction.marketType === "BEST" || prediction.marketType === "1X2")
      .map(compactPredictionForList)
      .filter(Boolean)
    : [],
  postMatchReview: compactPostMatchReviewForList(match.postMatchReview)
});

const sortedHistoryList = (rows) => (Array.isArray(rows) ? rows : [])
  .slice()
  .sort((a, b) => Date.parse(b.kickoffTime || b.matchDate || 0) - Date.parse(a.kickoffTime || a.matchDate || 0))
  .map(compactMatchForHistoryList);

const materializedMatchFileName = (match) => {
  const key = String(match?.id || match?.sourceMatchId || `${match?.homeTeamName || ""}-${match?.awayTeamName || ""}-${match?.kickoffTime || ""}`);
  return `${hashPayload({ key })}.json`;
};

const matchAliases = (match) => Array.from(new Set([
  match?.id,
  match?.sourceMatchId
].filter(Boolean).map(String)));

const writeMaterializedMatches = async (storeDir, current, history, source) => {
  const updatedAt = nowIso();
  const latestDir = latestMatchDirFor(storeDir);
  await fsp.mkdir(latestDir, { recursive: true });

  const index = {
    version: 1,
    updatedAt,
    source,
    currentCount: Array.isArray(current) ? current.length : 0,
    historyCount: Array.isArray(history) ? history.length : 0,
    matches: {}
  };

  const writeOne = async (match, dataset) => {
    if (!match || typeof match !== "object") return;
    const aliases = matchAliases(match);
    if (!aliases.length) return;
    const file = materializedMatchFileName(match);
    await writeJsonAtomic(latestMatchFileFor(storeDir, file), {
      version: 1,
      updatedAt,
      dataset,
      match
    });
    for (const alias of aliases) {
      index.matches[alias] = {
        file,
        dataset,
        matchId: match.id || null,
        sourceMatchId: match.sourceMatchId || null,
        matchNo: match.matchNo || null,
        businessDate: match.businessDate || match.matchDate || null,
        kickoffTime: match.kickoffTime || null,
        status: match.status || null,
        updatedAt
      };
    }
  };

  for (const match of Array.isArray(history) ? history : []) {
    await writeOne(match, "history");
  }
  for (const match of Array.isArray(current) ? current : []) {
    await writeOne(match, "current");
  }

  await Promise.all([
    writeJsonAtomic(materializedPathFor(storeDir, CURRENT_MATCHES_FILE), {
      version: 1,
      updatedAt,
      source,
      rows: Array.isArray(current) ? current : []
    }),
    writeJsonAtomic(materializedPathFor(storeDir, HISTORY_LIST_FILE), {
      version: 1,
      updatedAt,
      source,
      rows: sortedHistoryList(history)
    }),
    writeJsonAtomic(materializedPathFor(storeDir, MATCH_INDEX_FILE), index)
  ]);

  return {
    currentRows: index.currentCount,
    historyRows: index.historyCount,
    indexedMatches: Object.keys(index.matches).length
  };
};

const buildOddsSnapshots = (match, source, dataset = "current") => {
  const common = {
    at: nowIso(),
    source,
    dataset,
    matchId: match.id || null,
    sourceMatchId: match.sourceMatchId || null,
    matchNo: match.matchNo || null,
    matchDate: match.matchDate || null,
    kickoffDate: match.kickoffDate || null,
    businessDate: match.businessDate || match.matchDate || null,
    kickoffTime: match.kickoffTime || null,
    leagueId: match.leagueId || null,
    leagueName: match.leagueName || null,
    countryId: match.countryId || null,
    countryName: match.countryName || null,
    homeTeamId: match.homeTeamId || null,
    homeTeamName: match.homeTeamName || null,
    awayTeamId: match.awayTeamId || null,
    awayTeamName: match.awayTeamName || null,
    status: match.status || null,
    matchSource: match.source || null
  };
  const rows = [];
  const add = (pool, bookmaker, handicap, odds, updatedAt, origin) => {
    const compactOdds = pickOdds(odds);
    if (!compactOdds) return;
    const payload = { pool, bookmaker, handicap, odds: compactOdds, updatedAt, origin };
    rows.push({
      id: crypto.randomUUID(),
      ...common,
      pool,
      bookmaker,
      handicap,
      odds1: compactOdds.odds1,
      oddsX: compactOdds.oddsX,
      odds2: compactOdds.odds2,
      oddsUpdatedAt: updatedAt || null,
      origin: origin || null,
      signature: hashPayload(payload)
    });
  };

  add("HAD", "sporttery", 0, match.odds, match.oddsUpdatedAt || match.odds?.updatedAt, match.oddsSource || "sporttery:HAD");
  add(
    "HHAD",
    "sporttery",
    match.handicapLine ?? match.handicap ?? null,
    match.handicapOdds,
    match.handicapOddsUpdatedAt || match.handicapOdds?.updatedAt,
    match.handicapOddsSource || "sporttery:HHAD"
  );

  const bookmakerOdds = match.externalSignals?.bookmakerOdds || {};
  add("HAD", "500.com", 0, bookmakerOdds.had, match.externalSignals?.updatedAt, "500.com:jczq");
  add(
    "HAD",
    bookmakerOdds.apiFootball?.bookmaker || "api-football",
    0,
    bookmakerOdds.apiFootball?.had,
    bookmakerOdds.apiFootball?.updatedAt || match.externalSignals?.updatedAt,
    "api-football:odds"
  );
  add(
    "HHAD",
    "500.com",
    bookmakerOdds.hhad?.handicapLine ?? match.externalSignals?.handicapLine ?? null,
    bookmakerOdds.hhad,
    match.externalSignals?.updatedAt,
    "500.com:jczq"
  );
  return rows;
};

const poolForOddsHistory = (row) => {
  const raw = `${row.pool || row.poolCode || row.oddsPoolCode || row.oddsSource || ""}`.toUpperCase();
  return raw.includes("HHAD") ? "HHAD" : "HAD";
};

const bookmakerForOddsHistory = (row) => {
  const raw = `${row.bookmaker || row.oddsSource || row.origin || ""}`.toLowerCase();
  if (raw.includes("500")) return "500.com";
  return "sporttery";
};

const matchIdForOddsHistory = (row) => {
  if (row.matchId) return row.matchId;
  if (row.sourceMatchId && String(row.sourceMatchId).startsWith("sporttery_")) return row.sourceMatchId;
  return row.sourceMatchId ? `sporttery_${row.sourceMatchId}` : null;
};

const buildOddsHistorySnapshot = (row, source) => {
  const compactOdds = pickOdds(row);
  if (!compactOdds) return null;
  const pool = poolForOddsHistory(row);
  const bookmaker = bookmakerForOddsHistory(row);
  const handicap = row.handicapLine ?? row.handicap ?? (pool === "HAD" ? 0 : null);
  const origin = row.oddsSource || row.origin || `${bookmaker}:${pool}`;
  const payload = {
    pool,
    bookmaker,
    handicap,
    odds: compactOdds,
    capturedAt: row.capturedAt || null,
    updatedAt: row.oddsUpdatedAt || row.updatedAt || null,
    origin
  };
  return {
    id: crypto.randomUUID(),
    at: row.capturedAt || nowIso(),
    persistedAt: nowIso(),
    source,
    dataset: "odds-history",
    matchId: matchIdForOddsHistory(row),
    sourceMatchId: row.sourceMatchId || null,
    matchNo: row.matchNo || null,
    businessDate: row.businessDate || row.matchDate || null,
    kickoffTime: row.kickoffTime || null,
    leagueId: row.leagueId || null,
    leagueName: row.leagueName || null,
    countryId: row.countryId || null,
    countryName: row.countryName || null,
    homeTeamId: row.homeTeamId || null,
    homeTeamName: row.homeTeamName || null,
    awayTeamId: row.awayTeamId || null,
    awayTeamName: row.awayTeamName || null,
    status: row.status || null,
    pool,
    bookmaker,
    handicap,
    odds1: compactOdds.odds1,
    oddsX: compactOdds.oddsX,
    odds2: compactOdds.odds2,
    oddsUpdatedAt: row.oddsUpdatedAt || row.updatedAt || null,
    oddsCapturedAt: row.capturedAt || null,
    captureBucket: row.captureBucket || null,
    origin,
    sourceMethod: row.oddsSourceMethod || null,
    sourceUrl: row.oddsSourceUrl || null,
    signature: hashPayload(payload)
  };
};

const oddsKeyFor = (oddsRow) => {
  const matchKey = oddsRow.matchId || oddsRow.sourceMatchId || "unknown-match";
  return `${matchKey}:${oddsRow.bookmaker || "unknown"}:${oddsRow.pool || "unknown"}:${oddsRow.handicap ?? 0}`;
};

const persistOddsSnapshotRow = async (storeDir, state, oddsRow, mode = "latest") => {
  const oddsKey = oddsKeyFor(oddsRow);
  const stateKey = mode === "event"
    ? `${oddsKey}:${oddsRow.at || ""}:${oddsRow.signature}`
    : oddsKey;
  if (mode === "event" ? state.latestOddsSignatures[stateKey] : state.latestOddsSignatures[stateKey] === oddsRow.signature) {
    return false;
  }
  await appendRow(storeDir, TABLES.oddsSnapshots, oddsRow);
  state.latestOddsSignatures[stateKey] = mode === "event" ? nowIso() : oddsRow.signature;
  state.counts.oddsSnapshots += 1;
  return true;
};

const summarizeStatuses = (rows) => rows.reduce((acc, match) => {
  const key = match.status || "UNKNOWN";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const summarizeDataCompleteness = (rows) => rows.reduce((acc, match) => {
  const prediction = predictionSummaryFor(match);
  const completeness = dataCompletenessFor(match, prediction);
  acc.total += 1;
  for (const [key, value] of Object.entries(completeness)) {
    if (key === "missing") continue;
    if (value) acc[key] = (acc[key] || 0) + 1;
  }
  return acc;
}, { total: 0 });

const persistPredictionRows = async (storeDir, state, rows, source) => {
  let appended = 0;
  for (const row of rows) {
    const key = row.matchId || row.sourceMatchId || hashPayload(row);
    const signature = row.signature || hashPayload({
      generatedAt: row.generatedAt,
      source: row.source,
      relay: row.relay?.parsed || row.relay,
      best: row.best,
      oneXTwo: row.oneXTwo,
      goals: row.goals
    });
    const stateKey = `${key}:${signature}`;
    if (state.latestPredictionSignatures[stateKey]) continue;
    await appendRow(storeDir, TABLES.predictionRuns, {
      id: crypto.randomUUID(),
      at: nowIso(),
      source,
      matchId: row.matchId || null,
      sourceMatchId: row.sourceMatchId || null,
      matchNo: row.matchNo || null,
      businessDate: row.businessDate || null,
      kickoffTime: row.kickoffTime || null,
      status: row.status || null,
      leagueName: row.leagueName || null,
      homeTeamName: row.homeTeamName || null,
      awayTeamName: row.awayTeamName || null,
      phase: row.phase || null,
      policyVersion: row.policyVersion || null,
      promptVersion: row.promptVersion || null,
      signature,
      prediction: {
        best: row.best || null,
        oneXTwo: row.oneXTwo || null,
        goals: row.goals || null,
        probabilityFinal: row.probabilityFinal || null,
        probabilityModelVersion: row.probabilityModelVersion || null,
        relay: row.relay?.parsed || null
      }
    });
    state.latestPredictionSignatures[stateKey] = nowIso();
    state.counts.predictionRuns += 1;
    appended += 1;
  }
  return appended;
};

const persistDataSnapshot = async ({ storeDir, dataDir, source = "server-sync", sourceHealth = null }) => {
  await ensureDataStore(storeDir);
  const state = await readState(storeDir);
  const current = await readJsonFile(path.join(dataDir, "matches-current.json"), []);
  const history = await readJsonFile(path.join(dataDir, "matches-history.json"), []);
  const syncMeta = await readJsonFile(path.join(dataDir, "sync-meta.json"), {});
  const oddsHistory = await readJsonFile(path.join(dataDir, "odds-history.json"), {});
  const predictionSnapshots = await readJsonFile(path.join(dataDir, "prediction-snapshots.json"), {});
  const gptPredictions = await readJsonFile(path.join(dataDir, "gpt-predictions.json"), { rows: [] });
  const externalSignals = await readJsonFile(path.join(dataDir, "external-signals.json"), null);
  const matches = Array.isArray(current) ? current : [];
  const historicalMatches = Array.isArray(history) ? history : [];
  const oddsHistoryRowsRaw = Array.isArray(oddsHistory.rows) ? oddsHistory.rows : Array.isArray(oddsHistory) ? oddsHistory : [];
  const oddsHistoryRows = selectRecentOddsHistoryRows(
    oddsHistoryRowsRaw,
    syncMeta.capturedAt || syncMeta.updatedAt || nowIso()
  );
  const statuses = summarizeStatuses(matches);
  const historyStatuses = summarizeStatuses(historicalMatches);
  const runSignature = hashPayload({
    matches: matches.map((match) => ({
      id: match.id,
      status: match.status,
      score: scoreFor(match),
      odds: pickOdds(match.odds),
      hhad: pickOdds(match.handicapOdds),
      prediction: predictionSummaryFor(match)
    })),
    history: historicalMatches.map((match) => ({
      id: match.id,
      status: match.status,
      score: scoreFor(match),
      odds: pickOdds(match.odds),
      hhad: pickOdds(match.handicapOdds)
    })),
    metaUpdatedAt: syncMeta.updatedAt || syncMeta.capturedAt || null,
    externalUpdatedAt: externalSignals?.updatedAt || null
  });

  await appendRow(storeDir, TABLES.syncRuns, {
    id: crypto.randomUUID(),
    at: nowIso(),
    source,
    signature: runSignature,
    counts: {
      current: matches.length,
      history: historicalMatches.length,
      allMatches: matches.length + historicalMatches.length,
      oddsHistoryRows: oddsHistoryRowsRaw.length,
      oddsHistoryRowsPersisted: oddsHistoryRows.length,
      predictionSnapshots: Array.isArray(predictionSnapshots.rows) ? predictionSnapshots.rows.length : 0,
      gptPredictions: Array.isArray(gptPredictions.rows) ? gptPredictions.rows.length : 0,
      externalSignals: externalSignals?.matches ? Object.keys(externalSignals.matches).length : 0
    },
    statuses,
    historyStatuses,
    dataCompleteness: {
      current: summarizeDataCompleteness(matches),
      history: summarizeDataCompleteness(historicalMatches)
    },
    meta: {
      updatedAt: syncMeta.updatedAt || null,
      capturedAt: syncMeta.capturedAt || null,
      officialOddsMatches: syncMeta.officialOddsMatches || 0,
      officialHandicapOddsMatches: syncMeta.officialHandicapOddsMatches || 0,
      officialResultMatches: syncMeta.officialResultMatches || 0,
      coverage: syncMeta.coverage || null
    },
    sourceHealth
  });
  state.counts.syncRuns += 1;

  let matchSnapshots = 0;
  let oddsSnapshots = 0;

  const persistMatch = async (match, dataset) => {
    const row = buildMatchSnapshot(match, source, dataset);
    const matchKey = row.matchId || row.sourceMatchId || `${row.homeTeamName}-${row.awayTeamName}-${row.kickoffTime}`;
    if (matchKey && state.latestMatchSignatures[matchKey] !== row.signature) {
      await appendRow(storeDir, TABLES.matchSnapshots, row);
      state.latestMatchSignatures[matchKey] = row.signature;
      state.counts.matchSnapshots += 1;
      matchSnapshots += 1;
    }

    for (const oddsRow of buildOddsSnapshots(match, source, dataset)) {
      if (await persistOddsSnapshotRow(storeDir, state, oddsRow, "latest")) {
        oddsSnapshots += 1;
      }
    }
  };

  for (const match of matches) {
    await persistMatch(match, "current");
  }
  for (const match of historicalMatches.filter((item) => shouldPersistHistorySnapshot(item, syncMeta.capturedAt || syncMeta.updatedAt || nowIso()))) {
    await persistMatch(match, "history");
  }

  for (const row of oddsHistoryRows) {
    const oddsRow = buildOddsHistorySnapshot(row, source);
    if (!oddsRow) continue;
    if (await persistOddsSnapshotRow(storeDir, state, oddsRow, "event")) {
      oddsSnapshots += 1;
    }
  }

  const predictionRows = [
    ...(Array.isArray(predictionSnapshots.rows) ? predictionSnapshots.rows.slice(-500) : []),
    ...(Array.isArray(gptPredictions.rows) ? gptPredictions.rows.slice(-500) : [])
  ];
  const predictionRuns = await persistPredictionRows(storeDir, state, predictionRows, source);
  const materialized = await writeMaterializedMatches(storeDir, matches, historicalMatches, source);
  const prunedSignatures = pruneStateSignatures(state);
  const nextState = await writeState(storeDir, state);

  return {
    ok: true,
    persistedAt: nextState.updatedAt,
    source,
    syncRun: true,
    matchSnapshots,
    oddsSnapshots,
    predictionRuns,
    materialized,
    prunedSignatures,
    counts: nextState.counts
  };
};

const readTimelineRows = async (storeDir, table, id, limit) => {
  const [byMatchId, bySourceMatchId] = await Promise.all([
    readDataStoreRows(storeDir, table, { matchId: id, limit }),
    readDataStoreRows(storeDir, table, { sourceMatchId: id, limit })
  ]);
  const unique = new Map();
  for (const row of [...byMatchId, ...bySourceMatchId]) {
    unique.set(row.id || hashPayload(row), row);
  }
  return Array.from(unique.values());
};

const getLatestCurrentMatches = async (storeDir) => {
  const materialized = await readJsonFile(materializedPathFor(storeDir, CURRENT_MATCHES_FILE), null);
  if (Array.isArray(materialized?.rows) && materialized.rows.length > 0) {
    return materialized.rows
      .slice()
      .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""));
  }

  try {
    const latest = new Map();
    const stream = fs.createReadStream(tablePathFor(storeDir, TABLES.matchSnapshots), { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    for await (const line of lines) {
      if (!line) continue;
      const row = safeJsonParse(line, null);
      if (!row || row.dataset !== "current" || !row.match || typeof row.match !== "object") continue;
      const key = row.matchId || row.sourceMatchId || row.match.id;
      if (!key) continue;
      const previous = latest.get(key);
      if (!previous || Date.parse(row.at || "") >= Date.parse(previous.at || "")) {
        latest.set(key, row);
      }
    }
    return Array.from(latest.values())
      .map((row) => row.match)
      .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""));
  } catch {
    return [];
  }
};

const getHistoryMatchesForList = async (storeDir, limit = 600) => {
  const safeLimit = clampLimit(limit, 1200);
  const materialized = await readJsonFile(materializedPathFor(storeDir, HISTORY_LIST_FILE), null);
  return Array.isArray(materialized?.rows) ? materialized.rows.slice(0, safeLimit) : [];
};

const getLatestMatchById = async (storeDir, id) => {
  const matchId = String(id || "").trim();
  if (!matchId) return null;
  const index = await readJsonFile(materializedPathFor(storeDir, MATCH_INDEX_FILE), null);
  const entry = index?.matches?.[matchId];
  if (!entry?.file) return null;
  const payload = await readJsonFile(latestMatchFileFor(storeDir, entry.file), null);
  return payload?.match && typeof payload.match === "object" ? payload.match : null;
};

const readOddsHistoryRows = async (storeDir, options = {}) => {
  const rows = await readDataStoreRows(storeDir, TABLES.oddsSnapshots, {
    limit: options.limit || 200,
    matchId: options.matchId || "",
    sourceMatchId: options.sourceMatchId || "",
    pool: options.pool || ""
  });
  return rows
    .slice()
    .sort((a, b) => Date.parse(b.at || b.oddsCapturedAt || "") - Date.parse(a.at || a.oddsCapturedAt || ""));
};

const getMatchTimeline = async (storeDir, id, limit = 120) => {
  const matchId = String(id || "").trim();
  if (!matchId) return [];
  const [matchRows, oddsRows, predictionRows] = await Promise.all([
    readTimelineRows(storeDir, TABLES.matchSnapshots, matchId, limit),
    readTimelineRows(storeDir, TABLES.oddsSnapshots, matchId, limit),
    readTimelineRows(storeDir, TABLES.predictionRuns, matchId, limit)
  ]);
  const rows = [
    ...matchRows.map((row) => ({ type: "match", ...row })),
    ...oddsRows.map((row) => ({ type: "odds", ...row })),
    ...predictionRows.map((row) => ({ type: "prediction", ...row }))
  ];
  const unique = new Map(rows.map((row) => [`${row.type}:${row.id}`, row]));
  return Array.from(unique.values())
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))
    .slice(0, clampLimit(limit));
};

module.exports = {
  TABLES,
  ensureDataStore,
  getDataStoreStatus,
  getHistoryMatchesForList,
  getLatestCurrentMatches,
  getLatestMatchById,
  getMatchTimeline,
  persistDataSnapshot,
  readOddsHistoryRows,
  readDataStoreRows
};
