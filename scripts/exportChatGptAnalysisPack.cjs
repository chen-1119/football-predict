const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, "public", "data");
const PROMPT_SOURCE = path.join(ROOT_DIR, "docs", "chatgpt-pro-football-audit-prompt.md");
const DEFAULT_MAX_CSV_BYTES = 45 * 1024 * 1024;
const DATASET_BASE_NAMES = ["matches", "odds_snapshots", "predictions", "settlements"];

const MATCH_COLUMNS = [
  "match_id", "source_match_id", "match_no", "business_date", "kickoff_at", "cutoff_at",
  "cutoff_source", "cutoff_quality", "league_name", "league_name_en", "country_name",
  "country_name_en", "home_team", "home_team_en", "away_team", "away_team_en", "source",
  "data_scope"
];

const ODDS_COLUMNS = [
  "odds_snapshot_id", "match_id", "source_match_id", "observed_at", "source_updated_at",
  "cutoff_at", "cutoff_source", "cutoff_quality", "pool_code", "handicap_line", "odds_home",
  "odds_draw", "odds_away", "market_prob_home", "market_prob_draw", "market_prob_away",
  "source_kind", "source_name"
];

const PREDICTION_COLUMNS = [
  "prediction_id", "match_id", "source_match_id", "prediction_captured_at", "cutoff_at",
  "cutoff_source", "cutoff_quality", "temporal_quality", "source_kind", "source_phase",
  "prediction_role", "market_type", "odds_pool_code", "handicap_line", "tip_code",
  "tip_label_zh", "tip_label_en", "selected_odds", "trust_score", "recommendation_action",
  "recommendation_tier", "model_version", "calibration_version", "model_prob_home",
  "model_prob_draw", "model_prob_away", "selected_model_probability", "selected_market_probability",
  "probability_edge", "expected_value", "evidence_score", "evidence_threshold", "data_quality",
  "risk_count", "risk_tags_json", "blockers_json", "supporting_factors_json", "feature_snapshot_hash"
];

const SETTLEMENT_COLUMNS = [
  "prediction_id", "match_id", "source_match_id", "settlement_recorded_at", "market_type",
  "odds_pool_code", "handicap_line", "tip_code", "actual_code", "result_status", "score_home",
  "score_away", "total_goals", "actual_had_code", "actual_hhad_code", "actual_btts_code",
  "selected_odds", "profit_units", "recommendation_action", "settlement_integrity", "outcome_source",
  "data_scope"
];

const HELP = `
Export a privacy-minimized football audit pack for manual ChatGPT Pro analysis.

Usage:
  node scripts/exportChatGptAnalysisPack.cjs --out <directory> [options]
  node scripts/exportChatGptAnalysisPack.cjs --self-test

Options:
  --out <directory>      Required output directory.
  --data-dir <directory> Read JSON inputs from this directory (default: public/data).
  --sqlite <file>        Read JSON payloads from an existing football.db instead of JSON files.
  --max-csv-mb <number>  Maximum size of each deterministic CSV part (default: 45, max: 49).
  --self-test            Run the built-in leakage, escaping, sharding, and repeatability tests.
  --help, -h             Show this help.

This command never reads ChatGPT sessions, browser state, chats, .env files, or API keys.
It does not call ChatGPT or the OpenAI API.
`.trim();

