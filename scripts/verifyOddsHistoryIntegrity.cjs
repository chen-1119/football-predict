const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadOddsHistory } = require("./oddsHistoryStore.cjs");
const {
  ODDS_OBSERVATION_TRAIL_VERSION,
  oddsObservationTrailForRow,
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_FILE = path.join(PROJECT_ROOT, "public", "data", "odds-history.json");
const REQUIRED_POOLS = ["HAD", "HHAD"];

const parseTimestamp = (value) => {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)
    ? `${text.replace(" ", "T")}${text.length === 16 ? ":00" : ""}+08:00`
    : text;
  return Date.parse(normalized);
};

const parseHandicapLine = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-");
  const match = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) ? (line === 0 ? 0 : line) : null;
};

const formatHandicapLine = (value) => {
  const line = parseHandicapLine(value);
  if (line === null) return null;
  if (line === 0) return "0";
  const absolute = Math.abs(line);
  const text = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(2).replace(/\.?0+$/, "");
  return `${line > 0 ? "+" : "-"}${text}`;
};

const normalizedPool = (row) => String(row?.poolCode || "").trim().toUpperCase();

const normalizedOdds = (row) => {
  const odds = [Number(row?.odds1), Number(row?.oddsX), Number(row?.odds2)];
  return odds.every((value) => Number.isFinite(value) && value > 1.01) ? odds : null;
};

const expectedStateSignature = (row) => {
  const pool = normalizedPool(row);
  const odds = normalizedOdds(row);
  if (!REQUIRED_POOLS.includes(pool) || !odds) return null;
  const line = parseHandicapLine(row?.handicapLine);
  if (line === null || (pool === "HAD" && line !== 0)) return null;
  return [
    pool,
    formatHandicapLine(line),
    ...odds.map((value) => value.toFixed(3)),
  ].join("|");
};

const temporalLimit = (row) => {
  const cutoffMs = parseTimestamp(row?.cutoffTime);
  const kickoffMs = parseTimestamp(row?.kickoffTime);
  const limits = [cutoffMs, kickoffMs].filter(Number.isFinite);
  return limits.length ? Math.min(...limits) : NaN;
};

const rowIsPreMatch = (row) => {
  const capturedMs = parseTimestamp(row?.capturedAt);
  const limitMs = temporalLimit(row);
  return Number.isFinite(capturedMs) && Number.isFinite(limitMs) && capturedMs <= limitMs;
};

const issue = (code, message, rowIndex = null) => ({ code, message, rowIndex });

