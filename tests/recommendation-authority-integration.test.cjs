'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const authority = require('../server/recommendationAuthority.cjs');
const dual = require('../src/services/dualMarketDecisionBinding.cjs');
const parity = require('../server/recommendationProjectionParity.cjs');

const NOW = Date.parse('2026-10-10T13:18:07.000Z');
const UPDATED = '2026-10-10T13:17:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const publication = {
  mode: 'active-generation', generationId: 'authority-integration-generation',
  manifestHash: 'a'.repeat(64), sourceCycleId: 'authority-integration-cycle',
  committedAt: '2026-10-10T13:16:00.000Z',
};
const options = { publicationIdentity: publication, recommendationAuthorityPolicy: authority.TRAINED_ONLY_POLICY };
const match = (id = '2041870') => ({
  id: `sporttery_${id}`, sourceMatchId: id, status: 'SCHEDULED',
  kickoffTime: '2026-10-10T13:30:00.000Z', eventVersion: '2026-10-10T13:30:00.000Z',
  buyEndTime: '2026-10-10T13:30:00.000Z', homeTeamName: 'Home', awayTeamName: 'Away',
  predictions: [{ marketType: '1X2', oddsPoolCode: 'HAD', tipCode: '1', odds: 2.125 }],
});
const withArchive = row => ({ ...row, archivedPreMatchPrediction: {
  version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
  sourceMatchId: row.sourceMatchId, eventVersion: row.eventVersion, kickoffTime: row.kickoffTime,
  cutoffTime: row.buyEndTime, capturedAt: '2026-10-10T03:05:39.516Z',
  prediction: { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1', odds: 2.125 },
} });
const center = () => ({
  version: 'recommendation-center-v1', businessDate: '2026-10-10', updatedAt: UPDATED,
  current: [], previews: [], todayCombos: [], todayDualResearch: [],
  strategySwitch: { version: 'trained-strategy-switch-v1', activeReferenceStrategy: 'league-trained-baseline-v1',
    legacyPublicationEnabled: false, legacyFallbackEnabled: false, formalEligible: false, modelAdoptionCount: 0 },
  reviewedAnalysis: { version: 'reviewed-analysis-view-v1', businessDate: '2026-10-10', updatedAt: UPDATED,
    records: [], combos: [], threeCombos: [], formalEligible: false },
  leagueBaseline: { version: 'league-baseline-directions-v1', businessDate: '2026-10-10', updatedAt: UPDATED,
    records: [], blocked: 0, formalEligible: false },
});

// Execute the actual reader with only its clock and storage-mode environment
// pinned. Authority validation and both publication replay modules stay real.
function projectionReader(storageMode = 'postgres-only', overrides = {}) {
  const filename = require.resolve('../server/postgresProjectionStore.cjs');
  const module = { exports: {} };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: id => overrides[id] || createRequire(filename)(id), Date: FixedDate,
    process: { env: { ...process.env, FOOTBALL_STORAGE_MODE: storageMode } },
  }, { filename });
  return module.exports;
}

