'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const realAuthority = require('../server/recommendationAuthority.cjs');
const model = require('../src/services/leagueBaselineModel.cjs');
const reviewed = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const trainedRuntime = require('../scripts/recommendationPlatform/leagueBaselineRuntime.cjs');
const trainedMaker = require('../src/services/leagueBaselineRecommendation.cjs');
const signed = require('./fixtures/signed-live-had.cjs');
const at = delta => signed.stamp(signed.NOW + delta);
const clone = value => JSON.parse(JSON.stringify(value));
const reseal = value => { const { contentHash, ...body } = value; void contentHash; return model.seal(body); };

function load(file, overrides = {}) {
  const filename = path.resolve(__dirname, '..', file), native = Module.createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, Date, process, __dirname: path.dirname(filename),
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : native(id),
  }, { filename });
  return module.exports;
}

async function setup({ withReviewed = true, withTrained = true, activeFields = true } = {}) {
  const leagueId = require('../scripts/storedResultTeamIdentity.cjs').derivedTeamId('Synthetic League').replace(/^team_/, 'league_');
  const matches = [1, 2, 3].map(id => ({ ...signed.source(id), leagueId }));
  const { snapshot, registry } = signed.snapshot(matches, { mutate: entry => {
    entry.payload.value.matchInfoList[0].subMatchList.forEach((row, index) => {
      row.homeTeamId = 10 + index * 2; row.awayTeamId = 11 + index * 2; row.leagueAllName = 'Synthetic League';
    });
  } });
  const reviewedRuntime = load('scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs', {
    '../../src/services/collectorAttestation.cjs': { loadCollectorTrustRegistry: () => registry },
  });
  const replayCalls = { reviewed: 0, trained: 0 };
  const authority = load('server/recommendationAuthority.cjs', {
    '../src/services/collectorAttestation.cjs': { loadCollectorTrustRegistry: () => registry },
    '../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs': { ...reviewedRuntime, projection(...args) {
      replayCalls.reviewed++; return reviewedRuntime.projection(...args);
    } },
    '../scripts/recommendationPlatform/leagueBaselineRuntime.cjs': { ...trainedRuntime, projection(...args) {
      replayCalls.trained++; return trainedRuntime.projection(...args);
    } },
  });
  const artifacts = new Map(), queries = [];
  const store = (key, value) => {
    const json = JSON.stringify(value);
    artifacts.set(key, { artifact_key: key, artifact_version: value.version,
      generated_at: value.createdAt, updated_at: value.storedAt || value.createdAt, payload_json: json,
      payload_sha256: reviewed.sha(json), payload_bytes: Buffer.byteLength(json) });
  };
  const center = {
    version: 'recommendation-center-v1', businessDate: matches[0].businessDate, updatedAt: at(2000),
    current: [], previews: [], todayCombos: [], todayDualResearch: [],
    strategySwitch: { version: 'trained-strategy-switch-v1', activeReferenceStrategy: 'league-trained-baseline-v1',
      legacyPublicationEnabled: false, legacyFallbackEnabled: false, formalEligible: false, modelAdoptionCount: 0 },
  };
  const client = { async query(sql, args = []) {
    queries.push(sql);
    if (sql.includes('daily_featured_combo_state')) return { rows: [{ payload: { recommendationCenter: center } }] };
    if (sql.startsWith('SELECT artifact_key FROM football.private_model_artifacts')) return { rows: [...artifacts.values()]
      .filter(row => row.artifact_key === args[0] || (row.artifact_key.startsWith(args[1].slice(0, -1)) && row.artifact_version === args[2]))
      .map(row => ({ artifact_key: row.artifact_key })) };
    if (sql.includes('artifact_key ~')) return { rows: [...artifacts.values()].filter(row => /^league-forecast-[a-f0-9]{64}$/.test(row.artifact_key)
      && JSON.parse(row.payload_json).record.businessDate === args[0]) };
    if (/WHERE artifact_key\s*=\s*\$1/.test(sql)) return { rows: artifacts.has(args[0]) ? [artifacts.get(args[0])] : [] };
    throw new Error('Unexpected SQL: ' + sql);
  } };
  if (withReviewed) {
    const draft = { version: 1, reportKind: 'weekday-2000-selected-two', predictionScope: 'chat-only research',
      businessDate: center.businessDate, frozenAt: at(-60000), singles: matches.map((match, index) => ({
        eventId: String(match.sourceMatchId), matchNum: match.matchNo, businessDate: match.businessDate, kickoff: match.kickoffTime,
        market: 'HAD', handicap: null, selection: 'h', scores: [[2, 0], [3, 1]], confidence: '中', reason: 'Synthetic reviewed reference',
        analysisUrl: 'https://example.invalid/reference', teams: [match.homeTeamName, match.awayTeamName],
        orderedTeamIds: [10 + index * 2, 11 + index * 2], sp: 1.8, modelVersion: null, modelProbability: null,
        formalEligible: false, classification: 'manual-prematch-research',
      })) };
    const inputs = { matches, snapshot }, record = reviewed.make(draft, { ...inputs, trustRegistry: registry, asOf: at(0) });
    const key = 'reviewed-analysis-' + center.businessDate + '-selected-two';
    store(key, reviewed.seal({ version: 'reviewed-analysis-freeze-v1', createdAt: record.createdAt, record, draft, inputs, storedAt: at(1) }));
    store(key + '-ack', reviewed.seal({ version: 'reviewed-analysis-ack-v1', createdAt: at(2), recordKey: key,
      storedSha256: artifacts.get(key).payload_sha256, recordHash: record.contentHash }));
  }
  if (withTrained) {
    const match = matches[0];
    const parameters = { poisson: { teams: ['Alpha', 'Bravo'], attack: [.3, -.3], defense: [0, 0], homeIntercept: .3,
      awayIntercept: .1, converged: true, gradientNorm: 1e-8 }, elo: { ratings: { Alpha: 1500, Bravo: 1500 }, homeAdvantage: 50, drawRate: .25 },
      frequencies: { 1: .5, X: .25, 2: .25 }, poissonWeight: 1, trainingRows: 380, through: '2025-12-01', inputHash: 'f'.repeat(64) };
    const packet = model.seal({ version: model.VERSION, league: 'br1', researchOnly: true, formalEligible: false,
      createdAt: at(-60000), availableAt: at(-60000), parameters, parametersHash: model.hash(parameters),
      reportSha256: 'a'.repeat(64), historySha256: 'b'.repeat(64),
      validation: { kind: 'chronological-statistical-holdout', testRows: 380, brier: .6, logLoss: 1,
        baselineBrier: .65, baselineLogLoss: 1.1, formalEligible: false },
      bindings: ['home', 'away'].map((side, index) => ({ teamId: match[side + 'TeamId'], teamName: match[side + 'TeamName'],
        leagueId, modelTeam: parameters.poisson.teams[index], reviewId: 'synthetic-only', reviewedAt: at(-65000),
        evidence: [{ url: 'https://example.invalid/synthetic', sha256: 'c'.repeat(64) }] })),
    });
    const inputs = { packet, match, snapshot, trustRegistry: registry }, record = trainedMaker.make({ ...inputs, asOf: at(0) });
    store(record.id, model.seal({ version: 'league-baseline-freeze-v1', createdAt: record.createdAt, record, inputs, storedAt: at(1) }));
    store(record.id + '-ack', model.seal({ version: 'league-baseline-adoption-ack-v1', createdAt: at(2), observedAt: at(2),
      recordKey: record.id, recordHash: record.contentHash, storedSha256: artifacts.get(record.id).payload_sha256,
      modelHash: record.modelHash, parametersHash: record.parametersHash, formalEligible: false }));
  }
  if (activeFields) {
    center.reviewedAnalysis = await reviewedRuntime.projection(client, center.businessDate, center.updatedAt);
    center.leagueBaseline = await trainedRuntime.projection(client, center.businessDate, center.updatedAt, registry);
  }
  center.strategySwitch.modelAdoptionCount = withTrained ? 1 : 0;
  queries.length = 0;
  const read = () => authority.readPublicationAuthority(client, { policy: authority.TRAINED_ONLY_POLICY, asOf: at(3000) });
  return { authority, client, center, artifacts, matches, queries, store, read, replayCalls, registry };
}

