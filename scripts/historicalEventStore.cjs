"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { Readable } = require("stream");
const { StringDecoder } = require("string_decoder");

const EVENT_SCHEMA_VERSION = "historical-match-event-v1";
const MANIFEST_SCHEMA_VERSION = "historical-event-manifest-v1";
const ROOT_HASH_ALGORITHM = "sha256(sorted(sourceEventId:eventSha256))";

// License and URL values are provenance metadata supplied by the importer
// configuration. They are deliberately not inferred from downloaded content.
const DATASET_CONFIGS = Object.freeze({
  xgabora: Object.freeze({
    adapter: "xgabora",
    sourceDataset: "xgabora/Club-Football-Match-Data-2000-2025:Matches.csv",
    sourceUrl: "https://github.com/xgabora/Club-Football-Match-Data-2000-2025",
    license: "MIT",
  }),
  martj42: Object.freeze({
    adapter: "martj42",
    sourceDataset: "martj42/international_results:results.csv",
    sourceUrl: "https://github.com/martj42/international_results",
    license: "CC0",
  }),
  "football-data": Object.freeze({
    adapter: "football-data",
    sourceDataset: "football-data.co.uk:results-csv",
    sourceUrl: "https://www.football-data.co.uk/data.php",
    license: "free-for-league-match-prediction",
  }),
});

const DATASET_ALIASES = Object.freeze({
  club: "xgabora",
  international: "martj42",
  footballdata: "football-data",
  "xgabora/Club-Football-Match-Data-2000-2025:Matches.csv": "xgabora",
  "martj42/international_results:results.csv": "martj42",
  "football-data.co.uk:results-csv": "football-data",
});

// These columns are explicitly never copied into a canonical pre-match event.
// Keeping this list next to the allow-listed odds mapping makes the leakage
// boundary reviewable when either upstream CSV changes its schema.
const FORBIDDEN_POST_MATCH_FIELDS = Object.freeze([
  "homeshots",
  "awayshots",
  "hometarget",
  "awaytarget",
  "homefouls",
  "awayfouls",
  "homecorners",
  "awaycorners",
  "homeyellow",
  "awayyellow",
  "homered",
  "awayred",
  "hthome",
  "htaway",
  "htresult",
]);

class CsvParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CsvParseError";
    this.code = "CSV_PARSE_ERROR";
    Object.assign(this, details);
  }
}

class HistoricalEventConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HistoricalEventConflictError";
    this.code = "HISTORICAL_EVENT_CONFLICT";
    Object.assign(this, details);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function displayText(value) {
  return cleanText(value).replace(/\s+/g, " ");
}

function normalizeEntity(value) {
  return displayText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function uniqueNormalizedHeaders(cells, { allowCollisions = false } = {}) {
  const seen = new Map();
  return cells.map((cell) => {
    const key = normalizeHeader(cell);
    const count = Number(seen.get(key) || 0);
    seen.set(key, count + 1);
    if (!allowCollisions || count === 0) return key;
    // Football-Data uses symbols such as > and < in distinct columns. The
    // generic normalizer removes both symbols, so retain the first canonical
    // key and suffix later, unused collisions instead of rejecting the file.
    return `${key}duplicate${count + 1}`;
  });
}

function parseCsvRecord(rawRecord) {
  const raw = String(rawRecord ?? "");
  const cells = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inQuotes) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterClosingQuote) {
      if (char === ",") {
        cells.push(field);
        field = "";
        afterClosingQuote = false;
      } else if (char !== " " && char !== "\t") {
        throw new CsvParseError("unexpected character after a closing quote", { column: index + 1 });
      }
      continue;
    }

    if (char === ",") {
      cells.push(field);
      field = "";
    } else if (char === '"') {
      if (field.length !== 0) {
        throw new CsvParseError("quote found inside an unquoted field", { column: index + 1 });
      }
      inQuotes = true;
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new CsvParseError("unterminated quoted field");
  cells.push(field);
  return cells;
}