function database({ current = [match()], history = [], publishedCenter = center(), artifacts = [], failAt = null } = {}) {
  const calls = [];
  let inTransaction = false, connections = 0, releases = 0;
  const snapshots = (rows, dataset) => rows.map(payload => ({ payload: clone(payload), dataset,
    match_id: payload.id, source_match_id: payload.sourceMatchId, kickoff_time: payload.kickoffTime }));
  const client = {
    async query(sql, values = []) {
      const text = sql.trim().replace(/\s+/g, ' ');
      calls.push({ text, values });
      if (text.startsWith('BEGIN')) {
        assert.equal(inTransaction, false, 'must not nest an authority transaction');
        assert.equal(text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        inTransaction = true;
        return { rows: [] };
      }
      assert.equal(inTransaction, true, 'all match, center and publication reads must share the caller snapshot');
      if (text === 'COMMIT' || text === 'ROLLBACK') { inTransaction = false; return { rows: [] }; }
      assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/, 'public authority reads cannot write');
      if (failAt && text.includes(failAt)) throw new Error('injected authority storage failure');
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      if (/^(SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(text)) return { rows: [] };
      if (text.includes('football.recommendation_result_heads')) return { rows: [] };
      if (text.includes('football.projection_meta')) return { rows: Object.entries({
        data_publication_mode: publication.mode, data_generation_id: publication.generationId,
        manifest_hash: publication.manifestHash, data_generation_source_cycle_id: publication.sourceCycleId,
        source_cycle_id: publication.sourceCycleId, committed_at: publication.committedAt,
      }).map(([key, value]) => ({ key, value })) };
      if (text.includes('football.daily_featured_combo_state')) return { rows: publishedCenter === null ? []
        : [{ payload: { recommendationCenter: clone(publishedCenter) } }] };
      if (text.includes('football.private_model_artifacts')) return { rows: clone(artifacts) };
      if (text.includes('football.match_snapshots')) {
        if (/WHERE (?:match_id|dataset IN)/.test(text)) {
          return { rows: [...snapshots(current, 'current'), ...snapshots(history, 'history')] };
        }
        return { rows: /dataset\s*=\s*'current'/.test(text) ? snapshots(current, 'current') : snapshots(history, 'history') };
      }
      assert.fail(`Unexpected query: ${text}`);
    },
    release() { assert.equal(inTransaction, false); releases++; },
  };
  const pool = {
    async connect() { connections++; return client; },
    async query() { assert.fail('authority must use the existing client, never the pool'); },
  };
  return { pool, client, calls, get connections() { return connections; }, get releases() { return releases; } };
}

function committed(db) {
  assert.equal(db.connections, 1);
  assert.equal(db.releases, 1);
  assert.equal(db.calls[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.calls.at(-1).text, 'COMMIT');
  assert.equal(db.calls.filter(call => call.text.includes('football.daily_featured_combo_state')).length, 1);
  assert.equal(db.calls.filter(call => call.text.includes('football.private_model_artifacts')).length, 2);
}
function rolledBack(db) {
  assert.equal(db.connections, 1);
  assert.equal(db.releases, 1);
  assert.equal(db.calls.at(-1).text, 'ROLLBACK');
  assert.equal(db.calls.some(call => call.text === 'COMMIT'), false);
}

test('current public reader replays center authority in the same read-only snapshot and preserves raw evidence', async () => {
  const rows = [match(), withArchive(match('2041871'))], before = clone(rows), db = database({ current: rows });
  const result = await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options);
  assert.deepEqual(clone(result.rows.map(row => row.predictions)), [[], []]);
  assert.equal(result.rows[0].recommendationAuthority.legacyArchiveState, 'missing');
  assert.equal(result.rows[1].recommendationAuthority.legacyArchiveState, 'valid');
  assert.deepEqual(clone(result.rows[1].archivedPreMatchPrediction), before[1].archivedPreMatchPrediction);
  assert.equal(result.rows[0].archivedPreMatchPrediction, undefined);
  assert.deepEqual(rows, before);
  assert.equal(result.recommendationAuthority.activeValidation.reviewed.status, 'verified');
  assert.equal(result.recommendationAuthority.activeValidation.trained.status, 'verified');
  committed(db);
});

test('current wrapper and transition reader retire current predictions while preserving historical rows', async () => {
  const reader = projectionReader(), db = database();
  const rows = await reader.readPostgresCurrentMatches(db.pool, options);
  assert.deepEqual(clone(rows[0].predictions), []);
  committed(db);
  const history = [withArchive({ ...match('2041869'), status: 'FINISHED' })];
  const transitionDb = database({ history });
  const snapshot = await reader.readPostgresCurrentTransitionSnapshot(transitionDb.pool, { ...options, limit: 32 });
  assert.equal(snapshot.available, true);
  assert.deepEqual(clone(snapshot.currentRows[0].predictions), []);
  assert.deepEqual(clone(snapshot.transitionRows), history);
  assert.equal(snapshot.recommendationAuthority.legacyCurrentEnabled, false);
  committed(transitionDb);
});

test('canonical current detail uses verified retirement in the same transaction as its match read', async () => {
  const row = withArchive(match()), before = clone(row), db = database({ current: [row] });
  const result = await projectionReader().readPostgresMatchDetailById(db.pool, row.id, options);
  assert.equal(result.id, row.id);
  assert.deepEqual(clone(result.predictions), []);
  assert.deepEqual(clone(result.archivedPreMatchPrediction), row.archivedPreMatchPrediction);
  assert.deepEqual(row, before);
  committed(db);
});

test('historical detail and internal raw reader retain frozen payloads without current authority projection', async () => {
  const row = withArchive({ ...match(), status: 'FINISHED' }), reader = projectionReader();
  const historicDb = database({ current: [], history: [row] });
  const historical = await reader.readPostgresMatchDetailById(historicDb.pool, row.id, options);
  assert.deepEqual(clone(historical.predictions), row.predictions);
  assert.deepEqual(clone(historical.archivedPreMatchPrediction), row.archivedPreMatchPrediction);
  assert.equal(historicDb.calls.some(call => call.text.includes('daily_featured_combo_state')), false);
  const rawDb = database({ current: [row] });
  const raw = await reader.readPostgresMatchById(rawDb.pool, row.id, options);
  assert.deepEqual(clone(raw.predictions), row.predictions);
  assert.equal(rawDb.calls.some(call => call.text.includes('daily_featured_combo_state')), false);
});

test('omitted or copied policy cannot authorize retirement from public JSON fields', async () => {
  const row = { ...match(), recommendationAuthority: { legacyCurrentEnabled: false }, strategySwitch: center().strategySwitch };
  for (const policy of [undefined, { ...authority.TRAINED_ONLY_POLICY }, center().strategySwitch]) {
    const db = database({ current: [row], publishedCenter: null });
    const result = await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, {
      publicationIdentity: publication, recommendationAuthorityPolicy: policy,
    });
    assert.deepEqual(clone(result.rows[0].predictions), row.predictions);
    assert.equal(result.recommendationAuthority, null);
    assert.equal(db.calls.some(call => call.text.includes('daily_featured_combo_state')), false);
    assert.equal(db.calls.at(-1).text, 'COMMIT');
  }
});

