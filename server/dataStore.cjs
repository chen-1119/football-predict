const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_FILE = "state.json";
const TABLES = {
  syncRuns: "sync-runs",
  matchSnapshots: "match-snapshots",
  oddsSnapshots: "odds-snapshots",
  predictionRuns: "prediction-runs"
};

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

const appendRow = async (storeDir, table, row) => {
  await ensureDataStore(storeDir);
  await fsp.appendFile(tablePathFor(storeDir, table), `${JSON.stringify(row)}\n`);
};

const countLines = async (filePath) => {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    if (!text.trim()) return 0;
    return text.trim().split(/\n+/).length;
  } catch {
    return 0;
  }
};

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
  try {
    const text = await fsp.readFile(tablePathFor(storeDir, table), "utf8");
    const matchId = String(options.matchId || "").trim();
    const sourceMatchId = String(options.sourceMatchId || "").trim();
    const pool = String(options.pool || "").trim().toUpperCase();
    const rows = text
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line, null))
      .filter(Boolean)
      .filter((row) => !matchId || String(row.matchId || "") === matchId)
      .filter((row) => !sourceMatchId || String(row.sourceMatchId || "") === sourceMatchId)
      .filter((row) => !pool || String(row.pool || "").toUpperCase() === pool)
      .slice(-limit)
      .reverse();
    return rows;
  } catch {
    return [];
  }
};

