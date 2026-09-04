const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  getSqliteStatus,
  readSqliteCurrentMatches,
} = require("../server/sqliteStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
const sqliteSource = fs.readFileSync(path.join(rootDir, "server", "sqliteStore.cjs"), "utf8");
const performanceSource = fs.readFileSync(path.join(__dirname, "verifyApiPerformance.cjs"), "utf8");

const sourceSlice = (startMarker, endMarker) => {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after: ${startMarker}`);
  return serverSource.slice(start, end);
};

const historyPayload = sourceSlice(
  "const buildV1HistoryPayload = async (url) => {",
  "const buildV1MatchPayload = async (matchId) => {",
);
const matchPayload = sourceSlice(
  "const buildV1MatchPayload = async (matchId) => {",
  "const handleApi = async (req, res, url) => {",
);
const matchReader = sourceSlice(
  "const readMatchById = async (matchId, options = {}) => {",
  "const readOddsHistoryPage = async (url) => {",
);
const historyReader = sourceSlice(
  "const readHistoryMatchesForListDetailed = async (limit = 600, options = {}) => {",
  "const readHistoryMatchesForList = async (limit = 600) => {",
);
const sqliteMatchReaderStart = sqliteSource.indexOf("const readSqliteMatchById =");
const sqliteMatchReaderEnd = sqliteSource.indexOf("const readSqliteOddsHistoryRows =", sqliteMatchReaderStart);
assert.ok(sqliteMatchReaderStart >= 0 && sqliteMatchReaderEnd > sqliteMatchReaderStart);
const sqliteMatchReader = sqliteSource.slice(sqliteMatchReaderStart, sqliteMatchReaderEnd);

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check("history payload reads immutable publication metadata", () => {
  assert.match(historyPayload, /const basePublication = resolveBasePublication\(\);/);
  assert.match(historyPayload, /readStablePublicationMetadata\(basePublication, "sync-meta\.json", null\)/);
  assert.match(historyPayload, /sqliteReadCacheToken\(meta, basePublication\.identity\)/);
});

check("history cache key is bound to generation and manifest", () => {
  assert.match(historyPayload, /`generation:\$\{basePublication\.identity\.generationId \|\| basePublication\.identity\.mode\}`/);
  assert.match(historyPayload, /`manifest:\$\{basePublication\.identity\.manifestHash \|\| ""\}`/);
  assert.match(historyPayload, /getCachedSqliteReadStatus\(meta, basePublication\.identity\)/);
  assert.match(historyPayload, /readHistoryMatchesForListDetailed\(1200, \{ basePublication \}\)/);
});

check("history generation fallback cannot mix mutable server-db rows", () => {
  assert.match(historyReader, /if \(basePublication\?\.context\) \{/);
  assert.match(historyReader, /readPublicationJson\(basePublication, "matches-history\.json", \[\]\)/);
  assert.ok(
    historyReader.indexOf("if (basePublication?.context) {")
      < historyReader.indexOf("const dbRows = await getHistoryMatchesForList"),
    "generation fallback must run before mutable server-db fallback",
  );
});

check("match payload uses one publication for metadata risk and cache identity", () => {
  assert.match(matchPayload, /const basePublication = resolveBasePublication\(\);/);
  assert.match(matchPayload, /readStablePublicationMetadata\(basePublication, "sync-meta\.json", null\)/);
  assert.match(matchPayload, /readGlobalRecommendationRiskTier\(basePublication\)/);
  assert.match(matchPayload, /sqliteReadCacheToken\(meta, basePublication\.identity\)/);
  assert.match(matchPayload, /`generation:\$\{basePublication\.identity\.generationId \|\| basePublication\.identity\.mode\}`/);
  assert.match(matchPayload, /`manifest:\$\{basePublication\.identity\.manifestHash \|\| ""\}`/);
  assert.match(matchPayload, /readMatchById\(decodedId, \{ basePublication \}\)/);
});

check("recommendation risk takes the conservative floor across immutable and latest evaluations", () => {
  assert.match(serverSource, /const mostConservativeRecommendationRiskTier = \(\.\.\.tiers\) => \{/);
  assert.match(serverSource, /const effectiveBasePublication = basePublication \|\| resolveBasePublication\(\);/);
  assert.match(serverSource, /publicationEvaluation\?\.riskTiers\?\.overall\?\.tier/);
  assert.match(serverSource, /latestEvaluation\?\.riskTiers\?\.overall\?\.tier/);
  assert.match(serverSource, /code: "publication-risk-floor"/);
  assert.match(serverSource, /applyRecommendationRiskFloor\(latestEvaluation, globalRiskTier\)/);
});

check("match reader keeps current sqlite and history fallbacks on one publication", () => {
  assert.match(matchReader, /readCurrentMatchesDetailed\(\{ basePublication \}\)/);
  assert.match(matchReader, /getCachedSqliteReadStatus\(meta, basePublication\?\.identity \|\| null\)/);
  assert.match(
    matchReader,
    /readSqliteMatchById\(sqliteDbPath, decodedId, \{\s*publicationIdentity: basePublication\?\.identity \|\| null,\s*\}\)/,
  );
  assert.match(matchReader, /readPublicationJson\(basePublication, "matches-history\.json", \[\]\)/);
  assert.ok(
    matchReader.indexOf("if (basePublication?.context) {")
      < matchReader.indexOf("const dbMatch = await getLatestMatchById"),
    "generation lookup must return before mutable server-db merge",
  );
});

check("single-match sqlite lookup rejects a different publication inside one read transaction", () => {
  assert.match(sqliteMatchReader, /const readSqliteMatchById = async \(dbPath, id, options = \{\}\) => \{/);
  assert.match(sqliteMatchReader, /db\.exec\("BEGIN"\)/);
  assert.match(sqliteMatchReader, /sqlitePublicationMatches\(\s*readSqlitePublicationIdentityFromDb\(db\),\s*options\.publicationIdentity,\s*\)/);
  assert.match(sqliteMatchReader, /db\.exec\("COMMIT"\)/);
  assert.match(sqliteMatchReader, /db\.exec\("ROLLBACK"\)/);
});

check("sqlite API hot paths read only fixed schema metadata keys", () => {
  assert.match(sqliteSource, /const SQLITE_PUBLICATION_META_KEYS = Object\.freeze\(\[/);
  assert.match(sqliteSource, /const SQLITE_STATUS_META_KEYS = Object\.freeze\(\[/);
  assert.match(
    sqliteSource,
    /FROM schema_meta\s+WHERE key IN \(\$\{selectedKeys\.map\(\(\) => "\?"\)\.join\(","\)\}\)/,
  );
  assert.match(
    sqliteSource,
    /readSqlitePublicationIdentityFromDb = \(db\) => sqlitePublicationIdentityFromMeta\(\s*readMetaRows\(db, SQLITE_PUBLICATION_META_KEYS\)/,
  );
  assert.match(sqliteSource, /const meta = readMetaRows\(db, SQLITE_STATUS_META_KEYS\);/);
  assert.doesNotMatch(
    sqliteSource,
    /SELECT key, value, updated_at FROM schema_meta["'`]\)\.all\(\)/,
    "API reads must never materialize every per-event authority high-water JSON row",
  );
});