test('failed real center and publication validation rolls back every public reader without raw fallback', async () => {
  const reader = projectionReader();
  const read = [
    db => reader.readPostgresCurrentAuthoritySnapshot(db.pool, options),
    db => reader.readPostgresCurrentTransitionSnapshot(db.pool, options),
    db => reader.readPostgresMatchDetailById(db.pool, match().id, options),
  ];
  const corruptCenter = center(); corruptCenter.strategySwitch.legacyFallbackEnabled = true;
  const forgedView = center(); forgedView.reviewedAnalysis.records = [{ eventId: 'fabricated' }];
  for (const input of [{ publishedCenter: null }, { publishedCenter: corruptCenter }, { publishedCenter: forgedView },
    { failAt: 'football.private_model_artifacts' }, { artifacts: [{ artifact_key: 'corrupt-frozen-record' }] }]) {
    for (const call of read) {
      const db = database(input);
      await assert.rejects(call(db), error => error.code === 'POSTGRES_REQUIRED_READ_UNAVAILABLE' && error.statusCode === 503);
      rolledBack(db);
    }
  }
});

test('generation mismatch rejects before inspecting matches or trusting another publication center', async () => {
  const db = database();
  await assert.rejects(projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, {
    ...options, publicationIdentity: { ...publication, generationId: 'other-generation' },
  }), error => error.code === 'POSTGRES_REQUIRED_READ_UNAVAILABLE');
  assert.equal(db.calls.some(call => /match_snapshots|daily_featured_combo_state/.test(call.text)), false);
  rolledBack(db);
});

test('invalid existing archives remain fatal even when current legacy directions are retired', async () => {
  const row = withArchive(match()); row.archivedPreMatchPrediction.sourceMatchId = 'wrong-event';
  for (const read of [
    db => projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options),
    db => projectionReader().readPostgresMatchDetailById(db.pool, row.id, options),
  ]) {
    const db = database({ current: [row] });
    await assert.rejects(read(db), error => error.code === 'POSTGRES_REQUIRED_READ_UNAVAILABLE');
    rolledBack(db);
  }
});

test('unavailable reviewed and trained views remain explicit diagnostics after successful empty replay', async () => {
  const publishedCenter = center(); delete publishedCenter.reviewedAnalysis; delete publishedCenter.leagueBaseline;
  const db = database({ publishedCenter });
  const result = await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options);
  assert.equal(result.recommendationAuthority.activeValidation.reviewed.status, 'unavailable');
  assert.equal(result.recommendationAuthority.activeValidation.trained.status, 'unavailable');
  assert.equal(result.rows[0].recommendationAuthority.legacyArchiveState, 'missing');
  committed(db);
});

test('requesting trusted detail retirement cannot fall through to the raw reader for unsupported identifiers', async () => {
  const db = database();
  assert.equal(await projectionReader().readPostgresMatchDetailById(db.pool, 'legacy_arbitrary_id', options), null);
  assert.equal(db.connections, 0);
});

test('public recommendation center returns the payload verified in the same generation snapshot', async () => {
  const publishedCenter = center(), db = database({ publishedCenter });
  const payload = await projectionReader().readPostgresRecommendationCenter(db.pool, options);
  assert.deepEqual(clone(payload), { recommendationCenter: publishedCenter });
  committed(db);
  const broken = database({ publishedCenter: { ...publishedCenter, current: [{ decision: 'forged' }] } });
  await assert.rejects(projectionReader().readPostgresRecommendationCenter(broken.pool, options),
    error => error.code === 'POSTGRES_REQUIRED_READ_UNAVAILABLE');
  rolledBack(broken);
});

