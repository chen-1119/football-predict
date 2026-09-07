const strictAssert = require("node:assert/strict");
let assertionCount = 0;
const countAssertion = (method) => (...args) => {
  assertionCount += 1;
  return strictAssert[method](...args);
};
const assert = {
  deepEqual: countAssertion("deepEqual"),
  equal: countAssertion("equal"),
  ok: countAssertion("ok"),
  throws: countAssertion("throws"),
};
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  PREDICTION_STATE_IDENTITY_VERSION,
  canonicalOddsState,
  canonicalPredictionState,
  mergeCanonicalOddsStates,
  mergeCanonicalPredictionStates,
} = require("./sqliteWarehouse.cjs");
const {
  HHAD_COMPANION_AUDIT_KEY,
  readPrivateModelArtifact,
  writePrivateModelArtifact,
} = require("./privateModelArtifactStore.cjs");
const {
  createFastResultObservation,
} = require("./fastResultObservations.cjs");
const {
  fastResultReceiptRoot,
} = require("./fastResultReceiptIntegrity.cjs");
const {
  authorityHighWaterCandidate,
  mergeAuthorityHighWater,
  persistAuthorityHighWater,
} = require("./fastResultAuthorityHighWater.cjs");
const {
  assertActivePublicationPointerUnchanged,
  commitCurrentDataGeneration,
  resolveActivePublication,
} = require("../server/dataGenerationBundle.cjs");
const {
  acquirePointerCommitLock,
  storePaths,
} = require("../server/dataGenerationStore.cjs");
const {
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");

const rootDir = path.resolve(__dirname, "..");
const exporterPath = path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-sqlite-incremental-"));
const publicDataDir = path.join(tempDir, "public-data");
const storeDir = path.join(tempDir, "store");
const jsonlDir = path.join(storeDir, "db");
const dbPath = path.join(storeDir, "football.db");

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const writeJsonl = (filePath, rows) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
};