const getDataStoreStatus = async (storeDir) => {
  await ensureDataStore(storeDir);
  const state = await readState(storeDir);
  const dbDir = dbDirFor(storeDir);
  const files = {};
  for (const table of Object.values(TABLES)) {
    const filePath = tablePathFor(storeDir, table);
    try {
      const stat = await fsp.stat(filePath);
      files[table] = {
        exists: true,
        bytes: stat.size,
        rows: await countLines(filePath),
        updatedAt: stat.mtime.toISOString()
      };
    } catch {
      files[table] = { exists: false, bytes: 0, rows: 0, updatedAt: null };
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

const pickOdds = (odds) => {
  if (!odds) return null;
  return {
    odds1: compactNumber(odds.odds1),
    oddsX: compactNumber(odds.oddsX),
    odds2: compactNumber(odds.odds2)
  };
};

const scoreFor = (match) => ({
  home: match.scoreHome ?? match.homeScore ?? match.fullScoreHome ?? match.result?.scoreHome ?? null,
  away: match.scoreAway ?? match.awayScore ?? match.fullScoreAway ?? match.result?.scoreAway ?? null
});

const predictionSummaryFor = (match) => {
  const predictions = match.predictions || {};
  const probabilityFinal = match.probabilityModel?.oneXTwo?.final || match.probabilityFinal || null;
  return {
    main: predictions.best?.tipCode || predictions.oneXTwo?.tipCode || null,
    oneXTwo: predictions.oneXTwo?.tipCode || null,
    goals: predictions.goals?.tipCode || null,
    trustScore: predictions.best?.trustScore ?? predictions.oneXTwo?.trustScore ?? null,
    confidence: match.predictionMeta?.confidence ?? match.probabilityModel?.confidence ?? null,
    probabilityFinal,
    modelVersion: match.probabilityModel?.version || match.predictionMeta?.modelVersion || null
  };
};

const externalSummaryFor = (match) => {
  const signals = match.externalSignals;
  if (!signals || typeof signals !== "object") return null;
  return {
    source: signals.source || "external",
    updatedAt: signals.updatedAt || null,
    hasExternalOdds: Boolean(signals.externalOdds || signals.bookmakerOdds?.had || signals.bookmakerOdds?.hhad),
    hasBookmakerHad: Boolean(signals.bookmakerOdds?.had),
    hasBookmakerHhad: Boolean(signals.bookmakerOdds?.hhad)
  };
};

const buildMatchSnapshot = (match, source) => {
  const score = scoreFor(match);
  const payload = {
    status: match.status || null,
    score,
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
    prediction: predictionSummaryFor(match),
    external: externalSummaryFor(match)
  };
  const signature = hashPayload(payload);
  return {
    id: crypto.randomUUID(),
    at: nowIso(),
    source,
    matchId: match.id || null,
    sourceMatchId: match.sourceMatchId || null,
    matchNo: match.matchNo || null,
    businessDate: match.businessDate || match.matchDate || null,
    kickoffTime: match.kickoffTime || null,
    leagueName: match.leagueName || null,
    homeTeamName: match.homeTeamName || null,
    awayTeamName: match.awayTeamName || null,
    status: match.status || null,
    scoreHome: score.home,
    scoreAway: score.away,
    odds: payload.odds,
    handicapLine: payload.handicapLine,
    handicapOdds: payload.handicapOdds,
    oddsTrend: payload.oddsTrend,
    prediction: payload.prediction,
    external: payload.external,
    signature
  };
};

const buildOddsSnapshots = (match, source) => {
  const common = {
    at: nowIso(),
    source,
    matchId: match.id || null,
    sourceMatchId: match.sourceMatchId || null,
    matchNo: match.matchNo || null,
    businessDate: match.businessDate || match.matchDate || null,
    kickoffTime: match.kickoffTime || null,
    leagueName: match.leagueName || null,
    homeTeamName: match.homeTeamName || null,
    awayTeamName: match.awayTeamName || null,
    status: match.status || null
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
    "HHAD",
    "500.com",
    bookmakerOdds.hhad?.handicapLine ?? match.externalSignals?.handicapLine ?? null,
    bookmakerOdds.hhad,
    match.externalSignals?.updatedAt,
    "500.com:jczq"
  );
  return rows;
};

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
  const statuses = matches.reduce((acc, match) => {
    const key = match.status || "UNKNOWN";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const runSignature = hashPayload({
    matches: matches.map((match) => ({
      id: match.id,
      status: match.status,
      score: scoreFor(match),
      odds: pickOdds(match.odds),
      hhad: pickOdds(match.handicapOdds),
      prediction: predictionSummaryFor(match)
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
      oddsHistoryRows: Array.isArray(oddsHistory.rows) ? oddsHistory.rows.length : 0,
      predictionSnapshots: Array.isArray(predictionSnapshots.rows) ? predictionSnapshots.rows.length : 0,
      gptPredictions: Array.isArray(gptPredictions.rows) ? gptPredictions.rows.length : 0,
      externalSignals: externalSignals?.matches ? Object.keys(externalSignals.matches).length : 0
    },
    statuses,
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
  for (const match of matches) {
    const row = buildMatchSnapshot(match, source);
    const matchKey = row.matchId || row.sourceMatchId || `${row.homeTeamName}-${row.awayTeamName}-${row.kickoffTime}`;
    if (matchKey && state.latestMatchSignatures[matchKey] !== row.signature) {
      await appendRow(storeDir, TABLES.matchSnapshots, row);
      state.latestMatchSignatures[matchKey] = row.signature;
      state.counts.matchSnapshots += 1;
      matchSnapshots += 1;
    }

    for (const oddsRow of buildOddsSnapshots(match, source)) {
      const oddsKey = `${oddsRow.matchId || oddsRow.sourceMatchId}:${oddsRow.bookmaker}:${oddsRow.pool}:${oddsRow.handicap ?? 0}`;
      if (state.latestOddsSignatures[oddsKey] === oddsRow.signature) continue;
      await appendRow(storeDir, TABLES.oddsSnapshots, oddsRow);
      state.latestOddsSignatures[oddsKey] = oddsRow.signature;
      state.counts.oddsSnapshots += 1;
      oddsSnapshots += 1;
    }
  }

  const predictionRows = [
    ...(Array.isArray(predictionSnapshots.rows) ? predictionSnapshots.rows.slice(0, 300) : []),
    ...(Array.isArray(gptPredictions.rows) ? gptPredictions.rows.slice(0, 300) : [])
  ];
  const predictionRuns = await persistPredictionRows(storeDir, state, predictionRows, source);
  const nextState = await writeState(storeDir, state);

  return {
    ok: true,
    persistedAt: nextState.updatedAt,
    source,
    syncRun: true,
    matchSnapshots,
    oddsSnapshots,
    predictionRuns,
    counts: nextState.counts
  };
};

const getMatchTimeline = async (storeDir, id, limit = 120) => {
  const matchId = String(id || "").trim();
  if (!matchId) return [];
  const [matchRows, officialOdds, hhadOdds, predictionRows] = await Promise.all([
    readDataStoreRows(storeDir, TABLES.matchSnapshots, { matchId, limit }),
    readDataStoreRows(storeDir, TABLES.oddsSnapshots, { matchId, limit }),
    readDataStoreRows(storeDir, TABLES.oddsSnapshots, { sourceMatchId: matchId, limit }),
    readDataStoreRows(storeDir, TABLES.predictionRuns, { matchId, limit })
  ]);
  const rows = [
    ...matchRows.map((row) => ({ type: "match", ...row })),
    ...officialOdds.map((row) => ({ type: "odds", ...row })),
    ...hhadOdds.map((row) => ({ type: "odds", ...row })),
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
  getMatchTimeline,
  persistDataSnapshot,
  readDataStoreRows
};
