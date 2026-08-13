"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  createFastResultObservation,
} = require("./fastResultObservations.cjs");
const {
  reconcileFastResultGeneration,
} = require("./reconcileFastResultGeneration.cjs");

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const finalMatch = ({
  sourceMatchId = "fast-generation-1001",
  scoreHome = 2,
  scoreAway = 1,
} = {}) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  status: "FINISHED",
  effectiveStatus: "FINISHED",
  kickoffTime: "2026-07-30T12:00:00.000Z",
  eventVersion: "2026-07-30T12:00:00.000Z",
  scoreHome,
  scoreAway,
  resultObservedAt: "2026-07-30T14:05:00.000Z",
  settledAt: "2026-07-30T14:05:00.000Z",
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
    generatedAt: "2026-07-30T14:05:00.000Z",
    matchId: `sporttery_${sourceMatchId}`,
    sourceMatchId,
    finalScore: `${scoreHome}-${scoreAway}`,
    settlement: {
      resultObservedAt: "2026-07-30T14:05:00.000Z",
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
});

const buildFixture = (dir, { conflict = false } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, "public", "data");
  const dbPath = path.join(dir, "football.db");
  const match = finalMatch();
  const observation = createFastResultObservation(match, {
    publishedAt: "2026-07-30T14:05:01.000Z",
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
      publishedAt: "2026-07-30T14:05:01.000Z",
      sourceCycleId: "relay:fast-generation-test",
      datasetRevision: "sqlite-fast-result-r1",
      publishedRows: 1,
      observations: [observation],
    }), "2026-07-30T14:05:01.000Z");
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
    postMatchReview: {
      ...match.postMatchReview,
      finalScore: "0-0",
    },
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
  return { dataDir, dbPath, match };
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
  return { dataDir, dbPath, current, observation };
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
    assert.equal(reviews.summary.bestWon, 1);
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
  results: checks,
}, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