const appendJsonl = (filePath, rows) => {
  fs.appendFileSync(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
};

const parseExporterOutput = (result) => {
  if (result.status !== 0) {
    throw new Error(`export failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

const runExporter = (extraEnv = {}) => parseExporterOutput(spawnSync(process.execPath, [exporterPath], {
  cwd: rootDir,
  encoding: "utf8",
  env: {
    ...process.env,
    SQLITE_EXPORT_PUBLIC_DATA_DIR: publicDataDir,
    SERVER_STORE_DIR: storeDir,
    DATASTORE_SQLITE_PATH: dbPath,
    SQLITE_IMPORT_JSONL_SYNC_LIMIT: "2000",
    SQLITE_IMPORT_JSONL_MATCH_LIMIT: "20000",
    SQLITE_IMPORT_JSONL_ODDS_LIMIT: "50000",
    SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "50000",
    SQLITE_WAL_CHECKPOINT_MODE: "PASSIVE",
    ...extraEnv,
  },
}));

const fixtureOdds = (overrides = {}) => {
  const row = {
    sourceMatchId: "m1",
    matchId: "sporttery_m1",
    poolCode: "HAD",
    handicapLine: 0,
    odds1: 2.1,
    oddsX: 3.2,
    odds2: 3.4,
    oddsSource: "sporttery:HAD",
    oddsSourceMethod: "current",
    oddsSourceUrl: "https://webapi.sporttery.cn/gateway/lottery/getMatchInfoV1.qry",
    capturedAt: "2026-07-12T09:00:00.000Z",
    firstSeenAt: "2026-07-12T09:00:00.000Z",
    lastSeenAt: "2026-07-12T09:00:00.000Z",
    cutoffTime: "2026-07-12T17:55:00.000Z",
    kickoffTime: "2026-07-12T18:00:00.000Z",
    sourceCycleId: "fixture-cycle-1",
    seenCount: 1,
    stateSignature: "HAD|0|2.100|3.200|3.400",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "oddsReceivedAt")) {
    row.oddsReceivedAt = row.capturedAt;
  }
  return withOddsObservationTrail(row);
};

const fixturePrediction = (overrides = {}) => ({
  sourceMatchId: "m1",
  matchId: "sporttery_m1",
  phase: "prematch",
  signature: "BEST:1|1X2:1",
  featureSnapshotHash: "feature-a",
  capturedAt: "2026-07-12T09:30:00.000Z",
  firstSeenAt: "2026-07-12T09:30:00.000Z",
  lastSeenAt: "2026-07-12T09:30:00.000Z",
  seenCount: 1,
  probabilityFinal: { home: 48, draw: 27, away: 25 },
  ...overrides,
});

const openReadonly = () => new DatabaseSync(dbPath, { readOnly: true });

try {
  fs.mkdirSync(publicDataDir, { recursive: true });
  fs.mkdirSync(jsonlDir, { recursive: true });

  const sourceText = fs.readFileSync(exporterPath, "utf8");
  assert.equal(sourceText.includes("readJsonlTail"), false, "exporter must not scan a full JSONL tail into memory");
  assert.equal(sourceText.includes('db.exec("DELETE FROM odds_snapshots")'), false, "exporter must not delete the odds table every cycle");
  assert.equal(
    sourceText.includes('const select = db.prepare("SELECT * FROM prediction_snapshots WHERE id = ?")'),
    false,
    "the normal prediction upsert path must not transfer every existing payload into V8",
  );
  assert.equal(
    sourceText.includes('let externalSignals = loadBaseProjection'),
    true,
    "large external signals must be loaded and released before prediction and match projections",
  );
  assert.equal(
    PREDICTION_STATE_IDENTITY_VERSION,
    "prediction-state-v3",
    "prediction snapshots must use the capture-time-independent v3 semantic identity",
  );

  const identityA = canonicalOddsState(fixtureOdds());
  const identityALater = canonicalOddsState(fixtureOdds({
    lastSeenAt: "2026-07-12T14:00:00.000Z",
    oddsReceivedAt: "2026-07-12T14:00:00.000Z",
    sourceCycleId: "fixture-cycle-2",
    seenCount: 7,
  }));
  assert.equal(identityA.id, identityALater.id, "volatile observation fields must not change the stable odds id");
  const mergedIdentity = mergeCanonicalOddsStates(identityA, identityALater);
  assert.equal(mergedIdentity.capturedAt, "2026-07-12T09:00:00.000Z");
  assert.equal(mergedIdentity.lastSeenAt, "2026-07-12T14:00:00.000Z");
  assert.equal(mergedIdentity.seenCount, 7, "seenCount must use max, not sum duplicate cumulative counters");
  assert.equal(mergedIdentity.payload.observationCount, 2,
    "same-odds states must retain independently received official response times");

  const predictionIdentityA = canonicalPredictionState(fixturePrediction());
  const predictionIdentityLater = canonicalPredictionState(fixturePrediction({
    capturedAt: "2026-07-12T10:30:00.000Z",
    firstSeenAt: "2026-07-12T10:30:00.000Z",
    lastSeenAt: "2026-07-12T14:00:00.000Z",
    seenCount: 5,
  }));
  assert.equal(
    predictionIdentityA.id,
    predictionIdentityLater.id,
    "capture time must not create a second semantic prediction state"
  );
  const mergedPredictionIdentity = mergeCanonicalPredictionStates(predictionIdentityA, predictionIdentityLater);
  assert.equal(mergedPredictionIdentity.firstSeenAt, "2026-07-12T09:30:00.000Z");
  assert.equal(mergedPredictionIdentity.lastSeenAt, "2026-07-12T14:00:00.000Z");
  assert.equal(mergedPredictionIdentity.seenCount, 5);

  const currentMatch = {
    id: "sporttery_m1",
    sourceMatchId: "m1",
    kickoffTime: "2026-07-12T18:00:00.000Z",
    status: "UPCOMING",
    homeTeamName: "主队",
    awayTeamName: "客队",
  };
  const historyMatch = {
    id: "sporttery_h1",
    sourceMatchId: "h1",
    kickoffTime: "2026-07-11T18:00:00.000Z",
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-07-12T13:00:00.000Z",
      predictionReview: { settled: 1, won: 1 },
    },
  };
  const currentReviewedMatch = {
    id: "sporttery_m2",
    sourceMatchId: "m2",
    kickoffTime: "2026-07-12T16:00:00.000Z",
    status: "FINISHED",
    scoreHome: 0,
    scoreAway: 0,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-07-12T12:30:00.000Z",
      settlement: {
        resultRevision: 3,
        reviewGeneratedAt: "2026-07-12T12:31:00.000Z",
        publicationId: "existing-clock-must-survive",
      },
    },
  };
  const currentLegacyReviewedMatch = {
    id: "sporttery_m3",
    sourceMatchId: "m3",
    kickoffTime: "2026-07-12T15:00:00.000Z",
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 0,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-07-12T12:00:00.000Z",
      predictionReview: { settled: 1, won: 1 },
    },
  };
  const archivableScheduledMatch = {
    id: "sporttery_m4",
    sourceMatchId: "m4",
    kickoffTime: "2026-07-12T13:00:00.000Z",
    eventVersion: "2026-07-12T13:00:00.000Z",
    buyEndTime: "2026-07-12T12:55:00.000Z",
    status: "SCHEDULED",
    sourceStatus: "SCHEDULED",
    effectiveStatus: "SCHEDULED",
    homeTeamName: "Archive Home",
    awayTeamName: "Archive Away",
    predictions: [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "2",
      odds: 3.6,
      recommendationAction: "reference",
    }],
  };
  const archivableSnapshot = {
    sourceMatchId: "m4",
    matchId: "sporttery_m4",
    kickoffTime: archivableScheduledMatch.kickoffTime,
    eventVersion: archivableScheduledMatch.eventVersion,
    cutoffTime: archivableScheduledMatch.buyEndTime,
    capturedAt: "2026-07-12T12:30:00.000Z",
    phase: "final",
    signature: "BEST:HAD:X:reference",
    best: {
      tipCode: "X",
      oddsPoolCode: "HAD",
      odds: 3.2,
      trustScore: 62,
      recommendationAction: "reference",
      recommendationTier: "multi-factor-watch",
    },
  };
  const invalidLegacyReviewMatch = {
    id: "sporttery_h2",
    sourceMatchId: "h2",
    kickoffTime: "2026-07-10T18:00:00.000Z",
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 1,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "not-a-time",
      predictionReview: { settled: 1, won: 0 },
    },
  };
  const invalidSettlementContainerMatch = {
    id: "sporttery_h3",
    sourceMatchId: "h3",
    kickoffTime: "2026-07-09T18:00:00.000Z",
    status: "FINISHED",
    scoreHome: 3,
    scoreAway: 2,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-07-12T11:00:00.000Z",
      settlement: "explicitly-invalid-container",
    },
  };
  const invalidClockValueMatch = {
    id: "sporttery_h4",
    sourceMatchId: "h4",
    kickoffTime: "2026-07-08T18:00:00.000Z",
    status: "FINISHED",
    scoreHome: 0,
    scoreAway: 1,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-07-12T10:00:00.000Z",
      settlement: {
        resultRevision: 0,
        reviewGeneratedAt: "explicitly-not-a-time",
      },
    },
  };
  const invalidSettlementNullMatch = {
    ...invalidSettlementContainerMatch,
    id: "sporttery_h5",
    sourceMatchId: "h5",
    postMatchReview: {
      ...invalidSettlementContainerMatch.postMatchReview,
      settlement: null,
    },
  };
  const invalidSettlementArrayMatch = {
    ...invalidSettlementContainerMatch,
    id: "sporttery_h6",
    sourceMatchId: "h6",
    postMatchReview: {
      ...invalidSettlementContainerMatch.postMatchReview,
      settlement: [],
    },
  };
  const invalidSettlementNumberMatch = {
    ...invalidSettlementContainerMatch,
    id: "sporttery_h7",
    sourceMatchId: "h7",
    postMatchReview: {
      ...invalidSettlementContainerMatch.postMatchReview,
      settlement: 17,
    },
  };
  writeJson(path.join(publicDataDir, "matches-current.json"), [
    currentMatch,
    currentReviewedMatch,
    currentLegacyReviewedMatch,
    archivableScheduledMatch,
  ]);
  writeJson(path.join(publicDataDir, "matches-history.json"), [
    historyMatch,
    invalidLegacyReviewMatch,
    invalidSettlementContainerMatch,
    invalidClockValueMatch,
    invalidSettlementNullMatch,
    invalidSettlementArrayMatch,
    invalidSettlementNumberMatch,
  ]);
  writeJson(path.join(publicDataDir, "sync-meta.json"), { source: "self-test", updatedAt: "2026-07-12T14:00:00.000Z" });
  writeJson(path.join(publicDataDir, "external-signals.json"), { source: "self-test", updatedAt: "2026-07-12T14:00:00.000Z", matches: {} });
  writeJson(path.join(publicDataDir, "odds-history.json"), {
    version: 3,
    source: "sporttery:HAD+HHAD",
    writePolicy: "pre-cutoff-state-change-plus-official-receipt-trail",
    rows: [
      fixtureOdds({ lastSeenAt: "2026-07-12T13:00:00.000Z", seenCount: 7 }),
      fixtureOdds({
        odds1: 2.05,
        oddsX: 3.25,
        odds2: 3.5,
        capturedAt: "2026-07-12T11:00:00.000Z",
        firstSeenAt: "2026-07-12T11:00:00.000Z",
        lastSeenAt: "2026-07-12T11:00:00.000Z",
        stateSignature: "HAD|0|2.050|3.250|3.500",
      }),
    ],
  });
  writeJson(path.join(publicDataDir, "prediction-snapshots.json"), {
    version: 1,
    rows: [
      fixturePrediction({ lastSeenAt: "2026-07-12T13:00:00.000Z", seenCount: 4 }),
      archivableSnapshot,
    ],
  });
  const currentJsonPath = path.join(publicDataDir, "matches-current.json");
  const currentJsonBeforeExport = fs.readFileSync(currentJsonPath);

  writeJsonl(path.join(jsonlDir, "sync-runs.jsonl"), [{ id: "sync-1", at: "2026-07-12T14:00:00.000Z", source: "self-test" }]);
  writeJsonl(path.join(jsonlDir, "match-snapshots.jsonl"), [{
    id: "match-event-1",
    dataset: "current",
    capturedAt: "2026-07-12T14:00:00.000Z",
    match: currentMatch,
  }]);
  writeJsonl(path.join(jsonlDir, "odds-snapshots.jsonl"), [
    {
      id: "odds-event-a",
      sourceMatchId: "m1",
      matchId: "sporttery_m1",
      dataset: "current",
      pool: "HAD",
      bookmaker: "sporttery",
      handicap: 0,
      odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
      at: "2026-07-12T14:00:00.000Z",
      origin: "sporttery:HAD",
      sourceUrl: "https://webapi.sporttery.cn/gateway/lottery/getMatchInfoV1.qry",
      sourceMethod: "current",
      oddsReceivedAt: "2026-07-12T14:00:00.000Z",
      sourceCycleId: "fixture-jsonl-cycle-1",
      cutoffTime: "2026-07-12T17:55:00.000Z",
      kickoffTime: "2026-07-12T18:00:00.000Z",
    },
    {
      id: "odds-event-500",
      sourceMatchId: "m1",
      matchId: "sporttery_m1",
      dataset: "current",
      pool: "HAD",
      bookmaker: "500.com",
      handicap: 0,
      odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
      at: "2026-07-12T14:00:00.000Z",
      origin: "500.com:jczq",
    },
    {
      id: "odds-event-c",
      sourceMatchId: "m1",
      matchId: "sporttery_m1",
      dataset: "current",
      pool: "HAD",
      bookmaker: "sporttery",
      handicap: 0,
      odds: { odds1: 2, oddsX: 3.3, odds2: 3.6 },
      at: "2026-07-12T12:00:00.000Z",
      origin: "sporttery:HAD",
    },
  ]);
  writeJsonl(path.join(jsonlDir, "prediction-runs.jsonl"), [{
    id: "prediction-event-1",
    ...fixturePrediction({ lastSeenAt: "2026-07-12T14:00:00.000Z", seenCount: 6 }),
  }]);

  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE odds_snapshots (
      id TEXT PRIMARY KEY,
      match_id TEXT,
      source_match_id TEXT,
      pool TEXT,
      captured_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE prediction_snapshots (
      id TEXT PRIMARY KEY,
      match_id TEXT,
      source_match_id TEXT,
      phase TEXT,
      captured_at TEXT,
      payload TEXT NOT NULL
    );
  `);
  const insertOldOdds = v1.prepare("INSERT INTO odds_snapshots VALUES (?, ?, ?, ?, ?, ?)");
  for (let index = 0; index < 300; index += 1) {
    const payload = fixtureOdds({
      lastSeenAt: index % 2 ? "2026-07-12T12:00:00.000Z" : "2026-07-12T10:00:00.000Z",
      seenCount: index % 2 ? 5 : 2,
      legacyPadding: "x".repeat(2048),
    });
    insertOldOdds.run(`old-a-${index}`, "sporttery_m1", "m1", "HAD", payload.capturedAt, JSON.stringify(payload));
  }
  const oldPredictionA = fixturePrediction({ lastSeenAt: "2026-07-12T11:00:00.000Z", seenCount: 2 });
  const oldPredictionB = fixturePrediction({ lastSeenAt: "2026-07-12T12:00:00.000Z", seenCount: 3 });
  const insertOldPrediction = v1.prepare("INSERT INTO prediction_snapshots VALUES (?, ?, ?, ?, ?, ?)");
  insertOldPrediction.run("old-p-1", "sporttery_m1", "m1", "prematch", oldPredictionA.capturedAt, JSON.stringify(oldPredictionA));
  insertOldPrediction.run("old-p-2", "sporttery_m1", "m1", "prematch", oldPredictionB.capturedAt, JSON.stringify(oldPredictionB));
  v1.close();

  const privateArtifactFixture = {
    version: "hhad-companion-shadow-evaluation-v1",
    evaluatedAt: "2026-07-12T14:00:00.000Z",
    counts: { finalRevisions: 1, settlementRows: 1 },
    finalExposureRows: [{ matchId: "private-fixture" }],
    settlementRows: [{ matchId: "private-fixture", status: "won" }],
  };
  const privateArtifactBeforeExport = writePrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    artifactVersion: privateArtifactFixture.version,
    generatedAt: privateArtifactFixture.evaluatedAt,
    payload: privateArtifactFixture,
  });

  const first = runExporter({ SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE" });
  assert.equal(first.ok, true);
  assert.equal(first.schemaVersion, "football-sqlite-v2-incremental");
  assert.equal(first.migration.odds.migrated, true, "v1 odds table must migrate in one transaction");
  assert.equal(first.migration.odds.scanned, 300);
  assert.equal(first.migration.odds.canonicalStates, 1, "300 duplicate v1 rows must collapse to one state");
  assert.equal(first.migration.predictions.migrated, true);
  assert.equal(first.walCheckpoint.ok, true, "idle TRUNCATE checkpoint must be reported complete");
  assert.equal(first.incremental.jsonl.oddsSnapshots.startOffset, 0);
  assert.equal(first.incremental.jsonl.oddsSnapshots.endOffset, fs.statSync(path.join(jsonlDir, "odds-snapshots.jsonl")).size);

  let db = openReadonly();
  let columns = new Set(db.prepare("PRAGMA table_info(odds_snapshots)").all().map((row) => row.name));
  assert.equal(columns.has("state_key"), true);
  assert.equal(columns.has("last_seen_at"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM odds_snapshots").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prediction_snapshots").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM private_model_artifacts").get().count, 1,
    "incremental export must preserve private model artifacts");
  const migratedLegacyReview = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'history:sporttery_h1'"
  ).get().payload);
  assert.equal(migratedLegacyReview.postMatchReview.settlement.resultRevision, 1,
    "legacy reviews must become the first known result revision");
  assert.equal(
    migratedLegacyReview.postMatchReview.settlement.reviewGeneratedAt,
    historyMatch.postMatchReview.generatedAt,
    "legacy review clocks must reuse the persisted review time, not export time",
  );
  assert.deepEqual(migratedLegacyReview.postMatchReview.predictionReview, historyMatch.postMatchReview.predictionReview,
    "review-clock migration must not change review semantics");
  const migratedCurrentLegacyReview = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'current:sporttery_m3'"
  ).get().payload);
  assert.equal(migratedCurrentLegacyReview.postMatchReview.settlement.resultRevision, 1,
    "the current dataset must apply the same legacy review migration");
  assert.equal(
    migratedCurrentLegacyReview.postMatchReview.settlement.reviewGeneratedAt,
    currentLegacyReviewedMatch.postMatchReview.generatedAt,
    "current legacy review clocks must reuse their persisted review time",
  );
  const preservedReviewClock = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'current:sporttery_m2'"
  ).get().payload);
  assert.deepEqual(
    preservedReviewClock.postMatchReview.settlement,
    currentReviewedMatch.postMatchReview.settlement,
    "an existing monotonic review clock must remain byte-for-byte equivalent",
  );
  const projectedArchiveMatch = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'current:sporttery_m4'"
  ).get().payload);
  assert.equal(
    projectedArchiveMatch.archivedPreMatchPrediction?.prediction?.tipCode,
    "X",
    "SQLite projection must freeze the pre-cutoff snapshot direction after kickoff",
  );
  assert.equal(
    projectedArchiveMatch.archivedPreMatchPrediction?.capturedAt,
    archivableSnapshot.capturedAt,
    "projected archive must retain the immutable snapshot clock",
  );
  assert.equal(
    projectedArchiveMatch.archivedPreMatchPrediction?.marketEvidenceScope,
    "result-pool",
    "official HAD snapshot must remain a result-pool archive",
  );
  assert.equal(
    fs.readFileSync(currentJsonPath).equals(currentJsonBeforeExport),
    true,
    "SQLite archive materialization must not rewrite source JSON",
  );
  const projectedArchiveBytes = JSON.stringify(projectedArchiveMatch.archivedPreMatchPrediction);
  const invalidLegacyReview = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'history:sporttery_h2'"
  ).get().payload);
  assert.equal(invalidLegacyReview.postMatchReview.settlement, undefined,
    "an invalid legacy timestamp must remain unmodified so readiness fails closed");
  const invalidSettlementContainer = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'history:sporttery_h3'"
  ).get().payload);
  assert.equal(
    invalidSettlementContainer.postMatchReview.settlement,
    invalidSettlementContainerMatch.postMatchReview.settlement,
    "an explicit invalid settlement container must remain unmodified so readiness fails closed",
  );
  const invalidClockValue = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'history:sporttery_h4'"
  ).get().payload);
  assert.deepEqual(
    invalidClockValue.postMatchReview.settlement,
    invalidClockValueMatch.postMatchReview.settlement,
    "explicit invalid clock values must never be replaced with a fabricated baseline",
  );
  for (const invalidContainerMatch of [
    invalidSettlementNullMatch,
    invalidSettlementArrayMatch,
    invalidSettlementNumberMatch,
  ]) {
    const persistedMatch = JSON.parse(db.prepare(
      "SELECT payload FROM match_snapshots WHERE id = ?"
    ).get(`history:${invalidContainerMatch.id}`).payload);
    assert.deepEqual(
      persistedMatch.postMatchReview.settlement,
      invalidContainerMatch.postMatchReview.settlement,
      `explicit invalid settlement container for ${invalidContainerMatch.id} must remain unchanged`,
    );
  }
  const officialA = db.prepare(`
    SELECT captured_at, first_seen_at, last_seen_at, seen_count, payload
    FROM odds_snapshots
    WHERE source_match_id = 'm1' AND bookmaker = 'sporttery'
      AND json_extract(payload, '$.stateSignature') = 'HAD|0|2.100|3.200|3.400'
  `).get();
  assert.equal(officialA.captured_at, "2026-07-12T09:00:00.000Z", "captured_at must remain earliest for as-of model safety");
  assert.equal(officialA.first_seen_at, "2026-07-12T09:00:00.000Z");
  assert.equal(officialA.last_seen_at, "2026-07-12T14:00:00.000Z");
  assert.equal(officialA.seen_count, 7, "cumulative duplicate counters must merge by max");
  assert.equal(JSON.parse(officialA.payload).observationCount, 2,
    "warehouse merge must retain public and JSONL official receipt observations");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM odds_snapshots WHERE bookmaker = '500.com'").get().count, 1,
    "bookmakers with identical odds must remain separate states");
  assert.equal(Object.values(db.prepare("PRAGMA quick_check").get())[0], "ok");
  db.close();
  const privateArtifactAfterMigration = readPrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
  });
  assert.equal(privateArtifactAfterMigration.payloadSha256, privateArtifactBeforeExport.payloadSha256,
    "warehouse migration must preserve private artifact bytes and hash");
  assert.deepEqual(privateArtifactAfterMigration.payload, privateArtifactFixture);

  const firstCounts = first.counts;
  const second = runExporter({ SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE" });
  assert.deepEqual(second.counts, firstCounts, "a no-op second export must keep all table counts stable");
  assert.equal(second.migration.odds.migrated, false);
  assert.equal(second.incremental.matchChanges, 0,
    "a second export must not rewrite matches after the one-time legacy clock migration");
  assert.equal(second.incremental.jsonl.oddsSnapshots.rows, 0);
  assert.equal(second.incremental.jsonl.oddsSnapshots.bytesRead, 0, "unchanged JSONL must not be rescanned");
  assert.equal(second.incremental.oddsChanges, 0, "unchanged odds states must not be rewritten");
  assert.equal(second.incremental.predictionChanges, 0, "unchanged prediction states must not be rewritten");
  db = openReadonly();
  const repeatedArchiveMatch = JSON.parse(db.prepare(
    "SELECT payload FROM match_snapshots WHERE id = 'current:sporttery_m4'"
  ).get().payload);
  assert.equal(
    JSON.stringify(repeatedArchiveMatch.archivedPreMatchPrediction),
    projectedArchiveBytes,
    "repeated exports must preserve the frozen archive byte-for-byte",
  );
  db.close();

  const oddsPath = path.join(jsonlDir, "odds-snapshots.jsonl");
  appendJsonl(oddsPath, [
    {
      id: "odds-event-a-later",
      sourceMatchId: "m1",
      matchId: "sporttery_m1",
      dataset: "current",
      pool: "HAD",
      bookmaker: "sporttery",
      handicap: 0,
      odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
      at: "2026-07-12T15:00:00.000Z",
      origin: "sporttery:HAD",
      sourceUrl: "https://webapi.sporttery.cn/gateway/lottery/getMatchInfoV1.qry",
      sourceMethod: "current",
      oddsReceivedAt: "2026-07-12T15:00:00.000Z",
      sourceCycleId: "fixture-jsonl-cycle-2",
      cutoffTime: "2026-07-12T17:55:00.000Z",
      kickoffTime: "2026-07-12T18:00:00.000Z",
    },
    {
      id: "odds-event-d",
      sourceMatchId: "m1",
      matchId: "sporttery_m1",
      dataset: "current",
      pool: "HAD",
      bookmaker: "sporttery",
      handicap: 0,
      odds: { odds1: 1.95, oddsX: 3.4, odds2: 3.8 },
      at: "2026-07-12T15:00:00.000Z",
      origin: "sporttery:HAD",
    },
  ]);
  const third = runExporter({ SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE" });
  assert.equal(third.incremental.jsonl.oddsSnapshots.rows, 2);
  assert.equal(third.counts.oddsSnapshots, firstCounts.oddsSnapshots + 1, "one duplicate and one new state must add only one row");
  db = openReadonly();
  const officialALater = db.prepare(`
    SELECT captured_at, last_seen_at, seen_count, payload
    FROM odds_snapshots
    WHERE source_match_id = 'm1' AND bookmaker = 'sporttery'
      AND json_extract(payload, '$.stateSignature') = 'HAD|0|2.100|3.200|3.400'
  `).get();
  assert.equal(officialALater.captured_at, "2026-07-12T09:00:00.000Z");
  assert.equal(officialALater.last_seen_at, "2026-07-12T15:00:00.000Z");
  assert.equal(officialALater.seen_count, 7);
  assert.equal(JSON.parse(officialALater.payload).observationCount, 3,
    "incremental export must append a later independent official response without adding a state row");
  db.close();

  const reader = openReadonly();
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM odds_snapshots").get();
  appendJsonl(oddsPath, [{
    id: "odds-event-e",
    sourceMatchId: "m1",
    matchId: "sporttery_m1",
    dataset: "current",
    pool: "HAD",
    bookmaker: "sporttery",
    handicap: 0,
    odds: { odds1: 1.9, oddsX: 3.5, odds2: 4 },
    at: "2026-07-12T15:10:00.000Z",
    origin: "sporttery:HAD",
  }]);
  const withReader = runExporter({ SQLITE_WAL_CHECKPOINT_MODE: "PASSIVE" });
  assert.equal(withReader.ok, true, "an active reader must not make committed export data fail");
  if (withReader.walCheckpoint.logFrames > withReader.walCheckpoint.checkpointedFrames) {
    assert.equal(withReader.walCheckpoint.ok, false, "an incomplete checkpoint must never be reported as successful");
    assert.equal(withReader.walCheckpoint.reason, "checkpoint-incomplete");
  }
  reader.exec("ROLLBACK");
  reader.close();

  const deniedVacuum = runExporter({
    SQLITE_VACUUM_AFTER_EXPORT: "1",
    SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE",
  });
  assert.equal(deniedVacuum.vacuum.requested, true);
  assert.equal(deniedVacuum.vacuum.allowed, false, "vacuum must be denied outside the explicit stopped-release window");

  const beforeVacuumBytes = fs.statSync(dbPath).size;
  const vacuumed = runExporter({
    SQLITE_VACUUM_AFTER_EXPORT: "1",
    SQLITE_MAINTENANCE_WINDOW: "release-stopped",
    SQLITE_VACUUM_MIN_FREE_RATIO: "0",
    SQLITE_VACUUM_MIN_FREE_PAGES: "1",
    SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE",
  });
  assert.equal(vacuumed.vacuum.allowed, true);
  assert.equal(vacuumed.vacuum.performed, true, "explicit stopped-release maintenance must compact a bloated v1 migration");
  assert.ok(fs.statSync(dbPath).size < beforeVacuumBytes, "controlled VACUUM INTO must reduce the migrated database size");
  db = openReadonly();
  assert.equal(Object.values(db.prepare("PRAGMA quick_check").get())[0], "ok");
  assert.equal(Object.values(db.prepare("PRAGMA journal_mode").get())[0], "wal",
    "the atomically installed VACUUM output must remain in WAL mode");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM odds_snapshots").get().count, withReader.counts.oddsSnapshots);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM private_model_artifacts").get().count, 1,
    "controlled VACUUM must retain the dedicated private artifact table");
  db.close();
  assert.equal(readPrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
  }).payloadSha256, privateArtifactBeforeExport.payloadSha256,
  "controlled VACUUM must preserve the private artifact hash");

  const fastGuardDir = path.join(tempDir, "fast-result-export-guard");
  const fastGuardPublicDir = path.join(fastGuardDir, "public-data");
  const fastGuardStoreDir = path.join(fastGuardDir, "store");
  const fastGuardDbPath = path.join(fastGuardStoreDir, "football.db");
  const fastGuardEnv = {
    SQLITE_EXPORT_PUBLIC_DATA_DIR: fastGuardPublicDir,
    SERVER_STORE_DIR: fastGuardStoreDir,
    DATASTORE_SQLITE_PATH: fastGuardDbPath,
    SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
    SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
    SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
    SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
    SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE",
  };
  const guardedKickoff = "2026-07-13T10:00:00.000Z";
  const staleGuardedCurrent = {
    id: "sporttery_guard-1001",
    sourceMatchId: "guard-1001",
    eventVersion: guardedKickoff,
    kickoffTime: guardedKickoff,
    status: "PENDING_RESULT",
    effectiveStatus: "PENDING_RESULT",
    homeTeamId: "guard-home",
    awayTeamId: "guard-away",
  };
  const rescheduledCurrent = {
    ...staleGuardedCurrent,
    id: "sporttery_guard-1001-rescheduled",
    eventVersion: "2026-07-20T10:00:00.000Z",
    kickoffTime: "2026-07-20T10:00:00.000Z",
    status: "UPCOMING",
    effectiveStatus: "SCHEDULED",
  };
  const staleGuardedHistory = {
    ...staleGuardedCurrent,
    status: "FINISHED",
    effectiveStatus: "FINISHED",
    scoreHome: 0,
    scoreAway: 0,
    postMatchReview: { marker: "stale-static-history-must-not-win" },
  };
  writeJson(path.join(fastGuardPublicDir, "matches-current.json"), [
    staleGuardedCurrent,
    rescheduledCurrent,
  ]);
  writeJson(path.join(fastGuardPublicDir, "matches-history.json"), [staleGuardedHistory]);
  writeJson(path.join(fastGuardPublicDir, "sync-meta.json"), {
    source: "stale-full-sync",
    updatedAt: "2026-07-13T10:01:00.000Z",
  });
  const guardSeed = runExporter(fastGuardEnv);
  assert.equal(guardSeed.ok, true, "isolated fast-result guard database must initialize");

  const fastFinal = {
    ...staleGuardedCurrent,
    id: "fivehundred_guard-1001",
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    statusReason: "official-sporttery-final",
    scoreHome: 2,
    scoreAway: 1,
    resultObservedAt: "2026-07-13T12:00:01.000Z",
    settledAt: "2026-07-13T12:00:02.000Z",
    sourceCycleId: "relay:guard-cycle",
    datasetRevision: "sqlite-fast-result-r7",
    resultProvenance: {
      provider: "sporttery",
      official: true,
      trusted: true,
      sourceMatchId: "guard-1001",
      sourceStatus: "FINISHED",
      scoreHome: 2,
      scoreAway: 1,
      eventVersion: guardedKickoff,
      kickoffTime: guardedKickoff,
    },
    postMatchReview: { marker: "exact-fast-audit-payload" },
  };
  const observation = createFastResultObservation(fastFinal, {
    publishedAt: "2026-07-13T12:00:03.000Z",
    sourceCycleId: fastFinal.sourceCycleId,
    datasetRevision: fastFinal.datasetRevision,
  });
  assert.ok(observation, "trusted fast final fixture must produce an immutable observation");
  const fastReceipt = {
    version: "sqlite-fast-result-receipt-v2",
    revision: 7,
    publishedAt: "2026-07-13T12:00:03.000Z",
    sourceCycleId: fastFinal.sourceCycleId,
    datasetRevision: fastFinal.datasetRevision,
    publishedRows: 1,
    observations: [observation],
  };
  fastReceipt.observationsRootHash = fastResultReceiptRoot(fastReceipt.observations);
  const exactFastPayload = JSON.stringify(fastFinal);
  const exactReceiptPayload = JSON.stringify(fastReceipt);
  const exactReceiptUpdatedAt = "2026-07-13T12:00:03.000Z";
  let fastGuardDb = new DatabaseSync(fastGuardDbPath);
  fastGuardDb.exec("BEGIN IMMEDIATE");
  fastGuardDb.prepare("DELETE FROM match_snapshots").run();
  fastGuardDb.prepare(`
    INSERT INTO match_snapshots
      (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
    VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
  `).run(
    "history:fivehundred_guard-1001",
    fastFinal.id,
    fastFinal.sourceMatchId,
    fastFinal.kickoffTime,
    exactFastPayload
  );
  const upsertFastMeta = fastGuardDb.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsertFastMeta.run("fast_result_receipt", exactReceiptPayload, exactReceiptUpdatedAt);
  upsertFastMeta.run("fast_result_revision", "7", exactReceiptUpdatedAt);
  upsertFastMeta.run(
    "fast_result_source_cycle_id",
    fastFinal.sourceCycleId,
    exactReceiptUpdatedAt,
  );
  upsertFastMeta.run(
    "fast_result_dataset_revision",
    fastFinal.datasetRevision,
    exactReceiptUpdatedAt,
  );
  const authorityMerge = mergeAuthorityHighWater(
    { valid: true, missing: true, initialized: false, rows: [] },
    [authorityHighWaterCandidate({
      match: fastFinal,
      observedAt: fastFinal.resultObservedAt,
      sourceCycleId: fastFinal.sourceCycleId,
      resultProbeRevisionId: "guard-probe-r1",
    })],
  );
  assert.equal(authorityMerge.valid, true);
  persistAuthorityHighWater(fastGuardDb, authorityMerge, exactReceiptUpdatedAt);
  fastGuardDb.exec("COMMIT");
  fastGuardDb.close();

  const guardedExport = runExporter(fastGuardEnv);
  assert.equal(guardedExport.ok, true, "stale static export must complete under fast-result guard");
  assert.equal(guardedExport.incremental.fastResultGuard.preservedHistoryRows, 1);
  assert.equal(guardedExport.incremental.fastResultGuard.skippedCurrentRows, 1,
    "same-event stale current must not be reinserted");
  assert.equal(guardedExport.incremental.fastResultGuard.skippedHistoryRows, 1,
    "same-event stale history must not overwrite the fast audit payload");

  fastGuardDb = new DatabaseSync(fastGuardDbPath, { readOnly: true });
  const guardedHistoryRows = fastGuardDb.prepare(`
    SELECT id, payload
    FROM match_snapshots
    WHERE dataset = 'history' AND source_match_id = 'guard-1001'
  `).all();
  const guardedCurrentRows = fastGuardDb.prepare(`
    SELECT payload
    FROM match_snapshots
    WHERE dataset = 'current' AND source_match_id = 'guard-1001'
  `).all().map((row) => JSON.parse(row.payload));
  const persistedReceipt = fastGuardDb.prepare(`
    SELECT value, updated_at
    FROM schema_meta
    WHERE key = 'fast_result_receipt'
  `).get();
  assert.equal(guardedHistoryRows.length, 1, "fast official final must survive history pruning");
  assert.equal(guardedHistoryRows[0].payload, exactFastPayload,
    "fast official final payload must remain byte-for-byte exact");
  assert.deepEqual(guardedCurrentRows.map((match) => match.id), [rescheduledCurrent.id],
    "only the genuinely rescheduled event may remain current");
  assert.equal(persistedReceipt.value, exactReceiptPayload,
    "static export must not overwrite the fast-result receipt value");
  assert.equal(persistedReceipt.updated_at, exactReceiptUpdatedAt,
    "static export must not rewrite the fast-result receipt timestamp");
  fastGuardDb.close();

  const canonicalReview = {
    version: "post-match-review-v2",
    generatedAt: "2026-07-13T12:00:04.000Z",
    matchId: "sporttery_guard-1001",
    sourceMatchId: "guard-1001",
    eventVersion: guardedKickoff,
    finalScore: "2-1",
    settlement: {
      resultRevision: 7,
      reviewGeneratedAt: "2026-07-13T12:00:04.000Z",
    },
    predictionReview: { settled: 0, won: 0, rows: [] },
  };
  const canonicalGenerationFinal = {
    ...fastFinal,
    id: "sporttery_guard-1001",
    postMatchReview: canonicalReview,
  };
  writeJson(path.join(fastGuardPublicDir, "matches-current.json"), [rescheduledCurrent]);
  writeJson(path.join(fastGuardPublicDir, "matches-history.json"), [canonicalGenerationFinal]);
  writeJson(path.join(fastGuardPublicDir, "sync-meta.json"), {
    source: "reconciled-generation",
    sourceCycleId: fastFinal.sourceCycleId,
    updatedAt: "2026-07-13T12:00:05.000Z",
    fastResultGenerationRevision: fastReceipt.revision,
    fastResultGenerationReconciledAt: "2026-07-13T12:00:05.000Z",
    fastResultGenerationReconciliation: {
      version: "fast-result-generation-reconciliation-v1",
      receiptRevision: fastReceipt.revision,
      publishedAt: fastReceipt.publishedAt,
      sourceCycleId: fastReceipt.sourceCycleId,
      datasetRevision: fastReceipt.datasetRevision,
      rows: 1,
      recoveredRows: 0,
    },
  });
  writeJson(path.join(fastGuardPublicDir, "external-signals.json"), {
    source: "reconciled-generation",
    updatedAt: "2026-07-13T12:00:05.000Z",
    matches: {},
  });
  writeJson(path.join(fastGuardPublicDir, "odds-history.json"), { version: 1, rows: [] });
  writeJson(path.join(fastGuardPublicDir, "prediction-snapshots.json"), { version: 1, rows: [] });
  writeJson(path.join(fastGuardPublicDir, "model-calibration.json"), {
    version: "reconciled-generation-calibration-v1",
    generatedAt: "2026-07-13T12:00:05.000Z",
  });
  const canonicalGeneration = commitCurrentDataGeneration({
    storeDir: fastGuardStoreDir,
    publicDataDir: fastGuardPublicDir,
    sourceCycleId: fastFinal.sourceCycleId,
    committedAt: "2026-07-13T12:00:06.000Z",
  });
  assert.ok(canonicalGeneration.pointer.generationId,
    "canonical fast-result fixture must be committed as an immutable generation");

  const staleSameGenerationClonePath = path.join(fastGuardDir, "release-clone", "football.db");
  fs.mkdirSync(path.dirname(staleSameGenerationClonePath), { recursive: true });
  fs.copyFileSync(fastGuardDbPath, staleSameGenerationClonePath);
  let staleSameGenerationClone = new DatabaseSync(staleSameGenerationClonePath);
  const setCloneMeta = staleSameGenerationClone.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, value] of [
    ["data_publication_mode", "active-generation"],
    ["data_generation_id", canonicalGeneration.pointer.generationId],
    ["manifest_hash", canonicalGeneration.pointer.manifestHash],
    ["data_generation_source_cycle_id", canonicalGeneration.pointer.sourceCycleId],
    ["committed_at", canonicalGeneration.pointer.committedAt],
  ]) setCloneMeta.run(key, value || "", canonicalGeneration.pointer.committedAt);
  staleSameGenerationClone.close();

  const reconciledGuardExport = runExporter({
    ...fastGuardEnv,
    DATASTORE_SQLITE_PATH: staleSameGenerationClonePath,
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
  });
  assert.equal(reconciledGuardExport.ok, true,
    "a generation bound to the exact receipt must replace a legacy guarded alias");
  assert.equal(reconciledGuardExport.fastPath.applied, false,
    "a same-generation clone without the reconciliation projection stamp must replay once");
  assert.equal(
    reconciledGuardExport.fastPath.reason,
    "identity-mismatch:fast_result_generation_reconciliation",
    "the fast path must identify the missing projection acknowledgment precisely",
  );
  assert.equal(reconciledGuardExport.incremental.fastResultGuard.rebasedHistoryRows, 1);
  assert.equal(reconciledGuardExport.incremental.fastResultGuard.skippedHistoryRows, 0);
  fastGuardDb = new DatabaseSync(staleSameGenerationClonePath, { readOnly: true });
  const reconciledGuardRows = fastGuardDb.prepare(`
    SELECT id, match_id, payload
    FROM match_snapshots
    WHERE dataset = 'history' AND source_match_id = 'guard-1001'
  `).all();
  assert.equal(reconciledGuardRows.length, 1,
    "canonical rebase must not leave both fivehundred and sporttery aliases");
  assert.equal(reconciledGuardRows[0].id, "history:sporttery_guard-1001");
  assert.equal(reconciledGuardRows[0].match_id, "sporttery_guard-1001");
  const reconciledGuardPayload = JSON.parse(reconciledGuardRows[0].payload);
  assert.equal(reconciledGuardPayload.id, "sporttery_guard-1001");
  assert.equal(reconciledGuardPayload.scoreHome, fastFinal.scoreHome,
    "canonical rebase must retain the receipt-bound official score");
  assert.equal(reconciledGuardPayload.scoreAway, fastFinal.scoreAway,
    "canonical rebase must retain the receipt-bound official score");
  assert.equal(reconciledGuardPayload.postMatchReview.eventVersion, guardedKickoff,
    "canonical rebase must carry the reconciled embedded review event identity");
  assert.equal(reconciledGuardPayload.postMatchReview.matchId, canonicalReview.matchId,
    "canonical rebase must project the immutable generation review identity");
  assert.equal(reconciledGuardPayload.postMatchReview.generatedAt, canonicalReview.generatedAt,
    "canonical rebase must retain the immutable generation review clock");
  assert.deepEqual(reconciledGuardPayload.postMatchReview, canonicalReview,
    "canonical rebase must retain exact embedded/standalone review parity");
  assert.equal(
    JSON.parse(fastGuardDb.prepare(
      "SELECT value FROM schema_meta WHERE key = 'fast_result_generation_reconciliation'"
    ).get().value).receiptRevision,
    fastReceipt.revision,
    "SQLite must record which reconciled generation was actually projected",
  );
  fastGuardDb.close();

  const activeRoot = path.join(tempDir, "active-generation-fast-path");
  const activePublicDir = path.join(activeRoot, "public-data");
  const activeStoreDir = path.join(activeRoot, "store");
  const activeDbPath = path.join(activeRoot, "release-clone", "football.db");
  const activeSourceCycleId = "active-fast-path-cycle-1";
  const { bindPublicReferenceDecision, pendingPublicReferenceEvidence } = require("../src/services/publicReferenceDecision.cjs");
  const referenceMatch = bindPublicReferenceDecision({
    id: "sporttery_policy_upgrade", sourceMatchId: "policy_upgrade", status: "SCHEDULED", businessDate: "2026-07-13",
    kickoffTime: "2026-07-13T12:00:00.000Z", eventVersion: "2026-07-13T12:00:00.000Z", buyEndTime: "2026-07-13T11:55:00.000Z",
    odds: { odds1: 2, oddsX: 3.4, odds2: 4 },
    predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4 }],
    predictionMeta: { generatedAt: "2026-07-12T13:00:00.000Z", decisionId: "policy-upgrade-reference", modelVersion: "fixture", policyVersion: "fixture",
      featureSnapshot: { version: "fixture", capturedAt: "2026-07-12T13:00:00.000Z", sourceMatchId: "policy_upgrade", kickoffTime: "2026-07-13T12:00:00.000Z", modelInputs: {} } },
    probabilityModel: { version: "fixture", generatedAt: "2026-07-12T13:00:00.000Z", oneXTwo: { final: { home: 35, draw: 40, away: 25 } } },
  }, null, "2026-07-12T13:00:01.000Z");
  writeJson(path.join(activePublicDir, "matches-current.json"), [currentMatch]);
  writeJson(path.join(activePublicDir, "matches-history.json"), [historyMatch]);
  writeJson(path.join(activePublicDir, "sync-meta.json"), {
    source: "active-fast-path-test",
    sourceCycleId: activeSourceCycleId,
    updatedAt: "2026-07-12T14:00:00.000Z",
  });
  writeJson(path.join(activePublicDir, "external-signals.json"), {
    source: "active-fast-path-test",
    updatedAt: "2026-07-12T14:00:00.000Z",
    matches: {},
  });
  writeJson(path.join(activePublicDir, "odds-history.json"), {
    version: 3,
    rows: [fixtureOdds()],
  });
  writeJson(path.join(activePublicDir, "prediction-snapshots.json"), {
    version: 1,
    rows: [fixturePrediction()],
    publicReferenceDecisions: [referenceMatch.predictionMeta.publicReferenceDecision],
    publicReferenceEvidence: [pendingPublicReferenceEvidence(referenceMatch)],
  });
  writeJson(path.join(activePublicDir, "model-calibration.json"), {
    version: "active-fast-path-calibration-v1",
    generatedAt: "2026-07-12T14:00:00.000Z",
  });
  const committedGeneration = commitCurrentDataGeneration({
    storeDir: activeStoreDir,
    publicDataDir: activePublicDir,
    sourceCycleId: activeSourceCycleId,
    committedAt: "2026-07-12T14:01:00.000Z",
  });
  assert.equal(committedGeneration.pointer.sourceCycleId, activeSourceCycleId);

  const activeEnv = {
    SQLITE_EXPORT_PUBLIC_DATA_DIR: activePublicDir,
    SERVER_STORE_DIR: activeStoreDir,
    DATASTORE_SQLITE_PATH: activeDbPath,
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "0",
    SQLITE_WAL_CHECKPOINT_MODE: "TRUNCATE",
  };
  const activeSeed = runExporter(activeEnv);
  assert.equal(activeSeed.fastPath.requested, false);
  assert.equal(activeSeed.fastPath.applied, false,
    "ordinary writable-pointer exports must never take the release clone fast path");
  assert.throws(
    () => runExporter({
      ...activeEnv,
      SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1",
    }),
    /SQLITE_EXPORT_CONFIGURATION_INVALID|required active-generation fast path needs a read-only source pointer/,
    "required release fast path must reject a writable source pointer",
  );

  const canonicalLiveDbPath = path.join(activeStoreDir, "football.db");
  fs.copyFileSync(activeDbPath, canonicalLiveDbPath);
  const canonicalLiveAttempt = runExporter({
    ...activeEnv,
    DATASTORE_SQLITE_PATH: canonicalLiveDbPath,
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
  });
  assert.equal(canonicalLiveAttempt.fastPath.applied, false,
    "release fast path must never run against the canonical live database");
  assert.equal(canonicalLiveAttempt.fastPath.reason, "clone-path-is-live-database");
  fs.rmSync(canonicalLiveDbPath, { force: true });

  const incompleteClonePath = path.join(activeRoot, "release-clone-incomplete", "football.db");
  fs.mkdirSync(path.dirname(incompleteClonePath), { recursive: true });
  fs.copyFileSync(activeDbPath, incompleteClonePath);
  let incompleteClone = new DatabaseSync(incompleteClonePath);
  incompleteClone.exec("DROP TABLE odds_snapshots");
  incompleteClone.close();
  const incompleteCloneAttempt = runExporter({
    ...activeEnv,
    DATASTORE_SQLITE_PATH: incompleteClonePath,
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
  });
  assert.equal(incompleteCloneAttempt.fastPath.applied, false,
    "an identity-matching clone with a missing business table must use the repairing full export");
  assert.equal(incompleteCloneAttempt.fastPath.reason, "required-table-missing:odds_snapshots");
  incompleteClone = new DatabaseSync(incompleteClonePath, { readOnly: true });
  assert.equal(incompleteClone.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'odds_snapshots'"
  ).get().count, 1, "full fallback must repair the missing business table");
  incompleteClone.close();

  const requiredFastPathClone = path.join(activeRoot, "release-clone-required-fast", "football.db");
  fs.mkdirSync(path.dirname(requiredFastPathClone), { recursive: true });
  fs.copyFileSync(activeDbPath, requiredFastPathClone);
  let requiredFastPathDb = new DatabaseSync(requiredFastPathClone);
  requiredFastPathDb.exec("DROP TABLE odds_snapshots");
  requiredFastPathDb.close();
  assert.throws(
    () => runExporter({
      ...activeEnv,
      DATASTORE_SQLITE_PATH: requiredFastPathClone,
      SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
      SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1",
    }),
    /SQLITE_ACTIVE_GENERATION_FAST_PATH_REQUIRED|required active-generation fast path rejected release clone: required-table-missing:odds_snapshots/,
    "release prebuild must fail closed instead of materializing a full-export fallback",
  );
  requiredFastPathDb = new DatabaseSync(requiredFastPathClone, { readOnly: true });
  assert.equal(requiredFastPathDb.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'odds_snapshots'"
  ).get().count, 0, "required fast-path rejection must not repair or mutate the clone");
  requiredFastPathDb.close();

  const overlayId = "history:release-fast-overlay-sentinel";
  const insertOverlay = (database) => database.prepare(`
    INSERT OR REPLACE INTO match_snapshots
      (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
    VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
  `).run(
    overlayId,
    "sporttery_release-fast-overlay",
    "release-fast-overlay",
    "2026-07-12T12:00:00.000Z",
    JSON.stringify({ marker: "fast-result-overlay-must-survive" }),
  );
  const setMeta = (database, key, value) => database.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, "2026-07-12T14:02:00.000Z");

  let activeDb = new DatabaseSync(activeDbPath);
  insertOverlay(activeDb);
  setMeta(activeDb, "source_cycle_id", "fast-result-overlay-cycle");
  const exportedAtBeforeFastPath = activeDb.prepare(
    "SELECT value FROM schema_meta WHERE key = 'exported_at'"
  ).get().value;
  activeDb.close();

  const activeFast = runExporter({
    ...activeEnv,
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
    SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1",
  });
  assert.equal(activeFast.fastPath.eligible, true);
  assert.equal(activeFast.fastPath.applied, true);
  assert.equal(activeFast.fastPath.reason, "exact-active-generation-clone");
  assert.equal(activeFast.incremental.matchChanges, 0);
  assert.equal(activeFast.incremental.oddsChanges, 0);
  assert.equal(activeFast.incremental.predictionChanges, 0);
  activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
  assert.equal(activeDb.prepare("SELECT COUNT(*) AS count FROM match_snapshots WHERE id = ?").get(overlayId).count, 1,
    "same-generation release fast path must preserve the sentinel fast-result overlay");
  assert.equal(activeDb.prepare("SELECT value FROM schema_meta WHERE key = 'source_cycle_id'").get().value,
    "fast-result-overlay-cycle", "same-generation fast path must not regress the overlay source clock");
  assert.equal(activeDb.prepare("SELECT value FROM schema_meta WHERE key = 'exported_at'").get().value,
    exportedAtBeforeFastPath, "a metadata-only fast path must not fabricate a new base export time");
  const persistedFastEvidence = JSON.parse(activeDb.prepare(
    "SELECT value FROM schema_meta WHERE key = 'sqlite_export_fast_path'"
  ).get().value);
  assert.equal(persistedFastEvidence.applied, true);
  assert.equal(persistedFastEvidence.preservesFastResultOverlay, true);
  activeDb.close();

  const pointerLockPath = storePaths(activeStoreDir).pointerLockDir;
  activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
  const fastEvidenceBeforeBlockedCommit = activeDb.prepare(
    "SELECT value FROM schema_meta WHERE key = 'sqlite_export_fast_path'"
  ).get().value;
  activeDb.close();
  const heldPointerLock = acquirePointerCommitLock({
    lockDir: pointerLockPath,
    timeoutMs: 1_000,
    staleMs: 60_000,
  });
  let blockedExporterError = null;
  try {
    try {
      runExporter({
        ...activeEnv,
        SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
        SQLITE_BUSY_TIMEOUT_MS: "1000",
        SQLITE_EXPORT_ATTEMPTS: "1",
      });
    } catch (error) {
      blockedExporterError = error;
    }
    assert.ok(blockedExporterError, "read-only fast-path commit must wait for the supported pointer-writer lock");
    assert.ok(
      /POINTER_LOCK_TIMEOUT|pointer writer lock|timed out waiting/.test(String(blockedExporterError)),
      "a live supported pointer-writer lock must fail the bounded export before COMMIT",
    );
    activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
    assert.equal(
      activeDb.prepare("SELECT value FROM schema_meta WHERE key = 'sqlite_export_fast_path'").get().value,
      fastEvidenceBeforeBlockedCommit,
      "pointer-lock failure must roll back the SQLite transaction without crossing COMMIT",
    );
    activeDb.close();
  } finally {
    heldPointerLock.release();
  }
  assert.equal(fs.existsSync(pointerLockPath), false, "the test pointer lock is released by its owner");

  activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
  const exactWarehousePolicy = JSON.parse(activeDb.prepare(
    "SELECT value FROM schema_meta WHERE key = 'warehouse_policy'"
  ).get().value);
  activeDb.close();
  // Real v3 -> v5 clone migration: preserve all base/overlay rows and clocks,
  // build the actual reference membership proofs, then become exact-no-op.
  const upgradePath = path.join(activeRoot, "reference-upgrade-clone", "football.db");
  fs.mkdirSync(path.dirname(upgradePath), { recursive: true });
  fs.copyFileSync(activeDbPath, upgradePath);
  const { publicReferenceArchive: _oldArchive, publicReferenceIndex: _oldIndex, ...legacyReferencePolicy } = exactWarehousePolicy;
  legacyReferencePolicy.version = 3;
  let upgradeDb = new DatabaseSync(upgradePath);
  setMeta(upgradeDb, "warehouse_policy", JSON.stringify(legacyReferencePolicy));
  upgradeDb.exec("DELETE FROM source_snapshots WHERE id = 'public-reference-decisions:current' OR id LIKE 'public-reference-index:%';");
  const preservedTables = ["match_snapshots", "odds_snapshots", "prediction_snapshots", "private_model_artifacts"];
  const preservedRows = Object.fromEntries(preservedTables.map(table => [table, upgradeDb.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  const beforeExportClock = upgradeDb.prepare("SELECT value FROM schema_meta WHERE key='exported_at'").get().value;
  upgradeDb.close();
  const upgradeEnv = { ...activeEnv, DATASTORE_SQLITE_PATH: upgradePath, SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1", SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH: "1" };
  assert.throws(() => runExporter(upgradeEnv), /warehouse-policy-mismatch/, "a release cannot silently opt in to policy migration");
  const upgraded = runExporter({ ...upgradeEnv, SQLITE_EXPORT_ALLOW_REFERENCE_POLICY_UPGRADE: "1" });
  assert.equal(upgraded.fastPath.referencePolicyUpgrade, true);
  assert.equal(upgraded.fastPath.reason, "exact-active-generation-reference-policy-upgrade");
  assert.equal(upgraded.incremental.matchChanges, 0);
  assert.equal(upgraded.incremental.oddsChanges, 0);
  assert.equal(upgraded.incremental.predictionChanges, 0);
  assert.ok(upgraded.incremental.sourceChanges >= 3);
  upgradeDb = new DatabaseSync(upgradePath, { readOnly: true });
  for (const table of preservedTables) assert.deepEqual(upgradeDb.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), preservedRows[table], `${table} must remain byte-equivalent`);
  assert.equal(upgradeDb.prepare("SELECT value FROM schema_meta WHERE key='exported_at'").get().value, beforeExportClock);
  assert.deepEqual(JSON.parse(upgradeDb.prepare("SELECT value FROM schema_meta WHERE key='warehouse_policy'").get().value), exactWarehousePolicy);
  const proofHash = referenceMatch.predictionMeta.publicReferenceDecision.contentHash;
  const readPayload = id => JSON.parse(upgradeDb.prepare("SELECT payload FROM source_snapshots WHERE id=?").get(id).payload);
  const { resolveIndexedPublicReferenceEvidence } = require("../server/publicReferenceArchive.cjs");
  const proof = resolveIndexedPublicReferenceEvidence(readPayload("public-reference-index:current"), readPayload(`public-reference-index:row:${proofHash}`), proofHash);
  assert.equal(proof.ok, true);
  assert.equal(proof.record.prediction.tipCode, "X", "upgrading an index must not recalculate the published direction");
  upgradeDb.close();
  const upgradedNoOp = runExporter({ ...upgradeEnv, SQLITE_EXPORT_ALLOW_REFERENCE_POLICY_UPGRADE: "1" });
  assert.equal(upgradedNoOp.fastPath.referencePolicyUpgrade, false);
  assert.equal(upgradedNoOp.incremental.sourceChanges, 0);
  for (const invalidPolicy of [{ ...legacyReferencePolicy, version: 2 }, { ...legacyReferencePolicy, unexpected: true }, { ...legacyReferencePolicy, oddsStateLimit: "50000" }]) {
    upgradeDb = new DatabaseSync(upgradePath); setMeta(upgradeDb, "warehouse_policy", JSON.stringify(invalidPolicy)); upgradeDb.close();
    assert.throws(() => runExporter({ ...upgradeEnv, SQLITE_EXPORT_ALLOW_REFERENCE_POLICY_UPGRADE: "1" }), /warehouse-policy-mismatch/);
    upgradeDb = new DatabaseSync(upgradePath, { readOnly: true });
    assert.deepEqual(JSON.parse(upgradeDb.prepare("SELECT value FROM schema_meta WHERE key='warehouse_policy'").get().value), invalidPolicy, "rejected policy cannot be rewritten");
    upgradeDb.close();
  }
  assert.throws(() => runExporter({ ...activeEnv, SQLITE_EXPORT_ALLOW_REFERENCE_POLICY_UPGRADE: "1" }), /SQLITE_EXPORT_CONFIGURATION_INVALID/);

  const mismatchCases = [
    ["data_publication_mode", "legacy-bootstrap", "identity-mismatch:data_publication_mode"],
    ["data_generation_id", "g-" + "0".repeat(64), "identity-mismatch:data_generation_id"],
    ["manifest_hash", "0".repeat(64), "identity-mismatch:manifest_hash"],
    ["data_generation_source_cycle_id", "different-cycle", "identity-mismatch:data_generation_source_cycle_id"],
    ["committed_at", "2026-07-12T14:01:01.000Z", "identity-mismatch:committed_at"],
    ["schema_version", "football-sqlite-v1", "schema-version-mismatch"],
    ["prediction_state_identity_version", "prediction-state-v2", "prediction-identity-version-mismatch"],
    ["warehouse_policy", "{}", "warehouse-policy-mismatch"],
    ["warehouse_policy", JSON.stringify({ ...exactWarehousePolicy, unexpected: true }), "warehouse-policy-mismatch"],
    ["warehouse_policy", JSON.stringify({
      ...exactWarehousePolicy,
      oddsStateLimit: String(exactWarehousePolicy.oddsStateLimit),
    }), "warehouse-policy-mismatch"],
  ];
  for (const [key, value, reason] of mismatchCases) {
    activeDb = new DatabaseSync(activeDbPath);
    insertOverlay(activeDb);
    setMeta(activeDb, key, value);
    activeDb.close();
    const fallback = runExporter({
      ...activeEnv,
      SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY: "1",
    });
    assert.equal(fallback.fastPath.applied, false, `${key} mismatch must force full fallback`);
    assert.equal(fallback.fastPath.reason, reason);
    activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
    assert.equal(activeDb.prepare("SELECT COUNT(*) AS count FROM match_snapshots WHERE id = ?").get(overlayId).count, 0,
      `${key} fallback must execute the normal base-row prune`);
    activeDb.close();
  }

  activeDb = new DatabaseSync(activeDbPath);
  insertOverlay(activeDb);
  activeDb.close();
  const writablePointerExport = runExporter(activeEnv);
  assert.equal(writablePointerExport.fastPath.applied, false);
  assert.equal(writablePointerExport.fastPath.reason, "source-pointer-is-writable");
  activeDb = new DatabaseSync(activeDbPath, { readOnly: true });
  assert.equal(activeDb.prepare("SELECT COUNT(*) AS count FROM match_snapshots WHERE id = ?").get(overlayId).count, 0,
    "non-read-only exporters must execute the normal base-row prune");
  activeDb.close();

  const expectedPublication = resolveActivePublication({
    storeDir: activeStoreDir,
    publicDataDir: activePublicDir,
  });
  const generationSyncMetaPath = path.join(
    committedGeneration.context.generationDir,
    "sync-meta.json",
  );
  const generationSyncMetaBytes = fs.readFileSync(generationSyncMetaPath);
  const tamperedGenerationSyncMetaBytes = Buffer.from(generationSyncMetaBytes);
  tamperedGenerationSyncMetaBytes[tamperedGenerationSyncMetaBytes.length - 2] ^= 1;
  fs.writeFileSync(generationSyncMetaPath, tamperedGenerationSyncMetaBytes);
  try {
    assert.throws(
      () => resolveActivePublication({
        storeDir: activeStoreDir,
        publicDataDir: activePublicDir,
        validatePayloadSemantics: false,
      }),
      (error) => error?.code === "ACTIVE_GENERATION_INVALID"
        && error?.details?.causeCode === "FILE_HASH_MISMATCH",
      "integrity-only release resolution must still hash and reject every changed generation file",
    );
  } finally {
    fs.writeFileSync(generationSyncMetaPath, generationSyncMetaBytes);
  }
  const activePointerPath = storePaths(activeStoreDir).currentPointer;
  const originalPointerBytes = fs.readFileSync(activePointerPath);
  const changedPointer = JSON.parse(originalPointerBytes.toString("utf8"));
  changedPointer.committedAt = "2026-07-12T14:01:01.000Z";
  writeJson(activePointerPath, changedPointer);
  try {
    assert.throws(
      () => assertActivePublicationPointerUnchanged({
        storeDir: activeStoreDir,
        expected: expectedPublication,
      }),
      (error) => error?.code === "DATA_GENERATION_POINTER_CHANGED",
      "pointer-only release CAS must fail if any strict pointer identity field changes",
    );
  } finally {
    fs.writeFileSync(activePointerPath, originalPointerBytes);
  }

  console.log(JSON.stringify({
    ok: true,
    verifier: "sqlite-incremental-export",
    predictionStateIdentityVersion: PREDICTION_STATE_IDENTITY_VERSION,
    checks: assertionCount,
    firstCounts,
    finalCounts: vacuumed.counts,
    migration: first.migration,
    noOpCursor: second.incremental.jsonl.oddsSnapshots,
    vacuum: vacuumed.vacuum,
  }, null, 2));
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) { console.error(`test cleanup failed: ${tempDir}: ${error.message}`); process.exitCode = 1; }
}