function validateOddsHistory(payload, options = {}) {
  const requireBothPools = options.requireBothPools !== false;
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      errors: [issue("payload-invalid", "Payload must be a JSON object.")],
      summary: { rows: 0, byPool: {} },
    };
  }

  if (Number(payload.version) !== 3) {
    errors.push(issue(
      "version-not-v3",
      `version must be 3; found ${String(payload.version ?? "missing")}. Run the next sync to migrate, or use --self-test for fixture-only verification.`,
    ));
  }
  if (payload.source !== "sporttery:HAD+HHAD") {
    errors.push(issue("source-incomplete", "source must be sporttery:HAD+HHAD."));
  }
  if (payload.writePolicy !== "pre-cutoff-state-change-plus-official-receipt-trail") {
    errors.push(issue(
      "write-policy-invalid",
      "writePolicy must be pre-cutoff-state-change-plus-official-receipt-trail.",
    ));
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!Array.isArray(payload.rows)) errors.push(issue("rows-invalid", "rows must be an array."));
  const seenStates = new Map();
  const byPool = {};

  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(issue("row-invalid", "row must be an object.", rowIndex));
      return;
    }
    const matchId = String(row.sourceMatchId || "").trim();
    if (!matchId) errors.push(issue("match-id-missing", "sourceMatchId is required.", rowIndex));

    const pool = normalizedPool(row);
    if (!REQUIRED_POOLS.includes(pool)) {
      errors.push(issue("pool-invalid", `poolCode must be HAD or HHAD; found ${String(row.poolCode ?? "missing")}.`, rowIndex));
    } else {
      byPool[pool] = (byPool[pool] || 0) + 1;
    }

    const hasLine = row.handicapLine !== null
      && row.handicapLine !== undefined
      && String(row.handicapLine).trim() !== "";
    const line = parseHandicapLine(row.handicapLine);
    if (pool === "HHAD" && (!hasLine || line === null)) {
      errors.push(issue("hhad-line-missing", "HHAD rows require an explicit valid handicapLine.", rowIndex));
    }
    if (pool === "HAD" && (!hasLine || line !== 0)) {
      errors.push(issue("had-line-not-zero", "HAD rows must carry handicapLine 0.", rowIndex));
    }

    const odds = normalizedOdds(row);
    if (!odds) errors.push(issue("odds-invalid", "odds1, oddsX and odds2 must all be finite and greater than 1.01.", rowIndex));

    const signature = expectedStateSignature(row);
    if (!signature || row.stateSignature !== signature) {
      errors.push(issue(
        "state-signature-incomplete",
        `stateSignature must exactly encode pool, line and three odds; expected ${signature || "a valid canonical signature"}.`,
        rowIndex,
      ));
    }

    const capturedMs = parseTimestamp(row.capturedAt);
    const cutoffMs = parseTimestamp(row.cutoffTime);
    const kickoffMs = parseTimestamp(row.kickoffTime);
    if (!Number.isFinite(capturedMs)) errors.push(issue("captured-at-invalid", "capturedAt must be a valid timestamp.", rowIndex));
    if (!Number.isFinite(cutoffMs) && !Number.isFinite(kickoffMs)) {
      errors.push(issue("boundary-invalid", "At least one valid cutoffTime or kickoffTime is required.", rowIndex));
    }
    if (Number.isFinite(capturedMs) && Number.isFinite(cutoffMs) && capturedMs > cutoffMs) {
      errors.push(issue("post-cutoff-row", "capturedAt is later than cutoffTime.", rowIndex));
    }
    if (Number.isFinite(capturedMs) && Number.isFinite(kickoffMs) && capturedMs > kickoffMs) {
      errors.push(issue("post-kickoff-row", "capturedAt is later than kickoffTime.", rowIndex));
    }

    const firstSeenMs = parseTimestamp(row.firstSeenAt);
    const lastSeenMs = parseTimestamp(row.lastSeenAt);
    if (!Number.isFinite(firstSeenMs)) errors.push(issue("first-seen-invalid", "firstSeenAt must be a valid timestamp.", rowIndex));
    if (!Number.isFinite(lastSeenMs)) errors.push(issue("last-seen-invalid", "lastSeenAt must be a valid timestamp.", rowIndex));
    if (Number.isFinite(capturedMs) && Number.isFinite(firstSeenMs) && capturedMs !== firstSeenMs) {
      errors.push(issue("first-seen-mismatch", "capturedAt and firstSeenAt must identify the first observation.", rowIndex));
    }
    if (Number.isFinite(firstSeenMs) && Number.isFinite(lastSeenMs) && firstSeenMs > lastSeenMs) {
      errors.push(issue("seen-order-invalid", "firstSeenAt cannot be later than lastSeenAt.", rowIndex));
    }
    const limitMs = temporalLimit(row);
    if (Number.isFinite(lastSeenMs) && Number.isFinite(limitMs) && lastSeenMs > limitMs) {
      errors.push(issue("post-cutoff-last-seen", "lastSeenAt cannot extend past cutoff or kickoff.", rowIndex));
    }
    if (!Number.isInteger(Number(row.seenCount)) || Number(row.seenCount) < 1) {
      errors.push(issue("seen-count-invalid", "seenCount must be a positive integer.", rowIndex));
    }

    const rawObservationTrail = Array.isArray(row.observationTrail) ? row.observationTrail : [];
    const observationTrail = oddsObservationTrailForRow(row);
    if (row.observationTrailVersion !== ODDS_OBSERVATION_TRAIL_VERSION) {
      errors.push(issue(
        "observation-trail-version-invalid",
        `observationTrailVersion must be ${ODDS_OBSERVATION_TRAIL_VERSION}.`,
        rowIndex,
      ));
    }
    if (!Array.isArray(row.observationTrail)) {
      errors.push(issue("observation-trail-invalid", "observationTrail must be an array.", rowIndex));
    } else if (rawObservationTrail.length !== observationTrail.length) {
      errors.push(issue(
        "observation-trail-untrusted",
        "Every stored observation must be an independently received, pre-cutoff official Sporttery response.",
        rowIndex,
      ));
    }
    if (Number(row.observationCount) !== observationTrail.length) {
      errors.push(issue(
        "observation-count-mismatch",
        "observationCount must equal the normalized official observation trail length.",
        rowIndex,
      ));
    }
    if ((row.firstObservationAt || null) !== (observationTrail[0]?.availableAt || null)) {
      errors.push(issue("first-observation-mismatch", "firstObservationAt must match the first official receipt.", rowIndex));
    }
    if ((row.lastObservationAt || null) !== (observationTrail.at(-1)?.availableAt || null)) {
      errors.push(issue("last-observation-mismatch", "lastObservationAt must match the last official receipt.", rowIndex));
    }

    if (matchId && signature) {
      const stateKey = `${matchId}|${signature}`;
      if (seenStates.has(stateKey)) {
        errors.push(issue(
          "duplicate-state",
          `Duplicate match/pool/line/odds state; first row is ${seenStates.get(stateKey)}.`,
          rowIndex,
        ));
      } else {
        seenStates.set(stateKey, rowIndex);
      }
    }
  });

  if (requireBothPools) {
    for (const pool of REQUIRED_POOLS) {
      if (!byPool[pool]) errors.push(issue("pool-coverage-missing", `No ${pool} rows were found.`));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      rows: rows.length,
      uniqueStates: seenStates.size,
      byPool,
      officialObservations: rows.reduce(
        (sum, row) => sum + Number(row?.observationCount || 0),
        0,
      ),
      multiObservationStates: rows.filter((row) => Number(row?.observationCount || 0) > 1).length,
    },
  };
}