test('warm replay rereads fresh bytes and mints a new authority without repeating model projection', async () => {
  const f = await setup(), first = await f.read();
  assert.deepEqual(f.replayCalls, { reviewed: 1, trained: 1 });
  f.queries.length = 0;
  const second = await f.authority.readPublicationAuthority(f.client, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: at(3500) });
  assert.notEqual(first, second); assert.equal(second.observedAt, at(3500));
  assert.deepEqual(f.replayCalls, { reviewed: 1, trained: 1 });
  assert.equal(f.queries.length, 6); // center, both enumerations (trained includes freeze), reviewed freeze and both ACKs
  assert.equal(f.authority.isTrustedAuthority(second), true);
});

test('warm replay detects raw tampering and correct-hash ACK forgery then recovers without a stale proof', async () => {
  const f = await setup(); await f.read();
  const key = [...f.artifacts.keys()].find(key => key.startsWith('reviewed-') && key.endsWith('-ack'));
  const original = clone(f.artifacts.get(key));
  f.artifacts.get(key).payload_json += ' ';
  await assert.rejects(f.read(), /payload byte count mismatch/);
  f.artifacts.set(key, original); await f.read();
  const ack = JSON.parse(original.payload_json); ack.recordHash = '0'.repeat(64); f.store(key, reseal(ack));
  await assert.rejects(f.read(), /ACK_BINDING/);
  f.artifacts.set(key, original);
  assert.equal((await f.read()).activeValidation.ok, true);
});

test('warm replay detects removed and newly enumerated freezes', async () => {
  const f = await setup(); await f.read();
  const key = [...f.artifacts.keys()].find(key => key.startsWith('reviewed-') && !key.endsWith('-ack'));
  const original = f.artifacts.get(key); f.artifacts.delete(key);
  await assert.rejects(f.read(), /REVIEWED_VIEW_REPLAY/);
  f.artifacts.set(key, original); await f.read();
  const addedKey = 'reviewed-analysis-' + f.center.businessDate + '-batch-' + 'a'.repeat(64);
  f.artifacts.set(addedKey, { ...original, artifact_key: addedKey });
  await assert.rejects(f.read(), /FREEZE_KEY/);
});

test('complete trust registry, center, day and backward clock changes force genuine replay', async () => {
  const f = await setup(); await f.read();
  f.registry.cacheBindingTest = { allConfigurationIsBound: true }; await f.read();
  assert.deepEqual(f.replayCalls, { reviewed: 2, trained: 2 });
  f.center.cacheBindingTest = 'center content'; await f.read();
  assert.deepEqual(f.replayCalls, { reviewed: 3, trained: 3 });
  await f.authority.readPublicationAuthority(f.client, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: at(2500) });
  assert.deepEqual(f.replayCalls, { reviewed: 4, trained: 4 });
  const stale = await f.authority.readPublicationAuthority(f.client, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: '2026-09-17T16:00:00.000Z' });
  assert.deepEqual(f.replayCalls, { reviewed: 5, trained: 5 });
  assert.equal(stale.publicationState, 'stale'); assert.equal(stale.activeValidation.reviewed.openRecords, 0);
});

test('eight concurrent cold readers share replay only after fresh reads in every caller session', async () => {
  const f = await setup(), logs = Array.from({ length: 8 }, () => []);
  const values = await Promise.all(logs.map(log => f.authority.readPublicationAuthority({ query(sql, args) {
    log.push(sql); return f.client.query(sql, args);
  } }, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: at(3000) })));
  assert.deepEqual(f.replayCalls, { reviewed: 1, trained: 1 });
  assert.equal(new Set(values).size, 8);
  for (const log of logs) {
    assert.ok(log.length >= 6); assert.ok(log.some(sql => sql.includes('daily_featured_combo_state')));
    assert.ok(log.some(sql => sql.includes('artifact_key ~')));
  }
});

test('policy authority requires the exact production object and performs no SQL without it', async () => {
  const client = { query() { throw new Error('untrusted policy must not read'); } };
  assert.equal(realAuthority.isTrustedPolicy(realAuthority.TRAINED_ONLY_POLICY), true);
  assert.equal(realAuthority.isTrustedPolicy({ ...realAuthority.TRAINED_ONLY_POLICY }), false);
  assert.equal(await realAuthority.readPublicationAuthority(client, { policy: { ...realAuthority.TRAINED_ONLY_POLICY }, asOf: at(0) }), null);
});