check("performance p95 threshold remains 800ms", () => {
  assert.match(performanceSource, /process\.env\.PERF_MAX_P95_MS \|\| 800/);
});

check("immutable publication metadata is parsed once per generation manifest", () => {
  assert.match(serverSource, /const immutablePublicationMetadataCache = new Map\(\);/);
  assert.match(serverSource, /identity\.generationId \|\| basePublication\.mode/);
  assert.match(serverSource, /identity\.manifestHash \|\| ""/);
  assert.match(serverSource, /immutablePublicationMetadataCache\.has\(cacheKey\)/);
  assert.match(serverSource, /readStablePublicationMetadata\(basePublication, "model-evaluation\.json", null\)/);
});

const runRuntimeChecks = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-api-meta-scope-"));
  const dbPath = path.join(tempDir, "football.db");
  const highWaterRows = 4_096;
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_meta_storage (
        key TEXT PRIMARY KEY,
        raw_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIEW schema_meta AS
        SELECT
          key,
          CASE
            WHEN key LIKE 'fast_result_authority_high_water:event:%'
              THEN json_extract(raw_value, '$.must_not_be_read_by_api_hot_path')
            ELSE raw_value
          END AS value,
          updated_at
        FROM schema_meta_storage;
      CREATE TABLE match_snapshots (dataset TEXT NOT NULL);
      CREATE TABLE odds_snapshots (id INTEGER PRIMARY KEY);
      CREATE TABLE prediction_snapshots (id INTEGER PRIMARY KEY);
      CREATE TABLE source_snapshots (id INTEGER PRIMARY KEY);
      BEGIN;
    `);
    const insert = db.prepare(
      "INSERT INTO schema_meta_storage (key, raw_value, updated_at) VALUES (?, ?, ?)",
    );
    const timestamp = "2026-08-02T00:00:00.000Z";
    insert.run("data_publication_mode", "legacy-bootstrap", timestamp);
    insert.run("schema_version", "football-sqlite-v2", timestamp);
    insert.run("exported_at", timestamp, timestamp);
    for (let index = 0; index < highWaterRows; index += 1) {
      // Invalid JSON is an evaluation trap: an accidental full-table SELECT of
      // the generated value fails, while a fixed-key indexed read never touches it.
      insert.run(
        `fast_result_authority_high_water:event:${String(index).padStart(6, "0")}`,
        "{",
        timestamp,
      );
    }
    db.exec("COMMIT");
    assert.throws(
      () => db.prepare("SELECT key, value, updated_at FROM schema_meta").all(),
      /malformed JSON/,
      "the fixture must detect any accidental full schema_meta materialization",
    );
    db.close();
    db = null;

    const startedAt = process.hrtime.bigint();
    const status = await getSqliteStatus(dbPath);
    const current = await readSqliteCurrentMatches(dbPath);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.equal(status.available, true);
    assert.equal(status.schemaVersion, "football-sqlite-v2");
    assert.deepEqual(current, []);
    checks.push(
      `sqlite API fixed-key reads bypass ${highWaterRows} per-event high-water rows (${elapsedMs.toFixed(2)}ms)`,
    );
  } finally {
    try { db?.close(); } catch { /* cleanup only */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: checks.length,
    passed: checks,
  }, null, 2));
};

runRuntimeChecks().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