function compressStateRows(rows) {
  const byState = new Map();
  const rejected = [];
  for (const [rowIndex, row] of rows.entries()) {
    const matchId = String(row?.sourceMatchId || "").trim();
    const signature = expectedStateSignature(row);
    if (!matchId || !signature || !rowIsPreMatch(row)) {
      rejected.push({ rowIndex, row });
      continue;
    }
    const key = `${matchId}|${signature}`;
    const normalized = withOddsObservationTrail({
      ...row,
      poolCode: normalizedPool(row),
      handicapLine: formatHandicapLine(row.handicapLine),
      stateSignature: signature,
      firstSeenAt: row.firstSeenAt || row.capturedAt,
      lastSeenAt: row.lastSeenAt || row.capturedAt,
      seenCount: Math.max(1, Number(row.seenCount || 1)),
    });
    const existing = byState.get(key);
    if (!existing) {
      byState.set(key, normalized);
      continue;
    }
    const earlier = (left, right) => parseTimestamp(left) <= parseTimestamp(right) ? left : right;
    const later = (left, right) => parseTimestamp(left) >= parseTimestamp(right) ? left : right;
    byState.set(key, withOddsObservationTrail({
      ...existing,
      capturedAt: earlier(existing.capturedAt, normalized.capturedAt),
      firstSeenAt: earlier(existing.firstSeenAt, normalized.firstSeenAt),
      lastSeenAt: later(existing.lastSeenAt, normalized.lastSeenAt),
      seenCount: Number(existing.seenCount || 1) + Number(normalized.seenCount || 1),
    }, [normalized]));
  }
  return { rows: Array.from(byState.values()), rejected };
}

function fixtureRow(overrides = {}) {
  const row = {
    capturedAt: "2026-07-11T09:00:00.000Z",
    firstSeenAt: "2026-07-11T09:00:00.000Z",
    lastSeenAt: "2026-07-11T09:00:00.000Z",
    seenCount: 1,
    sourceMatchId: "fixture-match",
    kickoffTime: "2026-07-11T19:00:00+08:00",
    cutoffTime: "2026-07-11 18:00:00",
    poolCode: "HAD",
    handicapLine: 0,
    odds1: 2.1,
    oddsX: 3.2,
    odds2: 3.4,
    oddsSource: "sporttery:HAD",
    oddsSourceMethod: "current",
    oddsSourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry",
    sourceCycleId: "fixture-cycle",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "oddsReceivedAt")) {
    row.oddsReceivedAt = row.capturedAt;
  }
  if (row.poolCode === "HHAD" && !Object.prototype.hasOwnProperty.call(overrides, "oddsSource")) {
    row.oddsSource = "sporttery:HHAD";
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "stateSignature")) {
    row.stateSignature = expectedStateSignature(row);
  }
  return withOddsObservationTrail(row);
}

function fixturePayload(rows) {
  return {
    version: 3,
    source: "sporttery:HAD+HHAD",
    writePolicy: "pre-cutoff-state-change-plus-official-receipt-trail",
    rows,
  };
}