async function* iterateCsvRecords(input, { onRawChunk } = {}) {
  if (!input || typeof input[Symbol.asyncIterator] !== "function") {
    throw new TypeError("CSV input must be a Readable or another async iterable");
  }

  const decoder = new StringDecoder("utf8");
  let rawRecord = "";
  let inQuotes = false;
  let skipLineFeed = false;
  let recordNumber = 0;

  function* scan(text) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === "\n") continue;
      }

      if (char === '"') {
        // Toggling on every quote is intentional: an escaped pair toggles
        // twice and therefore cannot accidentally terminate a CSV record.
        inQuotes = !inQuotes;
        rawRecord += char;
        continue;
      }

      if (!inQuotes && (char === "\r" || char === "\n")) {
        recordNumber += 1;
        yield { rawRecord, recordNumber };
        rawRecord = "";
        if (char === "\r") skipLineFeed = true;
        continue;
      }

      rawRecord += char;
    }
  }

  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(String(chunkValue), "utf8");
    if (typeof onRawChunk === "function") onRawChunk(chunk);
    yield* scan(decoder.write(chunk));
  }

  yield* scan(decoder.end());
  if (inQuotes) {
    throw new CsvParseError("CSV ended inside a quoted field", { recordNumber: recordNumber + 1 });
  }
  if (rawRecord.length > 0) {
    recordNumber += 1;
    yield { rawRecord, recordNumber };
  }
}

