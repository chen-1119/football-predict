const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  migrateArchivedPreMatchReferences,
} = require("./migrateArchivedPreMatchReferences.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_IDS = new Set(["2040649", "2040650"]);
const sourceId = (row) => String(row?.sourceMatchId || row?.id || "")
  .replace(/^sporttery_/, "");
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const writeJson = (filePath, payload) => fs.writeFileSync(
  filePath,
  `${JSON.stringify(payload, null, 2)}\n`,
  "utf8"
);

const sourceDataDir = path.join(ROOT_DIR, "public", "data");
// These two historical regression events eventually leave the rolling current
// window. Keep the verifier deterministic by resolving the signed source row
// from history first and allowing a still-current copy to override it.
const sourceMatchesById = new Map([
  ...readJson(path.join(sourceDataDir, "matches-history.json")),
  ...readJson(path.join(sourceDataDir, "matches-current.json")),
].filter((row) => SOURCE_IDS.has(sourceId(row))).map((row) => [sourceId(row), row]));
const sourceMatches = [...sourceMatchesById.values()];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-archive-migration-"));
const evidenceDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-archive-evidence-"));
const ambiguityDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-archive-ambiguity-"));
const ambiguityEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-archive-ambiguity-evidence-"));
const historyClockDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-archive-history-clock-"));

try {
  const current = sourceMatches
    .map((row) => {
      const copy = structuredClone(row);
      delete copy.archivedPreMatchPrediction;
      copy.kickoffTime = sourceId(copy) === "2040650"
        ? "2026-07-29T00:00:00+08:00"
        : "2026-07-30T00:00:00+08:00";
      copy.eventVersion = copy.kickoffTime;
      copy.status = "FINISHED";
      copy.sourceStatus = "FINISHED";
      copy.predictionMeta = {
        ...(copy.predictionMeta || {}),
        cutoffTime: "2026-07-29 22:00:00",
      };
      return copy;
    });
  const snapshotsPayload = readJson(path.join(sourceDataDir, "prediction-snapshots.json"));
  const snapshots = {
    ...snapshotsPayload,
    observations: [],
    rows: [],
  };
  const evidenceSnapshots = {
    ...snapshotsPayload,
    observations: Array.isArray(snapshotsPayload.observations)
      ? snapshotsPayload.observations.filter((row) => SOURCE_IDS.has(sourceId(row)))
      : [],
    rows: snapshotsPayload.rows.filter((row) => SOURCE_IDS.has(sourceId(row))),
  };
  assert.equal(current.length, 2, "the regression fixture must contain both result-feed matches");
  assert.equal(snapshots.rows.length, 0, "the preserved production fixture must reproduce trimmed evidence");
  assert.ok(evidenceSnapshots.rows.length >= 2, "the signed release fixture must retain real pre-cutoff snapshots");

  writeJson(path.join(tempDir, "matches-current.json"), current);
  writeJson(path.join(tempDir, "matches-history.json"), []);
  writeJson(path.join(tempDir, "prediction-snapshots.json"), snapshots);
  writeJson(path.join(evidenceDataDir, "prediction-snapshots.json"), evidenceSnapshots);
  writeJson(
    path.join(evidenceDataDir, "matches-current.json"),
    sourceMatches
      .map((row) => {
        const copy = structuredClone(row);
        if (sourceId(copy) === "2040650") {
          delete copy.archivedPreMatchPrediction;
          copy.status = "SCHEDULED";
          copy.sourceStatus = "SCHEDULED";
        }
        return copy;
      })
  );

  const first = migrateArchivedPreMatchReferences({
    dataDir: tempDir,
    evidenceDataDir,
    capturedAt: "2026-07-30T05:40:00.000Z",
    write: true,
  });
  assert.equal(first.rows.changed, 2);
  assert.equal(
    first.rows.evidenceArchivesApplied,
    1,
    "one row must recover its clock from a signed pre-cutoff snapshot even when the signed current row has no archive yet"
  );
  assert.equal(first.rows.eventClocksRepaired, 2);
  assert.equal(first.rows.currentEvidenceSnapshots, evidenceSnapshots.rows.length);
  assert.deepEqual(
    first.changes.map((row) => row.sourceMatchId).sort(),
    ["2040649", "2040650"]
  );
  for (const change of first.changes) {
    assert.equal(change.action, "archive-attached-or-repaired");
    assert.equal(change.collection, "current");
    assert.equal(change.marketEvidenceScope, "model-only-reference");
    assert.equal(change.tipCode, "1");
    assert.equal(change.odds, 0);
    assert.ok(Date.parse(change.capturedAt) < Date.parse("2026-07-30T00:30:00.000Z"));
  }

  const migrated = readJson(path.join(tempDir, "matches-current.json"));
  for (const match of migrated) {
    assert.equal(match.kickoffTime, "2026-07-30T08:30:00+08:00");
    assert.equal(match.eventVersion, "2026-07-30T08:30:00+08:00");
    assert.equal(
      match.resultEventClockRecovery?.reason,
      "official-result-feed-omitted-kickoff-clock"
    );
    assert.equal(
      match.resultEventClockRecovery?.archiveEvidence,
      sourceId(match) === "2040650"
        ? "signed-pre-cutoff-prediction-snapshot"
        : "signed-current-archive"
    );
    const archive = match.archivedPreMatchPrediction;
    assert.equal(archive?.marketEvidenceScope, "model-only-reference");
    assert.equal(archive?.prediction?.marketType, "BEST");
    assert.equal(archive?.prediction?.oddsPoolCode, "HAD");
    assert.equal(archive?.prediction?.tipCode, "1");
    assert.equal(archive?.prediction?.odds, 0);
    assert.equal(archive?.prediction?.recommendationAction, "reference");
    assert.ok(Date.parse(archive?.capturedAt) < Date.parse(match.kickoffTime));
  }

  const repeated = migrateArchivedPreMatchReferences({
    dataDir: tempDir,
    evidenceDataDir,
    capturedAt: "2026-07-30T05:45:00.000Z",
    write: true,
  });
  assert.equal(repeated.rows.changed, 0, "repeated migration must be idempotent");

  const ambiguitySource = sourceMatches
    .find((row) => sourceId(row) === "2040650");
  assert.ok(ambiguitySource, "the ambiguity fixture requires a signed current row");
  const midnightResult = structuredClone(ambiguitySource);
  delete midnightResult.archivedPreMatchPrediction;
  midnightResult.status = "FINISHED";
  midnightResult.sourceStatus = "FINISHED";
  midnightResult.kickoffTime = "2026-07-29T00:00:00+08:00";
  midnightResult.eventVersion = midnightResult.kickoffTime;
  const firstEvidenceEvent = structuredClone(ambiguitySource);
  delete firstEvidenceEvent.archivedPreMatchPrediction;
  firstEvidenceEvent.status = "SCHEDULED";
  firstEvidenceEvent.sourceStatus = "SCHEDULED";
  const secondEvidenceEvent = structuredClone(firstEvidenceEvent);
  secondEvidenceEvent.kickoffTime = "2026-07-30T09:00:00+08:00";
  secondEvidenceEvent.eventVersion = secondEvidenceEvent.kickoffTime;
  const firstEventSnapshots = evidenceSnapshots.rows
    .filter((row) => sourceId(row) === "2040650");
  const secondEventSnapshots = firstEventSnapshots.map((row) => ({
    ...structuredClone(row),
    kickoffTime: secondEvidenceEvent.kickoffTime,
    eventVersion: secondEvidenceEvent.eventVersion,
  }));
  writeJson(path.join(ambiguityDir, "matches-current.json"), [midnightResult]);
  writeJson(path.join(ambiguityDir, "matches-history.json"), []);
  writeJson(path.join(ambiguityDir, "prediction-snapshots.json"), {
    ...snapshotsPayload,
    observations: [],
    rows: [],
  });
  writeJson(path.join(ambiguityEvidenceDir, "matches-current.json"), [
    firstEvidenceEvent,
    secondEvidenceEvent,
  ]);
  writeJson(path.join(ambiguityEvidenceDir, "prediction-snapshots.json"), {
    ...snapshotsPayload,
    observations: [],
    rows: [...firstEventSnapshots, ...secondEventSnapshots],
  });
  const ambiguous = migrateArchivedPreMatchReferences({
    dataDir: ambiguityDir,
    evidenceDataDir: ambiguityEvidenceDir,
    capturedAt: "2026-07-30T05:40:00.000Z",
    write: true,
  });
  assert.equal(ambiguous.rows.eventClocksRepaired, 0);
  assert.equal(ambiguous.rows.changed, 0);
  const ambiguousResult = readJson(path.join(ambiguityDir, "matches-current.json"))[0];
  assert.equal(ambiguousResult.kickoffTime, "2026-07-29T00:00:00+08:00");
  assert.equal(ambiguousResult.archivedPreMatchPrediction, undefined);

  const historyClockSource = sourceMatches
    .find((row) => sourceId(row) === "2040650");
  const historyMidnightResult = structuredClone(historyClockSource);
  delete historyMidnightResult.archivedPreMatchPrediction;
  // This fixture exercises snapshot-only legacy recovery. Remove any modern
  // immutable published decision inherited from the current production row;
  // when such proof exists, archive parity must prefer it over a hand-edited
  // raw snapshot and is covered by verifyDecisionSnapshots instead.
  delete historyMidnightResult.predictions;
  if (historyMidnightResult.predictionMeta) {
    delete historyMidnightResult.predictionMeta.dualMarketDecision;
    delete historyMidnightResult.predictionMeta.immutableAnalysisReferenceDecision;
    delete historyMidnightResult.predictionMeta.decisionId;
    delete historyMidnightResult.predictionMeta.decisionRevision;
  }
  historyMidnightResult.status = "FINISHED";
  historyMidnightResult.sourceStatus = "FINISHED";
  historyMidnightResult.kickoffTime = "2026-07-30T00:00:00+08:00";
  historyMidnightResult.eventVersion = historyMidnightResult.kickoffTime;
  historyMidnightResult.officialResultIdentity = {
    provider: "sporttery",
    endpoint: "getUniformMatchResultV1",
    matchId: historyMidnightResult.sourceMatchId,
    matchResultStatus: "2",
    poolStatus: "Payout",
    scheduleTimeAuthority: "inherited-pre-match-event-identity",
  };
  const historyEvidenceBase = structuredClone(
    evidenceSnapshots.rows.filter((row) => sourceId(row) === "2040650").at(-1)
  );
  historyEvidenceBase.eventVersion = historyEvidenceBase.kickoffTime;
  historyEvidenceBase.phase = "final";
  historyEvidenceBase.signature = "1X2:HAD:X:reference|BEST:HAD:X:reference";
  historyEvidenceBase.best = {
    ...(historyEvidenceBase.best || {}),
    tipCode: "X",
    oddsPoolCode: "HAD",
    odds: 4.05,
    recommendationAction: "reference",
    recommendationTier: "data-reference",
  };
  historyEvidenceBase.oneXTwo = {
    ...(historyEvidenceBase.oneXTwo || {}),
    tipCode: "X",
    oddsPoolCode: "HAD",
    odds: 4.05,
    recommendationAction: "reference",
    recommendationTier: "data-reference",
  };
  historyEvidenceBase.decisionSnapshot = {
    ...(historyEvidenceBase.decisionSnapshot || {}),
    kickoffTime: historyEvidenceBase.kickoffTime,
    cutoffTime: historyEvidenceBase.cutoffTime,
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      cutoffTime: historyEvidenceBase.cutoffTime,
      kickoffTime: historyEvidenceBase.kickoffTime,
    },
  };
  writeJson(path.join(historyClockDir, "matches-current.json"), []);
  writeJson(path.join(historyClockDir, "matches-history.json"), [historyMidnightResult]);
  writeJson(path.join(historyClockDir, "prediction-snapshots.json"), {
    ...snapshotsPayload,
    observations: [],
    rows: [historyEvidenceBase],
  });
  const historyClockMigration = migrateArchivedPreMatchReferences({
    dataDir: historyClockDir,
    capturedAt: "2026-07-30T05:40:00.000Z",
    write: true,
  });
  const recoveredHistory = readJson(path.join(historyClockDir, "matches-history.json"))[0];
  assert.equal(historyClockMigration.rows.eventClocksRepaired, 1);
  assert.equal(historyClockMigration.rows.changed, 1);
  assert.equal(historyClockMigration.changes[0]?.collection, "history");
  assert.equal(Date.parse(recoveredHistory.kickoffTime), Date.parse(historyEvidenceBase.kickoffTime));
  assert.equal(Date.parse(recoveredHistory.eventVersion), Date.parse(historyEvidenceBase.eventVersion));
  assert.equal(
    recoveredHistory.resultEventClockRecovery?.version,
    "sqlite-pre-match-event-clock-recovery-v1"
  );
  assert.equal(recoveredHistory.archivedPreMatchPrediction?.prediction?.oddsPoolCode, "HAD");
  assert.equal(recoveredHistory.archivedPreMatchPrediction?.prediction?.tipCode, "X");
  assert.equal(recoveredHistory.archivedPreMatchPrediction?.prediction?.odds, 4.05);
  assert.equal(
    recoveredHistory.archivedPreMatchPrediction?.prediction?.recommendationAction,
    "reference"
  );
  const historyClockReplay = migrateArchivedPreMatchReferences({
    dataDir: historyClockDir,
    capturedAt: "2026-07-30T05:45:00.000Z",
    write: true,
  });
  assert.equal(historyClockReplay.rows.changed, 0);
  assert.equal(historyClockReplay.rows.eventClocksRepaired, 0);

  console.log(JSON.stringify({
    ok: true,
    verifier: "archived-pre-match-reference-migration-v1",
    recovered: first.changes,
    repeatedChanges: repeated.rows.changed,
    ambiguousEventChanges: ambiguous.rows.changed,
    historyClockChanges: historyClockMigration.rows.changed,
    historyClockReplayChanges: historyClockReplay.rows.changed,
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(evidenceDataDir, { recursive: true, force: true });
  fs.rmSync(ambiguityDir, { recursive: true, force: true });
  fs.rmSync(ambiguityEvidenceDir, { recursive: true, force: true });
  fs.rmSync(historyClockDir, { recursive: true, force: true });
}
