const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  readSqlitePredictionSnapshotRows,
} = require("../server/sqliteStore.cjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-prediction-audit-"));
const dbPath = path.join(tempDir, "football.db");

const predictionRow = {
  matchId: "sporttery_2040643",
  sourceMatchId: "2040643",
  phase: "prematch",
  capturedAt: "2026-07-28T04:07:28.896Z",
  firstSeenAt: "2026-07-28T04:07:28.896Z",
  lastSeenAt: "2026-07-28T04:07:28.896Z",
  decisionSnapshotVersion: "candidate-decision-snapshot-v2",
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    decisionAt: "2026-07-28T04:07:28.896Z",
    sourceCycleId: "signed-cycle-1",
    policyVersion: "prediction-policy-v1",
    featureSnapshotHash: "feature-sha256",
    probabilities: {
      HAD: { home: 0.34, draw: 0.27, away: 0.39 },
    },
    markets: {
      HAD: {
        odds: { odds1: 2.6, oddsX: 3.3, odds2: 2.27 },
      },
    },
    clockAudit: { eligible: true },
  },
};

const run = async () => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE prediction_snapshots (
      id TEXT PRIMARY KEY,
      state_key TEXT UNIQUE,
      match_id TEXT,
      source_match_id TEXT,
      phase TEXT,
      captured_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO prediction_snapshots
      (id, state_key, match_id, source_match_id, phase, captured_at, first_seen_at, last_seen_at, seen_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "prediction-audit-fixture",
    "prediction-audit-fixture",
    predictionRow.matchId,
    predictionRow.sourceMatchId,
    predictionRow.phase,
    predictionRow.capturedAt,
    predictionRow.firstSeenAt,
    predictionRow.lastSeenAt,
    1,
    JSON.stringify(predictionRow),
  );
  db.close();

  const bySource = await readSqlitePredictionSnapshotRows(dbPath, {
    sourceMatchId: "2040643",
    phase: "prematch",
    limit: 5,
  });
  assert.equal(bySource.length, 1);
  assert.equal(bySource[0].decisionSnapshot.version, "candidate-decision-snapshot-v2");
  assert.equal(bySource[0].decisionSnapshot.clockAudit.eligible, true);

  const byMatch = await readSqlitePredictionSnapshotRows(dbPath, {
    matchId: "sporttery_2040643",
    limit: 5,
  });
  assert.equal(byMatch.length, 1);
  assert.equal(byMatch[0].decisionSnapshot.featureSnapshotHash, "feature-sha256");

  const missing = await readSqlitePredictionSnapshotRows(dbPath, {
    sourceMatchId: "missing",
    limit: 5,
  });
  assert.deepEqual(missing, []);

  console.log(JSON.stringify({
    ok: true,
    assertions: 7,
    decisionSnapshotVersion: bySource[0].decisionSnapshot.version,
    clockEligible: bySource[0].decisionSnapshot.clockAudit.eligible,
  }, null, 2));
};

run()
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