function canonicalDate(rawValue) {
  const value = cleanText(rawValue);
  if (!value) return null;

  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (!match) match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return null;

  const year = Number(match[1].length === 4 ? match[1] : match[3]);
  const month = Number(match[1].length === 4 ? match[2] : match[2]);
  const day = Number(match[1].length === 4 ? match[3] : match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localTime(rawValue) {
  const value = cleanText(rawValue);
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function canonicalKickoff(dateRaw, timeRaw, timezoneOffset) {
  const date = canonicalDate(dateRaw);
  if (!date) return { date: null, kickoff: null, kickoffLocalTime: null };

  const dateText = cleanText(dateRaw);
  if (/^\d{4}-\d{2}-\d{2}[T\s].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateText)) {
    const parsed = Date.parse(dateText.replace(" ", "T"));
    if (Number.isFinite(parsed)) {
      return { date, kickoff: new Date(parsed).toISOString(), kickoffLocalTime: null };
    }
  }

  const rawTime = cleanText(timeRaw);
  const normalizedLocalTime = localTime(rawTime);
  if (!normalizedLocalTime) return { date, kickoff: null, kickoffLocalTime: null };

  const explicitZone = rawTime.match(/(Z|[+-]\d{2}:?\d{2})$/i)?.[1] || null;
  const configuredZone = cleanText(timezoneOffset);
  const zone = explicitZone || (/^(Z|[+-]\d{2}:?\d{2})$/i.test(configuredZone) ? configuredZone : null);
  if (!zone) return { date, kickoff: null, kickoffLocalTime: normalizedLocalTime };

  const normalizedZone = /^z$/i.test(zone)
    ? "Z"
    : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = Date.parse(`${date}T${normalizedLocalTime}${normalizedZone}`);
  return {
    date,
    kickoff: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    kickoffLocalTime: normalizedLocalTime,
  };
}

function nonNegativeInteger(rawValue) {
  const value = cleanText(rawValue);
  if (!/^\d+(?:\.0+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveNumber(rawValue) {
  const value = cleanText(rawValue);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nullableBoolean(rawValue) {
  const value = cleanText(rawValue).toLowerCase();
  if (!value) return null;
  if (["true", "1", "yes", "y"].includes(value)) return true;
  if (["false", "0", "no", "n"].includes(value)) return false;
  return undefined;
}

function rowObject(header, cells) {
  if (cells.length !== header.length) {
    throw new CsvParseError(`column count mismatch: expected ${header.length}, received ${cells.length}`);
  }
  return Object.fromEntries(header.map((key, index) => [key, cells[index]]));
}

function oddsFromXgabora(record) {
  const mappings = [
    ["home", "oddhome"],
    ["draw", "odddraw"],
    ["away", "oddaway"],
    ["over25", "over25"],
    ["under25", "under25"],
  ];
  const odds = {};
  for (const [target, source] of mappings) {
    if (!Object.prototype.hasOwnProperty.call(record, source)) continue;
    const value = positiveNumber(record[source]);
    if (value !== null) odds[target] = value;
  }
  return Object.keys(odds).length > 0 ? odds : null;
}

function firstPositive(record, fields) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = positiveNumber(record[field]);
    if (value !== null) return value;
  }
  return null;
}

function oddsFromFootballData(record) {
  // Prefer closing market averages, then Pinnacle/market closing prices, and
  // finally the opening averages. This is historical research evidence only;
  // the values never replace official Sporttery SP in the live publication.
  const home = firstPositive(record, ["avgch", "psch", "maxch", "b365ch", "avgh", "psh", "maxh", "b365h"]);
  const draw = firstPositive(record, ["avgcd", "pscd", "maxcd", "b365cd", "avgd", "psd", "maxd", "b365d"]);
  const away = firstPositive(record, ["avgca", "psca", "maxca", "b365ca", "avga", "psa", "maxa", "b365a"]);
  return home !== null && draw !== null && away !== null ? { home, draw, away } : null;
}

function baseEvent({
  config,
  competition,
  date,
  kickoff,
  kickoffLocalTime,
  homeTeamRaw,
  awayTeamRaw,
  scoreHome,
  scoreAway,
  neutral,
  preMatchOdds,
  sourceRowNumber,
  rawRowSha256,
}) {
  const homeTeamNormalized = normalizeEntity(homeTeamRaw);
  const awayTeamNormalized = normalizeEntity(awayTeamRaw);
  if (!homeTeamNormalized || !awayTeamNormalized) {
    throw Object.assign(new Error("home and away team names must normalize to non-empty values"), {
      code: "INVALID_TEAM_NAME",
    });
  }

  const identity = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceDataset: config.sourceDataset,
    competition: normalizeEntity(competition || "unknown"),
    date,
    kickoff: kickoff || null,
    kickoffLocalTime: kickoffLocalTime || null,
    homeTeamNormalized,
    awayTeamNormalized,
  };
  const sourceEventId = sha256(stableStringify(identity));
  const event = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceEventId,
    sourceDataset: config.sourceDataset,
    competition: displayText(competition) || "Unknown",
    date,
    kickoff: kickoff || null,
    kickoffLocalTime: kickoffLocalTime || null,
    homeTeamRaw: cleanText(homeTeamRaw),
    homeTeamNormalized,
    awayTeamRaw: cleanText(awayTeamRaw),
    awayTeamNormalized,
    score: { home: scoreHome, away: scoreAway },
    neutral,
    sourceRowNumber,
    rawRowSha256,
  };
  if (preMatchOdds) event.preMatchOdds = preMatchOdds;

  const semanticEvent = { ...event };
  delete semanticEvent.sourceRowNumber;
  delete semanticEvent.rawRowSha256;
  event.eventSha256 = sha256(stableStringify(semanticEvent));
  return event;
}

function adaptXgabora(record, context) {
  const { date, kickoff, kickoffLocalTime } = canonicalKickoff(
    record.matchdate,
    record.matchtime,
    context.timezoneOffset,
  );
  if (!date) throw Object.assign(new Error("missing or invalid match date"), { code: "INVALID_DATE" });

  const homeTeamRaw = cleanText(record.hometeam);
  const awayTeamRaw = cleanText(record.awayteam);
  if (!homeTeamRaw || !awayTeamRaw) {
    throw Object.assign(new Error("missing home or away team"), { code: "INVALID_TEAM_NAME" });
  }

  const scoreHome = nonNegativeInteger(record.fthome);
  const scoreAway = nonNegativeInteger(record.ftaway);
  if (scoreHome === null || scoreAway === null) {
    throw Object.assign(new Error("full-time scores must be non-negative integers"), { code: "INVALID_SCORE" });
  }

  return baseEvent({
    ...context,
    competition: record.division || "Unknown",
    date,
    kickoff,
    kickoffLocalTime,
    homeTeamRaw,
    awayTeamRaw,
    scoreHome,
    scoreAway,
    neutral: null,
    preMatchOdds: oddsFromXgabora(record),
  });
}

function adaptMartj42(record, context) {
  const { date, kickoff } = canonicalKickoff(record.date, null, null);
  if (!date) throw Object.assign(new Error("missing or invalid match date"), { code: "INVALID_DATE" });

  const homeTeamRaw = cleanText(record.hometeam);
  const awayTeamRaw = cleanText(record.awayteam);
  if (!homeTeamRaw || !awayTeamRaw) {
    throw Object.assign(new Error("missing home or away team"), { code: "INVALID_TEAM_NAME" });
  }

  const scoreHome = nonNegativeInteger(record.homescore);
  const scoreAway = nonNegativeInteger(record.awayscore);
  if (scoreHome === null || scoreAway === null) {
    throw Object.assign(new Error("full-time scores must be non-negative integers"), { code: "INVALID_SCORE" });
  }

  const neutral = nullableBoolean(record.neutral);
  if (neutral === undefined) {
    throw Object.assign(new Error("neutral must be a boolean when supplied"), { code: "INVALID_NEUTRAL" });
  }

  return baseEvent({
    ...context,
    competition: record.tournament || "International",
    date,
    kickoff,
    kickoffLocalTime: null,
    homeTeamRaw,
    awayTeamRaw,
    scoreHome,
    scoreAway,
    neutral,
    preMatchOdds: null,
  });
}

function adaptFootballData(record, context) {
  const { date, kickoff, kickoffLocalTime } = canonicalKickoff(
    record.date,
    record.time,
    context.timezoneOffset,
  );
  if (!date) throw Object.assign(new Error("missing or invalid match date"), { code: "INVALID_DATE" });

  const homeTeamRaw = cleanText(record.hometeam || record.home);
  const awayTeamRaw = cleanText(record.awayteam || record.away);
  if (!homeTeamRaw || !awayTeamRaw) {
    throw Object.assign(new Error("missing home or away team"), { code: "INVALID_TEAM_NAME" });
  }

  const scoreHome = nonNegativeInteger(record.fthg ?? record.hg);
  const scoreAway = nonNegativeInteger(record.ftag ?? record.ag);
  if (scoreHome === null || scoreAway === null) {
    throw Object.assign(new Error("full-time scores must be non-negative integers"), { code: "INVALID_SCORE" });
  }

  const competition = cleanText(record.div || record.league || record.country) || "Unknown";
  return baseEvent({
    ...context,
    competition,
    date,
    kickoff,
    kickoffLocalTime,
    homeTeamRaw,
    awayTeamRaw,
    scoreHome,
    scoreAway,
    neutral: null,
    preMatchOdds: oddsFromFootballData(record),
  });
}

const ADAPTERS = Object.freeze({
  xgabora: adaptXgabora,
  martj42: adaptMartj42,
  "football-data": adaptFootballData,
});
const REQUIRED_HEADERS = Object.freeze({
  xgabora: Object.freeze(["matchdate", "hometeam", "awayteam", "fthome", "ftaway"]),
  martj42: Object.freeze(["date", "hometeam", "awayteam", "homescore", "awayscore"]),
  // Football-Data has two official CSV layouts. Required-field validation is
  // therefore performed by the adapter, while the date column remains common.
  "football-data": Object.freeze(["date"]),
});

function resolveDataset(dataset) {
  if (dataset && typeof dataset === "object") {
    const adapter = cleanText(dataset.adapter);
    if (!ADAPTERS[adapter]) throw new TypeError(`unsupported historical dataset adapter: ${adapter || "(empty)"}`);
    for (const field of ["sourceDataset", "sourceUrl", "license"]) {
      if (!cleanText(dataset[field])) throw new TypeError(`dataset configuration requires ${field}`);
    }
    return Object.freeze({ ...dataset, adapter });
  }

  const requested = cleanText(dataset) || "";
  const key = DATASET_CONFIGS[requested] ? requested : DATASET_ALIASES[requested];
  if (!key || !DATASET_CONFIGS[key]) {
    throw new TypeError(`unsupported historical dataset: ${requested || "(empty)"}`);
  }
  return DATASET_CONFIGS[key];
}

function sourceInput(options) {
  if (options.input !== undefined && options.filePath) {
    throw new TypeError("provide either input or filePath, not both");
  }
  if (options.filePath) return fs.createReadStream(options.filePath);
  if (typeof options.input === "string" || Buffer.isBuffer(options.input)) {
    return Readable.from([options.input]);
  }
  if (options.input && typeof options.input[Symbol.asyncIterator] === "function") return options.input;
  throw new TypeError("historical event import requires filePath or async-iterable input");
}

function rootHash(leaves) {
  const hasher = crypto.createHash("sha256");
  hasher.update(`${EVENT_SCHEMA_VERSION}\0`);
  for (const leaf of [...leaves].sort()) hasher.update(`${leaf}\n`);
  return hasher.digest("hex");
}

function buildManifest(config, state, sourceFileSha256, options = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    createdAt: options.createdAt || new Date().toISOString(),
    sourceDataset: config.sourceDataset,
    sourceUrl: config.sourceUrl,
    license: config.license,
    sourceFileSha256,
    rows: state.accepted,
    inputRows: state.inputRows,
    duplicateRows: state.duplicates,
    rejected: state.rejected,
    conflicts: state.conflicts,
    dateRange: {
      from: state.firstDate || null,
      to: state.lastDate || null,
    },
    rootHash: rootHash(state.leaves),
    rootHashAlgorithm: ROOT_HASH_ALGORITHM,
  };
}

async function* iterateHistoricalEvents(options = {}) {
  const config = resolveDataset(options.dataset);
  const adapter = ADAPTERS[config.adapter];
  const fileHasher = crypto.createHash("sha256");
  const seen = new Map();
  const state = {
    inputRows: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    conflicts: 0,
    firstDate: "",
    lastDate: "",
    leaves: [],
  };
  let header = null;

  for await (const csvRecord of iterateCsvRecords(sourceInput(options), {
    onRawChunk: (chunk) => fileHasher.update(chunk),
  })) {
    if (!csvRecord.rawRecord.trim()) continue;
    let cells;
    try {
      cells = parseCsvRecord(csvRecord.rawRecord);
    } catch (error) {
      if (!header) throw error;
      state.inputRows += 1;
      state.rejected += 1;
      if (typeof options.onRejected === "function") {
        await options.onRejected({
          sourceRowNumber: csvRecord.recordNumber,
          reason: error.code || "CSV_PARSE_ERROR",
          message: error.message,
          rawRowSha256: sha256(Buffer.from(csvRecord.rawRecord, "utf8")),
        });
      }
      continue;
    }

    if (!header) {
      header = uniqueNormalizedHeaders(cells, { allowCollisions: config.adapter === "football-data" });
      if (header.some((key) => !key)) throw new CsvParseError("CSV header contains an empty column name");
      if (new Set(header).size !== header.length) throw new CsvParseError("CSV header contains duplicate normalized names");
      const missing = REQUIRED_HEADERS[config.adapter].filter((field) => !header.includes(field));
      if (missing.length > 0) {
        throw new CsvParseError(`CSV header is missing required columns: ${missing.join(", ")}`);
      }
      continue;
    }

    state.inputRows += 1;
    const rawRowSha256 = sha256(Buffer.from(csvRecord.rawRecord, "utf8"));
    let event;
    try {
      const record = rowObject(header, cells);
      event = adapter(record, {
        config,
        sourceRowNumber: csvRecord.recordNumber,
        rawRowSha256,
        timezoneOffset: options.timezoneOffset,
      });
    } catch (error) {
      state.rejected += 1;
      if (typeof options.onRejected === "function") {
        await options.onRejected({
          sourceRowNumber: csvRecord.recordNumber,
          reason: error.code || "INVALID_ROW",
          message: error.message,
          rawRowSha256,
        });
      }
      continue;
    }

    const prior = seen.get(event.sourceEventId);
    if (prior) {
      if (prior.eventSha256 === event.eventSha256) {
        state.duplicates += 1;
        if (typeof options.onDuplicate === "function") await options.onDuplicate(event, prior);
        continue;
      }

      state.conflicts += 1;
      const conflict = {
        sourceEventId: event.sourceEventId,
        firstSourceRowNumber: prior.sourceRowNumber,
        conflictingSourceRowNumber: event.sourceRowNumber,
        firstEventSha256: prior.eventSha256,
        conflictingEventSha256: event.eventSha256,
      };
      if (typeof options.onConflict === "function") await options.onConflict(conflict);
      throw new HistoricalEventConflictError(
        `conflicting historical rows share sourceEventId ${event.sourceEventId}`,
        {
          conflict,
          partialManifest: buildManifest(config, state, null, options),
        },
      );
    }

    // Global key state is required for strict deduplication/conflict detection,
    // but canonical event objects themselves are not retained. This keeps the
    // importer streaming even for the 43 MB club CSV.
    seen.set(event.sourceEventId, {
      eventSha256: event.eventSha256,
      sourceRowNumber: event.sourceRowNumber,
      rawRowSha256: event.rawRowSha256,
    });
    state.accepted += 1;
    state.leaves.push(`${event.sourceEventId}:${event.eventSha256}`);
    if (!state.firstDate || event.date < state.firstDate) state.firstDate = event.date;
    if (!state.lastDate || event.date > state.lastDate) state.lastDate = event.date;
    yield event;
  }

  if (!header) throw new CsvParseError("CSV input does not contain a header row");
  return buildManifest(config, state, fileHasher.digest("hex"), options);
}

async function importHistoricalEvents(options = {}) {
  if (typeof options.onEvent !== "function") {
    throw new TypeError("callback import requires an onEvent(event) function");
  }
  const iterator = iterateHistoricalEvents(options);
  try {
    while (true) {
      const step = await iterator.next();
      if (step.done) return step.value;
      await options.onEvent(step.value);
    }
  } catch (error) {
    if (typeof iterator.return === "function") await iterator.return();
    throw error;
  }
}

function asOf(events, forecastTime) {
  const forecastMs = forecastTime instanceof Date ? forecastTime.getTime() : Date.parse(forecastTime);
  if (!Number.isFinite(forecastMs)) throw new TypeError("forecastTime must be a valid timestamp");
  if (!events || typeof events[Symbol.iterator] !== "function") {
    throw new TypeError("events must be an iterable");
  }

  const forecastDate = new Date(forecastMs).toISOString().slice(0, 10);
  return Array.from(events).filter((event) => {
    if (event?.kickoff) {
      const kickoffMs = Date.parse(event.kickoff);
      return Number.isFinite(kickoffMs) && kickoffMs < forecastMs;
    }
    // A date-only result has no trustworthy intra-day availability time.
    // Excluding the entire forecast date is the conservative no-leak policy.
    return typeof event?.date === "string" && event.date < forecastDate;
  });
}

module.exports = {
  DATASET_CONFIGS,
  EVENT_SCHEMA_VERSION,
  FORBIDDEN_POST_MATCH_FIELDS,
  HistoricalEventConflictError,
  MANIFEST_SCHEMA_VERSION,
  ROOT_HASH_ALGORITHM,
  CsvParseError,
  asOf,
  canonicalDate,
  importHistoricalEvents,
  iterateCsvRecords,
  iterateHistoricalEvents,
  normalizeEntity,
  parseCsvRecord,
  sha256,
  stableStringify,
};