test('native pre-pause helper obtains actual authority with the supplied session and retains missing-archive diagnostics', async () => {
  const native = require('../scripts/nativeCodeReleaseDataPlane.cjs');
  const rows = [match(), withArchive(match('2041871'))], before = clone(rows), db = database();
  assert.throws(() => native.assertCodeCutoverArchivesReady(rows, NOW),
    error => error.code === 'NATIVE_RESULT_ARCHIVE_PENDING' && error.pendingRows === 1);
  await db.pool.connect();
  await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const proof = await native.readCodeCutoverArchiveAuthority(db.client, rows, NOW);
  await db.client.query('COMMIT'); db.client.release();
  assert.equal(proof.checkedRows, 2);
  assert.equal(proof.pendingRows, 0);
  assert.equal(proof.retiredLegacyArchiveMissingRows, 1);
  assert.equal(proof.requiredThrough, '2026-10-10T13:33:07.000Z');
  assert.equal(proof.leaseSeconds, 900);
  assert.equal(proof.publicationAuthority.activeValidation.reviewed.status, 'verified');
  assert.deepEqual(rows, before);
  committed(db);
});

test('native pre-pause authority failures and corrupted existing archives remain permanent errors', async () => {
  const native = require('../scripts/nativeCodeReleaseDataPlane.cjs');
  const corrupt = withArchive(match()); corrupt.archivedPreMatchPrediction.sourceMatchId = 'wrong-event';
  for (const [input, rows] of [[{ publishedCenter: null }, [match()]], [{ failAt: 'private_model_artifacts' }, [match()]],
    [{}, [corrupt]]]) {
    const db = database(input); let attempts = 0;
    await db.pool.connect(); await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assert.rejects(native.retryLeaseRead(async () => {
      attempts++;
      return native.readCodeCutoverArchiveAuthority(db.client, rows, NOW);
    }, async () => assert.fail('invalid publication evidence must not become a natural archive wait')));
    assert.equal(attempts, 1);
    await db.client.query('ROLLBACK'); db.client.release();
    rolledBack(db);
  }
});

test('native preparation verifies authority on the existing client before persisting lease inputs', () => {
  const source = fs.readFileSync(require.resolve('../scripts/nativeCodeReleaseDataPlane.cjs'), 'utf8');
  const body = source.slice(source.indexOf('async function captureLeaseInputOnce'), source.indexOf('async function seed'));
  const read = body.indexOf("SELECT payload FROM football.match_snapshots WHERE dataset='current'");
  const verified = body.indexOf('await readCodeCutoverArchiveAuthority(session.client, archiveRows.rows.map(row => row.payload), Date.now())');
  assert.ok(read > 0 && verified > read && verified < body.indexOf("'code-lease-current.json'"));
});

test('the existing center endpoint can read a bounded prior reviewed day in its same RR snapshot', async () => {
  const db = database(), payload = await projectionReader().readPostgresRecommendationCenter(db.pool, { ...options, includeReviewedHistory: true });
  assert.deepEqual(clone(payload), { recommendationCenter: center() });
  const history = db.calls.find(call => call.text.includes('artifact_key < $3'));
  assert.ok(history); assert.match(history.text, /ORDER BY artifact_key DESC LIMIT 1$/);
  assert.deepEqual(clone(history.values), ['reviewed-analysis-freeze-v1', 'reviewed-analysis-%', 'reviewed-analysis-2026-10-10-']);
  assert.equal(db.connections, 1); assert.equal(db.releases, 1); assert.equal(db.calls.at(-1).text, 'COMMIT');
  const failed = database({ failAt: 'artifact_key < $3' });
  await assert.rejects(projectionReader().readPostgresRecommendationCenter(failed.pool, { ...options, includeReviewedHistory: true }),
    { code: 'POSTGRES_REQUIRED_READ_UNAVAILABLE' });
  rolledBack(failed);
  const source = fs.readFileSync(require.resolve('../server/index.cjs'), 'utf8');
  const route = source.slice(source.indexOf('if (url.pathname === "/api/v1/daily-featured-combos")'), source.indexOf('if (url.pathname === "/api/v1/model/evaluation")'));
  assert.match(route, /includeReviewedHistory: true/);
  assert.match(route, /hasRecommendationAccess\(req, url\)/);
});

test('an explicitly selected earlier day uses the same RR client and keeps its revision lane separate', async () => {
  const history = { businessDate: '2026-10-08', updatedAt: new Date(NOW).toISOString(), publicationHash: 'f'.repeat(64),
    records: [{ eventId: '2041800', eventVersion: '2026-10-08T13:30:00Z', businessDate: '2026-10-08' }] };
  for (const failVersions of [false, true]) {
    const db = database(), seen = [];
    const reader = projectionReader('postgres-only', {
      '../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs': {
        async readHistory(client, target, beforeDay, asOf) { seen.push(client); assert.equal(target, '2026-10-08'); assert.equal(beforeDay, '2026-10-10'); assert.equal(asOf, new Date(NOW).toISOString()); return history; },
        readLatestHistory() { throw Error('must not substitute latest history for a selected day'); },
      },
      './researchReviewProjection.cjs': { async projection(client, original, asOf, heads) {
        assert.equal(client, seen[0]); assert.equal(original, history); assert.equal(asOf, history.updatedAt); assert.deepEqual(clone(heads), []);
        if (failVersions) throw Error('corrupt optional archived revision');
        return { version: 'reviewed-revisions-view-v1', state: 'verified', businessDate: history.businessDate, updatedAt: asOf, singles: [], combos: [] };
      } },
    });
    const value = await reader.readPostgresRecommendationCenter(db.pool, { ...options, includeReviewedHistory: true, reviewedBusinessDate: '2026-10-08' });
    assert.deepEqual(clone(value.recommendationCenter.reviewedAnalysisHistory), history);
    assert.equal(value.recommendationCenter.reviewedRevisionsHistory.state, failVersions ? 'unavailable' : 'verified');
    assert.deepEqual(clone(value.recommendationCenter.reviewedAnalysis), center().reviewedAnalysis);
    assert.equal(db.connections, 1); assert.equal(db.releases, 1); assert.equal(db.calls.at(-1).text, 'COMMIT');
    assert.equal(db.calls.some(c => c.text === 'ROLLBACK TO SAVEPOINT historical_review_versions'), failVersions);
    assert.ok(db.calls.every(c => !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(c.text)));
  }
});

function coverageReader(read, parityOk = true) {
  const source = fs.readFileSync(require.resolve('../server/index.cjs'), 'utf8');
  const body = source.slice(source.indexOf('const recommendationCoverageOddsTripletValid ='), source.indexOf('const buildPublicV1Health = async'));
  const module = { exports: {} };
  class FixedDate extends Date { static now() { return NOW; } }
  vm.runInNewContext(`${body}\nmodule.exports = buildCurrentRecommendationCoverage;`, {
    module, Date: FixedDate, currentRecommendationPolicy: authority.TRAINED_ONLY_POLICY,
    isTrustedPolicy: authority.isTrustedPolicy,
    isTrustedCurrentAuthorityProjection: authority.isTrustedCurrentAuthorityProjection,
    verifyDualMarketDecisionBinding: dual.verifyDualMarketDecisionBinding,
    resolveBasePublication: () => ({ identity: publication }),
    readCurrentMatchesDetailed: async input => {
      assert.equal(input.recommendationAuthorityPolicy, authority.TRAINED_ONLY_POLICY);
      assert.equal(input.basePublication.identity, publication);
      return read;
    },
    readGlobalRecommendationRiskTier: async () => 'unknown',
    compactMatchForList: row => row,
    normalizeMatchForDetailPayload: row => row,
    enforceCurrentMatchRecommendationEvidence: row => row,
    buildRecommendationProjectionParityAudit: (pairs, options) => {
      assert.equal(pairs.length, read.rows.length);
      const result = parity.buildRecommendationProjectionParityAudit(pairs, options);
      return parityOk ? result : { ...result, ok: false };
    },
  });
  return module.exports();
}

test('actual health coverage consumes verified authority integrity and still enforces projection parity', async () => {
  const db = database({ current: [trainedMatch()] }), read = await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options);
  const health = await coverageReader(read);
  assert.equal(health.coverageOk, true);
  assert.equal(health.publicationAuthority, read.recommendationAuthority);
  assert.equal(health.retiredLegacyArchiveMissingRows, 1);
  assert.equal(health.missingDispositionMatches, 1, 'retired raw disposition absence remains visible diagnostically');
  assert.equal((await coverageReader(read, false)).coverageOk, false);
  const unverified = { ...read, recommendationAuthority: { ...read.recommendationAuthority, activeValidation: { ok: false } } };
  assert.equal((await coverageReader(unverified)).coverageOk, false);
  assert.equal((await coverageReader({ rows: [match()], recommendationAuthority: null })).coverageOk, false);
});