function runSelfTest() {
  let checks = 0;
  const check = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
  };
  const equal = (actual, expected, message) => {
    assert.equal(actual, expected, message);
    checks += 1;
  };

  const had = fixtureRow();
  const hhad = fixtureRow({
    poolCode: "HHAD",
    handicapLine: "-1",
    odds1: 2.85,
    oddsX: 3.35,
    odds2: 2.08,
  });
  const valid = validateOddsHistory(fixturePayload([had, hhad]));
  equal(valid.ok, true, "valid HAD+HHAD fixture must pass");
  equal(valid.summary.byPool.HAD, 1, "HAD fixture must be counted");
  equal(valid.summary.byPool.HHAD, 1, "HHAD fixture must be counted");
  equal(hhad.stateSignature, "HHAD|-1|2.850|3.350|2.080", "HHAD signature must include its line");

  const postMatch = fixtureRow({
    capturedAt: "2026-07-11T12:00:00.000Z",
    firstSeenAt: "2026-07-11T12:00:00.000Z",
    lastSeenAt: "2026-07-11T12:00:00.000Z",
  });
  const postResult = validateOddsHistory(fixturePayload([postMatch]), { requireBothPools: false });
  equal(postResult.ok, false, "post-match fixture must be rejected");
  check(postResult.errors.some((entry) => entry.code === "post-cutoff-row"), "post-cutoff reason must be reported");
  check(postResult.errors.some((entry) => entry.code === "post-kickoff-row"), "post-kickoff reason must be reported");
  equal(compressStateRows([postMatch]).rejected.length, 1, "compression must drop post-match rows");

  const repeated = fixtureRow({
    capturedAt: "2026-07-11T09:10:00.000Z",
    firstSeenAt: "2026-07-11T09:10:00.000Z",
    lastSeenAt: "2026-07-11T09:10:00.000Z",
    sourceCycleId: "fixture-cycle-2",
  });
  const duplicateResult = validateOddsHistory(fixturePayload([had, repeated]), { requireBothPools: false });
  check(duplicateResult.errors.some((entry) => entry.code === "duplicate-state"), "uncompressed duplicate state must be rejected");
  const compressed = compressStateRows([had, repeated]);
  equal(compressed.rows.length, 1, "same state must compress to one row");
  equal(compressed.rows[0].capturedAt, had.capturedAt, "compressed state keeps earliest capturedAt");
  equal(compressed.rows[0].firstSeenAt, had.firstSeenAt, "compressed state keeps earliest firstSeenAt");
  equal(compressed.rows[0].lastSeenAt, repeated.lastSeenAt, "compressed state keeps latest lastSeenAt");
  equal(compressed.rows[0].seenCount, 2, "compressed state accumulates seenCount");
  equal(compressed.rows[0].observationCount, 2, "compressed state retains two independent official receipts");
  equal(
    validateOddsHistory(fixturePayload([compressed.rows[0], hhad])).ok,
    true,
    "compressed state remains a valid v3 payload",
  );

  const missingLine = fixtureRow({ poolCode: "HHAD", handicapLine: undefined, stateSignature: null });
  const missingLineResult = validateOddsHistory(fixturePayload([missingLine]), { requireBothPools: false });
  equal(missingLineResult.ok, false, "HHAD without a line must fail");
  check(missingLineResult.errors.some((entry) => entry.code === "hhad-line-missing"), "missing HHAD line reason must be reported");
  equal(compressStateRows([missingLine]).rejected.length, 1, "compression must reject HHAD without a line");

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-odds-history-store-"));
  try {
    const publicDir = path.join(storeRoot, "public");
    const dataDir = path.join(publicDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "odds-history.json"),
      `${JSON.stringify({ ...fixturePayload([had]), updatedAt: "2026-07-11T08:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dataDir, "odds-history.json"),
      `${JSON.stringify({ ...fixturePayload([had, hhad]), updatedAt: "2026-07-11T09:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );

    const firstCanonicalRead = loadOddsHistory(publicDir);
    equal(firstCanonicalRead.rows.length, 2, "canonical public/data history must survive when legacy root payload is stripped");
    equal(firstCanonicalRead.rows[0].stateSignature, had.stateSignature, "canonical history must win over an empty legacy payload");

    const secondRoundHad = {
      ...had,
      lastSeenAt: "2026-07-11T09:10:00.000Z",
      seenCount: 2,
    };
    fs.writeFileSync(
      path.join(dataDir, "odds-history.json"),
      `${JSON.stringify({ ...fixturePayload([secondRoundHad, hhad]), updatedAt: "2026-07-11T09:10:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    const secondCanonicalRead = loadOddsHistory(publicDir);
    equal(secondCanonicalRead.rows.length, 2, "a second canonical sync must preserve both market pools");
    equal(secondCanonicalRead.rows[0].seenCount, 2, "a second canonical sync must expose the updated observation state");

    const sqlitePath = path.join(storeRoot, "football.db");
    const { DatabaseSync } = require("node:sqlite");
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite.exec(`
      CREATE TABLE odds_snapshots (
        id TEXT PRIMARY KEY,
        match_id TEXT,
        source_match_id TEXT,
        pool TEXT,
        captured_at TEXT,
        payload TEXT NOT NULL
      )
    `);
    const insertOdds = sqlite.prepare(`
      INSERT INTO odds_snapshots (id, match_id, source_match_id, pool, captured_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rawSqliteOdds = [
      { id: "state-a", at: "2026-07-11T09:00:00.000Z", lastSeenAt: "2026-07-11T09:20:00.000Z", seenCount: 4, odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
      { id: "state-b", at: "2026-07-11T09:10:00.000Z", odds1: 2.05, oddsX: 3.25, odds2: 3.5 },
    ];
    for (const row of rawSqliteOdds) {
      insertOdds.run(
        row.id,
        "sporttery_fixture-match",
        "fixture-match",
        "HAD",
        row.at,
        JSON.stringify({
          sourceMatchId: "fixture-match",
          pool: "HAD",
          handicap: 0,
          odds1: row.odds1,
          oddsX: row.oddsX,
          odds2: row.odds2,
          oddsCapturedAt: row.at,
          oddsReceivedAt: row.at,
          oddsSource: "sporttery:HAD",
          sourceCycleId: row.id,
           firstSeenAt: row.at,
           lastSeenAt: row.lastSeenAt,
           seenCount: row.seenCount,
          kickoffTime: "2026-07-11T19:00:00+08:00",
          sourceMethod: "current",
          sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001",
        }),
      );
    }
    sqlite.close();
    fs.writeFileSync(
      path.join(dataDir, "matches-current.json"),
      `${JSON.stringify([{
        id: "sporttery_fixture-match",
        sourceMatchId: "fixture-match",
        kickoffTime: "2026-07-11T19:00:00+08:00",
        buyEndTime: "2026-07-11T18:00:00+08:00",
      }], null, 2)}\n`,
      "utf8",
    );
    const recovered = loadOddsHistory(publicDir, { sqlitePath });
    const recoveredHadRows = recovered.rows.filter((row) => row.sourceMatchId === "fixture-match" && row.poolCode === "HAD");
    equal(recoveredHadRows.length, 2, "SQLite recovery must restore distinct pre-cutoff HAD states for trend analysis");
    check(recoveredHadRows.some((row) => row.stateSignature === "HAD|0|2.050|3.250|3.500"), "SQLite recovery must retain the changed official SP state");
    check(recoveredHadRows.every((row) => parseTimestamp(row.capturedAt) <= parseTimestamp(row.cutoffTime)), "SQLite recovery must remain pre-cutoff");
    equal(recoveredHadRows.find((row) => row.stateSignature === "HAD|0|2.100|3.200|3.400")?.seenCount, 4,
      "SQLite recovery must retain the compacted state's cumulative observation count");

    fs.unlinkSync(path.join(dataDir, "odds-history.json"));
    fs.writeFileSync(
      path.join(publicDir, "odds-history.json"),
      `${JSON.stringify(fixturePayload([had, hhad]), null, 2)}\n`,
      "utf8",
    );
    equal(loadOddsHistory(publicDir).rows.length, 2, "legacy root history remains a compatibility fallback");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }

  return { checks };
}

function parseCli(argv) {
  const selfTestOnly = argv.includes("--self-test");
  const fileFlag = argv.indexOf("--file");
  const requestedFile = fileFlag >= 0
    ? argv[fileFlag + 1]
    : argv.find((value) => !value.startsWith("--"));
  return {
    selfTestOnly,
    file: requestedFile ? path.resolve(process.cwd(), requestedFile) : DEFAULT_FILE,
  };
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const selfTest = runSelfTest();
  if (options.selfTestOnly) {
    console.log(`odds-history integrity self-test passed (${selfTest.checks} checks).`);
    return;
  }

  if (!fs.existsSync(options.file)) throw new Error(`Odds history file not found: ${options.file}`);
  const payload = JSON.parse(fs.readFileSync(options.file, "utf8").replace(/^\uFEFF/, ""));
  const result = validateOddsHistory(payload);
  if (!result.ok) {
    const details = result.errors
      .slice(0, 40)
      .map((entry) => `${entry.rowIndex === null ? "payload" : `row ${entry.rowIndex}`}: [${entry.code}] ${entry.message}`)
      .join("\n");
    const remainder = result.errors.length > 40 ? `\n... ${result.errors.length - 40} more issue(s)` : "";
    throw new Error(`Odds history integrity failed for ${options.file}:\n${details}${remainder}`);
  }
  console.log(JSON.stringify({
    ok: true,
    file: options.file,
    fixtureChecks: selfTest.checks,
    ...result.summary,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
} else {
  module.exports = {
    compressStateRows,
    expectedStateSignature,
    rowIsPreMatch,
    runSelfTest,
    validateOddsHistory,
  };
}