test('real signed-source and trained-model replay mints immutable authority without SQL writes', async () => {
  const f = await setup(), original = JSON.stringify([...f.artifacts]), authority = await f.read();
  assert.equal(f.authority.isTrustedAuthority(authority), true);
  assert.equal(authority.records.reviewed.length, 3); assert.equal(authority.records.trained.length, 1);
  assert.equal(authority.activeValidation.reviewed.status, 'verified');
  assert.equal(authority.activeValidation.trained.status, 'verified');
  assert.equal(authority.activeValidation.ok, true);
  assert.equal(authority.activeValidation.reviewed.openRecords, 3);
  assert.equal(authority.activeValidation.trained.openRecords, 1);
  assert.throws(() => { authority.records.reviewed[0].sp = 99; }, TypeError);
  assert.equal(JSON.stringify([...f.artifacts]), original);
  assert.ok(f.queries.every(sql => sql.startsWith('SELECT')));
});

test('both genuinely empty stores remain valid while omitted fields retain unavailable diagnostics', async () => {
  const f = await setup({ withReviewed: false, withTrained: false, activeFields: false });
  const authority = await f.read();
  assert.equal(authority.activeValidation.reviewed.status, 'unavailable');
  assert.equal(authority.activeValidation.trained.status, 'unavailable');
  assert.equal(authority.records.reviewed.length, 0); assert.equal(authority.records.trained.length, 0);
  const summary = f.authority.summarizeAuthority(authority);
  assert.equal(JSON.stringify(summary).includes('synthetic'), false);
});

test('current clock closes record availability without rewriting the verified publication payload', async () => {
  const f = await setup(), original = JSON.stringify(f.center), now = f.center.reviewedAnalysis.records[0].cutoffAt;
  const authority = await f.authority.readPublicationAuthority(f.client, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: now });
  assert.equal(authority.activeValidation.reviewed.openRecords, 0);
  assert.equal(authority.activeValidation.reviewed.closedRecords, 3);
  assert.equal(authority.activeValidation.trained.closedRecords, 1);
  assert.equal(JSON.stringify(f.authority.getAuthorityCenterPayload(authority).recommendationCenter), original);
});

test('midnight retains verified retirement while marking the old publication unavailable for today', async () => {
  const f = await setup(), original = JSON.stringify(f.center);
  const authority = await f.authority.readPublicationAuthority(f.client, { policy: f.authority.TRAINED_ONLY_POLICY, asOf: '2026-09-17T16:00:00.000Z' });
  assert.equal(authority.publicationState, 'stale');
  assert.equal(authority.currentBusinessDate, '2026-09-18');
  assert.equal(authority.availableForCurrentDay, false);
  assert.equal(authority.activeValidation.ok, true);
  assert.equal(authority.activeValidation.reviewed.openRecords, 0);
  assert.equal(JSON.stringify(f.authority.getAuthorityCenterPayload(authority).recommendationCenter), original);
  assert.equal(f.authority.isRetiredCurrentProjection(f.authority.projectRetiredCurrent(f.matches[0], authority)), true);
});

function emptyCenterAt(f, offset) {
  f.center.updatedAt = at(offset);
  f.center.reviewedAnalysis = { version: 'reviewed-analysis-view-v1', businessDate: f.center.businessDate,
    updatedAt: f.center.updatedAt, records: [], combos: [], threeCombos: [], formalEligible: false };
  f.center.leagueBaseline = { version: 'league-baseline-directions-v1', businessDate: f.center.businessDate,
    updatedAt: f.center.updatedAt, records: [], blocked: 0, formalEligible: false };
  f.center.strategySwitch.modelAdoptionCount = 0;
}