function trainedMatch(id) {
  return { ...match(id), predictionMeta: { trainingVersion: 'integration-training-v1', trainingSignature: 'integration-signed-training' } };
}
function hhadOnlyMatch(id) {
  return { ...trainedMatch(id), handicapOddsSource: 'sporttery:HHAD', handicapLine: '-1',
    handicapOdds: { odds1: 3, oddsX: 3, odds2: 3 } };
}
function dualMatch(id = '2041872') {
  const row = { ...hhadOnlyMatch(id), oddsSource: 'sporttery:HAD', odds: { odds1: 3, oddsX: 3, odds2: 3 } };
  const market = { odds: row.odds, observedAt: UPDATED, receivedAt: UPDATED, provenanceHash: 'a'.repeat(64) };
  const feature = { sourceMatchId: row.sourceMatchId, kickoffTime: row.kickoffTime, sourceCycleId: 'coverage-cycle',
    capturedAt: UPDATED, cutoffTime: row.buyEndTime, modelGeneratedAt: UPDATED,
    modelVersion: 'coverage-model', calibrationVersion: 'coverage-calibration',
    market: { had: market, hhad: { ...market, handicapLine: -1 } },
    modelOutputs: { unifiedSelection: { market: 'HAD', code: '1' }, hhad: { unifiedPosterior: { home: 50, draw: 30, away: 20 } } } };
  feature.hash = dual.predictionFeatureSnapshotHash(feature);
  const binding = { version: dual.DUAL_MARKET_DECISION_BINDING_VERSION, decisionSnapshotVersion: 'candidate-decision-snapshot-v2',
    sourceCycleId: feature.sourceCycleId, featureSnapshot: feature, featureSnapshotHash: feature.hash,
    sourceClocks: { capturedAt: UPDATED, decisionAt: UPDATED, cutoffTime: row.buyEndTime, modelGeneratedAt: UPDATED,
      hadObservedAt: UPDATED, hadReceivedAt: UPDATED, hhadObservedAt: UPDATED, hhadReceivedAt: UPDATED },
    strategyVersions: { predictionPolicy: 'coverage-policy', prompt: 'coverage-prompt', model: feature.modelVersion,
      calibration: feature.calibrationVersion, hhadCompanion: 'hhad-companion-shadow-v2' },
    had: { poolCode: 'HAD', code: '1', odds: 3, modelProbability: 0.5, marketProbability: 1 / 3 },
    hhad: { poolCode: 'HHAD', code: '1', odds: 3, handicapLine: -1, modelProbability: 0.5, marketProbability: 1 / 3 },
    hashes: Object.fromEntries(['policyHash', 'hadMarketProvenanceHash', 'hhadMarketProvenanceHash', 'strategyHash',
      'revisionHash', 'exposureHash', 'pairHash'].map(key => [key, 'a'.repeat(64)])) };
  binding.bindingHash = dual.hashDualMarketDecisionBinding(binding);
  row.predictionMeta.dualMarketDecision = binding;
  assert.deepEqual(dual.verifyDualMarketDecisionBinding(row).blockers, []);
  return row;
}

test('real RR authority retires HHAD-only dispositions but retains raw deficits and real dual binding checks', async () => {
  const db = database({ current: [hhadOnlyMatch('2041870'), hhadOnlyMatch('2041871'), dualMatch()] });
  const read = await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options);
  const result = await coverageReader(read);
  committed(db);
  assert.equal(result.coverageOk, true);
  assert.equal(result.legacyCoverageOk, false);
  assert.equal(result.dualMarketAtomicCoverageOk, false);
  for (const [key, value] of Object.entries({ scheduledMatches: 3, missingDispositionMatches: 3,
    retiredDispositionMatches: 3, effectiveMissingDispositionMatches: 0, hhadMarketMatches: 3,
    hhadBoundDirectionMatches: 1, hhadMissingDirectionMatches: 2, retiredHhadOnlyDirectionMatches: 2,
    effectiveHhadMissingDirectionMatches: 0, dualMarketEligibleMatches: 1, dualMarketAtomicMatches: 1,
    dualMarketAtomicMissingMatches: 0 })) assert.equal(result[key], value, key);
  assert.equal(result.publicationAuthority.activeValidation.reviewed.openRecords, 0);
  assert.equal(result.publicationAuthority.activeValidation.trained.openRecords, 0);
  assert.ok(read.rows.every(row => row.predictions.length === 0 && row.archivedPreMatchPrediction === undefined));
  const remote = require('../scripts/verifyRemoteRecommendationParity.cjs');
  assert.equal(remote.validateRemoteRecommendationCoverage(clone(result), { policy: authority.TRAINED_ONLY_POLICY, nowMs: NOW }).valid, true);
});

