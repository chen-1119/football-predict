"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { commitCurrentDataGeneration } = require("../server/dataGenerationBundle.cjs");
const { storePaths, acquirePointerCommitLock } = require("../server/dataGenerationStore.cjs");
const { createPostgresGenerationSource } = require("./postgresGenerationSource.cjs");
const { syncPostgresProjectionFromSource } = require("./postgresProjectionSync.cjs");
const { canonicalPredictionState, canonicalOddsState } = require("./sqliteWarehouse.cjs");

async function verifyGenerationSource(pool) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-generation-"));
  const storeDir = path.join(temp, "store"), publicDataDir = path.join(temp, "public");
  fs.mkdirSync(publicDataDir);
  const checks = [], at = "2026-09-09T00:01:00.000Z", later = "2026-09-09T01:01:00.000Z";
  const prediction = { matchId: "sporttery_qa-generation", sourceMatchId: "qa-generation", phase: "pre-match",
    signature: "original-draw-signature", capturedAt: at, tipCode: "X", note: "原始预测" };
  const odds = { matchId: prediction.matchId, sourceMatchId: prediction.sourceMatchId, poolCode: "HAD",
    capturedAt: at, odds1: 2, oddsX: 3.6, odds2: 3.1 };
  const payloads = {
    "matches-current.json": [{ id: prediction.matchId, sourceMatchId: prediction.sourceMatchId, status: "SCHEDULED", kickoffTime: "2026-09-11T10:00:00.000Z" }],
    "matches-history.json": [], "sync-meta.json": { sourceCycleId: "qa-native-generation", updatedAt: at },
    "external-signals.json": { updatedAt: at, matches: {} }, "odds-history.json": { rows: [odds] },
    "prediction-snapshots.json": { rows: [prediction] }, "model-calibration.json": { version: "qa-shadow", generatedAt: at },
  };
  const publish = () => {
    for (const [file, value] of Object.entries(payloads)) fs.writeFileSync(path.join(publicDataDir, file), JSON.stringify(value));
    return commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId: payloads["sync-meta.json"].sourceCycleId, committedAt: at });
  };
  const source = () => createPostgresGenerationSource({ storeDir, publicDataDir });
  const syncOptions = { pool, mode: "backfill", aiArenaPath: path.join(temp, "no-arena.json") };
  const rows = async table => (await pool.query(`SELECT *, payload::text AS raw FROM football.${table} ORDER BY id`)).rows;
  try {
    publish();
    const first = await syncPostgresProjectionFromSource(source(), syncOptions);
    assert.equal(first.ok, true); assert.equal(first.rowCounts.match_snapshots, 1);
    assert.equal((await rows("prediction_snapshots"))[0].raw, JSON.stringify(canonicalPredictionState(prediction).payload));
    assert.equal((await rows("odds_snapshots"))[0].raw, JSON.stringify(canonicalOddsState(odds).payload));
    checks.push({ name: "real immutable generation projects canonical states directly into PostgreSQL", ok: true });
    const { readPostgresModelInput } = require("./postgresModelInput.cjs");
    const { createModelInputCollector } = require("./modelInputRows.cjs");
    const modelOptions = { pool, storeDir, publicDataDir, createCollector: createModelInputCollector,
      prediction_snapshots: { limit: 50, preferLatestRows: true, maxRowsPerMatch: 6 },
      odds_snapshots: { limit: 50 } };
    const input = await readPostgresModelInput(modelOptions);
    assert.equal(input.current[0].id, prediction.matchId);
    assert.equal(input.history.length, 0);
    assert.equal(input.prediction_snapshots.source, "postgres");
    assert.deepEqual(input.prediction_snapshots.rows, [canonicalPredictionState(prediction).payload]);
    assert.deepEqual(input.odds_snapshots.rows, [canonicalOddsState(odds).payload]);
    checks.push({ name: "native model input reads exact matches, predictions and odds in one generation-bound snapshot", ok: true });
    await assert.rejects(readPostgresModelInput({ ...modelOptions,
      publicationIdentity: { ...input.publication, generationId: "wrong" } }), /publication mismatch/);
    await assert.rejects(readPostgresModelInput({ ...modelOptions,
      odds_snapshots: { limit: NaN } }), /row limit/);
    const deniedPool = { connect: async () => { throw new Error("qa model database unavailable"); } };
    await assert.rejects(readPostgresModelInput({ ...modelOptions, pool: deniedPool }), /database unavailable/);
    checks.push({ name: "native training refuses mismatched identity, unsafe bounds and database outage without fallback", ok: true });
    const originalOdds = (await rows("odds_snapshots"))[0];
    let concurrentWrite = false;
    const concurrentPool = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql, values) => {
        if (sql.startsWith("FETCH FORWARD 128 FROM model_prediction") && !concurrentWrite) {
          concurrentWrite = true;
          const writer = new (require("pg").Client)(pool.options);
          try {
            await writer.connect();
            await writer.query("UPDATE football.odds_snapshots SET payload = $1::json WHERE id = $2",
              [JSON.stringify({ ...JSON.parse(originalOdds.raw), oddsX: 99 }), originalOdds.id]);
          } finally { await writer.end(); }
        }
        return client.query(sql, values);
      } };
    } };
    try {
      const consistent = await readPostgresModelInput({ ...modelOptions, pool: concurrentPool });
      assert.equal(concurrentWrite, true);
      assert.deepEqual(consistent.odds_snapshots.rows, input.odds_snapshots.rows);
    } finally {
      await pool.query("UPDATE football.odds_snapshots SET payload = $1::json WHERE id = $2", [originalOdds.raw, originalOdds.id]);
    }
    checks.push({ name: "concurrent odds revision cannot mix with the training transaction's older predictions", ok: true });
    const pBefore = (await rows("prediction_snapshots"))[0];
    const same = await syncPostgresProjectionFromSource(source(), { ...syncOptions, mode: "incremental" });
    assert.equal(same.skipped, true); assert.equal((await rows("prediction_snapshots"))[0].raw, pBefore.raw);
    assert.equal(fs.existsSync(storePaths(storeDir).pointerLockDir), false);
    checks.push({ name: "unchanged generation skips and releases its COMMIT lock", ok: true });
    payloads["prediction-snapshots.json"].rows[0] = { ...prediction, note: "same-clock conflicting replacement" };
    publish();
    await syncPostgresProjectionFromSource(source(), syncOptions);
    assert.equal((await rows("prediction_snapshots"))[0].raw, pBefore.raw);
    checks.push({ name: "same-clock prediction cannot overwrite original draw payload", ok: true });
    payloads["prediction-snapshots.json"].rows[0] = { ...prediction, lastSeenAt: later, seenCount: 2 };
    payloads["odds-history.json"].rows[0] = { ...odds, lastSeenAt: later, seenCount: 2 };
    publish();
    await syncPostgresProjectionFromSource(source(), syncOptions);
    const observed = (await rows("prediction_snapshots"))[0];
    assert.equal(observed.captured_at.toISOString(), at); assert.equal(observed.last_seen_at.toISOString(), later);
    assert.equal(observed.seen_count, 2); assert.equal(JSON.parse(observed.raw).tipCode, "X");
    checks.push({ name: "later observation advances bounds without refreshing first capture or inventing samples", ok: true });
    payloads["prediction-snapshots.json"].rows = []; payloads["odds-history.json"].rows = []; publish();
    await syncPostgresProjectionFromSource(source(), syncOptions);
    assert.equal((await rows("prediction_snapshots"))[0].raw, observed.raw);
    assert.equal((await rows("odds_snapshots")).length, 1);
    checks.push({ name: "generation input retention cannot discard retained PostgreSQL warehouse history", ok: true });
    const stale = source();
    payloads["sync-meta.json"].sourceCycleId += "-next";
    // A cycle-clock-only update is deliberately a semantic no-op. Change
    // real content so this test actually rotates the immutable generation.
    payloads["matches-current.json"][0].homeTeam = "next immutable team";
    publish();
    await assert.rejects(syncPostgresProjectionFromSource(stale, syncOptions), /pointer changed/);
    checks.push({ name: "rotated generation rejected before PostgreSQL mutation", ok: true });
    const lockSource = source();
    const acquired = lockSource.beforeCommit.bind(lockSource);
    lockSource.beforeCommit = () => {
      acquired();
      assert.throws(() => acquirePointerCommitLock({ lockDir: storePaths(storeDir).pointerLockDir, timeoutMs: 0 }), /timed out/);
      throw new Error("qa failure after pointer lock acquired");
    };
    const beforeRuns = Number((await pool.query("SELECT count(*) AS n FROM football.projection_runs")).rows[0].n);
    await assert.rejects(syncPostgresProjectionFromSource(lockSource, syncOptions), /qa failure after pointer lock/);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM football.projection_runs")).rows[0].n), beforeRuns);
    assert.equal(fs.existsSync(storePaths(storeDir).pointerLockDir), false);
    checks.push({ name: "failed pointer-locked COMMIT rolls back receipt and releases owned lock", ok: true });
    const invalid = source();
    await pool.query("INSERT INTO football.projection_meta(key,value,updated_at) VALUES('fast_result_revision','1',$1)", [at]);
    try { await assert.rejects(syncPostgresProjectionFromSource(invalid, syncOptions), /fast-result integrity invalid/); }
    finally { await pool.query("DELETE FROM football.projection_meta WHERE key='fast_result_revision'"); }
    checks.push({ name: "partial fast-result metadata fails closed rather than resetting history", ok: true });
    const { publisherCollector, baseCurrentMatch, relaySnapshot } = require("./nativeFastResultFixture.cjs");
    const { publishOfficialResultsPostgres } = require("./publishOfficialResultsFast.cjs");
    const fastId = "native-fast-fixture";
    payloads["matches-current.json"] = [baseCurrentMatch({ sourceMatchId: fastId })];
    publish(); await syncPostgresProjectionFromSource(source(), syncOptions);
    const publisherOptions = { pool, storeDir, publicDataDir, syncMetaPath: path.join(publicDataDir, "sync-meta.json"),
      publicationLedgerPath: path.join(storeDir, "absent-ledger.json"), trustRegistry: publisherCollector.registry };
    const fast = await publishOfficialResultsPostgres({ ...publisherOptions,
      relaySnapshot: relaySnapshot({ sourceMatchId: fastId, capturedAt: "2026-07-13T02:05:00.000Z" }) });
    assert.equal(fast.ok, true); assert.equal(fast.publishedRows, 1, JSON.stringify(fast));
    let finals = (await rows("match_snapshots")).filter(row => row.source_match_id === fastId);
    assert.equal(finals.length, 1); assert.equal(finals[0].dataset, "history");
    const finalRaw = finals[0].raw;
    assert.equal(JSON.parse(finalRaw).scoreHome, 2);
    const { readPostgresFastResultReceiptState } = require("../server/postgresProjectionStore.cjs");
    const { resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
    const receiptState = await readPostgresFastResultReceiptState(pool, {
      publicationIdentity: resolveActivePublication({ storeDir, publicDataDir }).identity,
    });
    assert.equal(receiptState.valid, true, JSON.stringify(receiptState));
    assert.equal(receiptState.missing, false);
    assert.equal(receiptState.receipt.observations[0].scoreHome, 2);
    checks.push({ name: "native API reader validates the signed fast-result receipt directly without emulated SQLite SQL", ok: true });
    checks.push({ name: "signed official result publishes directly in PostgreSQL with an atomic history and receipt", ok: true });
    await syncPostgresProjectionFromSource(source(), syncOptions);
    finals = (await rows("match_snapshots")).filter(row => row.source_match_id === fastId);
    assert.equal(finals.length, 1); assert.equal(finals[0].raw, finalRaw);
    checks.push({ name: "stale immutable base cannot resurrect current match or overwrite receipt-protected final", ok: true });
    const repeated = await publishOfficialResultsPostgres({ ...publisherOptions,
      relaySnapshot: relaySnapshot({ sourceMatchId: fastId, capturedAt: "2026-07-13T02:06:00.000Z" }) });
    assert.equal(repeated.publishedRows, 0, JSON.stringify(repeated));
    assert.equal((await rows("match_snapshots")).find(row => row.source_match_id === fastId).raw, finalRaw);
    checks.push({ name: "same-score signed replay preserves original result payload", ok: true });
    const corrected = await publishOfficialResultsPostgres({ ...publisherOptions,
      relaySnapshot: relaySnapshot({ sourceMatchId: fastId, scoreHome: 3, capturedAt: "2026-07-13T02:07:00.000Z" }) });
    assert.equal(corrected.publishedRows, 1, JSON.stringify(corrected));
    const correctedRaw = (await rows("match_snapshots")).find(row => row.source_match_id === fastId).raw;
    assert.equal(JSON.parse(correctedRaw).scoreHome, 3);
    const older = await publishOfficialResultsPostgres({ ...publisherOptions,
      relaySnapshot: relaySnapshot({ sourceMatchId: fastId, scoreHome: 2, capturedAt: "2026-07-13T02:06:30.000Z" }) });
    assert.equal(older.publishedRows, 0);
    assert.equal((await rows("match_snapshots")).find(row => row.source_match_id === fastId).raw, correctedRaw);
    checks.push({ name: "new signed correction advances authority while an older score replay is refused", ok: true });
    assert.equal(fs.existsSync(path.join(storeDir, "football.db")), false);
    return { ok: true, checks, scope: "real generation files and native PostgreSQL; no production cutover" };
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-native-generation-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyGenerationSource };
