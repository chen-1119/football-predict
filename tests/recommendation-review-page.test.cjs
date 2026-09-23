'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDecision, validDecision, chooseCombo, freezeCombo } = require('../scripts/recommendationPlatform/decision.cjs');
const { collectResults } = require('../scripts/recommendationPlatform/results.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const { NOW, match, publication, validators } = require('./recommendationFixture.cjs');
const {
  parseReviewQuery, buildRecommendationReviewPage, readRecommendationReviewPage,
} = require('../server/recommendationReviewPage.cjs');

const at = Date.parse('2026-09-23T04:00:00Z');
const select = query => parseReviewQuery(new URL('https://example.test/api/v1/recommendations/review' + query));
const decisions = Array.from({ length: 25 }, (_, i) => {
  const decision = makeDecision(match(i + 1), { now: NOW, publication: publication(NOW) }).decision;
  assert.ok(decision);
  return decision;
});
const official = (id, won) => ({ ...match(id), status: 'FINISHED', testOfficial: true,
  scoreHome: won ? 2 : 0, scoreAway: won ? 0 : 2 });
const settled = collectResults(Array.from({ length: 10 }, (_, i) => official(i + 1, i < 5)),
  new Map(), validators, NOW + 9 * 3600000).updates;
const comboNow = Date.parse('2026-09-17T13:00:00Z');
const comboDecisions = [1, 2, 3].map(id => makeDecision(match(id, comboNow),
  { now: comboNow, publication: publication(comboNow) }).decision);
const combo = freezeCombo(chooseCombo(comboDecisions, 2, comboNow), comboNow);
assert.ok(combo);
const source = { updatedAt: new Date(at).toISOString(), decisions, combos: [combo], resultEvents: settled,
  boundDecisions: combo.legs };

test('query rejects unbounded and malformed filters', () => {
  for (const query of ['?page=0', '?page=-1', '?pageSize=51', '?date=2026-02-31', '?market=CORRECT_SCORE',
    '?kind=both', '?state=FAILED', '?version=synthetic', '?q=' + 'a'.repeat(81)]) {
    assert.throws(() => select(query), { code: 'INVALID_REVIEW_QUERY' });
  }
  assert.deepEqual(select(''), { kind: 'single', market: 'ALL', date: '', version: '', state: 'ALL', q: '', page: 1, pageSize: 12 });
});

test('complete frozen ledger determines all and 7/30 day totals, not the 12-row page', () => {
  const first = buildRecommendationReviewPage(source, select('?page=1&pageSize=12'), at);
  const third = buildRecommendationReviewPage(source, select('?page=3&pageSize=12'), at);
  assert.equal(first.rows.length, 12);
  assert.equal(third.rows.length, 1);
  assert.equal(first.total, 25);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(third.summary.all, first.summary.all);
  assert.equal(first.summary.all.published, 25);
  assert.equal(first.summary.all.settled, 10);
  assert.equal(first.summary.all.won, 5);
  assert.equal(first.summary.all.pending, 15);
  assert.equal(first.summary.all.hitRate, 0.5);
  assert.equal(first.summary.windows.last7.from, '2026-09-17');
  assert.equal(first.summary.windows.last7.published, 25);
  assert.equal(first.summary.windows.last30.published, 25);
  assert.equal(first.summary.byDate[0].businessDate, '2026-09-17');
  assert.ok(first.rows[0].selectionQuality);
  assert.ok(first.rows[0].scoreDistribution);
  assert.equal(first.rows[0].settlement.state, first.rows[0].selectedSettlement.state);
  assert.equal(first.rows[0].oddsState, 'available');
  assert.equal(first.summary.all.oddsCoverage.missing, 0);
});

test('status, date, search and version filter details without rewriting overall counts', () => {
  const baseline = buildRecommendationReviewPage(source, select(''), at);
  const won = buildRecommendationReviewPage(source, select('?state=WON&pageSize=2'), at);
  assert.equal(won.total, 5);
  assert.equal(won.rows.length, 2);
  assert.equal(won.summary.filtered.hitRate, 1);
  assert.equal(won.summary.all.hitRate, baseline.summary.all.hitRate);
  assert.equal(won.summary.windows.last7.hitRate, baseline.summary.windows.last7.hitRate);
  assert.equal(buildRecommendationReviewPage(source, select('?date=2026-09-18'), at).total, 0);
  assert.equal(buildRecommendationReviewPage(source, select('?q=主队23'), at).total, 1);
  assert.equal(buildRecommendationReviewPage(source, select('?version=' + baseline.versions[0].key), at).total, 25);
  assert.equal(buildRecommendationReviewPage(source, select('?version=' + '0'.repeat(64)), at).total, 0);
});

test('HAD and HHAD remain separate denominators; missing HHAD odds is explicit', () => {
  const handicapNow = Date.parse('2026-09-20T02:00:00Z');
  const hMatch = {
    id: 'sporttery_991', sourceMatchId: '991', businessDate: '2026-09-20', status: 'SCHEDULED',
    homeTeamId: 'h991', awayTeamId: 'a991', homeTeamName: '甲队', awayTeamName: '乙队',
    kickoffTime: '2026-09-20T10:00:00Z', eventVersion: '2026-09-20T10:00:00Z', buyEndTime: '2026-09-20T09:30:00Z',
    odds: { odds1: 1.7, oddsX: 3.5, odds2: 4.8 }, oddsSource: 'sporttery:had', oddsUpdatedAt: new Date(handicapNow).toISOString(),
    handicapLine: -1, handicapOdds: { odds1: 2.05, oddsX: 3.4, odds2: 2.75 },
    handicapOddsSource: 'sporttery:HHAD', handicapOddsUpdatedAt: '2026-09-20T00:00:00Z',
    probabilityModel: { version: 'handicap-test', generatedAt: new Date(handicapNow).toISOString(),
      oneXTwo: { final: { home: .62, draw: .23, away: .15 } },
      calculationTrace: { poisson: { lambdas: { home: 2.2, away: .6 } },
        expectedGoals: { values: { finalHome: 2.2, finalAway: .6 } } } },
    predictions: [],
  };
  const decision = makeDecision(hMatch, { now: handicapNow, publication: publication(handicapNow) }).decision;
  assert.ok(decision?.handicapAnalysis);
  const event = collectResults([{ ...hMatch, status: 'FINISHED', testOfficial: true, scoreHome: 2, scoreAway: 1 }],
    new Map(), validators, handicapNow + 9 * 3600000).updates[0];
  const hSource = { decisions: [decision], combos: [], resultEvents: [event], boundDecisions: [] };
  const had = buildRecommendationReviewPage(hSource, select('?market=HAD'), at);
  const hhad = buildRecommendationReviewPage(hSource, select('?market=HHAD'), at);
  const all = buildRecommendationReviewPage(hSource, select(''), at);
  assert.equal(all.total, 1);
  assert.equal(had.summary.all.published, 1);
  assert.equal(hhad.summary.all.published, 1);
  assert.equal(hhad.rows[0].settlement.state, had.rows[0].settlement.state);
  assert.equal(hhad.rows[0].selectedSettlement.state, hhad.rows[0].handicapSettlement.state);
  assert.equal(hhad.rows[0].oddsState, 'missing');
  assert.equal(hhad.summary.all.oddsCoverage.settledMissingOdds, 1);
  assert.equal(hhad.summary.byMarket.reduce((n, row) => n + row.published, 0), 2);

  // A previously published v2 handicap decision remains a valid frozen row.
  // Its upstream HAD version is unchanged, but it must not share the HHAD
  // version filter with the newer coherent v3 distribution.
  const older = structuredClone(decision);
  older.handicapAnalysis = require('./fixtures/handicap-margin-v2.json');
  delete older.selectionPolicyVersion;
  older.inputEvidence.model.handicapMarginInputHash = older.handicapAnalysis.inputHash;
  older.inputHash = hash({ hadInputHash: older.hadInputHash, handicapInputHash: older.handicapAnalysis.inputHash });
  older.decisionId = `decision_${hash([older.version, older.sourceMatchId, older.eventVersion, older.market, older.inputHash])}`;
  older.id = older.decisionId;
  const { recordHash, ...olderBody } = older;
  older.recordHash = hash(olderBody);
  assert.equal(validDecision(older), true);
  const oldSource = { ...hSource, decisions: [older] };
  const oldHad = buildRecommendationReviewPage(oldSource, select('?market=HAD'), at);
  const oldHhad = buildRecommendationReviewPage(oldSource, select('?market=HHAD'), at);
  assert.equal(oldHad.versions[0].key, had.versions[0].key);
  assert.notEqual(oldHhad.versions[0].key, hhad.versions[0].key);
  assert.match(oldHhad.versions[0].label, /handicap-margin-v2/);
  assert.match(hhad.versions[0].label, /handicap-margin-v3/);
});

test('combo review uses frozen legs and independent complete totals', () => {
  const page = buildRecommendationReviewPage(source, select('?kind=two&pageSize=1'), at);
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].combo.id, combo.id);
  assert.equal(page.rows[0].settlement.state, page.rows[0].selectedSettlement.state);
  assert.equal(page.summary.all.published, 1);
  assert.equal(page.summary.all.settled, 1);
  const missingBinding = buildRecommendationReviewPage({ ...source, boundDecisions: [] }, select('?kind=two'), at);
  assert.equal(missingBinding.total, 0);
  assert.equal(missingBinding.excludedCorruptRecords, 1);
});