test('real late committed ACKs do not invalidate an earlier empty center while waiting for refresh', async () => {
  const f = await setup(); emptyCenterAt(f, 1);
  const before = JSON.stringify([...f.artifacts]), authority = await f.read();
  assert.equal(authority.records.reviewed.length + authority.records.trained.length, 0);
  assert.equal(JSON.stringify([...f.artifacts]), before);
  // A corrupt newer ACK must still fail its original full verifier before exclusion.
  const key = [...f.artifacts.keys()].find(key => key.startsWith('reviewed-') && key.endsWith('-ack'));
  const ack = JSON.parse(f.artifacts.get(key).payload_json); ack.recordHash = '0'.repeat(64);
  f.store(key, reseal(ack));
  await assert.rejects(f.read(), /ACK_BINDING/);
});

test('newer pending freezes require real deterministic replay and cannot be promoted without ACK', async () => {
  const f = await setup(); emptyCenterAt(f, -1);
  for (const key of [...f.artifacts.keys()]) if (key.endsWith('-ack')) f.artifacts.delete(key);
  assert.equal((await f.read()).records.reviewed.length, 0);
  const key = [...f.artifacts.keys()].find(key => key.startsWith('reviewed-'));
  const freeze = JSON.parse(f.artifacts.get(key).payload_json);
  freeze.record.records[0].sp = 99; freeze.record = reseal(freeze.record);
  f.store(key, reseal(freeze));
  await assert.rejects(f.read(), /PENDING_FREEZE_REPLAY/);
});

test('an old freeze with a missing ACK still fails even when the old center was empty', async () => {
  const f = await setup(); emptyCenterAt(f, 1);
  for (const key of [...f.artifacts.keys()]) if (key.endsWith('-ack')) f.artifacts.delete(key);
  await assert.rejects(f.read(), /ACK_MISSING/);
});

test('declared and replayed empty active lanes are verified without manufacturing records', async () => {
  const f = await setup({ withReviewed: false, withTrained: false }), authority = await f.read();
  assert.equal(authority.activeValidation.reviewed.status, 'verified');
  assert.equal(authority.activeValidation.trained.status, 'verified');
  assert.equal(authority.records.reviewed.length + authority.records.trained.length, 0);
});

test('an omitted active view cannot hide real frozen publications', async () => {
  for (const field of ['reviewedAnalysis', 'leagueBaseline']) {
    const f = await setup(); delete f.center[field];
    await assert.rejects(f.read(), /VIEW_MISSING/);
  }
});

test('old reviewed view without optional threeCombos keeps its original valid seal', async () => {
  const f = await setup(); delete f.center.reviewedAnalysis.threeCombos;
  f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis);
  assert.equal((await f.read()).records.reviewed.length, 3);
  f.center.reviewedAnalysis.records[0].sp = 99;
  f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis);
  await assert.rejects(f.read(), /REVIEWED_VIEW_REPLAY/);
});

for (const [name, change] of [
  ['future view clock', f => { f.center.updatedAt = at(4000); }],
  ['old business day', f => { f.center.businessDate = '2026-09-16'; }],
  ['forged retirement', f => { f.center.strategySwitch.legacyPublicationEnabled = true; }],
  ['nonempty retired lane', f => { f.center.current.push({ decision: {} }); }],
  ['incorrect model adoption count', f => { f.center.strategySwitch.modelAdoptionCount = 0; }],
  ['changed reviewed direction with new seal', f => { f.center.reviewedAnalysis.records[0].selection = 'a'; f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis); }],
  ['changed reviewed price with new seal', f => { f.center.reviewedAnalysis.records[0].sp = 99; f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis); }],
  ['changed three-leg combination with new seal', f => { f.center.reviewedAnalysis.threeCombos[0].product += 1; f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis); }],
  ['changed trained model hash', f => { f.center.leagueBaseline.records[0].modelHash = '0'.repeat(64); }],
  ['changed trained SP', f => { f.center.leagueBaseline.records[0].comparisons[0].quote.odds.h = 99; }],
]) test('reject ' + name, async () => {
  const f = await setup(); change(f); await assert.rejects(f.read());
});

