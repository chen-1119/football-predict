"use strict";

// Synthetic-only integration contract: real source builders, generation commit,
// SQLite exporter/readers and PostgreSQL projection/readers. The PostgreSQL
// transport is a query-capture double, NOT a running PostgreSQL integration test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createCollectorAttestationTestContext } = require("./collectorAttestationTestFixture.cjs");
const trust = createCollectorAttestationTestContext({ keyId: "q1-synthetic-roundtrip-only" });
// The test trust registry must exist before the real source module is loaded.
const { buildPredictionFeatureSnapshot, predictionSnapshotRow, buildArchivedPreMatchPrediction, buildPostMatchReview } = require("./syncData.cjs");
const { bindPublicReferenceDecision: bind, attestPublicReferenceDecision: attest } = require("../src/services/publicReferenceDecision.cjs");
const { commitCurrentDataGeneration, resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
const { canonicalPredictionState } = require("./sqliteWarehouse.cjs");
const { syncPostgresProjectionFromSqlite } = require("./postgresProjectionSync.cjs");
const { readSqliteCurrentMatches, readSqlitePredictionSnapshotRows, readSqlitePublicReferenceEvidence } = require("../server/sqliteStore.cjs");
const { readPostgresCurrentMatches, readPostgresPredictionSnapshotRows, readPostgresPublicReferenceEvidence } = require("../server/postgresProjectionStore.cjs");
const { compactPredictionSnapshotAudit } = require("../server/predictionSnapshotAudit.cjs");
const { SOURCE_ID, VERSION: ARCHIVE_VERSION, INDEX_ID, INDEX_PREFIX, buildPublicReferenceIndex } = require("../server/publicReferenceArchive.cjs");
const { exactDecisionEventMatch } = require("../src/services/decisionEventIdentity.cjs");
const { observePredictionEvidence } = require("./predictionEvidenceAudit.cjs");
const { isDecisionClockAuditEligible } = require("../src/services/decisionSnapshot.cjs");
const { bindHistoricalContentObservation } = require("./historicalContentObservation.cjs");
const { summarizeRecentFormEvidence } = require("./recentFormEvidence.cjs");
const { readSqliteHistoryMatchesForList } = require("../server/sqliteStore.cjs");
const { readPostgresHistoryMatchesForList } = require("../server/postgresProjectionStore.cjs");
const { resolveFrozenReviewVersion } = require("../src/services/frozenReviewVersion.cjs");
const { auditFrozenReferenceMarket } = require("../src/services/frozenReferenceMarketPair.cjs");
const { buildReferenceReviewPerformance, compactReferenceReviewPerformance } = require("../server/reviewPerformanceSummary.cjs");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-evidence-roundtrip-"));
const publicDataDir = path.join(tempDir, "source");
const storeDir = path.join(tempDir, "store");
const dbPath = path.join(storeDir, "synthetic.db");
let realPool = null;
const realPostgresUrl = process.env.EVIDENCE_TEST_POSTGRES_URL || "";
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const check = (value, message) => { assert.ok(value, message); checks += 1; };
const verifyStoredMarketPair = (match, resolved, label) => {
  check(resolved.ok, `${label}: private evidence resolves`);
  const pair = auditFrozenReferenceMarket({ match, record: resolved.record,
    entry: { version: "public-reference-evidence-v1", referenceHash: resolved.record.contentHash,
      evidenceHash: resolved.record.evidenceBinding.evidenceHash, evidence: resolved.evidence },
    trustRegistry: trust.registry, auditAt: "2026-09-07T15:00:00.000Z" });
  equal(pair.eligible, true, `${label}: same-decision signed market pair survives transport: ${JSON.stringify(pair)}`);
  equal([pair.market, pair.publicCode, pair.baselineCode, pair.publishedWon, pair.baselineWon], ["HAD", "X", "1", true, false], `${label}: exact paired result uses old public draw and original market favorite`);
};
const json = (value) => JSON.parse(JSON.stringify(value));
const writeJson = (name, payload) => {
  fs.mkdirSync(publicDataDir, { recursive: true });
  fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(payload));
};
const runExporter = (extraEnv = {}) => spawnSync(process.execPath, [path.join(__dirname, "exportDataStoreSqlite.cjs")], {
  cwd: rootDir, encoding: "utf8", timeout: 60000,
  env: { ...process.env, SQLITE_EXPORT_PUBLIC_DATA_DIR: publicDataDir, SERVER_STORE_DIR: storeDir,
    DATASTORE_SQLITE_PATH: dbPath, SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "0",
    SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "0", SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE", ...extraEnv },
});
const exportSuccessfully = (extraEnv) => {
  const result = runExporter(extraEnv);
  equal(result.status, 0, `isolated exporter completed: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const readArchive = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT id, captured_at, payload FROM source_snapshots WHERE id = ?").get(SOURCE_ID) || null; }
  finally { db.close(); }
};
const readIndexRows = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT id, payload FROM source_snapshots WHERE id = ? OR substr(id, 1, ?) = ? ORDER BY id").all(INDEX_ID, INDEX_PREFIX.length, INDEX_PREFIX).map(row => ({ ...row })); }
  finally { db.close(); }
};
const capturedAt = "2026-09-07T01:00:00.000Z";
const publishedAt = "2026-09-07T01:00:01.000Z";
const sourceCycleId = "q1-synthetic-roundtrip-cycle";
const sourceMatchId = "99000001";
const proof = (poolCode, odds) => trust.buildSignedMarketProvenance({
  poolCode, sourceMatchId, odds,
  handicapLine: poolCode === "HHAD" ? -1 : 0,
  sourceUrl: "https://webapi.sporttery.cn/gateway/synthetic-roundtrip.qry",
  providerObservedAt: "2026-09-07T00:57:00.000Z",
  sourceTiming: {
    sourceCycleId, requestedAt: "2026-09-07T00:56:00.000Z",
    receivedAt: "2026-09-07T00:58:00.000Z",
    sourceRequest: { method: "GET", page: 1, role: "synthetic-roundtrip" },
    httpStatus: 200, rawSha256: (poolCode === "HAD" ? "a" : "b").repeat(64), rawBytes: 1024,
  },
});

const makeMatch = () => {
  const recentRows = Array.from({ length: 4 }, (_, i) => {
    const row = { source: "football-data.co.uk", division: "E0", kickoffTime: `2026-08-${28+i}T12:00:00.000Z`,
      homeKey: "synthetic home", awayKey: "synthetic away", scoreHome: 0, scoreAway: 1, side: "home" };
    row.sourceObservation = bindHistoricalContentObservation(row, { sourceEventId: String(i+1).padStart(64,"0"), eventSha256: "b".repeat(64), rawRowSha256: "c".repeat(64) },
      { version: "football-data-content-observation-v1", scope: "local-fetch-only", sourceVerified: false,
        sourceUrl: "https://www.football-data.co.uk/mmz4281/2627/E0.csv", sha256: "a".repeat(64), firstObservedAt: "2026-09-06T12:00:00.000Z" });
    return row;
  });
  const match = {
    id: `sporttery_${sourceMatchId}`, sourceMatchId, status: "SCHEDULED",
    eventVersion: "2026-09-07T12:00:00.000Z", kickoffTime: "2026-09-07T12:00:00.000Z",
    buyEndTime: "2026-09-07T11:55:00.000Z", businessDate: "2026-09-07", sourceCycleId,
    homeTeamName: "SYNTHETIC HOME", awayTeamName: "SYNTHETIC AWAY",
    odds: { odds1: 2.2, oddsX: 3.4, odds2: 3.1 },
    handicapLine: -1, handicapOdds: { odds1: 3.7, oddsX: 3.5, odds2: 1.8 },
    oddsMarketProvenance: proof("HAD", { "1": 2.2, X: 3.4, "2": 3.1 }),
    handicapOddsMarketProvenance: proof("HHAD", { "1": 3.7, X: 3.5, "2": 1.8 }),
    predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4,
      tipLabel: { zh: "平局", en: "Draw" }, recommendationAction: "reference", trustScore: 40 }],
    predictionMeta: {
      generatedAt: capturedAt, decisionGeneratedAt: capturedAt, decisionId: "q1-synthetic-decision-1",
      decisionRevision: 1, policyVersion: "q1-synthetic-policy", promptVersion: "q1-synthetic-prompt",
      modelVersion: "q1-synthetic-model", calibrationVersion: "q1-synthetic-uncalibrated",
      sourceCycleId, cutoffTime: "2026-09-07T11:55:00.000Z",
    },
    probabilityModel: {
      version: "q1-synthetic-model", generatedAt: "2026-09-07T00:59:00.000Z",
      oneXTwo: { final: { home: 32, draw: 37, away: 31 } },
      handicap: { line: -1, unifiedPosterior: { home: 22, draw: 27, away: 51 } },
      goalLines: { over25: 45, under25: 55 }, bothTeamsToScore: { yes: 48, no: 52 },
      form: { home: { sampleSize: 4, lastMatchAt: "2026-08-31T12:00:00.000Z", resultEvidence: summarizeRecentFormEvidence(recentRows, "synthetic home", capturedAt) },
        away: { sampleSize: 0, lastMatchAt: null } },
      modelHealth: { dataGaps: { connected: { homeForm: "available", awayForm: "missing", injury: null } } },
      unifiedPosterior: {
        version: "q1-synthetic-unified", generatedAt: "2026-09-07T00:59:30.000Z",
        selectedMarket: "HAD", selectedCode: "X", recommendationAction: "reference", dataQuality: 0.4,
        candidates: [{ market: "HAD", code: "X", probability: 37, odds: 3.4 }],
      },
    },
  };
  match.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(match, capturedAt);
  match.predictionMeta.featureSnapshotHash = match.predictionMeta.featureSnapshot.hash;
  return bind(match, null, publishedAt);
};

// Capture real projection SQL and values. Readback parses the exact payload JSON
// string emitted by the real mapper, preserving order-sensitive legacy hashes.
const capturePostgres = () => {
  const tables = new Map();
  const calls = [];
  const tempIds = new Map();
  const state = { latestCommittedAt: null, payloadAsText: false };
  const client = {
    release() {},
    async query(sql, values = []) {
      const statement = String(sql).trim();
      calls.push({ sql: statement, values });
      if (/^SELECT committed_at FROM football\.projection_runs/.test(statement)) {
        return { rows: state.latestCommittedAt ? [{ committed_at: new Date(state.latestCommittedAt) }] : [], rowCount: state.latestCommittedAt ? 1 : 0 };
      }
      const createTemp = statement.match(/^CREATE TEMP TABLE (active_[a-z0-9_]+) /);
      if (createTemp) tempIds.set(createTemp[1], []);
      const activeInsert = statement.match(/^INSERT INTO (active_[a-z0-9_]+) /);
      if (activeInsert) tempIds.get(activeInsert[1]).push(...values);
      const prune = statement.match(/^DELETE FROM football\.source_snapshots target\s+WHERE\s+NOT EXISTS \(SELECT 1 FROM (active_[a-z0-9_]+) active/);
      if (prune) {
        const active = tempIds.get(prune[1]);
        check(Array.isArray(active), "source pruning uses actual SQLite active IDs");
        tables.set("source_snapshots", (tables.get("source_snapshots") || []).filter((row) => active.includes(row.id)));
      }
      if (/^SELECT key, value, updated_at\s+FROM football\.projection_meta/.test(statement)) {
        return { rows: (tables.get("projection_meta") || []).filter((row) => values[0].includes(row.key)), rowCount: 6 };
      }
      if (/^SELECT payload\s+FROM football\.prediction_snapshots/.test(statement)) {
        const [matchId, sourceId, phase, limit] = values;
        const rows = (tables.get("prediction_snapshots") || []).filter((row) => (
          (!matchId || row.match_id === matchId || row.source_match_id === sourceId)
          && (matchId || !sourceId || row.source_match_id === sourceId)
          && (!phase || row.phase === phase)
        )).slice(0, limit).map((row) => ({ payload: state.payloadAsText ? row.payload : JSON.parse(row.payload) }));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT payload FROM football\.source_snapshots WHERE id = \$1/.test(statement)) {
        const rows = (tables.get("source_snapshots") || []).filter(row => row.id === values[0]
          && Buffer.byteLength(row.payload) <= values[1]).slice(0, 1)
          .map(row => ({ payload: state.payloadAsText ? row.payload : JSON.parse(row.payload) }));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT payload\s+FROM football\.match_snapshots/.test(statement)) {
        const dataset = /dataset = 'history'/.test(statement) ? "history" : "current";
        const rows = (tables.get("match_snapshots") || []).filter((row) => row.dataset === dataset)
          .map((row) => ({ payload: state.payloadAsText ? row.payload : JSON.parse(row.payload) }));
        return { rows, rowCount: rows.length };
      }
      const insert = statement.match(/^INSERT INTO football\.(projection_meta|match_snapshots|source_snapshots|prediction_snapshots)\s*\(([^)]+)\)\s+VALUES\s/i);
      if (insert) {
        const columns = insert[2].split(",").map((name) => name.trim());
        equal(values.length % columns.length, 0, `complete ${insert[1]} SQL row bindings`);
        if (columns.includes("payload")) {
          check(statement.includes("::json") && !statement.includes("::jsonb"), "hash-bound transport uses json, not jsonb");
        }
        const rows = tables.get(insert[1]) || [];
        for (let offset = 0; offset < values.length; offset += columns.length) {
          const row = Object.fromEntries(columns.map((name, index) => [name, values[offset + index]]));
          const existing = rows.findIndex((item) => insert[1] === "projection_meta" ? item.key === row.key : item.id === row.id);
          if (existing === -1) rows.push(row);
          else rows[existing] = row;
        }
        tables.set(insert[1], rows);
        return { rows: [], rowCount: values.length / columns.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { tables, calls, state, pool: { connect: async () => client, query: client.query.bind(client) } };
};

const verifyEvidenceHttp = async (reference, identity, postgresUrl = "", postgresOnly = false) => {
  // Copy runtime code into the fixture: even startup's generated-file writes
  // must remain isolated from the user's working tree and production data.
  const app = path.join(tempDir, postgresOnly ? "http-app-postgres-only" : postgresUrl ? "http-app-postgres" : "http-app");
  fs.mkdirSync(app);
  for (const dir of ["server", "scripts", "src"]) fs.cpSync(path.join(rootDir, dir), path.join(app, dir), {
    recursive: true, filter: p => fs.statSync(p).isDirectory() || /\.(cjs|json|sql)$/.test(p),
  });
  fs.symlinkSync(path.join(rootDir, "node_modules"), path.join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.cpSync(publicDataDir, path.join(app, "public", "data"), { recursive: true });
  const { updateCandidateProspectiveLedger } = require("./candidateProspectiveLedger.cjs");
  const { candidateReadinessPreview } = require("./captureCandidateProspectiveDeadline.cjs");
  const { buildShadowObservationState, shadowObservationAuditValid } = require("../src/services/candidateCaptureState.cjs");
  const shadowAt = new Date().toISOString();
  const candidate = { id: "http-shadow-only", role: "shadow-feature-candidate", weights: { market: 1, temperature: 1.25 } };
  const shadow = updateCandidateProspectiveLedger({ candidates: [candidate], selectedCandidate: candidate, evaluatedAt: shadowAt });
  shadow.audit.captureState = buildShadowObservationState(shadow.audit);
  check(shadow.audit.captureState, "real ledger constructs an explicitly unactivated observation receipt");
  fs.mkdirSync(path.join(storeDir, "model-artifacts"), { recursive: true });
  fs.writeFileSync(path.join(storeDir, "model-artifacts", "candidate-prospective-registry.json"), JSON.stringify(shadow.registry));
  fs.writeFileSync(path.join(storeDir, "candidate-prospective-capture-status.json"), JSON.stringify({
    version: "prospective-deadline-heartbeat-v2", captureMode: "deadline-only", evaluatedAt: shadowAt,
    ok: true, skipped: false, captureDurationMs: 0, reason: "settlement-heartbeat",
    dueMatches: 0, eventsAdded: 0, dueCaptureEventsAdded: 0, dueDecisionEventsAdded: 0,
    dueExclusionEventsAdded: 0, dueAtomicDecisionEventsAdded: 0, dueCaptureComplete: true,
    dueAtomicComplete: true, dueUnrecorded: 0, readyDueUnrecorded: 0, blockers: [], audit: shadow.audit,
    readiness: candidateReadinessPreview({ ledger: shadow.registry.ledgers[0], matches: [], snapshots: [], evaluatedAt: shadowAt, trustedCollectorCount: 2 }),
  }));
  const port = 24000 + Math.floor(Math.random() * 12000);
  const token = crypto.randomBytes(24).toString("hex");
  const output = [];
  const sqliteTrap = path.join(app, "forbid-sqlite.cjs");
  if (postgresOnly) fs.writeFileSync(sqliteTrap, `
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name === "node:sqlite" || name === "sqlite") {
        console.error("SQLITE_FORBIDDEN_ATTEMPT");
        throw new Error("PostgreSQL-only HTTP must never load SQLite");
      }
      return original.call(this, name, ...args);
    };
  `);
  const runtimeEnv = { ...process.env, NODE_ENV: "test", NODE_OPTIONS: postgresOnly ? `--require="${sqliteTrap.replaceAll("\\", "/")}"` : "", HOST: "127.0.0.1", PORT: String(port),
      FOOTBALL_STORAGE_MODE: postgresOnly ? "postgres-only" : "hybrid",
      ENABLE_SQLITE_EXPORT: "0", PRIVATE_MODEL_ARTIFACT_STORAGE: postgresOnly ? "postgres" : "sqlite",
      POSTGRES_PROJECTION_SOURCE: postgresOnly ? "native-generation" : "sqlite",
      SERVER_STORE_DIR: storeDir, DATASTORE_SQLITE_PATH: postgresOnly ? path.join(app, "must-not-exist.sqlite") : dbPath, DATASTORE_READ_SOURCE: postgresUrl ? "postgres" : "sqlite", CURRENT_MATCH_SOURCE: postgresUrl ? "postgres" : "sqlite",
      FOOTBALL_POSTGRES_URL: postgresUrl, DATABASE_URL: "", FOOTBALL_POSTGRES_MODE: postgresUrl ? "primary" : "disabled", FOOTBALL_POSTGRES_SSL_MODE: "disable",
      ENABLE_SYNC_CRON: "0", ENABLE_GPT_CRON: "0", SYNC_WORKER_EVENT_BRIDGE: "0", RELAY_FAST_WATCHER_ENABLED: "0",
      ADMIN_TOKEN: token, ACCESS_CODE_ADMIN_TOKEN: token, ACCESS_CODE_SECRET: crypto.randomBytes(32).toString("hex") };
  const child = spawn(process.execPath, [path.join(app, "server", "index.cjs")], {
    cwd: app, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: runtimeEnv,
  });
  child.stdout.on("data", data => output.push(String(data)));
  child.stderr.on("data", data => output.push(String(data)));
  const exited = new Promise(resolve => child.once("exit", resolve));
  const request = async (route, headers = {}, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      method, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  };
  try {
    const deadline = Date.now() + 30000;
    while (!output.some(line => line.includes("[football-server] listening on"))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("isolated HTTP startup failed: " + output.join("").slice(-2500));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const route = `/api/db/public-reference-evidence?referenceHash=${reference.contentHash}`;
    const health = await request("/api/v1/health");
    equal(health.status, 200, "real public health returns capacity aggregates without evidence authentication");
    if (postgresOnly) {
      equal(health.body.storage?.sqlite?.retired, true, `native HTTP reports SQLite retired: ${JSON.stringify(health.body).slice(0, 2000)}; ${output.join("").slice(-1800)}`);
      equal(health.body.storage?.fastResultIntegrity?.valid, true, "native HTTP validates PostgreSQL receipts without a SQLite SQL adapter");
      const readiness = require("./nativeStorageReadiness.cjs").nativeStorageReadiness(health.body);
      equal(readiness.ok, true, `native release storage verifier accepts the actual runtime proof: ${JSON.stringify(readiness)}`);
      equal(require("./nativeStorageReadiness.cjs").nativeStorageReadiness({ ...health.body, storage: { ...health.body.storage, sqlite: { available: true } } }).ok,
        false, "native release storage verifier refuses a live SQLite dependency");
    }
    equal(health.body.storage?.predictionExecutionCapture?.status, "failed", "real health recomputes full capture capacity rather than trusting stored healthy status");
    equal(health.body.storage?.predictionExecutionCapture?.reason, "private-store-capacity-limit", "actual SQLite metadata-to-health capacity reason is explicit");
    equal(health.body.storage?.predictionExecutionCapture?.files, 60000, "stored capture count survives the real metadata and HTTP path");
    check(!JSON.stringify(health.body).includes("capture-private-http-canary"), "public health must not expose private capture records or arbitrary metadata fields");
    equal(health.body.storage?.predictionExecutionCapture?.productionEligible, false, "capture diagnostics never enable formal prediction authority");
    equal((await request(route)).status, 401, "real HTTP rejects anonymous evidence access");
    equal((await request(route, { authorization: "Bearer incorrect" })).status, 401, "real HTTP rejects wrong admin credentials");
    equal((await request(route + `&token=${token}`)).status, 401, "query-string token cannot bypass admin authentication");
    const admin = { authorization: `Bearer ${token}` };
    const result = await request(route, admin);
    equal(result.status, 200, "real authenticated HTTP resolves stored public evidence");
    equal(result.body.source, postgresUrl ? "postgres" : "sqlite", "HTTP actually uses the requested database driver");
    equal(result.cache, "no-store", "private evidence cannot be cached by intermediaries");
    equal(result.body.record.contentHash, reference.contentHash, "HTTP resolves exact original reference hash");
    equal(result.body.evidence.publicPrediction.tipCode, "X", "HTTP does not substitute private home prediction");
    equal(result.body.evidence.featureSnapshot.modelInputs.form.home.resultEvidence.contentObservation,
      reference.dataGaps.inputSummaries.form.home.resultEvidence.contentObservation, "actual primary-mode HTTP retains the separate local file receipt summary");
    equal(result.body.publication.generationId, identity.generationId, "HTTP evidence read is publication paired");
    equal((await request("/api/matches/history?limit=10", admin)).status, 401, "admin token alone never bypasses public-history access protection");
    // Disposable local application only: exercise the normal code/session
    // exchange, do not disable protection or touch production credentials.
    const issued = await request("/api/admin/access-codes", admin, "POST", { label: "synthetic-version-roundtrip", ttlSeconds: 300 });
    equal(issued.status, 200, "local test code created");
    const verified = await request("/api/access/verify", {}, "POST", { code: issued.body.code });
    equal(verified.status, 200, "local test code exchanged normally");
    const history = await request("/api/matches/history?limit=10", { authorization: `Bearer ${verified.body.session.token}` });
    equal(history.status, 200, "authenticated history HTTP succeeds");
    const frozenRow = history.body[0]?.postMatchReview?.predictionReview?.rows?.find(row => row.marketType === "BEST");
    check(frozenRow?.frozenVersion, "actual history list compactor retains frozen version receipt");
    equal(frozenRow.frozenVersion.referenceHash, reference.contentHash, "history HTTP version receipt addresses original public record");
    equal(frozenRow.frozenVersion.modelVersion, reference.evidenceBinding.modelVersion, "history HTTP never substitutes current model version");
    verifyStoredMarketPair(history.body[0], result.body, postgresUrl ? "real PostgreSQL history/admin HTTP" : "SQLite history/admin HTTP");
    const scorecard = await request("/api/v1/model/evaluation", { authorization: `Bearer ${verified.body.session.token}` });
    equal(scorecard.status, 200, "public scorecard HTTP succeeds with a real local recommendation session");
    const publicShadow = scorecard.body.publicScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE;
    equal(publicShadow?.state, "SHADOW", "real public HTTP never changes observation to ACTIVE");
    equal(publicShadow?.captureState, shadow.audit.captureState, "actual public projection preserves the registry-bound observation receipt");
    equal(shadowObservationAuditValid(publicShadow), true, "public compact counters remain sufficient for the shared operational gate");
    equal([publicShadow?.onlineEffect, publicShadow?.formalPromotionEligible, publicShadow?.activationAt], [false, false, null], "operational health is not recommendation or trial activation permission");
    const { candidateProspectiveRuntimeState } = require("./checkServerRuntime.cjs");
    const observationRuntime = candidateProspectiveRuntimeState(scorecard.body);
    equal(observationRuntime.ok, true, `actual public SHADOW output passes unchanged operational evidence checks: ${JSON.stringify(observationRuntime.blockers)}`);
    const unboundPublic = json(scorecard.body);
    unboundPublic.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE.captureState = null;
    check(candidateProspectiveRuntimeState(unboundPublic).blockers.includes("candidate-prospective-not-active"), "a SHADOW label alone does not satisfy the runtime health gate");
    const partition = scorecard.body.publicScorecard?.referenceReviewPerformance?.versionBreakdown;
    equal(partition?.groups?.[0]?.modelVersion, reference.evidenceBinding.modelVersion, "actual public scorecard exposes the reconciled frozen version labels");
    equal(partition?.groups?.[0]?.marketBreakdown?.HAD?.cumulative?.settled, 1, "actual scorecard preserves version and market denominator");
    const paired = scorecard.body.publicScorecard?.referenceReviewPerformance?.pairedBaseline;
    equal(paired?.version, "reference-paired-baseline-v1", "actual public HTTP exposes the complete-history paired count ledger");
    equal(paired?.cells?.map(c => [c.market, c.settledReferenceEvents, c.paired, c.publishedWon, c.baselineWon, c.publicOnly]),
      [["HAD", 1, 1, 1, 0, 1]], "actual database to public HTTP preserves original draw and paired market favorite counts");
    equal([paired?.recommendationCoverage, paired?.promotionEligible, paired?.parameterRevisionVerified], [null, false, false], "public count ledger does not fabricate coverage or admission");
    equal((await request("/api/db/public-reference-evidence?referenceHash=bad", admin)).status, 400, "HTTP rejects malformed hash");
    equal((await request("/api/db/public-reference-evidence?referenceHash=" + "f".repeat(64), admin)).status, 404, "HTTP reports absent reference without fabricated evidence");
    equal((await request(route, admin, "POST")).status, 405, "evidence endpoint is read-only");
    equal((await request("/data/prediction-snapshots.json")).status, 410, "full static evidence dump remains disabled");
    if (postgresOnly) {
      check(!output.join("").includes("SQLITE_FORBIDDEN_ATTEMPT"), "native HTTP and resolver workers never attempt SQLite loading");
      check(!fs.existsSync(path.join(app, "must-not-exist.sqlite")), "native HTTP never creates a fallback SQLite file");
      const backtest = spawnSync(process.execPath, [path.join(app, "scripts", "runModelBacktest.cjs")], {
        cwd: app, windowsHide: true, env: runtimeEnv, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      equal(backtest.status, 0, `native backtest CLI completes in isolated application: ${String(backtest.stderr || backtest.error || "").slice(-2000)}`);
      check(!String(backtest.stderr).includes("SQLITE_FORBIDDEN_ATTEMPT"), "actual native backtest never attempts SQLite loading");
      const evaluation = JSON.parse(fs.readFileSync(path.join(app, "public/data/model-evaluation.json"), "utf8"));
      for (const label of ["matches", "predictionSnapshots", "oddsHistory"]) {
        equal(evaluation.sample.dataSources[label].selectedSource, "postgres", `native backtest reports true ${label} storage`);
      }
      equal(evaluation.sample.dataSources.predictionSnapshots.publication.generationId, identity.generationId,
        "backtest diagnostic binds to the same immutable generation");
      const previousManifest = await realPool.query("SELECT value FROM football.projection_meta WHERE key='manifest_hash'");
      try {
        await realPool.query("UPDATE football.projection_meta SET value=$1 WHERE key='manifest_hash'", ["f".repeat(64)]);
        const session = { authorization: `Bearer ${verified.body.session.token}` };
        for (const endpoint of ["/api/v1/matches/current?view=detail", "/api/v1/matches/history?limit=7"]) {
          const blocked = await request(endpoint, session);
          equal(blocked.status, 503, "native mismatched PostgreSQL publication cannot fall back to old generation rows");
          equal(blocked.body.code, "POSTGRES_REQUIRED_READ_UNAVAILABLE", "native data outage is explicitly labeled");
        }
      } finally {
        await realPool.query("UPDATE football.projection_meta SET value=$1 WHERE key='manifest_hash'", [previousManifest.rows[0].value]);
      }
      check(!output.join("").includes("SQLITE_FORBIDDEN_ATTEMPT"), "failed native reads never probe SQLite as a recovery path");
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
};

const main = async () => {
  const match = makeMatch();
  const reference = match.predictionMeta.publicReferenceDecision;
  check(attest(reference, match), "synthetic public record is independently attested");
  const snapshot = predictionSnapshotRow(match, capturedAt);
  check(snapshot, "real source builder creates the candidate audit row");
  equal(snapshot.decisionSnapshot.clockAudit.eligible, true, "signed synthetic source clocks pass without manual eligibility flags");
  equal(snapshot.decisionSnapshot.exposure.publicEligible, false, "reference is never a formal recommendation");
  equal(snapshot.featureSnapshot, match.predictionMeta.featureSnapshot, "feature evidence preserved by source builder");
  equal(snapshot.decisionSnapshot.probabilities.HAD, { "1": 0.32, X: 0.37, "2": 0.31 }, "model probabilities remain numeric and exact");
  equal(snapshot.decisionId, match.predictionMeta.decisionId, "source decision ID retained");
  equal(snapshot.modelVersion, match.predictionMeta.modelVersion, "source model version retained");
  equal(snapshot.best.tipCode, "X", "public direction never changes to model market leader");

  const decision = snapshot.decisionSnapshot;
  const alias = { ...match, id: `fivehundred_${sourceMatchId}` };
  equal(exactDecisionEventMatch(decision, alias), true, "known internal provider aliases bind to the same official event");
  equal(exactDecisionEventMatch({ ...decision, sourceMatchId: Number(sourceMatchId) }, alias), true, "positive integer source ID equals canonical decimal text");
  equal(exactDecisionEventMatch(decision, { ...alias, kickoffTime: "2026-09-07T20:00:00+08:00" }), true, "same kickoff epoch survives timezone representation");
  equal(exactDecisionEventMatch(decision, { ...alias, kickoffTime: "2026-09-07T12:01:00.000Z" }), false, "alias cannot cross rescheduled kickoff");
  equal(exactDecisionEventMatch({ ...decision, eventVersion: match.eventVersion }, { ...alias, eventVersion: "2026-09-08T12:00:00.000Z" }), false, "explicit conflicting event version cannot alias");
  equal(exactDecisionEventMatch({ ...decision, eventVersion: "invalid" }, alias), false, "explicit malformed event version cannot match a supplied version");
  equal(exactDecisionEventMatch(decision, { ...alias, id: `unknown_${sourceMatchId}` }), false, "unknown provider prefix cannot alias");
  equal(exactDecisionEventMatch(decision, { ...alias, id: `fivehundred_${sourceMatchId}0` }), false, "provider suffix must exactly equal official source ID");
  equal(exactDecisionEventMatch(decision, { ...alias, sourceMatchId: "99000002" }), false, "contradicting explicit source ID always rejects");
  equal(exactDecisionEventMatch({ ...decision, sourceMatchId: undefined }, alias), false, "different provider IDs require explicit source on decision");
  equal(exactDecisionEventMatch(decision, { ...alias, sourceMatchId: undefined }), false, "different provider IDs require explicit source on match");
  equal(exactDecisionEventMatch({ kickoffTime: match.kickoffTime }, { kickoffTime: match.kickoffTime }), false, "time alone is never sufficient event identity");
  for (const invalid of [{}, [], true, false, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "bad\u0000id", "bad/id", "x".repeat(161)]) {
    for (const field of ["matchId", "sourceMatchId"]) {
      equal(exactDecisionEventMatch({ ...decision, [field]: invalid }, match), false,
        `supplied malformed decision ${field} must not become missing and fall back`);
    }
    for (const field of ["matchId", "id", "sourceMatchId"]) {
      equal(exactDecisionEventMatch(decision, { ...match, [field]: invalid }), false,
        `supplied malformed match ${field} must not become missing and fall back`);
    }
  }
  const identityBefore = JSON.stringify({ decision, alias });
  exactDecisionEventMatch(decision, alias);
  equal(JSON.stringify({ decision, alias }), identityBefore, "event alias check never mutates either immutable identity");
  const forgedClockClaim = json(snapshot);
  delete forgedClockClaim.decisionSnapshot.markets.HAD.provenance;
  const forgedTrace = observePredictionEvidence({ match: alias, selectedSnapshot: { snapshot: forgedClockClaim }, strictPair: null });
  equal(forgedTrace.storedClockClaimEligible, true, "negative fixture retains the previously stored eligible claim");
  equal(forgedTrace.revalidatedClockEligible, false, "alias repair still revalidates provenance instead of trusting stored eligible");
  equal(forgedTrace.stage, "clock-or-provenance-rejected", "missing signed proof stays rejected under known alias");

  // Diagnostic measurement only: do not pin implementation to a specific
  // crypto call count or wall-clock threshold. A null strict pair cannot be
  // mistaken for an already-computed successful validation.
  const originalVerify = crypto.verify;
  let observerCryptoVerifications = 0;
  const observerStarted = performance.now();
  try {
    crypto.verify = function (...args) { observerCryptoVerifications += 1; return originalVerify.apply(this, args); };
    for (let index = 0; index < 10; index += 1) {
      const trace = observePredictionEvidence({ match: alias, selectedSnapshot: { snapshot }, strictPair: null });
      equal(trace.stage, "same-decision-pair-rejected", "valid source clocks alone do not claim an accepted strict market pair");
    }
  } finally { crypto.verify = originalVerify; }
  const observerDurationMs = Number((performance.now() - observerStarted).toFixed(3));
  equal(isDecisionClockAuditEligible(decision), true, "reuse fixture first computes real full clock and signature eligibility");
  const alreadyVerifiedPair = { decision };
  let reusedObserverVerifications = 0;
  try {
    crypto.verify = function (...args) { reusedObserverVerifications += 1; return originalVerify.apply(this, args); };
    const reused = observePredictionEvidence({ match: alias, selectedSnapshot: { snapshot }, strictPair: alreadyVerifiedPair });
    equal(reused.stage, "strict-pair-accepted", "same-object successful strict pair preserves diagnostic semantics");
  } finally { crypto.verify = originalVerify; }
  equal(reusedObserverVerifications, 0, "same-object computed strict pair avoids redundant signature verification");
  const unrelatedPairTrace = observePredictionEvidence({ match: alias,
    selectedSnapshot: { snapshot: forgedClockClaim }, strictPair: alreadyVerifiedPair });
  equal(unrelatedPairTrace.stage, "clock-or-provenance-rejected", "computed eligibility of another decision cannot validate this decision");
  const strictSelfTest = spawnSync(process.execPath, [path.join(__dirname, "runModelBacktest.cjs"), "--verify-strict-promotion-cohort"], {
    cwd: rootDir, encoding: "utf8", timeout: 60000,
    env: { ...process.env, SERVER_STORE_DIR: storeDir, DATASTORE_SQLITE_PATH: dbPath,
      MODEL_BACKTEST_PUBLIC_OUTPUT_FILE: path.join(tempDir, "unused-self-test-output.json") },
  });
  equal(strictSelfTest.status, 0, `real strict-promotion self-test retains clock/provenance/market/history gates: ${strictSelfTest.stderr}`);
  const strictSelfTestResult = JSON.parse(strictSelfTest.stdout);
  equal(strictSelfTestResult.ok, true, "real backtest strict-pair alias tests pass");

  const noLegacy = bind({ ...match, status: "LIVE", predictionMeta: { ...match.predictionMeta, publicReferenceDecision: undefined } },
    null, "2026-09-07T12:01:00.000Z");
  equal(noLegacy.predictionMeta.publicReferenceDecision, undefined, "legacy missing reference proof cannot be retroactively created");
  const after = bind({ ...match, status: "LIVE", predictions: [{ ...match.predictions[0], tipCode: "1" }] },
    match, "2026-09-07T12:01:00.000Z");
  equal(after.predictionMeta.publicReferenceDecision.contentHash, reference.contentHash, "post-cutoff public hash remains unchanged");
  const archive = buildArchivedPreMatchPrediction(after, new Map(), null, "2026-09-07T12:01:00.000Z");
  equal(archive.prediction.tipCode, "X", "archive replays public draw, not later private home win");
  equal(archive.prediction.recommendationAction, "reference", "archive does not promote the reference track");
  const finished = { ...json(after), status: "FINISHED", scoreHome: 1, scoreAway: 1, archivedPreMatchPrediction: archive,
    resultProvenance: { provider: "sporttery", official: true, trusted: true, scoreHome: 1, scoreAway: 1 } };
  finished.postMatchReview = buildPostMatchReview(finished, "2026-09-07T15:00:00.000Z", new Map());
  const frozenRow = finished.postMatchReview?.predictionReview?.rows?.find(row => row.marketType === "BEST");
  check(resolveFrozenReviewVersion(finished, frozenRow), "real public capture to archive to settled version receipt validates");
  equal(frozenRow.resultStatus, "WON", "synthetic draw settles without adopting private home win");

  const payloads = {
    "matches-current.json": [match], "matches-history.json": [finished],
    "sync-meta.json": { source: "synthetic-test-only", sourceCycleId, updatedAt: publishedAt,
      predictionExecutionCapture: { persisted: true, captured: 34, attempted: 34,
        records: ["capture-private-http-canary"],
        storage: { version: "prediction-capture-capacity-v2", observedAt: new Date().toISOString(), status: "ok",
          files: 60000, bytes: 1000, nextBatchBytes: 767824, availableBytes: 100 * 1024 ** 3,
          privatePath: "capture-private-http-canary" } } },
    "external-signals.json": { source: "synthetic-test-only", updatedAt: publishedAt, matches: {} },
    "odds-history.json": { version: 3, rows: [] },
    "prediction-snapshots.json": { version: 3, updatedAt: publishedAt, rows: [snapshot], publicReferenceDecisions: [reference],
      publicReferenceEvidence: [require("../src/services/publicReferenceDecision.cjs").pendingPublicReferenceEvidence(match)].filter(Boolean) },
    "model-calibration.json": { version: "synthetic-uncalibrated", generatedAt: publishedAt },
    "model-evaluation.json": { version: "rolling-backtest-v19", generatedAt: publishedAt, sample: {} },
    "post-match-reviews.json": { version: "post-match-reviews-v2", generatedAt: "2026-09-07T15:00:00.000Z", rows: [finished.postMatchReview],
      referencePerformance: buildReferenceReviewPerformance({ matches: [finished], generatedAt: "2026-09-07T15:00:00.000Z" }) },
  };
  payloads["post-match-reviews.json"].referencePerformance = require("../server/referencePairedBaseline.cjs").buildReferencePerformanceWithPairs({
    matches: [finished], generatedAt: "2026-09-07T15:00:00.000Z", snapshotPayload: payloads["prediction-snapshots.json"], trustRegistry: trust.registry,
  });
  for (const [name, payload] of Object.entries(payloads)) writeJson(name, payload);
  commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId, committedAt: publishedAt });
  exportSuccessfully();
  const noOpGuard = new DatabaseSync(dbPath);
  try {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      // INSERT may legitimately hit ON CONFLICT without a physical write; use
      // AFTER triggers to distinguish it from an actual replacement.
      const ref = event === "DELETE" ? "OLD" : "NEW";
      noOpGuard.exec(`CREATE TRIGGER guard_reference_index_${event} AFTER ${event} ON source_snapshots
        WHEN ${ref}.source = 'sporttery:public-reference-index'
        BEGIN SELECT RAISE(ABORT, 'unchanged index was rewritten'); END;`);
    }
    equal(exportSuccessfully().fastPath.applied, false, "no-op index write guard exercises the full base exporter, not its release fast path");
  } finally {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) noOpGuard.exec(`DROP TRIGGER IF EXISTS guard_reference_index_${event}`);
    noOpGuard.close();
  }
  const identity = resolveActivePublication({ storeDir, publicDataDir }).identity;
  if (realPostgresUrl) {
    const url = new URL(realPostgresUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
      || !/^\/q2_evidence_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) throw new Error("real PostgreSQL test requires a disposable local q2_evidence_* database without URL options");
    realPool = new (require("pg").Pool)({ connectionString: realPostgresUrl, ssl: false, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    const existing = await realPool.query("SELECT to_regnamespace('football') AS namespace");
    equal(existing.rows[0].namespace, null, "real PostgreSQL test refuses an existing football schema");
    await require("../server/postgresStore.cjs").runPostgresMigrations(realPool);
    await syncPostgresProjectionFromSqlite({ dbPath, pool: realPool, mode: "backfill", aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json") });
    const retirementAudit = require("./verifyPostgresRetirementParity.cjs").verifyPostgresRetirementParity;
    const parity = await retirementAudit({ pool: realPool, sqlitePath: dbPath, storeDir, publicDataDir });
    equal(parity.ok, true, "one-time retirement audit compares every original byte and clock in the real databases");
    equal(parity.sampled, false, "retirement equality is not inferred from sampled rows");
    await realPool.query("UPDATE football.prediction_snapshots SET seen_count=seen_count+1");
    await assert.rejects(retirementAudit({ pool: realPool, sqlitePath: dbPath, storeDir, publicDataDir }), /retirement original row differs/);
    await realPool.query("UPDATE football.prediction_snapshots SET seen_count=seen_count-1");
    const snapshotTests = require("./verifyPostgresSnapshotUpsert.cjs");
    checks += snapshotTests.verifySnapshotSqlContract();
    const noOpChecks = await snapshotTests.verifySnapshotUpsertsInPostgres(realPool);
    checks += noOpChecks.checks;
    const tupleSnapshot = async () => {
      const captured = {};
      for (const table of ["match_snapshots", "source_snapshots", "odds_snapshots", "prediction_snapshots", "private_model_artifacts"]) {
        const key = table === "private_model_artifacts" ? "artifact_key" : "id";
        captured[table] = (await realPool.query(`SELECT ${key} AS id, xmin::text AS version, payload::text AS payload FROM football.${table} ORDER BY ${key}`)).rows;
      }
      return captured;
    };
    const beforeRepeat = await tupleSnapshot();
    const repeated = await syncPostgresProjectionFromSqlite({ dbPath, pool: realPool, mode: "backfill", aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json") });
    equal(repeated.skipped, false, "real repeat still runs full backfill rather than fingerprint skipping");
    equal(await tupleSnapshot(), beforeRepeat, "real full backfill preserves unchanged snapshot tuple versions and JSON order");
    const { createPostgresGenerationSource } = require("./postgresGenerationSource.cjs");
    const { syncPostgresProjectionFromSource } = require("./postgresProjectionSync.cjs");
    await syncPostgresProjectionFromSource(createPostgresGenerationSource({ storeDir, publicDataDir }), {
      pool: realPool, mode: "backfill", aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json"),
    });
    equal(await tupleSnapshot(), beforeRepeat, "direct generation migration preserves frozen decisions, evidence, raw JSON and PostgreSQL tuple versions");
    equal(await readPostgresCurrentMatches(realPool, { publicationIdentity: identity }), await readSqliteCurrentMatches(dbPath, { publicationIdentity: identity }), "real PostgreSQL driver matches SQLite current payload including immutable public record");
    equal(await readPostgresPredictionSnapshotRows(realPool, { sourceMatchId, publicationIdentity: identity }), await readSqlitePredictionSnapshotRows(dbPath, { sourceMatchId }), "real PostgreSQL candidate evidence survives actual writer and reader");
    const realEvidence = await readPostgresPublicReferenceEvidence(realPool, { referenceHash: reference.contentHash, publicationIdentity: identity });
    equal(realEvidence.evidence.featureSnapshot.modelInputs.form.home.resultEvidence.contentObservation,
      reference.dataGaps.inputSummaries.form.home.resultEvidence.contentObservation, "real PostgreSQL retains source-to-feature local receipt counters and clock without promoting them");
    equal(realEvidence, readSqlitePublicReferenceEvidence(dbPath, { referenceHash: reference.contentHash, publicationIdentity: identity }), "real PostgreSQL hash-bound evidence matches actual SQLite reader");
    verifyStoredMarketPair((await readPostgresHistoryMatchesForList(realPool, 10, { publicationIdentity: identity }))[0], realEvidence, "native PostgreSQL history and evidence readers");
    equal((await readPostgresPublicReferenceEvidence(realPool, { referenceHash: reference.contentHash, publicationIdentity: { ...identity, generationId: "wrong" } })).reason, "generation-mismatch", "real PostgreSQL refuses mismatched generation");
    await verifyEvidenceHttp(reference, identity, realPostgresUrl);
    await verifyEvidenceHttp(reference, identity, realPostgresUrl, true);
    // Force an old-clock incremental scenario in this newly created test schema only.
    await realPool.query("UPDATE football.projection_runs SET committed_at = '2026-09-10T01:00:00Z'");
  }
  const sqliteRows = await readSqlitePredictionSnapshotRows(dbPath, { sourceMatchId });
  equal(sqliteRows.length, 1, "SQLite returns exactly one semantic decision");
  equal(sqliteRows[0], json(canonicalPredictionState(snapshot).payload), "SQLite keeps the entire candidate evidence payload");
  const sqliteMatches = await readSqliteCurrentMatches(dbPath, { publicationIdentity: identity });
  equal(sqliteMatches.length, 1, "SQLite current read is publication bound");
  equal(sqliteMatches[0].predictionMeta.publicReferenceDecision, json(reference), "SQLite current payload preserves the exact public reference hash");
  equal(sqliteMatches[0].eventVersion, match.eventVersion, "SQLite current event identity retained");
  const sqliteHistory = await readSqliteHistoryMatchesForList(dbPath, 10, { publicationIdentity: identity });
  equal(sqliteHistory.length, 1, "SQLite returns the real settled fixture");
  equal(sqliteHistory[0].postMatchReview.predictionReview.rows[0].frozenVersion, json(frozenRow.frozenVersion), "SQLite preserves complete frozen review version receipt");

  const transport = capturePostgres();
  const projected = await syncPostgresProjectionFromSqlite({ dbPath, pool: transport.pool, mode: "backfill",
    aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json") });
  equal(projected.rowCounts.prediction_snapshots, 1, "real PostgreSQL writer maps one candidate payload");
  const pgRows = await readPostgresPredictionSnapshotRows(transport.pool, { sourceMatchId, publicationIdentity: identity });
  equal(pgRows, sqliteRows, "SQLite to PostgreSQL reader preserves all immutable evidence JSON");
  const pgMatches = await readPostgresCurrentMatches(transport.pool, { publicationIdentity: identity });
  equal(pgMatches, sqliteMatches, "current match payload survives real PostgreSQL SQL transport");
  const pgHistory = await readPostgresHistoryMatchesForList(transport.pool, 10, { publicationIdentity: identity });
  equal(pgHistory, sqliteHistory, "PostgreSQL history reader preserves frozen review version receipt");
  const versionSummary = compactReferenceReviewPerformance(buildReferenceReviewPerformance({ matches: pgHistory, generatedAt: "2026-09-07T15:00:00.000Z" }));
  equal(versionSummary?.versionBreakdown?.groups?.[0]?.modelVersion, reference.evidenceBinding.modelVersion, "database history builds reconciled frozen-label partition");
  if (realPool) {
    const nativeHistory = await readPostgresHistoryMatchesForList(realPool, 10, { publicationIdentity: identity });
    equal(nativeHistory, sqliteHistory, "native PostgreSQL stores and returns the frozen history receipt unchanged");
  }
  check(attest(pgMatches[0].predictionMeta.publicReferenceDecision, pgMatches[0]), "reference order-sensitive hash still verifies after both projections");
  transport.state.payloadAsText = true;
  equal(await readPostgresPredictionSnapshotRows(transport.pool, { sourceMatchId, publicationIdentity: identity }), sqliteRows,
    "PostgreSQL raw-text and driver-decoded JSON readers preserve identical candidate evidence");
  equal(await readPostgresCurrentMatches(transport.pool, { publicationIdentity: identity }), sqliteMatches,
    "PostgreSQL raw-text public reference hashes survive the alternative decoder path");
  transport.state.payloadAsText = false;
  const wrongIdentity = { ...identity, generationId: `g-${"f".repeat(64)}` };
  equal(await readPostgresPredictionSnapshotRows(transport.pool, { sourceMatchId, publicationIdentity: wrongIdentity }), [], "wrong generation cannot leak a candidate audit row");
  equal(await readSqliteCurrentMatches(dbPath, { publicationIdentity: wrongIdentity }), [], "wrong generation cannot supply public reference");
  equal(await readPostgresPredictionSnapshotRows(transport.pool, { sourceMatchId: "not-this-event", publicationIdentity: identity }), [], "source identity filter is retained in bound SQL arguments");

  const summary = compactPredictionSnapshotAudit(pgRows[0]);
  equal(summary.probabilities, snapshot.decisionSnapshot.probabilities, "admin summary probability contract");
  equal(summary.clockAudit, snapshot.decisionSnapshot.clockAudit, "admin summary exact clock audit contract");
  equal(summary.modelVersion, snapshot.modelVersion, "admin summary model version contract");
  equal(summary.featureSnapshotHash, snapshot.featureSnapshotHash, "admin summary points to retained private feature evidence");
  for (const market of ["HAD", "HHAD"]) {
    equal(summary.markets[market].odds, snapshot.decisionSnapshot.markets[market].odds, `${market} odds preserved in admin summary`);
    equal(summary.markets[market].provenanceHash, snapshot.decisionSnapshot.markets[market].provenanceHash, `${market} source proof hash retained in summary`);
    equal(summary.markets[market].provenance, undefined, "summary deliberately omits full private provenance");
  }
  equal(summary.featureSnapshot, undefined, "admin compact view is not a full private evidence endpoint");
  equal(summary.publicReferenceDecision, undefined, "candidate admin summary is not the public reference ledger");

  const checkArchive = (expectedRows, label) => {
    const sqliteArchive = readArchive();
    check(sqliteArchive, `${label}: source document exists`);
    const document = JSON.parse(sqliteArchive.payload);
    equal(document.version, ARCHIVE_VERSION, `${label}: versioned private source document`);
    equal(document.rows, json(expectedRows), `${label}: original reference records preserved without promotion`);
    equal(document.contentHash, createHash("sha256").update(JSON.stringify(expectedRows)).digest("hex"), `${label}: independent hash of exact reference sequence`);
    equal(document.sourceUpdatedAt, publishedAt, `${label}: stale candidate clock is not rewritten`);
    equal(document.lastRecordedAt, expectedRows.length ? expectedRows.at(-1).recordedAt : null, `${label}: archive clock is reference clock or null`);
    equal(sqliteArchive.captured_at, document.lastRecordedAt, `${label}: SQLite reference clock`);
    const pgArchive = (transport.tables.get("source_snapshots") || []).find((row) => row.id === SOURCE_ID);
    check(pgArchive, `${label}: actual PostgreSQL mapper emitted archive`);
    equal(pgArchive.payload, sqliteArchive.payload, `${label}: PostgreSQL transports exact hash-bound document bytes`);
    equal(document.evidenceContentHash, createHash("sha256").update(JSON.stringify(document.evidence)).digest("hex"), `${label}: exact evidence sequence hash survives projection`);
    equal(document.evidence.length, expectedRows.filter(row => row.evidenceBinding).length, `${label}: all bound revisions retain independent companions`);
    const expectedIndex = buildPublicReferenceIndex(document);
    const expectedIndexRows = [{ id: INDEX_ID, payload: JSON.stringify(expectedIndex.manifest) },
      ...expectedIndex.shards.map(row => ({ id: row.id, payload: JSON.stringify(row.payload) }))].sort((a, b) => a.id.localeCompare(b.id));
    equal(readIndexRows(), expectedIndexRows, `${label}: SQLite index is complete and exact`);
    equal((transport.tables.get("source_snapshots") || []).filter(row => row.id === INDEX_ID || row.id.startsWith(INDEX_PREFIX))
      .map(row => ({ id: row.id, payload: row.payload })).sort((a, b) => a.id.localeCompare(b.id)), expectedIndexRows, `${label}: PostgreSQL index membership and exact bytes match SQLite`);
    for (const row of expectedRows.filter(row => row.evidenceBinding)) {
      const entry = document.evidence.find(entry => entry.referenceHash === row.contentHash);
      check(require("../src/services/publicReferenceEvidence.cjs").verifyPublicReferenceEvidence(entry, row), `${label}: original feature and model hashes bind to public direction`);
    }
    return document;
  };
  checkArchive([reference], "initial");
  const evidenceOptions = { referenceHash: reference.contentHash, publicationIdentity: identity };
  const sqliteEvidence = readSqlitePublicReferenceEvidence(dbPath, evidenceOptions);
  check(sqliteEvidence.ok, "SQLite admin reader resolves the exact hash-bound evidence");
  verifyStoredMarketPair(sqliteHistory[0], sqliteEvidence, "SQLite history and evidence readers");
  equal(sqliteEvidence.evidence.publicPrediction.tipCode, "X", "admin evidence retains public draw");
  equal(sqliteEvidence.evidence.featureSnapshot.modelInputs.form.home.resultEvidence.contentObservation,
    reference.dataGaps.inputSummaries.form.home.resultEvidence.contentObservation, "actual SQLite retains separate file receipt metadata");
  for (const payloadAsText of [true, false]) {
    transport.state.payloadAsText = payloadAsText;
    equal(await readPostgresPublicReferenceEvidence(transport.pool, evidenceOptions), sqliteEvidence, "PostgreSQL admin reader preserves exact evidence for text and driver-object payloads");
    verifyStoredMarketPair(pgHistory[0], await readPostgresPublicReferenceEvidence(transport.pool, evidenceOptions), `query-capture PostgreSQL ${payloadAsText ? "text" : "object"} decoder`);
  }
  for (const [options, reason] of [
    [{ ...evidenceOptions, referenceHash: "invalid" }, "invalid-reference-hash"],
    [{ ...evidenceOptions, publicationIdentity: null }, "generation-unavailable"],
    [{ ...evidenceOptions, publicationIdentity: { ...identity, generationId: "wrong" } }, "generation-mismatch"],
    [{ ...evidenceOptions, referenceHash: "f".repeat(64) }, "reference-not-found"],
  ]) {
    equal(readSqlitePublicReferenceEvidence(dbPath, options).reason, reason, "SQLite evidence reader fails closed: " + reason);
    equal((await readPostgresPublicReferenceEvidence(transport.pool, options)).reason, reason, "PostgreSQL evidence reader fails closed: " + reason);
  }
  await verifyEvidenceHttp(reference, identity);
  check(!Object.hasOwn(pgMatches[0], "publicReferenceArchive"), "private revision ledger is not attached to public current match payload");
  equal(pgMatches[0].predictionMeta.publicReferenceDecision.contentHash, reference.contentHash, "public head binds to independent private archive record");

  // The reference records are older than the incremental six-hour cutoff, and
  // sourceUpdatedAt deliberately stays unchanged through these source revisions.
  transport.state.latestCommittedAt = "2026-09-10T01:00:00.000Z";
  const refreshArchive = async (ledger) => {
    const nextSnapshot = { ...payloads["prediction-snapshots.json"] };
    if (ledger === undefined) delete nextSnapshot.publicReferenceDecisions;
    else nextSnapshot.publicReferenceDecisions = ledger;
    writeJson("prediction-snapshots.json", nextSnapshot);
    commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId, committedAt: publishedAt });
    exportSuccessfully();
    if (realPool) {
      await syncPostgresProjectionFromSqlite({ dbPath, pool: realPool, mode: "incremental", force: true,
        aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json") });
      const realArchive = await realPool.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id = $1", [SOURCE_ID]);
      equal(realArchive.rows[0]?.payload || null, readArchive()?.payload || null, "real PostgreSQL old-clock/empty/missing ledger matches exact SQLite bytes");
      const realIndex = await realPool.query("SELECT id, payload::text AS payload FROM football.source_snapshots WHERE id = $1 OR left(id, $2) = $3 ORDER BY id", [INDEX_ID, INDEX_PREFIX.length, INDEX_PREFIX]);
      equal(realIndex.rows, readIndexRows(), "real PostgreSQL index membership and pruning match SQLite");
      if (ledger?.length) {
        const currentIdentity = resolveActivePublication({ storeDir, publicDataDir }).identity;
        for (const record of ledger) equal((await readPostgresPublicReferenceEvidence(realPool, { referenceHash: record.contentHash, publicationIdentity: currentIdentity })).ok, true, "real PostgreSQL independently resolves every retained reference revision");
      }
    }
    return syncPostgresProjectionFromSqlite({ dbPath, pool: transport.pool, mode: "incremental", force: true,
      aiArenaPath: path.join(tempDir, "absent-synthetic-ai-arena.json") });
  };
  const revisedMatch = bind({ ...match, predictionMeta: { ...match.predictionMeta, decisionId: "q1-synthetic-decision-2" },
    predictions: [{ ...match.predictions[0], odds: 3.45 }] }, match, "2026-09-07T01:01:00.000Z");
  const revision = revisedMatch.predictionMeta.publicReferenceDecision;
  payloads["prediction-snapshots.json"].publicReferenceEvidence.push(
    require("../src/services/publicReferenceDecision.cjs").pendingPublicReferenceEvidence(revisedMatch));
  equal(revision.previousHash, reference.contentHash, "new genuine pre-cutoff reference points to previous hash");
  await refreshArchive([reference, revision]);
  const changedArchive = checkArchive([reference, revision], "reference-only revision with old timestamps");
  equal(changedArchive.rows.map((row) => row.prediction.recommendationAction), ["reference", "reference"], "persisting reference revisions never promotes legacy evidence");
  equal(changedArchive.rows.map((row) => row.contentHash), [reference.contentHash, revision.contentHash], "both public hash identities can be resolved after incremental projection");
  await refreshArchive([]);
  checkArchive([], "explicitly empty ledger with null captured_at");
  await refreshArchive(undefined);
  equal(readArchive(), null, "missing source ledger removes stale SQLite proof rather than manufacturing an empty valid ledger");
  equal((transport.tables.get("source_snapshots") || []).filter((row) => row.id === SOURCE_ID), [], "actual PostgreSQL prune SQL removes the missing source document");
  equal(readIndexRows(), [], "missing ledger removes all SQLite index rows");
  equal((transport.tables.get("source_snapshots") || []).filter(row => row.id === INDEX_ID || row.id.startsWith(INDEX_PREFIX)), [], "missing ledger removes all PostgreSQL index rows");

  // A release clone stamped with the old warehouse contract must be rejected
  // before the required no-rebuild fast path; only a normal export can upgrade it.
  const writable = new DatabaseSync(dbPath);
  try {
    const policy = JSON.parse(writable.prepare("SELECT value FROM schema_meta WHERE key = 'warehouse_policy'").get().value);
    equal(policy.version, 5, "new exports acknowledge the indexed reference-evidence projection");
    equal(policy.publicReferenceArchive, ARCHIVE_VERSION, "fast path policy binds the archive contract version");
    policy.version = 3;
    delete policy.publicReferenceArchive;
    writable.prepare("UPDATE schema_meta SET value = ? WHERE key = 'warehouse_policy'").run(JSON.stringify(policy));
  } finally { writable.close(); }
  const beforeRejectedClone = fs.readFileSync(dbPath);
  const rejected = runExporter({ SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1", SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1" });
  check(rejected.status !== 0 && /warehouse-policy-mismatch/.test(rejected.stderr), "old clone cannot falsely acknowledge absent reference projection");
  equal(fs.readFileSync(dbPath), beforeRejectedClone, "required fast-path rejection does not modify old clone bytes");
  exportSuccessfully();
  const fast = exportSuccessfully({ SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1", SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1" });
  equal(fast.fastPath.applied, true, "properly rebuilt policy-v5 clone can use existing guarded fast path");

  console.log(JSON.stringify({ ok: true, checks, productionDataTouched: false,
    strictPromotionSelfTestAssertions: strictSelfTestResult.assertions,
    observerProbe: { invocations: 10, cryptoVerifications: observerCryptoVerifications, durationMs: observerDurationMs },
    reusedObserverCryptoVerifications: reusedObserverVerifications,
    postgresScope: realPool ? "disposable local PostgreSQL with real migrations, driver, full/incremental writer, readers and primary-mode HTTP; query-capture regressions also retained" : "real writer/reader with query-capture transport; no live PostgreSQL server",
    apiScope: realPool ? "isolated SQLite, hybrid PostgreSQL and PostgreSQL-only HTTP; native API and backtest forbid SQLite loading; real auth, exact frozen hash, no-store and disabled static dump" : "isolated real HTTP server with SQLite, admin auth, exact hash retrieval, no-store, input validation and disabled static dump; PostgreSQL transport remains a test double",
    publicReferenceScope: "current match head and independent revision-ledger source document; old-clock/empty/missing incremental paths" }, null, 2));
};

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (realPool) await realPool.end();
  const resolved = path.resolve(tempDir);
  if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
    || !path.basename(resolved).startsWith("football-evidence-roundtrip-")) {
    throw new Error("refusing unsafe synthetic fixture cleanup");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});