test('combo version filter binds each frozen leg market, including HHAD policy', () => {
  const hInput = match(301, comboNow, {
    handicapLine: 1, handicapOdds: { odds1: 2.05, oddsX: 3.4, odds2: 2.75 },
    handicapOddsSource: 'sporttery:HHAD', handicapOddsUpdatedAt: new Date(comboNow).toISOString(),
  });
  hInput.probabilityModel.calculationTrace = { poisson: { lambdas: { home: 2.2, away: .6 } } };
  const hDecision = makeDecision(hInput, { now: comboNow, publication: publication(comboNow) }).decision;
  const plainDecision = makeDecision(match(302, comboNow), { now: comboNow, publication: publication(comboNow) }).decision;
  const parents = [hDecision, plainDecision];
  const mixed = freezeCombo(chooseCombo(parents, 2, comboNow), comboNow);
  const hadOnly = freezeCombo(chooseCombo(parents, 2, comboNow,
    { admit: candidate => candidate.selection.market === 'HAD' }), comboNow);
  assert.deepEqual(mixed.selections.map(row => row.market), ['HHAD', 'HAD']);
  assert.deepEqual(hadOnly.selections.map(row => row.market), ['HAD', 'HAD']);
  const common = { decisions: [], resultEvents: [], boundDecisions: parents };
  const mixedPage = buildRecommendationReviewPage({ ...common, combos: [mixed] }, select('?kind=two'), at);
  const hadPage = buildRecommendationReviewPage({ ...common, combos: [hadOnly] }, select('?kind=two'), at);
  assert.equal(mixedPage.total, 1);
  assert.equal(hadPage.total, 1);
  assert.notEqual(mixedPage.versions[0].key, hadPage.versions[0].key);
  assert.equal(buildRecommendationReviewPage({ ...common, combos: [mixed] },
    select(`?kind=two&version=${hadPage.versions[0].key}`), at).total, 0);
});

test('database read uses one read-only snapshot and returns source truth', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql);
      if (sql.startsWith('SELECT payload FROM football.daily_featured_combo_state'))
        return { rows: [{ payload: { recommendationCenter: { version: 'recommendation-center-v1', updatedAt: new Date(at).toISOString() } } }] };
      if (sql.includes('DISTINCT ON')) return { rows: source.decisions.map(payload => ({ payload })) };
      if (sql.includes('recommendation_combo_records')) return { rows: source.combos.map(payload => ({ payload })) };
      if (sql.includes('recommendation_result_heads')) return { rows: source.resultEvents.map(payload => ({ payload })) };
      if (sql.includes('WHERE id=ANY')) return { rows: source.boundDecisions.map(payload => ({ payload })) };
      return { rows: [] };
    },
    release() { commands.push('RELEASE'); },
  };
  const result = await readRecommendationReviewPage({ connect: async () => client },
    new URL('https://example.test/api/v1/recommendations/review?pageSize=3'), at);
  assert.equal(result.rows.length, 3);
  assert.equal(result.summary.all.published, 25);
  assert.match(commands[0], /READ ONLY/);
  assert.ok(commands.includes('COMMIT'));
  assert.equal(commands.at(-1), 'RELEASE');
});