for (const lane of ['reviewed', 'trained']) {
  test(lane + ' publication requires its real committed ACK', async () => {
    const f = await setup(), prefix = lane === 'reviewed' ? 'reviewed-analysis-' : 'league-forecast-';
    const ackKey = [...f.artifacts.keys()].find(key => key.startsWith(prefix) && key.endsWith('-ack'));
    f.artifacts.delete(ackKey);
    await assert.rejects(f.read(), error => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, lane === 'reviewed' ? /ACK_MISSING/ : /TRAINED_REPLAY_BLOCKED/);
      return true;
    });
  });
  test(lane + ' payload bytes and hashes are independently replayed', async () => {
    const f = await setup(), prefix = lane === 'reviewed' ? 'reviewed-analysis-' : 'league-forecast-';
    const key = [...f.artifacts.keys()].find(key => key.startsWith(prefix) && !key.endsWith('-ack'));
    f.artifacts.get(key).payload_json += ' ';
    await assert.rejects(f.read(), /byte count mismatch|TRAINED_REPLAY_BLOCKED/);
  });
}

test('retirement projection requires opaque authority and retains explicit missing archive diagnostics', async () => {
  const f = await setup(), authority = await f.read();
  const match = { ...f.matches[0], predictions: [{ marketType: '1X2', oddsPoolCode: 'HAD', tipCode: '1', odds: 1.8 }] };
  const before = JSON.stringify(match);
  assert.equal(f.authority.projectRetiredCurrent(match, clone(authority)), match);
  assert.equal(f.authority.summarizeAuthority(clone(authority)), null);
  const projected = f.authority.projectRetiredCurrent(match, authority);
  assert.equal(projected.predictions.length, 0);
  assert.equal(projected.recommendationAuthority.legacyArchiveState, 'missing');
  assert.equal(JSON.stringify(match), before);
  assert.equal(f.authority.projectRetiredCurrent({ ...match, predictions: [] }, authority).recommendationAuthority.legacyArchiveState, 'none');
  assert.equal(f.authority.isRetiredCurrentProjection(projected), true);
  assert.equal(f.authority.isRetiredCurrentProjection({ ...projected }), true);
  assert.equal(f.authority.isRetiredCurrentProjection(clone(projected)), false);
  assert.equal(f.authority.isRetiredCurrentProjection({ recommendationAuthority: projected.recommendationAuthority }), false);
  assert.equal(f.authority.projectRetiredCurrent({ ...projected }, authority).recommendationAuthority.legacyArchiveState, 'missing');
});

test('validated original center payload remains available only through its minted authority', async () => {
  const f = await setup(); delete f.center.reviewedAnalysis.threeCombos;
  f.center.reviewedAnalysis = reseal(f.center.reviewedAnalysis);
  const original = JSON.stringify({ recommendationCenter: f.center }), authority = await f.read();
  const payload = f.authority.getAuthorityCenterPayload(authority);
  assert.equal(JSON.stringify(payload), original);
  assert.equal(Object.hasOwn(payload.recommendationCenter.reviewedAnalysis, 'threeCombos'), false);
  assert.equal(f.authority.getAuthorityCenterPayload(clone(authority)), null);
  assert.throws(() => { payload.recommendationCenter.updatedAt = at(0); }, TypeError);
  f.center.reviewedAnalysis.records[0].sp = 99;
  assert.equal(JSON.stringify(payload), original);
});

test('existing valid archive is retained byte for byte, while invalid archive always blocks retirement', async () => {
  const f = await setup(), authority = await f.read(), match = { ...f.matches[0] };
  match.archivedPreMatchPrediction = { version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
    sourceMatchId: String(match.sourceMatchId), eventVersion: match.eventVersion, capturedAt: at(-60000), cutoffTime: match.buyEndTime,
    marketEvidenceScope: 'result-pool', signature: 'synthetic-original',
    prediction: { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1', odds: 1.8 } };
  const original = JSON.stringify(match.archivedPreMatchPrediction), projected = f.authority.projectRetiredCurrent(match, authority);
  assert.equal(projected.recommendationAuthority.legacyArchiveState, 'valid');
  assert.equal(projected.archivedPreMatchPrediction, match.archivedPreMatchPrediction);
  assert.equal(JSON.stringify(projected.archivedPreMatchPrediction), original);
  match.archivedPreMatchPrediction.prediction.tipCode = 'WATCH';
  assert.throws(() => f.authority.projectRetiredCurrent(match, authority), /EXISTING_ARCHIVE_INVALID/);
});