for (const [name, mutate] of [
  ['copied summary', read => ({ ...read, recommendationAuthority: clone(read.recommendationAuthority) })],
  ['JSON rows', read => ({ ...read, rows: clone(read.rows) })],
  ['partial rows', read => ({ ...read, rows: read.rows.slice(0, 1) })],
  ['empty subset', read => ({ ...read, rows: [] })],
  ['duplicate row', read => ({ ...read, rows: [read.rows[0], read.rows[0]] })],
]) test(`health rejects ${name} as retirement authority`, async () => {
  const read = await projectionReader().readPostgresCurrentAuthoritySnapshot(database({ current: [hhadOnlyMatch('2041870'), hhadOnlyMatch('2041871')] }).pool, options);
  const result = await coverageReader(mutate(read));
  assert.equal(result.coverageOk, false);
  assert.equal(result.retiredDispositionMatches, 0);
  assert.equal(result.retiredHhadOnlyDirectionMatches, 0);
});

test('health rejects authority and rows from different RR reads even when public summaries agree', async () => {
  const reader = projectionReader(), db = () => database({ current: [hhadOnlyMatch('2041870')] });
  const first = await reader.readPostgresCurrentAuthoritySnapshot(db().pool, options);
  const second = await reader.readPostgresCurrentAuthoritySnapshot(db().pool, options);
  assert.deepEqual(clone(first.recommendationAuthority), clone(second.recommendationAuthority));
  assert.equal((await coverageReader({ ...first, rows: second.rows })).coverageOk, false);
  const normalized = { ...first, rows: first.rows.map(row => ({ ...row })) };
  assert.equal((await coverageReader(normalized)).coverageOk, true, 'normal object-spread lifecycle projection preserves the exact snapshot');
});

test('only a genuinely read empty current snapshot can claim empty engineering coverage', async () => {
  const read = await projectionReader().readPostgresCurrentAuthoritySnapshot(database({ current: [] }).pool, options);
  assert.equal((await coverageReader(read)).coverageOk, true);
  assert.equal((await coverageReader(clone(read))).coverageOk, false);
  assert.equal((await coverageReader({ rows: [], recommendationAuthority: null })).coverageOk, false,
    'trusted runtime policy must not turn an unknown authority into an empty success');
});

for (const [name, mutate] of [
  ['missing binding', row => { delete row.predictionMeta.dualMarketDecision; }],
  ['HAD direction disagreement', row => { row.predictionMeta.dualMarketDecision.had.code = '2'; }],
  ['HHAD direction disagreement', row => { row.predictionMeta.dualMarketDecision.hhad.code = '2'; }],
  ['HAD SP disagreement', row => { row.predictionMeta.dualMarketDecision.had.odds = 3.01; }],
  ['HHAD line disagreement', row => { row.predictionMeta.dualMarketDecision.hhad.handicapLine = 1; }],
  ['different event', row => { row.sourceMatchId = 'different-event'; }],
  ['different kickoff', row => { row.kickoffTime = '2026-10-10T14:30:00.000Z'; }],
  ['source provenance hash disagreement', row => { row.predictionMeta.dualMarketDecision.hashes.hhadMarketProvenanceHash = 'b'.repeat(64); }],
]) test(`verified retirement still rejects actual dual-market ${name}`, async () => {
  const row = dualMatch(); mutate(row);
  // Rehashing a changed claim cannot bypass source, feature, event and SP binding.
  if (row.predictionMeta.dualMarketDecision) row.predictionMeta.dualMarketDecision.bindingHash = dual.hashDualMarketDecisionBinding(row.predictionMeta.dualMarketDecision);
  const read = await projectionReader().readPostgresCurrentAuthoritySnapshot(database({ current: [row] }).pool, options);
  const result = await coverageReader(read);
  assert.equal(result.coverageOk, false);
  assert.equal(result.dualMarketAtomicMissingMatches, 1);
  assert.equal(result.effectiveHhadMissingDirectionMatches, 1);
  assert.ok(Object.keys(result.dualMarketBindingBlockerCounts).length > 0);
});

test('trusted retirement still rejects missing training lineage', async () => {
  const row = hhadOnlyMatch(); delete row.predictionMeta.trainingSignature;
  const read = await projectionReader().readPostgresCurrentAuthoritySnapshot(database({ current: [row] }).pool, options);
  const result = await coverageReader(read);
  assert.equal(result.trainingCoverageOk, false);
  assert.equal(result.coverageOk, false);
});

