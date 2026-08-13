"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  HistoricalWarehouseError,
  QUERY_SCHEMA_VERSION,
  WAREHOUSE_SCHEMA_VERSION,
  historicalWarehouseStatus,
  importHistoricalCsvToWarehouse,
  queryHistoricalEventsAsOf,
} = require("./historicalTrainingWarehouse.cjs");

const CREATED_AT = "2026-07-16T00:00:00.000Z";
const COMPLETED_AT = "2026-07-16T00:00:01.000Z";
const HEADER = "Division,MatchDate,MatchTime,HomeTeam,AwayTeam,FTHome,FTAway,OddHome,OddDraw,OddAway,HomeShots,HomeCorners";

const csv = (...rows) => [HEADER, ...rows, ""].join("\n");

async function importText(dbPath, text, suffix, extra = {}) {
  return importHistoricalCsvToWarehouse({
    dbPath,
    dataset: "xgabora",
    input: text,
    importId: `synthetic-${suffix}`,
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    batchSize: 1,
    ...extra,
  });
}

async function expectQuarantine(operation, expectedCode = "IMPORT_QUARANTINED") {
  let thrown = null;
  try { await operation(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof HistoricalWarehouseError);
  assert.equal(thrown.code, expectedCode);
  return thrown;
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "historical-training-warehouse-"));
  const dbPath = path.join(tempDir, "training.sqlite");
  const policyDbPath = path.join(tempDir, "policy.sqlite");
  const availabilityTamperDbPath = path.join(tempDir, "availability-tamper.sqlite");
  const coverageTamperDbPath = path.join(tempDir, "coverage-tamper.sqlite");
  try {
    const source = csv(
      "L1,2024-01-01,10:00Z,Alpha,Beta,2,1,1.8,3.4,4.2,99,18",
      "L1,2024-01-02,,Gamma,Delta,0,0,2.1,3.0,3.2,88,11",
      "L1,2024-01-03,20:00Z,Echo,Foxtrot,1,3,2.0,3.1,3.7,77,9",
    );
    const first = await importText(dbPath, source, "first");
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(first.insertedRows, 3);
    assert.match(first.manifest.sourceFileSha256, /^[a-f0-9]{64}$/);
    assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(first.manifest.sourceEventRootHash, /^[a-f0-9]{64}$/);
    assert.match(first.manifest.importStrategySha256, /^[a-f0-9]{64}$/);
    assert.notEqual(first.manifest.rootHash, first.manifest.sourceEventRootHash);
    assert.equal(first.manifest.importStrategy.availabilityPolicy.kickoffDelayMs, 6 * 60 * 60 * 1000);
    assert.equal(first.manifest.importStrategy.availabilityPolicy.strictPromotionEligible, false);
    assert.match(first.manifest.importStrategy.parserRevision, /historical-event-csv-parser/);
    assert.match(first.manifest.importStrategy.adapterRevision, /historical-event-adapters/);

    const strictDefault = queryHistoricalEventsAsOf({
      dbPath,
      forecastTime: "2025-01-01T00:00:00.000Z",
    });
    assert.equal(strictDefault.rows, 0, "strict queries must reject derived result availability by default");
    assert.equal(strictDefault.queryPolicy, "strict-explicit-observation-only");
    assert.equal(strictDefault.integrity.derivedAvailabilityAllowed, false);
    assert.equal(strictDefault.integrity.derivedRowsExcluded, 3);

    const exploratory = (forecastTime) => queryHistoricalEventsAsOf({
      dbPath,
      forecastTime,
      allowDerivedAvailability: true,
    });
    const beforeFinished = exploratory("2024-01-01T15:59:59.000Z");
    assert.equal(beforeFinished.version, QUERY_SCHEMA_VERSION);
    assert.equal(beforeFinished.rows, 0, "a final score is unavailable before kickoff plus the result delay");
    const afterFinished = exploratory("2024-01-01T16:00:00.000Z");
    assert.equal(afterFinished.rows, 1);
    assert.deepEqual(afterFinished.events[0].historicalOutcome, { homeGoals: 2, awayGoals: 1 });
    assert.equal(afterFinished.events[0].availableAt, "2024-01-01T16:00:00.000Z");
    assert.equal(afterFinished.events[0].availabilityProvenance.strictPromotionEligible, false);
    assert.match(afterFinished.events[0].availabilityProvenance.importStrategySha256, /^[a-f0-9]{64}$/);
    assert.equal(afterFinished.queryPolicy, "exploratory-derived-opt-in");
    assert.equal(afterFinished.integrity.availabilityCommitmentVerified, true);
    assert.doesNotMatch(JSON.stringify(afterFinished.events).toLowerCase(), /homeshots|homecorners|fouls|yellow|redcard/);
    assert.equal(afterFinished.events[0].sourceRowNumber, undefined);
    assert.equal(afterFinished.integrity.projectionOnly, true);

    const dateOnlySameDay = exploratory("2024-01-02T23:59:59.000Z");
    assert.equal(dateOnlySameDay.events.some((row) => row.homeTeam.raw === "Gamma"), false);
    const dateOnlyNextDay = exploratory("2024-01-03T00:00:00.000Z");
    assert.equal(dateOnlyNextDay.events.some((row) => row.homeTeam.raw === "Gamma"), false);
    const dateOnlyTwoDaysLater = exploratory("2024-01-04T00:00:00.000Z");
    assert.equal(dateOnlyTwoDaysLater.events.some((row) => row.homeTeam.raw === "Gamma"), true);

    const bytesBeforeDuplicate = fs.statSync(dbPath).size;
    const duplicate = await importText(dbPath, source, "duplicate");
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.preflight, true);
    assert.equal(duplicate.priorImportId, first.importId);
    assert.equal(fs.statSync(dbPath).size, bytesBeforeDuplicate, "idempotent preflight must not grow the database");
    assert.equal(historicalWarehouseStatus(dbPath).events, 3);

    const policyFirst = await importText(policyDbPath, source, "policy-first");
    assert.equal(policyFirst.idempotent, false);
    await expectQuarantine(() => importText(policyDbPath, source, "policy-delay-change", {
      resultDelayMs: 12 * 60 * 60 * 1000,
    }));
    await expectQuarantine(() => importText(policyDbPath, source, "policy-timezone-change", {
      timezoneOffset: "+08:00",
    }));
    await expectQuarantine(() => importText(policyDbPath, source, "policy-parser-change", {
      parserRevision: "historical-event-csv-parser:test-revision-2",
    }));
    await expectQuarantine(() => importText(policyDbPath, source, "policy-adapter-change", {
      adapterRevision: "historical-event-adapters:test-revision-2",
    }));
    const policyStatus = historicalWarehouseStatus(policyDbPath);
    assert.equal(policyStatus.events, 3, "strategy changes must not replace the active event set");
    assert.equal(policyStatus.imports.active, 1);
    assert.equal(policyStatus.imports.blocked, 4);

    const incremental = await importText(dbPath, csv(
      "L1,2024-01-04,18:00Z,India,Juliet,4,2,1.7,3.6,4.8,66,8",
    ), "incremental");
    assert.equal(incremental.insertedRows, 1);
    assert.equal(historicalWarehouseStatus(dbPath).events, 4);

    const conflict = await expectQuarantine(() => importText(dbPath, csv(
      "L1,2024-01-01,10:00Z,Alpha,Beta,9,1,1.8,3.4,4.2,1,1",
    ), "conflict"));
    assert.equal(conflict.conflicts, 1);
    const afterConflict = historicalWarehouseStatus(dbPath);
    assert.equal(afterConflict.events, 4, "a conflicting import must not alter active events");
    assert.equal(afterConflict.conflicts, 1);
    assert.equal(afterConflict.stagingRows, 0);

    await expectQuarantine(() => importText(dbPath, csv(
      "L1,2024-01-05,12:00Z,Invalid,Score,-1,0,2.0,3.0,4.0,1,1",
    ), "rejected"));
    const afterReject = historicalWarehouseStatus(dbPath);
    assert.equal(afterReject.events, 4);
    assert.equal(afterReject.rejections, 1);
    assert.equal(afterReject.storage.encoding, "deflate-raw-json-v1");
    assert.ok(afterReject.storage.compressedEventBytes < afterReject.storage.rawEventJsonBytes);
    assert.ok(afterReject.storage.payloadCompressionRatio < 0.8);

    const allowedRejected = await importText(dbPath, csv(
      "L1,2024-01-05,12:00Z,Kilo,Lima,2,0,1.9,3.2,4.1,2,1",
      "L1,2024-01-06,12:00Z,Invalid,Allowed,-1,0,2.0,3.0,4.0,1,1",
    ), "allowed-rejected", { allowRejectedRows: true });
    assert.equal(allowedRejected.manifest.rejected, 1);
    assert.equal(allowedRejected.insertedRows, 1);
    const rejectedAuditDb = new DatabaseSync(dbPath);
    const allowedRejectedImport = rejectedAuditDb.prepare(`
      SELECT rejected_rows, manifest_json FROM historical_event_imports
      WHERE import_id='synthetic-allowed-rejected'
    `).get();
    const allowedRejectedRows = rejectedAuditDb.prepare(`
      SELECT COUNT(*) AS count FROM historical_event_rejections
      WHERE import_id='synthetic-allowed-rejected'
    `).get();
    rejectedAuditDb.close();
    assert.equal(allowedRejectedImport.rejected_rows, 1);
    assert.equal(JSON.parse(allowedRejectedImport.manifest_json).rejected, 1);
    assert.equal(allowedRejectedRows.count, 1);

    const tamperSource = csv(
      "L1,2024-02-01,10:00Z,Tamper Home,Tamper Away,1,0,2.0,3.0,4.0,1,1",
    );
    await importText(availabilityTamperDbPath, tamperSource, "availability-tamper-first");
    const availabilityTamperDb = new DatabaseSync(availabilityTamperDbPath);
    availabilityTamperDb.prepare(`
      UPDATE historical_event_payloads SET available_at='2024-02-01T11:00:00.000Z'
    `).run();
    availabilityTamperDb.close();
    assert.throws(
      () => queryHistoricalEventsAsOf({
        dbPath: availabilityTamperDbPath,
        forecastTime: "2024-02-02T00:00:00.000Z",
        allowDerivedAvailability: true,
      }),
      (error) => error instanceof HistoricalWarehouseError && error.code === "QUERY_INTEGRITY_FAILURE",
      "changing committed availability from kickoff+6h to kickoff+1h must fail closed",
    );

    const coverageSource = csv(
      "L1,2024-03-01,10:00Z,Coverage Home,Coverage Away,1,0,2.0,3.0,4.0,1,1",
    );
    await importText(coverageTamperDbPath, coverageSource, "coverage-first");
    const coverageTamperDb = new DatabaseSync(coverageTamperDbPath);
    coverageTamperDb.exec("DELETE FROM historical_events");
    coverageTamperDb.close();
    await expectQuarantine(
      () => importText(coverageTamperDbPath, coverageSource, "coverage-duplicate"),
      "QUERY_INTEGRITY_FAILURE",
    );

    const db = new DatabaseSync(dbPath);
    const eventColumns = new Set(db.prepare("PRAGMA table_info(historical_event_payloads)").all().map((row) => row.name));
    assert.equal(eventColumns.has("event_payload"), true);
    assert.equal(eventColumns.has("availability_commitment_sha256"), true);
    assert.equal(eventColumns.has("event_json"), false);
    assert.equal(eventColumns.has("feature_json"), false);
    const importColumns = new Set(db.prepare("PRAGMA table_info(historical_event_imports)").all().map((row) => row.name));
    assert.equal(importColumns.has("import_strategy_json"), true);
    assert.equal(importColumns.has("import_strategy_sha256"), true);
    assert.equal(importColumns.has("availability_mode"), true);
    const manifestRow = db.prepare(`
      SELECT source_file_sha256, manifest_sha256, manifest_root_hash, manifest_json,
             import_strategy_json, import_strategy_sha256
      FROM historical_event_imports WHERE import_id=?
    `).get(first.importId);
    assert.match(manifestRow.source_file_sha256, /^[a-f0-9]{64}$/);
    assert.match(manifestRow.manifest_sha256, /^[a-f0-9]{64}$/);
    const storedManifest = JSON.parse(manifestRow.manifest_json);
    assert.equal(storedManifest.rootHash, manifestRow.manifest_root_hash);
    assert.equal(storedManifest.importStrategySha256, manifestRow.import_strategy_sha256);
    assert.deepEqual(storedManifest.importStrategy, JSON.parse(manifestRow.import_strategy_json));
    const uniqueRows = db.prepare(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT source_event_id) AS unique_rows FROM historical_events
    `).get();
    assert.equal(uniqueRows.rows, uniqueRows.unique_rows);

    db.prepare(`
      UPDATE historical_event_payloads SET event_payload=zeroblob(event_payload_bytes)
      WHERE source_event_id=(SELECT source_event_id FROM historical_events ORDER BY source_event_id LIMIT 1)
    `).run();
    db.close();
    assert.throws(
      () => queryHistoricalEventsAsOf({
        dbPath,
        forecastTime: "2025-01-01T00:00:00.000Z",
        allowDerivedAvailability: true,
      }),
      (error) => error instanceof HistoricalWarehouseError && error.code === "QUERY_INTEGRITY_FAILURE",
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "historical-training-warehouse",
      schemaVersion: WAREHOUSE_SCHEMA_VERSION,
      checks: [
        "streaming-batched-import",
        "source-event-id-uniqueness",
        "event-content-hash-recomputed",
        "source-file-and-manifest-hashes",
        "strategy-bound-idempotent-incremental-import",
        "active-row-root-manifest-preflight-coverage",
        "cross-import-conflict-quarantine-fail-closed",
        "rejected-row-quarantine-default",
        "allowed-rejection-three-way-audit-consistency",
        "strict-default-rejects-derived-availability",
        "exploratory-derived-availability-explicit-opt-in",
        "availability-policy-and-timestamp-content-commitment",
        "date-only-two-day-conservative-availability",
        "post-match-field-projection-boundary",
        "stored-content-tamper-detection",
        "single-compressed-canonical-payload-no-feature-duplication",
      ],
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
