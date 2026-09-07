"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const publicPairs = require("./verifyPublicReferencePairs.cjs");
const {
  createFastResultObservation,
} = require("./fastResultObservations.cjs");
const {
  reconcileFastResultGeneration,
} = require("./reconcileFastResultGeneration.cjs");
const {
  attachPostMatchReviews,
  buildPostMatchReview,
  compactPostMatchReviewForMatch,
  postMatchReviewComparable,
} = require("./syncData.cjs");
const {
  buildFormalReviewPerformance,
} = require("../server/reviewPerformanceSummary.cjs");

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const finalMatch = ({
  sourceMatchId = "fast-generation-1001",
  scoreHome = 2,
  scoreAway = 1,
  kickoffTime = "2026-07-30T12:00:00.000Z",
  resultObservedAt = "2026-07-30T14:05:00.000Z",
  includeResultOnlyModelContent = false,
  includeContaminatedReceiptReview = false,
} = {}) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  status: "FINISHED",
  effectiveStatus: "FINISHED",
  kickoffTime,
  eventVersion: kickoffTime,
  scoreHome,
  scoreAway,
  resultObservedAt,
  settledAt: resultObservedAt,
  resultObservationSource: "sporttery-relay-endpoint-fetched-at",
  resultObservationFallback: false,
  resultProvenance: {
    provider: "sporttery",
    official: true,
    trusted: true,
    observationSource: "sporttery-relay-endpoint-fetched-at",
  },
  postMatchReview: {
    version: "post-match-review-v2",
    generatedAt: resultObservedAt,
    matchId: `sporttery_${sourceMatchId}`,
    sourceMatchId,
    finalScore: `${scoreHome}-${scoreAway}`,
    settlement: {
      resultObservedAt,
      resultRevision: 1,
      datasetRevision: "sqlite-fast-result-r1",
    },
    predictionReview: {
      bestStatus: "WON",
      formalBestStatus: "WON",
      referenceBestStatus: null,
      handicapHit: false,
      missedHandicapLane: false,
      rows: [],
    },
  },
  ...(includeContaminatedReceiptReview ? {
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: resultObservedAt,
      matchId: `sporttery_${sourceMatchId}`,
      sourceMatchId,
      finalScore: `${scoreHome}-${scoreAway}`,
      settlement: {
        resultObservedAt,
        resultRevision: 1,
        datasetRevision: "sqlite-fast-result-r1",
        publicationId: "receipt-must-not-publish",
        publicationVerified: true,
      },
      predictionReview: {
        settled: 1,
        won: 1,
        mainSettled: 1,
        mainWon: 1,
        allSettled: 1,
        allWon: 1,
        bestStatus: "WON",
        formalBestStatus: "WON",
        rows: [{
          marketType: "BEST",
          oddsPoolCode: "HAD",
          tipCode: "1",
          odds: 2.1,
          resultStatus: "WON",
          recommendationAction: "recommend",
          performanceTrack: "formal",
          reviewRole: "main",
          publicationId: "receipt-must-not-publish",
          publicationEvidence: { version: "untrusted-receipt-review" },
        }],
      },
    },
  } : {}),
  ...(includeResultOnlyModelContent ? {
    oddsSource: "500.com:HAD",
    predictions: [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "1",
    }],
    probabilityModel: { version: "fixture-model-v1" },
    projectedScoreHome: 2,
    projectedScoreAway: 1,
    stats: {
      version: "pre-match-model-estimates-v1",
      sourceType: "model-estimate",
    },
    gptPrediction: "synthetic fixture prediction",
  } : {}),
});