test('public list, detail and center routes explicitly carry the same trusted runtime policy', () => {
  const source = fs.readFileSync(require.resolve('../server/index.cjs'), 'utf8');
  assert.match(source, /currentRecommendationPolicy\s*=\s*storageMode\.postgresOnly\s*\?\s*TRAINED_ONLY_POLICY\s*:\s*null/);
  assert.match(source, /readPostgresCurrentTransitionSnapshot\(postgresPool,\s*\{[^}]*recommendationAuthorityPolicy:\s*currentRecommendationPolicy/s);
  assert.match(source, /readMatchDetailById\(decodedId,\s*\{\s*basePublication,\s*recommendationAuthorityPolicy:\s*currentRecommendationPolicy\s*\}\)/);
  assert.match(source, /readMatchDetailById\(matchDetailRoute\[1\],\s*\{\s*recommendationAuthorityPolicy:\s*currentRecommendationPolicy\s*\}\)/);
  for (const route of ['/api/matches/current', '/api/matches/root']) {
    const start = source.indexOf(`url.pathname === "${route}"`), body = source.slice(start, start + 900);
    assert.ok(start > 0);
    assert.match(body, /readCurrentMatchesDetailed\(\{\s*recommendationAuthorityPolicy:\s*currentRecommendationPolicy\s*\}\)/);
  }
  const centerRoute = source.slice(source.indexOf('await readPostgresRecommendationCenter(postgresPool'), source.indexOf('await readPostgresRecommendationCenter(postgresPool') + 350);
  assert.match(centerRoute, /recommendationAuthorityPolicy:\s*currentRecommendationPolicy/);
});

test('the public prediction wrapper honors only minted retirement after real lifecycle normalization', async () => {
  const row = { ...withArchive(match()), odds: { odds1: 2.125, oddsX: 3.5, odds2: 3.1 }, oddsSource: 'sporttery:had' };
  const db = database({ current: [row] });
  const projected = (await projectionReader().readPostgresCurrentAuthoritySnapshot(db.pool, options)).rows[0];
  const lifecycle = require('../src/services/matchLifecycle.cjs').resolveMatchLifecycle(projected, { nowMs: NOW });
  assert.equal(authority.isRetiredCurrentProjection(lifecycle), true);
  const source = fs.readFileSync(require.resolve('../server/index.cjs'), 'utf8');
  const wrapper = source.match(/const projectPublicPredictionRows = \(match, options\)[\s\S]*?;\r?\n/)[0];
  const module = { exports: {} }, parity = require('../server/recommendationProjectionParity.cjs');
  vm.runInNewContext(`${wrapper}\nmodule.exports = projectPublicPredictionRows;`, {
    module, isRetiredCurrentProjection: authority.isRetiredCurrentProjection,
    projectLegacyPublicPredictionRows: parity.projectPublicPredictionRows,
  });
  assert.deepEqual(clone(module.exports(lifecycle, { nowMs: NOW })), []);
  const untrusted = clone(lifecycle);
  assert.equal(authority.isRetiredCurrentProjection(untrusted), false);
  assert.equal(module.exports(untrusted, { nowMs: NOW }).some(prediction => prediction.marketType === 'BEST'), true);
  assert.equal(parity.compareRecommendationProjectionPair(projected, projected, NOW).ok, true);
  assert.deepEqual(clone(projected.archivedPreMatchPrediction), row.archivedPreMatchPrediction);
});

test('real result-phase parity stops demanding retired 1X2 archives while the default reader remains strict', async () => {
  const reader = projectionReader(), db = database(), rawDb = database();
  const projected = (await reader.readPostgresCurrentAuthoritySnapshot(db.pool, options)).rows[0];
  const raw = (await reader.readPostgresCurrentAuthoritySnapshot(rawDb.pool, { publicationIdentity: publication })).rows[0];
  const parity = require('../server/recommendationProjectionParity.cjs'), afterKickoff = NOW + 900000;
  const retiredAudit = parity.compareRecommendationProjectionPair(projected, projected, afterKickoff);
  const strictAudit = parity.compareRecommendationProjectionPair(raw, raw, afterKickoff);
  assert.equal(retiredAudit.ok, true);
  assert.equal(projected.recommendationAuthority.legacyArchiveState, 'missing');
  assert.equal(projected.archivedPreMatchPrediction, undefined);
  assert.equal(strictAudit.ok, false);
  assert.ok(strictAudit.reasons.includes('list-canonical-decision-missing'));
  assert.ok(strictAudit.reasons.includes('detail-canonical-decision-missing'));
});