function parseArgs(argv) {
  const options = {
    outDir: "",
    dataDir: DEFAULT_DATA_DIR,
    sqlitePath: "",
    maxCsvBytes: DEFAULT_MAX_CSV_BYTES,
    help: false,
    selfTest: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (["--out", "--data-dir", "--sqlite", "--max-csv-mb"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--out") options.outDir = path.resolve(value);
      if (arg === "--data-dir") options.dataDir = path.resolve(value);
      if (arg === "--sqlite") options.sqlitePath = path.resolve(value);
      if (arg === "--max-csv-mb") {
        const mb = Number(value);
        if (!Number.isFinite(mb) || mb < 1 || mb > 49) throw new Error("--max-csv-mb must be between 1 and 49");
        options.maxCsvBytes = Math.floor(mb * 1024 * 1024);
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.sqlitePath && argv.includes("--data-dir")) {
    throw new Error("Use either --sqlite or --data-dir, not both");
  }
  return options;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const shortHash = (value) => sha256(value).slice(0, 24);
const asText = (value) => value === null || value === undefined ? "" : String(value).trim();
const asFinite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const firstPresent = (...values) => values.find(
  (value) => value !== null && value !== undefined && String(value).trim() !== ""
);
const arrayFromPayload = (payload, key = "rows") => {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.[key]) ? payload[key] : [];
};

function parseDateLike(value) {
  const raw = asText(value);
  if (!raw) return null;
  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    normalized = raw.replace(/\s+/, "T");
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    normalized = `${normalized}+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized = `${normalized}T00:00:00+08:00`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString(), raw } : null;
}

function probabilityToUnit(value) {
  const number = asFinite(value);
  if (number === null || number < 0) return "";
  const unit = number > 1 ? number / 100 : number;
  return unit <= 1 ? Number(unit.toFixed(8)) : "";
}

function normalizedMarketProbabilities(home, draw, away) {
  const odds = [home, draw, away].map(asFinite);
  if (odds.some((value) => value === null || value <= 1)) return ["", "", ""];
  const inverse = odds.map((value) => 1 / value);
  const sum = inverse.reduce((acc, value) => acc + value, 0);
  return inverse.map((value) => Number((value / sum).toFixed(8)));
}

function jsonCell(value) {
  if (value === null || value === undefined || value === "") return "";
  return JSON.stringify(value);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(row, columns) {
  return `${columns.map((column) => csvCell(row[column])).join(",")}\n`;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sourceFileMeta(filePath, logicalName = path.basename(filePath)) {
  const content = fs.readFileSync(filePath);
  return {
    name: logicalName,
    bytes: content.byteLength,
    sha256: sha256(content)
  };
}

function collectSourceTimes(payload, target) {
  for (const value of [payload?.updatedAt, payload?.generatedAt, payload?.capturedAt, payload?.lastAttemptAt]) {
    const parsed = parseDateLike(value);
    if (parsed) target.push(parsed.ms);
  }
}

function loadJsonInputs(dataDir) {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`JSON data directory does not exist: ${dataDir}`);
  }
  const definitions = {
    current: "matches-current.json",
    history: "matches-history.json",
    odds: "odds-history.json",
    predictions: "prediction-snapshots.json",
    reviews: "post-match-reviews.json",
    syncMeta: "sync-meta.json"
  };
  const payloads = {};
  const sourceFiles = [];
  const sourceTimes = [];
  for (const [key, fileName] of Object.entries(definitions)) {
    const filePath = path.join(dataDir, fileName);
    payloads[key] = readJsonFile(filePath, key === "current" || key === "history" ? [] : {});
    if (fs.existsSync(filePath)) sourceFiles.push(sourceFileMeta(filePath, fileName));
    collectSourceTimes(payloads[key], sourceTimes);
  }
  return {
    inputKind: "public-data-json",
    matches: [...arrayFromPayload(payloads.current, "matches"), ...arrayFromPayload(payloads.history, "matches")],
    oddsRows: arrayFromPayload(payloads.odds),
    predictionRows: arrayFromPayload(payloads.predictions),
    reviewRows: arrayFromPayload(payloads.reviews),
    sourceFiles,
    sourceTimes
  };
}

function loadSqliteInputs(dbPath) {
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) throw new Error(`SQLite file does not exist: ${dbPath}`);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`node:sqlite is unavailable; use Node.js 22+ (${error.message || error})`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const payloadRows = (table, where = "") => {
    if (!hasTable(table)) return [];
    return db.prepare(`SELECT payload FROM ${table} ${where}`).all().flatMap((row) => {
      try { return [JSON.parse(row.payload)]; } catch { return []; }
    });
  };
  let matches;
  let oddsRows;
  let predictionRows;
  const sourceTimes = [];
  try {
    matches = payloadRows("match_snapshots", "WHERE dataset IN ('current', 'history')");
    oddsRows = payloadRows("odds_snapshots");
    predictionRows = payloadRows("prediction_snapshots");
    if (hasTable("schema_meta")) {
      const row = db.prepare("SELECT value FROM schema_meta WHERE key='exported_at'").get();
      const parsed = parseDateLike(row?.value);
      if (parsed) sourceTimes.push(parsed.ms);
    }
  } finally {
    db.close();
  }
  const sourceFiles = [sourceFileMeta(dbPath, path.basename(dbPath))];
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) sourceFiles.push(sourceFileMeta(walPath, `${path.basename(dbPath)}-wal`));
  return {
    inputKind: "sqlite-json-payloads",
    matches,
    oddsRows,
    predictionRows,
    reviewRows: [],
    sourceFiles,
    sourceTimes
  };
}

function matchIdFor(value) {
  const direct = asText(value?.matchId || value?.id);
  if (direct) return direct;
  const sourceId = asText(value?.sourceMatchId);
  return sourceId ? `sporttery_${sourceId}` : "";
}

function sourceMatchIdFor(value) {
  return asText(value?.sourceMatchId || matchIdFor(value).replace(/^sporttery_/, ""));
}

function syntheticMatch(row, origin) {
  return {
    id: matchIdFor(row),
    sourceMatchId: sourceMatchIdFor(row),
    matchNo: row?.matchNo,
    businessDate: row?.businessDate,
    kickoffTime: row?.kickoffTime,
    leagueName: row?.leagueName,
    leagueNameEn: row?.leagueNameEn,
    countryName: row?.countryName,
    countryNameEn: row?.countryNameEn,
    homeTeamName: row?.homeTeamName,
    homeTeamNameEn: row?.homeTeamNameEn,
    awayTeamName: row?.awayTeamName,
    awayTeamNameEn: row?.awayTeamNameEn,
    source: row?.source || origin,
    predictionMeta: {
      cutoffTime: row?.cutoffTime,
      featureSnapshot: row?.featureSnapshot
    },
    __origin: origin,
    __synthetic: true
  };
}

function matchQuality(match) {
  let score = match?.__synthetic ? 0 : 100;
  if (asText(match?.homeTeamName)) score += 5;
  if (asText(match?.awayTeamName)) score += 5;
  if (parseDateLike(match?.predictionMeta?.cutoffTime)) score += 4;
  if (Number.isFinite(Number(match?.scoreHome)) && Number.isFinite(Number(match?.scoreAway))) score += 3;
  return score;
}

function buildFixtureIndex(inputs) {
  const candidates = [
    ...inputs.matches,
    ...inputs.predictionRows.map((row) => syntheticMatch(row, "prediction-snapshot")),
    ...inputs.oddsRows.map((row) => syntheticMatch(row, "odds-snapshot"))
  ];
  const byId = new Map();
  for (const candidate of candidates) {
    const id = matchIdFor(candidate);
    if (!id) continue;
    const current = byId.get(id);
    if (!current || matchQuality(candidate) > matchQuality(current)) byId.set(id, candidate);
  }
  const aliases = new Map();
  for (const match of byId.values()) {
    aliases.set(matchIdFor(match), match);
    const sourceId = sourceMatchIdFor(match);
    if (sourceId) aliases.set(sourceId, match);
  }
  return { matches: [...byId.values()], aliases };
}

function findFixture(index, row) {
  return index.aliases.get(matchIdFor(row)) || index.aliases.get(sourceMatchIdFor(row)) || syntheticMatch(row, "unmatched-row");
}

function resolveCutoff(match, related = null) {
  const candidates = [];
  const add = (source, value) => {
    const parsed = parseDateLike(value);
    if (parsed) candidates.push({ source, ...parsed });
  };
  add("related.cutoffTime", related?.cutoffTime);
  add("related.featureSnapshot.cutoffTime", related?.featureSnapshot?.cutoffTime);
  add("predictionMeta.cutoffTime", match?.predictionMeta?.cutoffTime);
  add("predictionMeta.featureSnapshot.cutoffTime", match?.predictionMeta?.featureSnapshot?.cutoffTime);
  add("buyEndTime", match?.buyEndTime);
  add("externalSignals.buyEndTime", match?.externalSignals?.buyEndTime);
  add("externalSignals.fiveHundred.sale.buyEndTime", match?.externalSignals?.fiveHundred?.sale?.buyEndTime);
  if (candidates.length > 0) {
    const earliest = Math.min(...candidates.map((candidate) => candidate.ms));
    const sources = candidates.filter((candidate) => candidate.ms === earliest).map((candidate) => candidate.source);
    return { ms: earliest, iso: new Date(earliest).toISOString(), source: sources.join("+"), quality: "explicit" };
  }
  const kickoff = parseDateLike(related?.kickoffTime || match?.kickoffTime);
  if (!kickoff) return null;
  return { ...kickoff, source: "kickoffTime", quality: "kickoff_fallback" };
}

function buildMatchRows(fixtureIndex) {
  return fixtureIndex.matches.map((match) => {
    const cutoff = resolveCutoff(match);
    return {
      match_id: matchIdFor(match),
      source_match_id: sourceMatchIdFor(match),
      match_no: asText(match?.matchNo),
      business_date: asText(match?.businessDate),
      kickoff_at: parseDateLike(match?.kickoffTime)?.iso || "",
      cutoff_at: cutoff?.iso || "",
      cutoff_source: cutoff?.source || "",
      cutoff_quality: cutoff?.quality || "missing",
      league_name: asText(match?.leagueName),
      league_name_en: asText(match?.leagueNameEn),
      country_name: asText(match?.countryName),
      country_name_en: asText(match?.countryNameEn),
      home_team: asText(match?.homeTeamName),
      home_team_en: asText(match?.homeTeamNameEn),
      away_team: asText(match?.awayTeamName),
      away_team_en: asText(match?.awayTeamNameEn),
      source: asText(match?.source || match?.__origin),
      data_scope: "pre_match_fixture_only"
    };
  }).sort((a, b) => `${a.kickoff_at}|${a.match_id}`.localeCompare(`${b.kickoff_at}|${b.match_id}`));
}

function emptyExclusions() {
  return {
    odds: { missingCutoff: 0, missingObservedAt: 0, afterCutoff: 0, sourceAfterCutoff: 0, invalidOdds: 0 },
    predictions: { missingCutoff: 0, missingCapturedAt: 0, afterCutoff: 0, invalidPrediction: 0, unsafeFallback: 0 },
    settlements: { noFinalScore: 0, missingHandicapLine: 0, unsupported: 0 }
  };
}

function poolCodeFor(row, fallback = "HAD") {
  const raw = asText(row?.pool || row?.poolCode || row?.oddsPoolCode || row?.oddsSource || fallback).toUpperCase();
  return raw.includes("HHAD") ? "HHAD" : raw.includes("HAD") ? "HAD" : fallback;
}

function oddsRowFromValues({ fixture, related, observedAt, sourceUpdatedAt, poolCode, handicapLine, odds, sourceKind, sourceName }, exclusions) {
  const cutoff = resolveCutoff(fixture, related);
  const observed = parseDateLike(observedAt);
  const sourceUpdated = parseDateLike(sourceUpdatedAt);
  if (!cutoff) { exclusions.odds.missingCutoff += 1; return null; }
  if (!observed) { exclusions.odds.missingObservedAt += 1; return null; }
  if (observed.ms > cutoff.ms) { exclusions.odds.afterCutoff += 1; return null; }
  if (sourceUpdated && sourceUpdated.ms > cutoff.ms) { exclusions.odds.sourceAfterCutoff += 1; return null; }
  const home = asFinite(odds?.odds1 ?? odds?.home);
  const draw = asFinite(odds?.oddsX ?? odds?.draw);
  const away = asFinite(odds?.odds2 ?? odds?.away);
  if ([home, draw, away].some((value) => value === null || value <= 1)) {
    exclusions.odds.invalidOdds += 1;
    return null;
  }
  const probabilities = normalizedMarketProbabilities(home, draw, away);
  const safeLine = poolCode === "HHAD" ? asText(handicapLine) : "0";
  const identity = {
    matchId: matchIdFor(fixture), observedAt: observed.iso, poolCode, handicapLine: safeLine,
    home, draw, away, sourceKind
  };
  return {
    odds_snapshot_id: `odds_${shortHash(JSON.stringify(identity))}`,
    match_id: matchIdFor(fixture),
    source_match_id: sourceMatchIdFor(fixture),
    observed_at: observed.iso,
    source_updated_at: sourceUpdated?.iso || "",
    cutoff_at: cutoff.iso,
    cutoff_source: cutoff.source,
    cutoff_quality: cutoff.quality,
    pool_code: poolCode,
    handicap_line: safeLine,
    odds_home: home,
    odds_draw: draw,
    odds_away: away,
    market_prob_home: probabilities[0],
    market_prob_draw: probabilities[1],
    market_prob_away: probabilities[2],
    source_kind: sourceKind,
    source_name: asText(sourceName)
  };
}

function featureMarketOddsRows(owner, fixture, sourceKind, exclusions) {
  const snapshot = owner?.featureSnapshot || owner?.predictionMeta?.featureSnapshot;
  if (!snapshot || typeof snapshot !== "object") return [];
  const observedAt = snapshot.capturedAt || owner?.capturedAt;
  const result = [];
  for (const [key, poolCode] of [["had", "HAD"], ["hhad", "HHAD"]]) {
    const market = snapshot?.market?.[key];
    if (!market?.odds) continue;
    const row = oddsRowFromValues({
      fixture,
      related: owner,
      observedAt,
      sourceUpdatedAt: market.updatedAt,
      poolCode,
      handicapLine: firstPresent(market.handicapLine, snapshot?.market?.hhad?.handicapLine, owner?.handicapLine, fixture?.handicapLine),
      odds: market.odds,
      sourceKind,
      sourceName: market.source || snapshot.source || "feature-snapshot"
    }, exclusions);
    if (row) result.push(row);
  }
  return result;
}

function buildOddsRows(inputs, fixtureIndex, exclusions) {
  const rows = [];
  for (const sourceRow of inputs.oddsRows) {
    const fixture = findFixture(fixtureIndex, sourceRow);
    const poolCode = poolCodeFor(sourceRow);
    const row = oddsRowFromValues({
      fixture,
      related: sourceRow,
      observedAt: sourceRow?.capturedAt || sourceRow?.captureBucket,
      sourceUpdatedAt: sourceRow?.oddsUpdatedAt || sourceRow?.updatedAt,
      poolCode,
      handicapLine: sourceRow?.handicapLine || fixture?.handicapLine,
      odds: sourceRow,
      sourceKind: "odds-history",
      sourceName: sourceRow?.oddsSource || sourceRow?.source
    }, exclusions);
    if (row) rows.push(row);
  }
  for (const owner of inputs.predictionRows) {
    rows.push(...featureMarketOddsRows(owner, findFixture(fixtureIndex, owner), "prediction-feature-snapshot", exclusions));
  }
  for (const fixture of fixtureIndex.matches) {
    rows.push(...featureMarketOddsRows(fixture, fixture, "match-feature-snapshot", exclusions));
    const snapshot = fixture?.predictionMeta?.featureSnapshot;
    if (!snapshot?.capturedAt) continue;
    if (fixture?.odds && !snapshot?.market?.had?.odds) {
      const row = oddsRowFromValues({
        fixture,
        related: fixture,
        observedAt: snapshot.capturedAt,
        sourceUpdatedAt: fixture?.oddsUpdatedAt,
        poolCode: "HAD",
        handicapLine: "0",
        odds: fixture.odds,
        sourceKind: "match-feature-fallback",
        sourceName: fixture?.oddsSource
      }, exclusions);
      if (row) rows.push(row);
    }
    if (fixture?.handicapOdds && !snapshot?.market?.hhad?.odds) {
      const row = oddsRowFromValues({
        fixture,
        related: fixture,
        observedAt: snapshot.capturedAt,
        sourceUpdatedAt: fixture?.handicapOddsUpdatedAt,
        poolCode: "HHAD",
        handicapLine: fixture?.handicapLine,
        odds: fixture.handicapOdds,
        sourceKind: "match-feature-fallback",
        sourceName: fixture?.handicapOddsSource
      }, exclusions);
      if (row) rows.push(row);
    }
  }
  const unique = new Map(rows.map((row) => [row.odds_snapshot_id, row]));
  return [...unique.values()].sort((a, b) => `${a.observed_at}|${a.match_id}|${a.pool_code}|${a.odds_snapshot_id}`
    .localeCompare(`${b.observed_at}|${b.match_id}|${b.pool_code}|${b.odds_snapshot_id}`));
}

function predictionSections(snapshot) {
  const rows = [];
  if (snapshot?.oneXTwo) rows.push(["one_x_two", snapshot.oneXTwo, "1X2"]);
  if (snapshot?.best) rows.push(["best", snapshot.best, "BEST"]);
  if (snapshot?.goals) rows.push(["goals", snapshot.goals, "GOALS"]);
  if (Array.isArray(snapshot?.predictions)) {
    for (const item of snapshot.predictions) {
      const role = asText(item?.marketType || "prediction").toLowerCase();
      rows.push([role, item, item?.marketType || "UNKNOWN"]);
    }
  }
  return rows;
}

function labelText(value, language) {
  if (value && typeof value === "object") return asText(value[language]);
  return asText(value);
}

function probabilityTriple(source, poolCode) {
  let probabilities = null;
  if (poolCode === "HHAD") {
    probabilities = source?.probabilityModel?.handicap?.unifiedPosterior
      || source?.probabilityModel?.handicap?.final
      || source?.featureSnapshot?.modelInputs?.handicapFinal;
  } else {
    probabilities = source?.probabilityFinal
      || source?.probabilityModel?.oneXTwo?.final
      || source?.featureSnapshot?.modelInputs?.oneXTwoFinal;
  }
  return {
    home: probabilityToUnit(probabilities?.home),
    draw: probabilityToUnit(probabilities?.draw),
    away: probabilityToUnit(probabilities?.away)
  };
}

function selectedProbability(probabilities, code) {
  if (code === "1") return probabilities.home;
  if (code === "0" || code === "X") return probabilities.draw;
  if (code === "2") return probabilities.away;
  return "";
}

function normalizeRiskTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => typeof tag === "object" ? (asText(tag.zh) || asText(tag.en)) : asText(tag)).filter(Boolean);
}

function predictionRowFromItem({ source, fixture, item, role, fallbackMarketType, captured, cutoff, sourceKind, temporalQuality }) {
  const poolCode = poolCodeFor(item, fallbackMarketType === "GOALS" ? "" : "HAD");
  const marketType = fallbackMarketType === "GOALS" ? "GOALS" : asText(item?.marketType || fallbackMarketType || poolCode);
  const tipCode = asText(item?.tipCode).toUpperCase();
  if (!tipCode || !marketType) return null;
  const evidence = item?.multiFactorEvidence || {};
  const probabilities = probabilityTriple(source, poolCode);
  const modelVersion = asText(source?.modelVersion || source?.probabilityModelVersion || source?.probabilityModel?.version || source?.predictionMeta?.modelVersion);
  const calibrationVersion = asText(source?.calibrationVersion || source?.predictionMeta?.calibrationVersion);
  const handicapLine = poolCode === "HHAD" ? asText(firstPresent(item?.handicapLine, source?.handicapLine, fixture?.handicapLine)) : "0";
  const riskTags = normalizeRiskTags(item?.riskTags);
  const dataQuality = probabilityToUnit(evidence?.dataQuality ?? source?.featureSnapshot?.modelInputs?.dataGaps?.coverageScore);
  const identity = {
    matchId: matchIdFor(fixture), capturedAt: captured.iso, role, marketType, poolCode, handicapLine,
    tipCode, odds: asFinite(item?.odds), modelVersion, featureHash: source?.featureSnapshotHash || source?.predictionMeta?.featureSnapshotHash
  };
  return {
    prediction_id: `pred_${shortHash(JSON.stringify(identity))}`,
    match_id: matchIdFor(fixture),
    source_match_id: sourceMatchIdFor(fixture),
    prediction_captured_at: captured.iso,
    cutoff_at: cutoff.iso,
    cutoff_source: cutoff.source,
    cutoff_quality: cutoff.quality,
    temporal_quality: temporalQuality,
    source_kind: sourceKind,
    source_phase: asText(source?.phase || source?.predictionMeta?.snapshot?.phase),
    prediction_role: role,
    market_type: marketType,
    odds_pool_code: poolCode,
    handicap_line: handicapLine,
    tip_code: tipCode,
    tip_label_zh: labelText(item?.tipLabel, "zh"),
    tip_label_en: labelText(item?.tipLabel, "en"),
    selected_odds: asFinite(item?.odds) ?? "",
    trust_score: asFinite(item?.trustScore) ?? "",
    recommendation_action: asText(item?.recommendationAction),
    recommendation_tier: asText(item?.recommendationTier),
    model_version: modelVersion,
    calibration_version: calibrationVersion,
    model_prob_home: probabilities.home,
    model_prob_draw: probabilities.draw,
    model_prob_away: probabilities.away,
    selected_model_probability: firstPresent(
      probabilityToUnit(evidence?.modelProbability),
      selectedProbability(probabilities, tipCode)
    ) ?? "",
    selected_market_probability: probabilityToUnit(evidence?.marketProbability),
    probability_edge: asFinite(evidence?.probabilityEdge) ?? "",
    expected_value: asFinite(evidence?.expectedValue) ?? "",
    evidence_score: asFinite(evidence?.evidenceScore) ?? "",
    evidence_threshold: asFinite(evidence?.threshold) ?? "",
    data_quality: dataQuality,
    risk_count: asFinite(item?.riskCount) ?? riskTags.length,
    risk_tags_json: jsonCell(riskTags),
    blockers_json: jsonCell(Array.isArray(evidence?.blockers) ? evidence.blockers : []),
    supporting_factors_json: jsonCell(Array.isArray(evidence?.supportingFactors) ? evidence.supportingFactors : []),
    feature_snapshot_hash: asText(source?.featureSnapshotHash || source?.predictionMeta?.featureSnapshotHash || source?.featureSnapshot?.hash)
  };
}

function latestTimestamp(values) {
  const parsed = values.map(parseDateLike).filter(Boolean);
  if (!parsed.length) return null;
  return parsed.reduce((latest, current) => current.ms > latest.ms ? current : latest);
}

function buildPredictionRows(inputs, fixtureIndex, exclusions) {
  const rows = [];
  const representedMatches = new Set();
  for (const source of inputs.predictionRows) {
    const fixture = findFixture(fixtureIndex, source);
    const cutoff = resolveCutoff(fixture, source);
    const captured = parseDateLike(source?.capturedAt);
    if (!cutoff) { exclusions.predictions.missingCutoff += 1; continue; }
    if (!captured) { exclusions.predictions.missingCapturedAt += 1; continue; }
    if (captured.ms > cutoff.ms) { exclusions.predictions.afterCutoff += 1; continue; }
    const temporalQuality = source?.featureSnapshot?.migrated
      ? "captured_pre_cutoff_feature_snapshot_migrated"
      : "captured_pre_cutoff";
    let added = 0;
    for (const [role, item, marketType] of predictionSections(source)) {
      const row = predictionRowFromItem({
        source, fixture, item, role, fallbackMarketType: marketType, captured, cutoff,
        sourceKind: "prediction-snapshot", temporalQuality
      });
      if (row) { rows.push(row); added += 1; }
      else exclusions.predictions.invalidPrediction += 1;
    }
    if (added > 0) representedMatches.add(matchIdFor(fixture));
  }

  for (const fixture of fixtureIndex.matches) {
    if (representedMatches.has(matchIdFor(fixture)) || !Array.isArray(fixture?.predictions) || !fixture.predictions.length) continue;
    const cutoff = resolveCutoff(fixture);
    const evidenceTimes = [
      fixture?.predictionMeta?.featureSnapshot?.capturedAt,
      fixture?.probabilityModel?.generatedAt,
      fixture?.predictionMeta?.lockedAt,
      fixture?.predictionMeta?.generatedAt
    ].filter(Boolean);
    const captured = latestTimestamp(evidenceTimes);
    if (!cutoff) { exclusions.predictions.missingCutoff += 1; continue; }
    if (!captured) { exclusions.predictions.missingCapturedAt += 1; continue; }
    if (evidenceTimes.map(parseDateLike).filter(Boolean).some((time) => time.ms > cutoff.ms) || captured.ms > cutoff.ms) {
      exclusions.predictions.afterCutoff += 1;
      continue;
    }
    const hasIntegrityProof = Boolean(
      fixture?.predictionMeta?.featureSnapshotHash
      || fixture?.predictionMeta?.featureSnapshot?.hash
      || fixture?.predictionMeta?.lockedAt
    );
    if (!hasIntegrityProof || (asText(fixture?.status).toUpperCase() === "FINISHED" && !fixture?.predictionMeta?.lockedAt)) {
      exclusions.predictions.unsafeFallback += 1;
      continue;
    }
    for (const [role, item, marketType] of predictionSections(fixture)) {
      const row = predictionRowFromItem({
        source: fixture, fixture, item, role, fallbackMarketType: marketType, captured, cutoff,
        sourceKind: "match-locked-snapshot", temporalQuality: "frozen_pre_cutoff"
      });
      if (row) rows.push(row);
      else exclusions.predictions.invalidPrediction += 1;
    }
  }
  const unique = new Map(rows.map((row) => [row.prediction_id, row]));
  return [...unique.values()].sort((a, b) => `${a.prediction_captured_at}|${a.match_id}|${a.prediction_role}|${a.prediction_id}`
    .localeCompare(`${b.prediction_captured_at}|${b.match_id}|${b.prediction_role}|${b.prediction_id}`));
}

function parseHandicapLine(value) {
  const raw = asText(value).replace(/−/g, "-");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const line = Number(raw);
  return Number.isFinite(line) ? line : null;
}

function actualHadCode(scoreHome, scoreAway) {
  if (scoreHome > scoreAway) return "1";
  if (scoreHome === scoreAway) return "0";
  return "2";
}

function actualHhadCode(scoreHome, scoreAway, line) {
  if (!Number.isFinite(line)) return "";
  const adjustedHome = scoreHome + line;
  if (adjustedHome > scoreAway) return "1";
  if (adjustedHome === scoreAway) return "0";
  return "2";
}

function settleTip(prediction, scoreHome, scoreAway) {
  const pool = asText(prediction.odds_pool_code).toUpperCase();
  const market = asText(prediction.market_type).toUpperCase();
  const tip = asText(prediction.tip_code).toUpperCase();
  const total = scoreHome + scoreAway;
  const had = actualHadCode(scoreHome, scoreAway);
  const line = pool === "HHAD" ? parseHandicapLine(prediction.handicap_line) : 0;
  const hhad = pool === "HHAD" ? actualHhadCode(scoreHome, scoreAway, line) : "";
  const btts = scoreHome > 0 && scoreAway > 0 ? "GG" : "NG";
  if (pool === "HHAD" && line === null) {
    return { actualCode: "", status: "UNSETTLED", integrity: "missing_handicap_line", had, hhad: "", btts, total, line: null };
  }
  let won = null;
  let push = false;
  let actualCode = "";
  if (pool === "HAD" || pool === "HHAD") {
    actualCode = pool === "HHAD" ? hhad : had;
    won = tip === actualCode;
  } else if (market === "GOALS") {
    const thresholdMatch = tip.match(/^([OU])(\d+(?:\.\d+)?)$/);
    const plusMatch = tip.match(/^(\d+)\+$/);
    if (thresholdMatch) {
      const threshold = Number(thresholdMatch[2]);
      actualCode = total > threshold ? `O${threshold}` : total < threshold ? `U${threshold}` : `P${threshold}`;
      push = total === threshold;
      won = thresholdMatch[1] === "O" ? total > threshold : total < threshold;
    } else if (plusMatch) {
      actualCode = String(total);
      won = total >= Number(plusMatch[1]);
    } else if (/^\d+$/.test(tip)) {
      actualCode = String(total);
      won = tip === "7" ? total >= 7 : total === Number(tip);
    }
  } else if (market === "BTTS" || tip === "GG" || tip === "NG") {
    actualCode = btts;
    won = tip === btts;
  }
  if (won === null) return { actualCode, status: "UNSETTLED", integrity: "unsupported_market_or_tip", had, hhad, btts, total, line };
  return { actualCode, status: push ? "PUSH" : won ? "WON" : "LOST", integrity: "ok", had, hhad, btts, total, line };
}

function resultMatchIndex(matches) {
  const aliases = new Map();
  for (const match of matches) {
    const home = asFinite(match?.scoreHome);
    const away = asFinite(match?.scoreAway);
    if (home === null || away === null) continue;
    aliases.set(matchIdFor(match), match);
    const sourceId = sourceMatchIdFor(match);
    if (sourceId) aliases.set(sourceId, match);
  }
  return aliases;
}

function reviewIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = matchIdFor(row);
    if (id) map.set(id, row);
    const sourceId = sourceMatchIdFor(row);
    if (sourceId) map.set(sourceId, row);
  }
  return map;
}

function buildSettlementRows(inputs, predictions, exclusions) {
  const results = resultMatchIndex(inputs.matches);
  const reviews = reviewIndex(inputs.reviewRows);
  const rows = [];
  for (const prediction of predictions) {
    const match = results.get(prediction.match_id) || results.get(prediction.source_match_id);
    if (!match) { exclusions.settlements.noFinalScore += 1; continue; }
    const scoreHome = asFinite(match.scoreHome);
    const scoreAway = asFinite(match.scoreAway);
    if (scoreHome === null || scoreAway === null) { exclusions.settlements.noFinalScore += 1; continue; }
    const settlement = settleTip(prediction, scoreHome, scoreAway);
    if (settlement.integrity === "missing_handicap_line") exclusions.settlements.missingHandicapLine += 1;
    if (settlement.integrity === "unsupported_market_or_tip") exclusions.settlements.unsupported += 1;
    const odds = asFinite(prediction.selected_odds);
    const profit = settlement.status === "WON" && odds !== null ? odds - 1
      : settlement.status === "LOST" ? -1
        : settlement.status === "PUSH" ? 0 : "";
    const review = reviews.get(prediction.match_id) || reviews.get(prediction.source_match_id);
    const recorded = latestTimestamp([
      review?.generatedAt,
      match?.externalSignals?.fiveHundred?.result?.updatedAt,
      match?.finishedAt,
      match?.updatedAt
    ]);
    rows.push({
      prediction_id: prediction.prediction_id,
      match_id: prediction.match_id,
      source_match_id: prediction.source_match_id,
      settlement_recorded_at: recorded?.iso || "",
      market_type: prediction.market_type,
      odds_pool_code: prediction.odds_pool_code,
      handicap_line: settlement.line === null ? "" : prediction.handicap_line,
      tip_code: prediction.tip_code,
      actual_code: settlement.actualCode,
      result_status: settlement.status,
      score_home: scoreHome,
      score_away: scoreAway,
      total_goals: settlement.total,
      actual_had_code: settlement.had,
      actual_hhad_code: settlement.hhad,
      actual_btts_code: settlement.btts,
      selected_odds: prediction.selected_odds,
      profit_units: typeof profit === "number" ? Number(profit.toFixed(6)) : "",
      recommendation_action: prediction.recommendation_action,
      settlement_integrity: settlement.integrity,
      outcome_source: asText(match?.externalSignals?.fiveHundred?.result?.source || match?.source || "match-result"),
      data_scope: "post_match_outcome_only"
    });
  }
  return rows.sort((a, b) => a.prediction_id.localeCompare(b.prediction_id));
}

function dataDictionaryMarkdown() {
  return `# ChatGPT 足球分析包数据字典

## 阶段边界

- matches、odds_snapshots、predictions 属于赛前区，字段白名单中没有最终比分、实际赛果或命中状态。
- settlements 属于赛后区，只能在赛前完整性检查通过后通过 prediction_id 连接。
- observed_at 和 prediction_captured_at 必须小于或等于 cutoff_at；导出器已排除越界行，manifest 保留排除计数。
- cutoff_quality=explicit 表示有明确停售/锁定时间；kickoff_fallback 表示只能用开赛时间做保守回退。

## 公共标识

| 字段 | 说明 |
| --- | --- |
| match_id | 网站内部比赛键；连接四个数据集 |
| source_match_id | 上游比赛键；仅在 match_id 缺失映射时辅助连接 |
| prediction_id | 预测快照、玩法、方向和版本组成的稳定哈希；连接 predictions 与 settlements |
| cutoff_at | 允许进入赛前分析的数据截止时间，统一输出 ISO 8601 UTC |
| cutoff_source | cutoff 的原始字段来源；多个来源同一时刻时用 + 连接 |
| cutoff_quality | explicit、kickoff_fallback 或 missing |

## matches

这是赛前比赛维表。kickoff_at 为开赛时间；球队、联赛和国家字段只用于分组。data_scope 固定为 pre_match_fixture_only。此表故意不含 status、score_home、score_away 或赛果。

## odds_snapshots

| 字段 | 说明 |
| --- | --- |
| odds_snapshot_id | 赔率快照稳定哈希 |
| observed_at | 本系统真正观察到该赔率的时间；不是网页声称的历史更新时间 |
| source_updated_at | 数据源提供的更新时间；若晚于 cutoff，该行不导出 |
| pool_code | HAD=普通胜平负，HHAD=让球胜平负 |
| handicap_line | 主队让球数；HAD 固定写 0，HHAD 不得缺失后假定为 0 |
| odds_home/draw/away | 三项十进制 SP/赔率 |
| market_prob_home/draw/away | 三项 1/odds 归一化后的去水市场概率，单位 0 到 1 |
| source_kind/source_name | 安全的来源类别和名称；不包含源 URL |

## predictions

| 字段 | 说明 |
| --- | --- |
| prediction_captured_at | 预测快照被记录或冻结的时间 |
| temporal_quality | captured_pre_cutoff、frozen_pre_cutoff；带 feature_snapshot_migrated 的旧样本应单独做敏感性分析 |
| prediction_role | one_x_two、best、goals 或网站原玩法角色 |
| market_type | 预测展示角色；实际结算优先结合 odds_pool_code 判断 HAD/HHAD |
| odds_pool_code | HAD、HHAD；GOALS 等非三项玩法可为空 |
| tip_code | HAD/HHAD: 1=主、0=平、2=客；GOALS 可为 O2.5、U2.5 或整数 |
| recommendation_action | reference 为分析参考；只有正式动作才能进入正式推荐 ROI |
| model_prob_home/draw/away | 模型三项概率，单位 0 到 1；缺少完整 HHAD 概率时留空，不用 HAD 代替 |
| selected_model_probability | 所选方向模型概率，单位 0 到 1 |
| selected_market_probability | 所选方向去水市场概率，单位 0 到 1 |
| probability_edge/expected_value | 快照当时记录的概率边际和期望值 |
| evidence_score/evidence_threshold | 多因素证据分与门槛 |
| data_quality | 数据覆盖质量，单位 0 到 1 |
| risk_tags_json/blockers_json/supporting_factors_json | JSON 数组字符串；解析后再统计 |
| feature_snapshot_hash | 赛前特征快照哈希；没有值不代表可以用赛后字段补齐 |

predictions 不包含源 resultStatus；命中状态由 settlements 根据最终比分重新计算。

## settlements

| 字段 | 说明 |
| --- | --- |
| settlement_recorded_at | 本系统记录最终结果的时间；可为空 |
| actual_code | 对应预测玩法的实际代码 |
| result_status | WON、LOST、PUSH 或 UNSETTLED，由导出器重新计算 |
| score_home/score_away | 最终比分，只存在于赛后区 |
| actual_had_code | 普通赛果：1=主胜、0=平、2=客胜 |
| actual_hhad_code | 以该预测 handicap_line 计算的让球赛果 |
| profit_units | 每条预测按 1 单位投入计算：赢=赔率-1，负=-1，走盘=0；未结算为空 |
| settlement_integrity | ok、missing_handicap_line 或 unsupported_market_or_tip |
| data_scope | 固定为 post_match_outcome_only |

HHAD 规则：比较 score_home + handicap_line 与 score_away。主队 -1 且 2:1 时为让平（代码 0）；让球数缺失时必须 UNSETTLED，绝不能默认为 0。

## CSV 与分片

CSV 使用 UTF-8、逗号分隔和 RFC 4180 风格转义：含逗号、双引号或换行的值会被双引号包裹，内部双引号写成两个双引号。超限数据集由基础文件和 .part-0002.csv 等文件组成；每片都有完整表头，按 manifest 顺序纵向合并。
`;
}

function timeRange(rows, field) {
  const values = rows.map((row) => parseDateLike(row[field])).filter(Boolean).map((value) => value.ms);
  if (!values.length) return { field, min: null, max: null };
  return { field, min: new Date(Math.min(...values)).toISOString(), max: new Date(Math.max(...values)).toISOString() };
}

function managedPartRegex(baseName) {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\.part-\\d{4})?\\.csv$`);
}

function clearManagedParts(outDir, baseName) {
  if (!fs.existsSync(outDir)) return;
  const matcher = managedPartRegex(baseName);
  for (const name of fs.readdirSync(outDir)) {
    const filePath = path.join(outDir, name);
    if (matcher.test(name) && fs.statSync(filePath).isFile()) fs.rmSync(filePath);
  }
}

function csvPartName(baseName, partNumber) {
  return partNumber === 1 ? `${baseName}.csv` : `${baseName}.part-${String(partNumber).padStart(4, "0")}.csv`;
}

function writeCsvDataset({ outDir, baseName, rows, columns, maxBytes, phase, primaryTimeField }) {
  clearManagedParts(outDir, baseName);
  const header = `${columns.map(csvCell).join(",")}\n`;
  const headerBytes = Buffer.byteLength(header);
  if (headerBytes > maxBytes) throw new Error(`${baseName}.csv header exceeds configured size limit`);
  const shards = [];
  let shardRows = [];
  let shardLines = [header];
  let shardBytes = headerBytes;
  const flush = () => {
    if (!shardRows.length && shards.length > 0) return;
    shards.push({ rows: shardRows, content: shardLines.join("") });
    shardRows = [];
    shardLines = [header];
    shardBytes = headerBytes;
  };
  for (const row of rows) {
    const line = csvLine(row, columns);
    const lineBytes = Buffer.byteLength(line);
    if (headerBytes + lineBytes > maxBytes) {
      throw new Error(`${baseName} contains a single row larger than the configured CSV limit`);
    }
    if (shardRows.length > 0 && shardBytes + lineBytes > maxBytes) flush();
    shardRows.push(row);
    shardLines.push(line);
    shardBytes += lineBytes;
  }
  flush();

  const parts = shards.map((shard, index) => {
    const partNumber = index + 1;
    const name = csvPartName(baseName, partNumber);
    const filePath = path.join(outDir, name);
    fs.writeFileSync(filePath, shard.content, "utf8");
    const content = Buffer.from(shard.content, "utf8");
    return {
      name,
      dataset: baseName,
      part: partNumber,
      phase,
      rows: shard.rows.length,
      bytes: content.byteLength,
      sha256: sha256(content),
      primaryTime: timeRange(shard.rows, primaryTimeField),
      cutoffTime: timeRange(shard.rows, "cutoff_at")
    };
  });
  return {
    name: baseName,
    phase,
    rows: rows.length,
    bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
    primaryTime: timeRange(rows, primaryTimeField),
    cutoffTime: timeRange(rows, "cutoff_at"),
    parts
  };
}

function writeTextArtifact(outDir, name, content, phase = "metadata") {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  fs.writeFileSync(path.join(outDir, name), normalized, "utf8");
  const bytes = Buffer.from(normalized, "utf8");
  return { name, phase, rows: null, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function latestIso(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? new Date(Math.max(...finite)).toISOString() : null;
}

function exportPack(options) {
  const inputs = options.sqlitePath ? loadSqliteInputs(options.sqlitePath) : loadJsonInputs(options.dataDir);
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.statSync(outDir).isDirectory()) throw new Error(`Output path is not a directory: ${outDir}`);
  const exclusions = emptyExclusions();
  const fixtures = buildFixtureIndex(inputs);
  const matches = buildMatchRows(fixtures);
  const odds = buildOddsRows(inputs, fixtures, exclusions);
  const predictions = buildPredictionRows(inputs, fixtures, exclusions);
  const settlements = buildSettlementRows(inputs, predictions, exclusions);

  const datasetConfigs = [
    { baseName: "matches", rows: matches, columns: MATCH_COLUMNS, phase: "pre-match", primaryTimeField: "kickoff_at" },
    { baseName: "odds_snapshots", rows: odds, columns: ODDS_COLUMNS, phase: "pre-match", primaryTimeField: "observed_at" },
    { baseName: "predictions", rows: predictions, columns: PREDICTION_COLUMNS, phase: "pre-match", primaryTimeField: "prediction_captured_at" },
    { baseName: "settlements", rows: settlements, columns: SETTLEMENT_COLUMNS, phase: "post-match", primaryTimeField: "settlement_recorded_at" }
  ];
  const datasets = datasetConfigs.map((config) => writeCsvDataset({
    outDir,
    maxBytes: options.maxCsvBytes || DEFAULT_MAX_CSV_BYTES,
    ...config
  }));
  if (!fs.existsSync(PROMPT_SOURCE)) throw new Error(`Prompt template is missing: ${PROMPT_SOURCE}`);
  const metadataFiles = [
    writeTextArtifact(outDir, "data_dictionary.md", dataDictionaryMarkdown()),
    writeTextArtifact(outDir, "prompt.md", fs.readFileSync(PROMPT_SOURCE, "utf8"))
  ];
  const files = [...datasets.flatMap((dataset) => dataset.parts), ...metadataFiles];
  const observedTimes = [
    ...odds.map((row) => parseDateLike(row.observed_at)?.ms),
    ...predictions.map((row) => parseDateLike(row.prediction_captured_at)?.ms),
    ...settlements.map((row) => parseDateLike(row.settlement_recorded_at)?.ms)
  ].filter(Number.isFinite);
  const dataAsOf = latestIso([...inputs.sourceTimes, ...observedTimes]);
  const manifest = {
    schemaVersion: "chatgpt-football-analysis-pack-v1",
    generatedAt: dataAsOf,
    generationClock: "source-data-as-of (deterministic for identical inputs)",
    purpose: "manual historical football model audit in ChatGPT Pro",
    interactionMode: "manual-file-upload",
    inputKind: inputs.inputKind,
    maxCsvBytes: options.maxCsvBytes || DEFAULT_MAX_CSV_BYTES,
    automatedOpenAiApiCalls: false,
    chatGptSessionAccess: false,
    phaseBoundary: {
      preMatchDatasets: ["matches", "odds_snapshots", "predictions"],
      postMatchDatasets: ["settlements"],
      predictionSettlementJoinKey: "prediction_id",
      fixtureJoinKey: "match_id",
      oddsRule: "observed_at <= cutoff_at",
      predictionRule: "prediction_captured_at <= cutoff_at",
      warning: "Never use settlements as prediction features. Missing HHAD lines are never coerced to zero."
    },
    privacy: {
      fieldPolicy: "explicit allowlist",
      excludedByDefault: [
        "ChatGPT chats and exports", "browser sessions, cookies and login state", "API keys and access tokens",
        "environment files", "contact details", "source URLs and image URLs", "unselected raw JSON fields"
      ]
    },
    sourceFiles: inputs.sourceFiles.sort((a, b) => a.name.localeCompare(b.name)),
    excludedRows: exclusions,
    datasets,
    files,
    contentFingerprint: sha256(files.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => `${file.name}:${file.sha256}:${file.bytes}:${file.rows ?? ""}`).join("\n"))
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function snapshotDirectory(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    return [name, fs.statSync(filePath).isFile() ? sha256(fs.readFileSync(filePath)) : "directory"];
  }));
}

function runSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-football-pack-test-"));
  const dataDir = path.join(tempRoot, "data");
  const outDir = path.join(tempRoot, "out");
  fs.mkdirSync(dataDir, { recursive: true });
  const fixture = {
    id: "sporttery_test-1",
    sourceMatchId: "test-1",
    matchNo: "周一001",
    kickoffTime: "2026-01-01T14:00:00Z",
    businessDate: "2026-01-01",
    leagueName: "测试,联赛",
    countryName: "测试国",
    homeTeamName: "A, \"United\"\nClub",
    awayTeamName: "B队",
    source: "self-test",
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    predictionMeta: { cutoffTime: "2026-01-01T12:00:00Z" }
  };
  const oddsRows = [];
  for (let index = 0; index < 18; index += 1) {
    oddsRows.push({
      sourceMatchId: "test-1",
      capturedAt: new Date(Date.parse("2026-01-01T10:00:00Z") + index * 60_000).toISOString(),
      kickoffTime: fixture.kickoffTime,
      odds1: 1.8 + index / 100,
      oddsX: 3.2,
      odds2: 4.4,
      oddsSource: "sporttery:HAD"
    });
  }
  oddsRows.push({
    sourceMatchId: "test-1", capturedAt: "2026-01-01T13:00:00Z", kickoffTime: fixture.kickoffTime,
    odds1: 9.99, oddsX: 3.2, odds2: 4.4, oddsSource: "sporttery:HAD"
  });
  const predictionBase = {
    matchId: fixture.id,
    sourceMatchId: fixture.sourceMatchId,
    kickoffTime: fixture.kickoffTime,
    cutoffTime: "2026-01-01T12:00:00Z",
    capturedAt: "2026-01-01T11:00:00Z",
    phase: "locked",
    modelVersion: "self-test-v1",
    probabilityFinal: { home: 60, draw: 25, away: 15 },
    featureSnapshot: { migrated: true },
    featureSnapshotHash: "safe-hash",
    oneXTwo: {
      tipCode: "1", tipLabel: { zh: "缺盘让胜", en: "missing line" }, oddsPoolCode: "HHAD",
      odds: 2.1, recommendationAction: "reference"
    },
    best: {
      tipCode: "0", tipLabel: { zh: "让平", en: "HHAD draw" }, oddsPoolCode: "HHAD", handicapLine: "-1",
      odds: 3.1, recommendationAction: "formal", recommendationTier: "self-test"
    },
    goals: { tipCode: "O2.5", odds: 1.9, recommendationAction: "reference" }
  };
  const afterCutoff = JSON.parse(JSON.stringify(predictionBase));
  afterCutoff.capturedAt = "2026-01-01T13:00:00Z";
  afterCutoff.oneXTwo.tipLabel.zh = "LEAK_AFTER_CUTOFF";
  fs.writeFileSync(path.join(dataDir, "matches-current.json"), `${JSON.stringify([fixture], null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, "matches-history.json"), "[]\n");
  fs.writeFileSync(path.join(dataDir, "odds-history.json"), `${JSON.stringify({ updatedAt: "2026-01-01T13:00:00Z", rows: oddsRows }, null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, "prediction-snapshots.json"), `${JSON.stringify({ updatedAt: "2026-01-01T13:00:00Z", rows: [predictionBase, afterCutoff] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, "post-match-reviews.json"), `${JSON.stringify({ generatedAt: "2026-01-01T15:00:00Z", rows: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, "sync-meta.json"), `${JSON.stringify({ updatedAt: "2026-01-01T15:00:00Z" }, null, 2)}\n`);
  try {
    const options = { dataDir, outDir, sqlitePath: "", maxCsvBytes: 2200 };
    const first = exportPack(options);
    const firstSnapshot = snapshotDirectory(outDir);
    const second = exportPack(options);
    const secondSnapshot = snapshotDirectory(outDir);
    assert.deepEqual(secondSnapshot, firstSnapshot, "identical inputs must produce identical files");
    assert.equal(first.contentFingerprint, second.contentFingerprint);
    assert.ok(first.datasets.find((dataset) => dataset.name === "odds_snapshots").parts.length > 1, "small self-test limit must shard odds");
    for (const file of first.files.filter((item) => item.name.endsWith(".csv"))) assert.ok(file.bytes <= options.maxCsvBytes);
    const matchesCsv = fs.readFileSync(path.join(outDir, "matches.csv"), "utf8");
    assert.ok(matchesCsv.includes('"A, ""United""\nClub"'), "CSV must escape comma, quote, and newline");
    assert.ok(!MATCH_COLUMNS.includes("score_home") && !PREDICTION_COLUMNS.includes("result_status"));
    const allOdds = first.datasets.find((dataset) => dataset.name === "odds_snapshots").parts
      .map((part) => fs.readFileSync(path.join(outDir, part.name), "utf8")).join("\n");
    const allPredictions = first.datasets.find((dataset) => dataset.name === "predictions").parts
      .map((part) => fs.readFileSync(path.join(outDir, part.name), "utf8")).join("\n");
    const allSettlements = first.datasets.find((dataset) => dataset.name === "settlements").parts
      .map((part) => fs.readFileSync(path.join(outDir, part.name), "utf8")).join("\n");
    assert.ok(!allOdds.includes("9.99"), "post-cutoff odds must be excluded");
    assert.ok(!allPredictions.includes("LEAK_AFTER_CUTOFF"), "post-cutoff predictions must be excluded");
    assert.ok(allSettlements.includes("missing_handicap_line"), "missing HHAD line must not become zero");
    assert.ok(allSettlements.includes(",0,WON,2,1,"), "2:1 with -1 must settle as HHAD draw");
    assert.equal(first.excludedRows.odds.afterCutoff, 1);
    assert.equal(first.excludedRows.predictions.afterCutoff, 1);
    return { ok: true, tests: 12, datasets: Object.fromEntries(first.datasets.map((dataset) => [dataset.name, dataset.rows])) };
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir())) && path.basename(resolved).startsWith("chatgpt-football-pack-test-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (options.selfTest) { console.log(JSON.stringify(runSelfTest(), null, 2)); return; }
  if (!options.outDir) throw new Error("--out <directory> is required");
  const manifest = exportPack(options);
  console.log(JSON.stringify({
    ok: true,
    outDir: options.outDir,
    contentFingerprint: manifest.contentFingerprint,
    generatedAt: manifest.generatedAt,
    datasets: Object.fromEntries(manifest.datasets.map((dataset) => [dataset.name, { rows: dataset.rows, parts: dataset.parts.length, bytes: dataset.bytes }]))
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