const buildFixture = (dir, {
  conflict = false,
  includeResultOnlyModelContent = false,
  includeContaminatedReceiptReview = false,
  matchOptions = {},
} = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, "public", "data");
  const dbPath = path.join(dir, "football.db");
  const match = finalMatch({
    ...matchOptions,
    includeResultOnlyModelContent,
    includeContaminatedReceiptReview,
  });
  const publishedAt = new Date(Date.parse(match.resultObservedAt) + 1_000).toISOString();
  const observation = createFastResultObservation(match, {
    publishedAt,
    sourceCycleId: "relay:fast-generation-test",
    datasetRevision: "sqlite-fast-result-r1",
  });
  assert.ok(observation);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE match_snapshots (
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        match_id TEXT,
        source_match_id TEXT,
        kickoff_time TEXT,
        status TEXT,
        payload TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO schema_meta (key, value, updated_at) VALUES ('fast_result_receipt', ?, ?)"
    ).run(JSON.stringify({
      version: "sqlite-fast-result-receipt-v1",
      revision: 1,
      publishedAt,
      sourceCycleId: "relay:fast-generation-test",
      datasetRevision: "sqlite-fast-result-r1",
      publishedRows: 1,
      observations: [observation],
    }), publishedAt);
    db.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
    `).run(
      `history:${match.id}`,
      match.id,
      match.sourceMatchId,
      match.kickoffTime,
      JSON.stringify(match),
    );
  } finally {
    db.close();
  }

  writeJson(path.join(dataDir, "matches-current.json"), [{
    id: match.id,
    sourceMatchId: match.sourceMatchId,
    status: "PENDING_RESULT",
    kickoffTime: match.kickoffTime,
    eventVersion: match.eventVersion,
  }]);
  writeJson(path.join(dataDir, "matches-history.json"), conflict ? [{
    ...match,
    scoreHome: 0,
    scoreAway: 0,
    postMatchReview: undefined,
  }] : []);
  writeJson(path.join(dataDir, "post-match-reviews.json"), {
    version: 2,
    source: "post-match-review-v2",
    generatedAt: "2026-07-30T14:00:00.000Z",
    rows: [],
    summary: {},
  });
  writeJson(path.join(dataDir, "sync-meta.json"), {
    sourceCycleId: "sporttery-full-sync:2026-07-30T14:00:00.000Z",
    fastResultRevision: 1,
    files: {
      current: 1,
      history: 0,
      postMatchReviews: 0,
    },
  });
  return {
    dataDir,
    dbPath,
    quarantinePath: path.join(dir, "post-match-review-quarantine.json"),
    match,
  };
};

const buildLegacyAliasFixture = (dir, { validAlias = true } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, "public", "data");
  const dbPath = path.join(dir, "football.db");
  const sourceMatchId = validAlias ? "2040649" : "legacy-alias-invalid";
  const receiptFinal = finalMatch({
    sourceMatchId,
    scoreHome: 0,
    scoreAway: validAlias ? 0 : 4,
  });
  receiptFinal.kickoffTime = "2026-07-29T16:00:00.000Z";
  receiptFinal.eventVersion = receiptFinal.kickoffTime;
  receiptFinal.resultObservedAt = "2026-07-30T05:10:02.733Z";
  receiptFinal.settledAt = receiptFinal.resultObservedAt;
  receiptFinal.postMatchReview.settlement.resultObservedAt = receiptFinal.resultObservedAt;
  const observation = createFastResultObservation(receiptFinal, {
    publishedAt: "2026-07-30T05:14:40.610Z",
    sourceCycleId: "sporttery-runtime-lane-overlay:legacy-alias",
    datasetRevision: "sqlite-fast-result-r633",
  });
  assert.ok(observation);

  const actualKickoff = validAlias
    ? "2026-07-30T00:30:00.000Z"
    : "2026-07-30T01:30:00.000Z";
  const current = {
    id: `sporttery_${sourceMatchId}`,
    sourceMatchId,
    status: "LIVE",
    effectiveStatus: "LIVE",
    kickoffTime: actualKickoff,
    eventVersion: actualKickoff,
    homeTeamName: "Alias Home",
    awayTeamName: "Alias Away",
    sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all",
    archivedPreMatchPrediction: {
      version: "archived-pre-match-prediction-v1",
      source: "immutable-pre-match-prediction-snapshot",
      matchId: `sporttery_${sourceMatchId}`,
      sourceMatchId,
      eventVersion: actualKickoff,
      kickoffTime: actualKickoff,
      capturedAt: "2026-07-29T12:00:00.000Z",
      predictions: [{
        marketType: "BEST",
        oddsPoolCode: "HAD",
        tipCode: "X",
        recommendationAction: "reference",
      }],
    },
    predictions: [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "X",
      recommendationAction: "reference",
    }],
  };
  if (!validAlias) {
    current.archivedPreMatchPrediction.eventVersion = "2026-07-30T02:30:00.000Z";
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE match_snapshots (
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        match_id TEXT,
        source_match_id TEXT,
        kickoff_time TEXT,
        status TEXT,
        payload TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO schema_meta (key, value, updated_at) VALUES ('fast_result_receipt', ?, ?)"
    ).run(JSON.stringify({
      version: "sqlite-fast-result-receipt-v1",
      revision: 633,
      publishedAt: "2026-07-30T05:14:40.610Z",
      sourceCycleId: "sporttery-runtime-lane-overlay:legacy-alias",
      datasetRevision: "sqlite-fast-result-r633",
      publishedRows: 1,
      observations: [observation],
    }), "2026-07-30T05:14:40.610Z");
  } finally {
    db.close();
  }

  writeJson(path.join(dataDir, "matches-current.json"), [current]);
  writeJson(path.join(dataDir, "matches-history.json"), []);
  writeJson(path.join(dataDir, "post-match-reviews.json"), {
    version: 2,
    source: "post-match-review-v2",
    generatedAt: "2026-07-30T05:00:00.000Z",
    rows: [],
    summary: {},
  });
  writeJson(path.join(dataDir, "sync-meta.json"), {
    sourceCycleId: "sporttery-full-sync:2026-07-30T05:00:00.000Z",
    fastResultRevision: 633,
    files: {
      current: 1,
      history: 0,
      postMatchReviews: 0,
    },
  });
  return {
    dataDir,
    dbPath,
    quarantinePath: path.join(dir, "post-match-review-quarantine.json"),
    current,
    observation,
  };
};

const HASH = "a".repeat(64);
const publicationBinding = ({ cutoffTime, publishedAt }) => ({
  cutoffTime,
  evidenceHash: HASH,
  featureHash: HASH,
  publishedAt,
  recordHash: HASH,
  strategyHash: HASH,
  version: "recommendation-publication-binding-v1",
});

const buildLegalArchivedHistory = (match) => {
  const kickoffMs = Date.parse(match.kickoffTime);
  const cutoffTime = new Date(kickoffMs - (30 * 60 * 1000)).toISOString();
  const publishedAt = new Date(kickoffMs - (60 * 60 * 1000)).toISOString();
  const archivedPrediction = {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    odds: 2.1,
    recommendationAction: "recommend",
    recommendationTier: "multi-factor",
  };
  const { postMatchReview: ignoredReceiptReview, ...matchWithoutReceiptReview } = match;
  void ignoredReceiptReview;
  const seed = {
    ...matchWithoutReceiptReview,
    oddsSource: "sporttery:HAD",
    buyEndTime: cutoffTime,
    archivedPreMatchPrediction: {
      version: "archived-pre-match-prediction-v1",
      source: "immutable-pre-match-prediction-snapshot",
      matchId: match.id,
      sourceMatchId: match.sourceMatchId,
      eventVersion: match.eventVersion,
      kickoffTime: match.kickoffTime,
      cutoffTime,
      capturedAt: publishedAt,
      marketEvidenceScope: "result-pool",
      prediction: archivedPrediction,
    },
    predictions: [archivedPrediction],
  };
  const reviewed = attachPostMatchReviews(
    [seed],
    match.resultObservedAt,
    null,
    null,
  ).matches[0];
  assert.equal(reviewed.postMatchReview.predictionReview.formalBestStatus, null);
  assert.equal(reviewed.postMatchReview.predictionReview.referenceBestStatus, "WON");
  assert.equal(reviewed.postMatchReview.predictionReview.rows[0].publicationId, null);
  return reviewed;
};

const buildForgedFormalArchivedHistory = (match) => {
  const reviewed = buildLegalArchivedHistory(match);
  const publicationId = `pub_${"b".repeat(32)}`;
  const kickoffMs = Date.parse(match.kickoffTime);
  const cutoffTime = new Date(kickoffMs - (30 * 60 * 1000)).toISOString();
  const publishedAt = new Date(kickoffMs - (60 * 60 * 1000)).toISOString();
  const publicationEvidence = publicationBinding({ cutoffTime, publishedAt });
  const referenceRow = reviewed.postMatchReview.predictionReview.rows[0];
  return {
    ...reviewed,
    postMatchReview: {
      ...reviewed.postMatchReview,
      settlement: {
        ...reviewed.postMatchReview.settlement,
        publicationId,
        publicationVerified: true,
      },
      predictionReview: {
        ...reviewed.postMatchReview.predictionReview,
        settled: 1,
        won: 1,
        hitRate: 100,
        mainSettled: 1,
        mainWon: 1,
        allSettled: 1,
        allWon: 1,
        referenceSettled: 0,
        referenceWon: 0,
        bestStatus: "WON",
        formalBestStatus: "WON",
        referenceBestStatus: null,
        bestRole: "main",
        bestTrack: "formal",
        rows: [{
          ...referenceRow,
          recommendationAction: "recommend",
          performanceTrack: "formal",
          reviewRole: "main",
          publicationId,
          publicationEvidence,
        }],
      },
      modelDiagnosis: [{
        code: "forged-formal-hit",
        zh: "不可采信的旧正式命中",
        en: "Unverified legacy formal hit",
      }],
    },
  };
};

const checks = [];
const check = (name, fn) => {
  try {
    const details = fn() || {};
    checks.push({ name, ok: true, ...details });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message || String(error) });
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-fast-generation-"));
try {
  check("slow reconciliation retains actual original paired reference statistics", () => {
    const fixture = buildFixture(path.join(root, "paired-reference"));
    const f = publicPairs.fixture({ day: "2026-08-31" });
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [f.match]);
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), { version: 2, generatedAt: "2026-08-31T15:00:00Z", rows: [f.match.postMatchReview], summary: {} });
    writeJson(path.join(fixture.dataDir, "prediction-snapshots.json"), { rows: [{ ignoredCandidate: "x".repeat(2 * 1024 * 1024) }], publicReferenceDecisions: [f.record], publicReferenceEvidence: [f.entry] });
    assert.equal(reconcileFastResultGeneration(fixture).ok, true);
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    const p = reviews.referencePerformance.pairedBaseline;
    assert.equal(p.generatedAt, reviews.referencePerformance.generatedAt);
    assert.deepEqual(p.cells.map(c => [c.market, c.paired, c.publishedWon, c.baselineWon, c.publicOnly]), [["HAD", 1, 1, 0, 1]]);
    const snapshot = require("../server/referencePairedBaseline.cjs").readReferenceSnapshotFile(path.join(fixture.dataDir, "prediction-snapshots.json"));
    assert.deepEqual(Object.keys(snapshot).sort(), ["publicReferenceDecisions", "publicReferenceEvidence"]);
    assert.deepEqual(snapshot.publicReferenceDecisions, [f.record]);
    const before = fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8");
    assert.equal(reconcileFastResultGeneration(fixture).skipped, true);
    assert.equal(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"), before);
    return { paired: 1, publicOnly: 1, unrelatedCandidateBytesDiscarded: 2 * 1024 * 1024 };
  });
  check("corrupt pair snapshot fails before current history review or sync-meta writes", () => {
    for (const kind of ["syntax", "binding"]) {
      const fixture = buildFixture(path.join(root, `corrupt-pair-${kind}`));
      const snapshotPath = path.join(fixture.dataDir, "prediction-snapshots.json");
      if (kind === "syntax") fs.writeFileSync(snapshotPath, '{"rows":[invalid],"publicReferenceDecisions":[]}');
      else {
        const f = publicPairs.fixture({ day: "2026-08-31" }); f.record.contentHash = "a".repeat(64);
        writeJson(snapshotPath, { publicReferenceDecisions: [f.record], publicReferenceEvidence: [f.entry] });
      }
      const files = ["matches-current.json", "matches-history.json", "post-match-reviews.json", "sync-meta.json"];
      const before = files.map(name => fs.readFileSync(path.join(fixture.dataDir, name), "utf8"));
      assert.throws(() => reconcileFastResultGeneration(fixture));
      files.forEach((name, i) => assert.equal(fs.readFileSync(path.join(fixture.dataDir, name), "utf8"), before[i]));
    }
    return { rejectedModes: 2, activeFilesUnchanged: 4 };
  });
  check("SQLite fast final is rebased before immutable generation", () => {
    const fixture = buildFixture(path.join(root, "happy"));
    const result = reconcileFastResultGeneration(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.receiptRevision, 1);
    const current = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-current.json"), "utf8"));
    const history = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"));
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(current.length, 0);
    assert.equal(history.length, 1);
    assert.equal(history[0].scoreHome, 2);
    assert.equal(history[0].scoreAway, 1);
    assert.equal(reviews.rows.length, 1);
    assert.equal(reviews.summary.bestWon, 0);
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    assert.equal(syncMeta.fastResultGenerationRevision, 1);
    assert.deepEqual(syncMeta.files, {
      current: 0,
      history: 1,
      postMatchReviews: 1,
    });
    return {
      removedCurrentRows: result.removedCurrentRows,
      historyRows: history.length,
      reviewRows: reviews.rows.length,
    };
  });

  check("repeated reconciliation is idempotent", () => {
    const fixture = buildFixture(path.join(root, "idempotent"));
    const first = reconcileFastResultGeneration(fixture);
    const currentBefore = fs.readFileSync(path.join(fixture.dataDir, "matches-current.json"), "utf8");
    const historyBefore = fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8");
    const second = reconcileFastResultGeneration(fixture);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "fast-result-generation-current");
    assert.equal(fs.readFileSync(path.join(fixture.dataDir, "matches-current.json"), "utf8"), currentBefore);
    assert.equal(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"), historyBefore);
    return { reason: second.reason };
  });

  check("missing or corrupt standalone review input fails before any generation write", () => {
    const cases = ["missing", "corrupt"];
    for (const mode of cases) {
      const fixture = buildFixture(path.join(root, `invalid-review-input-${mode}`));
      const reviewsPath = path.join(fixture.dataDir, "post-match-reviews.json");
      if (mode === "missing") {
        fs.rmSync(reviewsPath);
      } else {
        fs.writeFileSync(reviewsPath, "{invalid-review-json", "utf8");
      }
      const activePaths = [
        "matches-current.json",
        "matches-history.json",
        "post-match-reviews.json",
        "sync-meta.json",
      ].map((fileName) => path.join(fixture.dataDir, fileName));
      const activeBefore = new Map(activePaths.map((filePath) => [filePath, {
        exists: fs.existsSync(filePath),
        bytes: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
      }]));

      assert.throws(
        () => reconcileFastResultGeneration(fixture),
        (error) => error?.code === "FAST_RESULT_GENERATION_INPUT_INVALID",
      );
      for (const filePath of activePaths) {
        const before = activeBefore.get(filePath);
        assert.equal(fs.existsSync(filePath), before.exists);
        if (before.exists) assert.deepEqual(fs.readFileSync(filePath), before.bytes);
      }
      const syncMeta = JSON.parse(fs.readFileSync(
        path.join(fixture.dataDir, "sync-meta.json"),
        "utf8",
      ));
      assert.equal(syncMeta.fastResultGenerationRevision, undefined);
      assert.equal(syncMeta.fastResultGenerationReconciledAt, undefined);
      assert.equal(
        fs.existsSync(path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json")),
        false,
      );
    }
    return { rejectedModes: cases };
  });

  check("invalid existing quarantine ledger cannot be overwritten or advance generation", () => {
    const cases = ["bad-json", "wrong-schema", "bad-artifact-hash"];
    for (const mode of cases) {
      const fixture = buildFixture(path.join(root, `invalid-quarantine-${mode}`));
      const quarantinePath = path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json");
      if (mode === "bad-json") {
        fs.writeFileSync(quarantinePath, "{invalid-quarantine-json", "utf8");
      } else if (mode === "wrong-schema") {
        writeJson(quarantinePath, {
          version: "legacy-post-match-review-quarantine-wrong-version",
          count: 0,
          artifactCount: 0,
          rows: [],
        });
      } else {
        writeJson(quarantinePath, {
          version: "legacy-post-match-review-quarantine-v1",
          count: 1,
          artifactCount: 1,
          rows: [{
            version: "legacy-post-match-review-quarantine-v1",
            sourceMatchId: "quarantine-hash-fixture",
            canonicalEventVersion: "2026-07-30T12:00:00.000Z",
            finalScore: "1-0",
            surfaces: ["standalone"],
            artifacts: [{
              surface: "standalone",
              reviewHash: "0".repeat(64),
              review: { sourceMatchId: "quarantine-hash-fixture", finalScore: "1-0" },
            }],
          }],
        });
      }
      const activePaths = [
        "matches-current.json",
        "matches-history.json",
        "post-match-reviews.json",
        "sync-meta.json",
      ].map((fileName) => path.join(fixture.dataDir, fileName));
      const activeBefore = new Map(
        activePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]),
      );
      const quarantineBefore = fs.readFileSync(quarantinePath);

      assert.throws(
        () => reconcileFastResultGeneration(fixture),
        (error) => error?.code === "FAST_RESULT_GENERATION_QUARANTINE_INVALID",
      );
      for (const filePath of activePaths) {
        assert.deepEqual(fs.readFileSync(filePath), activeBefore.get(filePath));
      }
      assert.deepEqual(fs.readFileSync(quarantinePath), quarantineBefore);
      const syncMeta = JSON.parse(fs.readFileSync(
        path.join(fixture.dataDir, "sync-meta.json"),
        "utf8",
      ));
      assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    }
    return { rejectedModes: cases };
  });

  check("SQLite receipt reconciliation cannot reintroduce result-only model content", () => {
    const fixture = buildFixture(path.join(root, "result-only-model-content"), {
      includeResultOnlyModelContent: true,
    });
    const { postMatchReview: ignoredReceiptReview, ...historyMatch } = fixture.match;
    void ignoredReceiptReview;
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [historyMatch]);
    const result = reconcileFastResultGeneration(fixture);
    const history = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].predictions, []);
    assert.equal(history[0].probabilityModel, undefined);
    assert.equal(history[0].projectedScoreHome, undefined);
    assert.equal(history[0].projectedScoreAway, undefined);
    assert.equal(history[0].stats, undefined);
    assert.equal(history[0].gptPrediction, undefined);
    assert.equal(history[0].predictionMeta?.lockedReason, "result-only");
    return {
      receiptRevision: result.receiptRevision,
      resultOnlyModelContentStripped: true,
    };
  });

  check("legacy SQLite aliases cannot rename an existing public match or detach its review", () => {
    const cases = [
      { name: "equal-clock", incomingRevision: 1, expectedDatasetRevision: "public-canonical-r1" },
      { name: "newer-result", incomingRevision: 2, expectedDatasetRevision: "sqlite-alias-r2" },
    ];
    for (const testCase of cases) {
      const fixture = buildFixture(path.join(root, `sqlite-public-identity-${testCase.name}`), {
        matchOptions: {
          sourceMatchId: "2040801",
          scoreHome: 2,
          scoreAway: 2,
          kickoffTime: "2026-08-09T19:30:00.000Z",
          resultObservedAt: "2026-08-10T04:07:04.170Z",
        },
      });
      const publicId = "sporttery_2040801";
      const sqliteAliasId = "fivehundred_2040801";
      const { postMatchReview: ignoredReceiptReview, ...publicSeed } = fixture.match;
      void ignoredReceiptReview;
      const reviewedPublicMatch = attachPostMatchReviews(
        [{ ...publicSeed, id: publicId, datasetRevision: "public-canonical-r1" }],
        fixture.match.resultObservedAt,
        null,
        null,
      ).matches[0];
      const standaloneReview = JSON.parse(JSON.stringify(reviewedPublicMatch.postMatchReview));
      const embeddedReview = compactPostMatchReviewForMatch(standaloneReview);
      delete standaloneReview.eventVersion;
      delete embeddedReview.eventVersion;
      writeJson(path.join(fixture.dataDir, "matches-history.json"), [{
        ...reviewedPublicMatch,
        postMatchReview: embeddedReview,
      }]);
      writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
        version: 2,
        source: "post-match-review-v2",
        generatedAt: fixture.match.resultObservedAt,
        rows: [standaloneReview],
        summary: {},
      });

      const sqliteAlias = JSON.parse(JSON.stringify(fixture.match));
      sqliteAlias.id = sqliteAliasId;
      sqliteAlias.datasetRevision = "sqlite-alias-r2";
      sqliteAlias.postMatchReview.matchId = sqliteAliasId;
      sqliteAlias.postMatchReview.settlement = {
        ...sqliteAlias.postMatchReview.settlement,
        resultRevision: testCase.incomingRevision,
        datasetRevision: "sqlite-alias-r2",
      };
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.prepare(`
          UPDATE match_snapshots
          SET match_id = ?, payload = ?
          WHERE dataset = 'history' AND source_match_id = ?
        `).run(sqliteAliasId, JSON.stringify(sqliteAlias), fixture.match.sourceMatchId);
      } finally {
        db.close();
      }

      const result = reconcileFastResultGeneration(fixture);
      const history = JSON.parse(fs.readFileSync(
        path.join(fixture.dataDir, "matches-history.json"),
        "utf8",
      ));
      const reviews = JSON.parse(fs.readFileSync(
        path.join(fixture.dataDir, "post-match-reviews.json"),
        "utf8",
      ));
      assert.equal(result.ok, true);
      assert.equal(history.length, 1);
      assert.equal(reviews.rows.length, 1);
      assert.equal(history[0].id, publicId);
      assert.equal(history[0].datasetRevision, testCase.expectedDatasetRevision);
      assert.equal(history[0].postMatchReview.matchId, publicId);
      assert.equal(reviews.rows[0].matchId, publicId);
      assert.equal(
        postMatchReviewComparable(history[0].postMatchReview),
        postMatchReviewComparable(reviews.rows[0]),
      );
      assert.equal(fs.existsSync(fixture.quarantinePath), false);
      assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    }
    return {
      cases: cases.map((row) => row.name),
      canonicalPublicId: "sporttery_2040801",
      sqliteAliasId: "fivehundred_2040801",
    };
  });

  check("receipt post-match review cannot enter formal or summary metrics", () => {
    const fixture = buildFixture(path.join(root, "receipt-review-contamination"), {
      includeContaminatedReceiptReview: true,
    });
    const result = reconcileFastResultGeneration(fixture);
    const history = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"));
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    const review = history[0].postMatchReview;
    assert.equal(result.ok, true);
    assert.deepEqual(review.predictionReview.rows, []);
    assert.equal(review.predictionReview.formalBestStatus, null);
    assert.equal(review.predictionReview.mainSettled, 0);
    assert.equal(reviews.summary.bestWon, 0);
    assert.equal(reviews.summary.bestLost, 0);
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    assert.equal(
      reviews.rows.some((row) => row?.settlement?.publicationId === "receipt-must-not-publish"),
      false,
    );
    return {
      receiptReviewRows: review.predictionReview.rows.length,
      formalSettled: reviews.formalPerformance.cumulative.settled,
    };
  });

  check("same-event reproducible archive and reference review remain byte-for-byte immutable", () => {
    const fixture = buildFixture(path.join(root, "legal-history-preserved"), {
      includeContaminatedReceiptReview: true,
    });
    const legalHistory = buildLegalArchivedHistory(fixture.match);
    const revalidatedLegalHistory = attachPostMatchReviews(
      [legalHistory],
      legalHistory.postMatchReview.generatedAt,
      null,
      null,
    ).matches[0];
    assert.equal(
      postMatchReviewComparable(revalidatedLegalHistory.postMatchReview),
      postMatchReviewComparable(legalHistory.postMatchReview),
    );
    const archiveBefore = JSON.stringify(legalHistory.archivedPreMatchPrediction);
    const reviewBefore = JSON.stringify(legalHistory.postMatchReview);
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [legalHistory]);
    const result = reconcileFastResultGeneration(fixture);
    const history = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"));
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(history[0].archivedPreMatchPrediction), archiveBefore);
    assert.equal(JSON.stringify(history[0].postMatchReview), reviewBefore);
    assert.deepEqual(history[0].predictions, []);
    assert.equal(history[0].postMatchReview.predictionReview.formalBestStatus, null);
    assert.equal(history[0].postMatchReview.predictionReview.referenceBestStatus, "WON");
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    assert.equal(reviews.formalPerformance.exclusions.beforeStart, 1);
    return {
      archivePreserved: true,
      referenceReviewPreserved: true,
    };
  });

  check("standalone review upsert is bound to eventVersion and never inherits wrong event factors", () => {
    const fixture = buildFixture(path.join(root, "review-event-version"));
    const wrongEventVersion = "2026-07-30T13:00:00.000Z";
    const { postMatchReview: ignoredReceiptReview, ...wrongEventSeed } = fixture.match;
    void ignoredReceiptReview;
    const wrongEventMatch = attachPostMatchReviews(
      [{
        ...wrongEventSeed,
        kickoffTime: wrongEventVersion,
        eventVersion: wrongEventVersion,
      }],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0];
    wrongEventMatch.postMatchReview.eventFactors = { marker: "wrong-event-must-not-cross" };
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [wrongEventMatch]);
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: "2026-07-30T14:00:00.000Z",
      rows: [{
        ...wrongEventMatch.postMatchReview,
        eventFactors: { marker: "wrong-event-must-not-cross" },
      }],
      summary: {},
    });
    const result = reconcileFastResultGeneration(fixture);
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    const wrongEvent = reviews.rows.find((row) => row.eventVersion === wrongEventVersion);
    const currentEvent = reviews.rows.find((row) => row.eventVersion === fixture.match.eventVersion);
    assert.equal(result.ok, true);
    assert.equal(reviews.rows.length, 2);
    assert.equal(wrongEvent.eventFactors.marker, "wrong-event-must-not-cross");
    assert.ok(currentEvent);
    assert.notEqual(currentEvent.eventFactors?.marker, "wrong-event-must-not-cross");
    assert.deepEqual(currentEvent.predictionReview.rows, []);
    return {
      rows: reviews.rows.length,
      currentEventVersion: currentEvent.eventVersion,
    };
  });

  check("post-match review producer and compact payload retain canonical eventVersion", () => {
    const match = finalMatch();
    const produced = buildPostMatchReview(
      match,
      match.resultObservedAt,
      null,
      null,
    );
    assert.ok(produced);
    assert.equal(produced.eventVersion, match.eventVersion);
    assert.equal(compactPostMatchReviewForMatch(produced).eventVersion, match.eventVersion);
    assert.equal(
      compactPostMatchReviewForMatch({
        ...produced,
        eventVersion: "2026-07-30T20:00:00+08:00",
      }).eventVersion,
      match.eventVersion,
    );
    const attached = attachPostMatchReviews(
      [match],
      match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    assert.equal(attached.eventVersion, match.eventVersion);
    return { eventVersion: attached.eventVersion };
  });

  check("one reproducible legacy review without eventVersion binds to its unique result event", () => {
    const fixture = buildFixture(path.join(root, "legacy-review-unique-event"));
    const { postMatchReview: ignoredReceiptReview, ...reviewSeed } = fixture.match;
    void ignoredReceiptReview;
    const legacyReview = attachPostMatchReviews(
      [reviewSeed],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    delete legacyReview.eventVersion;
    assert.equal(legacyReview.eventVersion, undefined);
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyReview],
      summary: {},
    });

    const result = reconcileFastResultGeneration(fixture);
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(reviews.rows.length, 1);
    assert.equal(reviews.rows[0].eventVersion, fixture.match.eventVersion);
    assert.equal(
      postMatchReviewComparable(reviews.rows[0]),
      postMatchReviewComparable({
        ...legacyReview,
        eventVersion: fixture.match.eventVersion,
      }),
    );
    assert.equal(reviews.rows[0].predictionReview.formalBestStatus, null);
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    return {
      reboundEventVersion: reviews.rows[0].eventVersion,
      formalSettled: reviews.formalPerformance.cumulative.settled,
    };
  });

  check("legacy review without eventVersion rejects same-source same-score event ambiguity", () => {
    const fixture = buildFixture(path.join(root, "legacy-review-ambiguous-event"));
    const { postMatchReview: ignoredReceiptReview, ...reviewSeed } = fixture.match;
    void ignoredReceiptReview;
    const legacyReview = attachPostMatchReviews(
      [reviewSeed],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    delete legacyReview.eventVersion;
    const otherEvent = {
      ...fixture.match,
      kickoffTime: "2026-07-30T13:00:00.000Z",
      eventVersion: "2026-07-30T13:00:00.000Z",
      postMatchReview: undefined,
    };
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [otherEvent]);
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyReview],
      summary: {},
    });

    assert.throws(
      () => reconcileFastResultGeneration(fixture),
      (error) => error?.code === "FAST_RESULT_GENERATION_REVIEW_EVENT_AMBIGUOUS",
    );
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    return { ambiguousLegacyReviewRejected: true };
  });

  check("non-reproducible reference legacy review surfaces quarantine originals idempotently", () => {
    const fixture = buildFixture(path.join(root, "legacy-review-content-tamper"));
    const { postMatchReview: ignoredReceiptReview, ...reviewSeed } = fixture.match;
    void ignoredReceiptReview;
    const legacyReview = attachPostMatchReviews(
      [reviewSeed],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    delete legacyReview.eventVersion;
    legacyReview.modelDiagnosis = [{
      code: "tampered-legacy-diagnosis",
      zh: "不可重现的旧复盘内容",
      en: "Non-reproducible legacy review content",
    }];
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyReview],
      summary: {},
    });
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [{
      ...fixture.match,
      postMatchReview: JSON.parse(JSON.stringify(legacyReview)),
    }]);
    const expectedHash = crypto.createHash("sha256")
      .update(JSON.stringify(legacyReview))
      .digest("hex");
    const first = reconcileFastResultGeneration(fixture);
    const quarantinePath = path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json");
    const quarantine = JSON.parse(fs.readFileSync(quarantinePath, "utf8"));
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    assert.equal(first.ok, true);
    assert.equal(first.quarantinedLegacyReviewRows, 1);
    assert.equal(first.quarantinedLegacyReviewSurfaceRows, 2);
    assert.equal(quarantine.count, 1);
    assert.equal(quarantine.artifactCount, 2);
    assert.deepEqual(quarantine.rows[0].surfaces, ["history", "standalone"]);
    assert.equal(
      quarantine.rows[0].artifacts.every((artifact) => artifact.reviewHash === expectedHash),
      true,
    );
    assert.equal(quarantine.rows[0].canonicalEventVersion, fixture.match.eventVersion);
    assert.equal(
      quarantine.rows[0].artifacts.every((artifact) => (
        JSON.stringify(artifact.review) === JSON.stringify(legacyReview)
      )),
      true,
    );
    assert.equal(reviews.rows.length, 1);
    assert.equal(reviews.rows[0].eventVersion, fixture.match.eventVersion);
    assert.equal(
      reviews.rows[0].modelDiagnosis.some((row) => row?.code === "tampered-legacy-diagnosis"),
      false,
    );
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);

    const quarantineBeforeRetry = fs.readFileSync(quarantinePath, "utf8");
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    delete syncMeta.fastResultGenerationRevision;
    writeJson(path.join(fixture.dataDir, "sync-meta.json"), syncMeta);
    const second = reconcileFastResultGeneration(fixture);
    assert.equal(second.ok, true);
    assert.equal(second.quarantinedLegacyReviewRows, 0);
    assert.equal(fs.readFileSync(quarantinePath, "utf8"), quarantineBeforeRetry);
    return {
      quarantinedReferenceEvents: quarantine.count,
      quarantinedSurfaceArtifacts: quarantine.artifactCount,
      originalReviewHashPreserved: true,
      idempotent: true,
    };
  });

  check("quarantine write failure leaves every active generation surface unchanged", () => {
    const fixture = buildFixture(path.join(root, "legacy-review-quarantine-write-failure"));
    const { postMatchReview: ignoredReceiptReview, ...reviewSeed } = fixture.match;
    void ignoredReceiptReview;
    const legacyReview = attachPostMatchReviews(
      [reviewSeed],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    delete legacyReview.eventVersion;
    legacyReview.modelDiagnosis = [{
      code: "quarantine-write-must-precede-active-generation",
      zh: "隔离写入失败时不得推进活动代",
      en: "A failed quarantine write must not advance the active generation",
    }];
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyReview],
      summary: {},
    });
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [{
      ...fixture.match,
      postMatchReview: JSON.parse(JSON.stringify(legacyReview)),
    }]);

    const activePaths = [
      "matches-current.json",
      "matches-history.json",
      "post-match-reviews.json",
      "sync-meta.json",
    ].map((fileName) => path.join(fixture.dataDir, fileName));
    const activeBefore = new Map(
      activePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]),
    );
    const quarantinePath = path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json");
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (sourcePath, targetPath) => {
      if (path.resolve(targetPath) === path.resolve(quarantinePath)) {
        const error = new Error("fixture quarantine rename denied");
        error.code = "EACCES";
        throw error;
      }
      return originalRenameSync(sourcePath, targetPath);
    };
    try {
      assert.throws(
        () => reconcileFastResultGeneration({ ...fixture, quarantinePath }),
        (error) => error?.code === "EACCES",
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    for (const filePath of activePaths) {
      assert.deepEqual(fs.readFileSync(filePath), activeBefore.get(filePath));
    }
    const syncMeta = JSON.parse(fs.readFileSync(
      path.join(fixture.dataDir, "sync-meta.json"),
      "utf8",
    ));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    assert.equal(syncMeta.fastResultGenerationReconciledAt, undefined);
    assert.equal(fs.existsSync(quarantinePath), false);
    return {
      activeSurfacesUnchanged: activePaths.length,
      revisionAdvanced: false,
    };
  });

  check("embedded and standalone review surfaces remain exact one-to-one peers", () => {
    const cases = [
      "standalone-missing",
      "embedded-missing",
      "standalone-duplicate",
      "content-mismatch",
    ];
    for (const mode of cases) {
      const fixture = buildFixture(path.join(root, `review-surface-parity-${mode}`));
      const rawExtraMatch = finalMatch({
        sourceMatchId: `review-surface-${mode}`,
        scoreHome: 1,
        scoreAway: 0,
        kickoffTime: "2026-07-29T10:00:00.000Z",
        resultObservedAt: "2026-07-29T12:05:00.000Z",
      });
      const { postMatchReview: ignoredRawReview, ...extraSeed } = rawExtraMatch;
      void ignoredRawReview;
      const extraMatch = attachPostMatchReviews(
        [extraSeed],
        rawExtraMatch.resultObservedAt,
        null,
        null,
      ).matches[0];
      const extraReview = JSON.parse(JSON.stringify(extraMatch.postMatchReview));
      const { postMatchReview: ignoredEmbeddedReview, ...extraWithoutReview } = extraMatch;
      void ignoredEmbeddedReview;

      const historyRows = mode === "embedded-missing"
        ? [extraWithoutReview]
        : [extraMatch];
      let standaloneRows = mode === "standalone-missing" ? [] : [extraReview];
      if (mode === "standalone-duplicate") {
        standaloneRows = [extraReview, JSON.parse(JSON.stringify(extraReview))];
      } else if (mode === "content-mismatch") {
        standaloneRows[0].modelDiagnosis = [{
          code: "surface-content-mismatch",
          zh: "两面内容不一致",
          en: "Review surface content mismatch",
        }];
      }
      writeJson(path.join(fixture.dataDir, "matches-history.json"), historyRows);
      writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
        version: 2,
        source: "post-match-review-v2",
        generatedAt: rawExtraMatch.resultObservedAt,
        rows: standaloneRows,
        summary: {},
      });
      const activePaths = [
        "matches-current.json",
        "matches-history.json",
        "post-match-reviews.json",
        "sync-meta.json",
      ].map((fileName) => path.join(fixture.dataDir, fileName));
      const activeBefore = new Map(
        activePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]),
      );

      assert.throws(
        () => reconcileFastResultGeneration(fixture),
        (error) => [
          "FAST_RESULT_GENERATION_REVIEW_DUPLICATE",
          "FAST_RESULT_GENERATION_REVIEW_SURFACE_MISMATCH",
        ].includes(error?.code),
      );
      for (const filePath of activePaths) {
        assert.deepEqual(fs.readFileSync(filePath), activeBefore.get(filePath));
      }
      const syncMeta = JSON.parse(fs.readFileSync(
        path.join(fixture.dataDir, "sync-meta.json"),
        "utf8",
      ));
      assert.equal(syncMeta.fastResultGenerationRevision, undefined);
      assert.equal(
        fs.existsSync(path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json")),
        false,
      );
    }
    return { rejectedModes: cases };
  });

  check("legacy live-only review is quarantined as non-formal and cannot affect formal metrics", () => {
    const fixture = buildFixture(path.join(root, "legacy-live-only-quarantine"));
    const { postMatchReview: ignoredReceiptReview, ...reviewSeed } = fixture.match;
    void ignoredReceiptReview;
    const legacyReview = attachPostMatchReviews(
      [reviewSeed],
      fixture.match.resultObservedAt,
      null,
      null,
    ).matches[0].postMatchReview;
    delete legacyReview.eventVersion;
    legacyReview.predictionReview = {
      ...legacyReview.predictionReview,
      allSettled: 1,
      allWon: 1,
      liveSettled: 1,
      liveWon: 1,
      liveHitRate: 100,
      liveBestStatus: "WON",
      archivedBestStatus: "WON",
      bestTrack: "live-model",
      rows: [{
        marketType: "BEST",
        oddsPoolCode: "HAD",
        tipCode: "1",
        resultStatus: "WON",
        recommendationAction: "reference",
        liveRecommendationAction: "recommend",
        performanceTrack: "live-model",
        reviewRole: "reference",
        publicationId: null,
        publicationEvidence: null,
      }],
    };
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyReview],
      summary: {},
    });

    const result = reconcileFastResultGeneration(fixture);
    const quarantine = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json"),
      "utf8",
    ));
    const reviews = JSON.parse(fs.readFileSync(
      path.join(fixture.dataDir, "post-match-reviews.json"),
      "utf8",
    ));
    assert.equal(result.ok, true);
    assert.equal(result.quarantinedLegacyReviewRows, 1);
    assert.equal(quarantine.count, 1);
    assert.equal(quarantine.rows[0].artifacts[0].review.predictionReview.liveSettled, 1);
    assert.equal(reviews.formalPerformance.cumulative.settled, 0);
    assert.equal(reviews.rows[0].predictionReview.formalBestStatus, null);
    return {
      quarantinedLiveOnlyRows: quarantine.count,
      formalSettled: reviews.formalPerformance.cumulative.settled,
    };
  });

  check("embedded shape-only formal review cannot self-verify and hard blocks", () => {
    const fixture = buildFixture(path.join(root, "embedded-formal-self-proof"), {
      matchOptions: {
        sourceMatchId: "fast-generation-formal-self-proof",
        kickoffTime: "2026-08-30T12:00:00.000Z",
        resultObservedAt: "2026-08-30T14:05:00.000Z",
      },
    });
    const forgedHistory = buildForgedFormalArchivedHistory(fixture.match);
    const forgedPerformance = buildFormalReviewPerformance({
      matches: [forgedHistory],
      generatedAt: fixture.match.resultObservedAt,
    });
    assert.equal(forgedPerformance.cumulative.settled, 1);
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [forgedHistory]);

    assert.throws(
      () => reconcileFastResultGeneration(fixture),
      (error) => error?.code === "FAST_RESULT_GENERATION_REVIEW_FORMAL_UNVERIFIED",
    );
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    assert.equal(
      fs.existsSync(path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json")),
      false,
    );
    return {
      forgedFormalSettledBeforeRevalidation: forgedPerformance.cumulative.settled,
      hardBlocked: true,
    };
  });

  check("unbound shape-only formal review after metric start is rejected before commit", () => {
    const fixture = buildFixture(path.join(root, "legacy-formal-self-proof"), {
      matchOptions: {
        sourceMatchId: "fast-generation-legacy-formal",
        kickoffTime: "2026-08-30T12:00:00.000Z",
        resultObservedAt: "2026-08-30T14:05:00.000Z",
      },
    });
    const forgedHistory = buildForgedFormalArchivedHistory(fixture.match);
    const legacyForgedReview = JSON.parse(JSON.stringify(forgedHistory.postMatchReview));
    delete legacyForgedReview.eventVersion;
    writeJson(path.join(fixture.dataDir, "matches-history.json"), [
      buildLegalArchivedHistory(fixture.match),
    ]);
    writeJson(path.join(fixture.dataDir, "post-match-reviews.json"), {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: fixture.match.resultObservedAt,
      rows: [legacyForgedReview],
      summary: {},
    });
    const historyBefore = fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8");
    const reviewsBefore = fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8");

    assert.throws(
      () => reconcileFastResultGeneration(fixture),
      (error) => error?.code === "FAST_RESULT_GENERATION_REVIEW_FORMAL_UNVERIFIED",
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"),
      historyBefore,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"),
      reviewsBefore,
    );
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    assert.equal(
      fs.existsSync(path.join(path.dirname(fixture.dbPath), "post-match-review-quarantine.json")),
      false,
    );
    return { forgedLegacyFormalRejectedBeforeCommitAndNotQuarantined: true };
  });

  check("score conflicts fail closed", () => {
    const fixture = buildFixture(path.join(root, "conflict"), { conflict: true });
    assert.throws(
      () => reconcileFastResultGeneration(fixture),
      (error) => error?.code === "FAST_RESULT_GENERATION_CONFLICT",
    );
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    return { conflictRejected: true };
  });

  check("legacy midnight receipt recovers one immutable pre-match event", () => {
    const fixture = buildLegacyAliasFixture(path.join(root, "legacy-alias"));
    const result = reconcileFastResultGeneration(fixture);
    const current = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-current.json"), "utf8"));
    const history = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "matches-history.json"), "utf8"));
    const reviews = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "post-match-reviews.json"), "utf8"));
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.recoveredReceiptRows, 1);
    assert.equal(result.recoveredLegacyMidnightAliases, 1);
    assert.equal(current.length, 0);
    assert.equal(history.length, 1);
    assert.equal(history[0].kickoffTime, fixture.current.kickoffTime);
    assert.equal(history[0].scoreHome, 0);
    assert.equal(history[0].scoreAway, 0);
    assert.equal(history[0].resultProvenance?.trusted, true);
    assert.equal(
      history[0].fastResultIdentityResolution?.policy,
      "sqlite-receipt-legacy-midnight-rebound-to-immutable-prematch-event",
    );
    assert.equal(reviews.rows.length, 1);
    assert.equal(syncMeta.fastResultGenerationRevision, 633);
    assert.deepEqual(syncMeta.files, {
      current: 0,
      history: 1,
      postMatchReviews: 1,
    });
    assert.equal(
      syncMeta.fastResultGenerationReconciliation?.recoveredLegacyMidnightAliases,
      1,
    );
    return {
      receiptRevision: result.receiptRevision,
      recoveredLegacyMidnightAliases: result.recoveredLegacyMidnightAliases,
    };
  });

  check("invalid midnight alias fails closed without advancing generation revision", () => {
    const fixture = buildLegacyAliasFixture(path.join(root, "legacy-alias-invalid"), {
      validAlias: false,
    });
    assert.throws(
      () => reconcileFastResultGeneration(fixture),
      (error) => error?.code === "FAST_RESULT_GENERATION_RECEIPT_MISSING",
    );
    const syncMeta = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "sync-meta.json"), "utf8"));
    assert.equal(syncMeta.fastResultGenerationRevision, undefined);
    return { invalidAliasRejected: true };
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((row) => !row.ok);
process.stdout.write(`${JSON.stringify({
  ok: failed.length === 0,
  verifier: "fast-result-generation-reconciliation",
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.map((row) => row.name),
  contract: {
    receiptReviewCannotEnterFormalMetrics: true,
    pairedReferenceSurvivesReconciliation: true,
    invalidPairSourceFailsBeforeAnyWrite: true,
    invalidReviewInputCannotAdvanceGeneration: true,
    existingQuarantineLedgerIsStrictlyValidated: true,
    existingSameEventReviewPreservedByteForByte: true,
    standaloneReviewIdentityIncludesEventVersion: true,
    producedReviewsCarryCanonicalEventVersion: true,
    reproducibleLegacyReviewRequiresUniqueEventBinding: true,
    legacyReviewContentMustReproduce: true,
    nonReproducibleReferenceReviewIsQuarantined: true,
    quarantineWriteFailureCannotAdvanceGeneration: true,
    reviewSurfacesRemainOneToOne: true,
    legacyLiveOnlyReviewIsNonFormalQuarantine: true,
    embeddedReviewCannotSelfVerifyFormalPublication: true,
    unverifiedLegacyFormalReviewCannotAdvanceGeneration: true,
    wrongEventFactorsAreNotInherited: true,
    resultOnlyTopLevelModelContentIsStripped: true,
    sqliteAliasCannotRenamePublicIdentity: true,
  },
  results: checks,
}, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
