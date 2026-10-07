'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NOW, match, publication } = require('./recommendationFixture.cjs');
const { withVerifiedInputEvidence } = require('./fixtures/recommendation-input-helper.cjs');
const { makeDecision, validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { collectResults, validResultEvent } = require('../scripts/recommendationPlatform/results.cjs');
const { officialResultValidators } = require('../scripts/recommendationPlatform/officialResults.cjs');
const { buildFixtureSignal, applyKLeagueOfficialResult } = require('../scripts/syncKLeagueOfficialStandings.cjs');
const { buildRecommendationReviewPage, parseReviewQuery } = require('../server/recommendationReviewPage.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const m = require('../scripts/marketSeparatedRegression.cjs');
const OBSERVED = '2026-09-18T08:00:00.123456Z';
function frozen(id = 1, { line = -1, now = NOW, primaryPolicy = 'coherent-market-primary-v1', p = { home: 40, draw: 30, away: 30 }, quote = true, odds = null } = {}) {
  const source = withVerifiedInputEvidence(match(id, now, {
    ...(line ? { handicapLine: line, handicapOddsSource: 'sporttery:HHAD', handicapOddsUpdatedAt: new Date(now).toISOString(),
      ...(quote ? { handicapOdds: { odds1: 2, oddsX: 3.5, odds2: 2.8 } } : {}) } : {}),
    ...(odds ? { odds } : {}), probabilityModel: { generatedAt: new Date(now).toISOString(), oneXTwo: { final: p },
      calculationTrace: { poisson: { lambdas: { home: 1.5, away: 1 } } } },
  }));
  const d = makeDecision(source, { now, publication: publication(now), primaryPolicy }).decision;
  assert(d); assert(validDecision(d)); return d;
}
function head(d, { state = 'FINAL', home = 2, away = 0, source = 'sporttery:official-api', observedAt = '2026-09-17T18:00:00.000Z', revision = 0 } = {}) {
  const row = { sourceMatchId: d.sourceMatchId, eventVersion: d.eventVersion, kickoffTime: d.eventVersion,
    homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId, official: true, status: 'FINISHED',
    resultSource: source, resultObservedAt: observedAt, resultRevision: revision, scoreHome: home, scoreAway: away,
    ...(state === 'VOID' ? { resultDisposition: 'VOID', voidSource: 'sporttery:official-api', voidReason: 'official cancel' } : {}) };
  const result = collectResults([row], new Map(), officialResultValidators(Date.parse(observedAt)), Date.parse(observedAt)).updates[0];
  assert(result); assert(validResultEvent(result)); return result;
}
function pages(decisions, heads, observedAt = OBSERVED) {
  const source = { updatedAt: observedAt, decisions, resultEvents: heads, combos: [], boundDecisions: [] };
  return ['HAD', 'HHAD'].flatMap(market => {
    const filters = parseReviewQuery(new URL(`https://test.invalid/?kind=single&market=${market}&pageSize=50`));
    const first = buildRecommendationReviewPage(source, filters, Date.parse(observedAt));
    return Array.from({ length: Math.max(1, first.pageCount) }, (_, index) => index ? buildRecommendationReviewPage(source,
      { ...filters, page: index + 1 }, Date.parse(observedAt)) : first);
  });
}
function envelope(decisions, heads = [], extras = {}) {
  const value = { version: m.INPUT_VERSION, observedAt: OBSERVED, from: '2026-09-17', through: '2026-09-18',
    readOnly: 'on', isolation: 'repeatable read', productionWrites: 0,
    runtime: { runtimeSha: 'b'.repeat(64), completeSha: 'b'.repeat(64), stable: true },
    generation: { data_publication_mode: 'active-generation', data_generation_id: 'g-' + 'c'.repeat(64),
      manifest_hash: 'd'.repeat(64), committed_at: '2026-09-18T07:59:59Z' },
    decisions, resultHeads: heads, resultEvidenceRows: [], ...extras };
  value.reviewPages = pages(decisions, heads, value.observedAt); return value;
}
const build = (ds, hs = [], extras = {}) => m.buildMarketSeparatedRegression(envelope(ds, hs, extras));

test('frozen original, HAD argmax and integer-line HHAD remain separate without changing any bytes', () => {
  const d = frozen(), before = JSON.stringify(d), report = build([d], [head(d)]), e = report.events[0];
  assert.equal(report.crossMarketSelectionPerformed, false); assert.equal(report.coverage.uniqueEvents, 1);
  assert.equal(e.items.find(i => i.kind === 'frozenHAD').code, d.tipCode);
  assert.equal(e.items.find(i => i.kind === 'hadArgmaxResearch').code, '1');
  assert.equal(e.items.find(i => i.kind === 'originalPrimary').code, d.coherentPrimary.anchorCode);
  assert.equal(e.items.find(i => i.kind === 'frozenHHAD').actual, '1');
  assert.deepEqual(e.items.find(i => i.kind === 'frozenHHAD').p, d.handicapAnalysis.overallProbabilities);
  assert.equal(JSON.stringify(d), before); assert.equal(report.trainingPerformed, false);
});

test('two market pages, identical page copies and multiple quote batches count one exact event', () => {
  const old = frozen(1), newer = frozen(1, { now: NOW + 60000 }), h = head(newer);
  const input = envelope([old, newer, newer], [h, h]); input.reviewPages.push(structuredClone(input.reviewPages[0]));
  const r = m.buildMarketSeparatedRegression(input);
  assert.equal(r.coverage.uniqueEvents, 1); assert.equal(r.coverage.nonSelectedValidRows, 2);
  assert.equal(r.events[0].recordHash, newer.recordHash); assert.equal(r.tracks.frozenHAD.hitOnly.denominator, 1);
  assert.equal(r.pageCoverage.HAD.complete, false, 'duplicated original event rows are not called a complete unique cohort');
});

test('same published instant with different frozen content is ambiguous, never tie-broken by p or row order', () => {
  const one = frozen(), other = frozen(1, { p: { home: 45, draw: 30, away: 25 } });
  for (const ds of [[one, other], [other, one]]) {
    const r = build(ds); assert.equal(r.coverage.uniqueEvents, 0);
    assert.equal(r.issues[0].reason, 'ambiguous-latest-freeze');
  }
});

test('unknown 0-0, VOID and a conflicting same-event head are outside hit denominators', () => {
  const ds = [1, 2, 3, 4].map(id => frozen(id));
  const hs = [head(ds[1], { state: 'VOID' }), head(ds[2]), head(ds[2], { home: 0, away: 0 }), head(ds[3], { home: 0, away: 0 })];
  const r = build(ds, hs), x = r.tracks.frozenHAD.byMarketAndLine['HAD:0'].admittedLedgerMetrics;
  assert.deepEqual(x.stateCounts, { FINAL: 1, PENDING: 1, VOID: 1, DISPUTED: 1, UNVERIFIED_RESULT: 0 });
  assert.equal(x.hit.denominator, 1); assert.equal(r.events[0].result.state, 'PENDING');
});

test('official cancellation before kickoff remains VOID and never counts as a loss', () => {
  const d = frozen(), h = head(d, { state: 'VOID', observedAt: '2026-09-17T12:00:00Z' });
  const r = build([d], [h]); assert.equal(r.events[0].result.state, 'VOID');
  assert.equal(r.tracks.frozenHAD.hitOnly.denominator, 0);
});

test('official same-revision score conflict blocks the head, while generic and unbound revisions cannot veto', () => {
  const d = frozen(), h = head(d), row = { sourceMatchId: d.sourceMatchId, eventVersion: d.eventVersion,
    kickoffTime: d.eventVersion, homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId,
    official: true, status: 'FINISHED', resultSource: 'sporttery:official-api', resultRevision: h.revision,
    resultObservedAt: h.observedAt, scoreHome: 0, scoreAway: 1 };
  assert.equal(build([d], [h], { resultEvidenceRows: [row] }).events[0].result.state, 'DISPUTED');
  for (const change of [r => delete r.resultRevision, r => r.resultRevision = 1,
    r => { r.resultSource = '500.com:jczq-result'; r.official = false; }, r => r.status = 'SCHEDULED']) {
    const x = structuredClone(row); change(x);
    assert.equal(build([d], [h], { resultEvidenceRows: [x] }).events[0].result.state, 'FINAL');
  }
  const extra = { ...row, scoreHome: h.scoreHome, scoreAway: h.scoreAway,
    resultProvenance: { scoreKind: 'extra-time' } };
  assert.equal(build([d], [h], { resultEvidenceRows: [extra] }).events[0].result.state, 'UNVERIFIED_RESULT');
});

test('unsupported/generic result labels and ordered-team mismatch do not borrow settlement from review', () => {
  const d = frozen(), normal = head(d), generic = structuredClone(normal); generic.source = 'validated-result-adapter';
  assert(validResultEvent(generic), 'legacy result hashing did not bind source; the evaluator must enforce its own allowlist');
  assert.equal(build([d], [generic]).events[0].result.state, 'UNVERIFIED_RESULT');
  const wrong = head({ ...d, homeTeamId: d.awayTeamId, awayTeamId: d.homeTeamId });
  assert.equal(build([d], [wrong]).events[0].result.state, 'DISPUTED');
  const fake = envelope([d], []); fake.reviewPages[0].rows[0].selectedSettlement = { state: 'WON' };
  assert.equal(m.buildMarketSeparatedRegression(fake).tracks.frozenHAD.hitOnly.denominator, 0);
});

test('nanosecond future result observation is excluded rather than rounded to the export millisecond', () => {
  const d = frozen(), h = head(d), x = structuredClone(h);
  x.observedAt = '2026-09-18T08:00:00.123456001Z'; assert(validResultEvent(x));
  assert.equal(build([d], [x]).events[0].result.state, 'UNVERIFIED_RESULT');
  x.observedAt = '2026-09-18T16:00:00.123456+08:00';
  assert.equal(build([d], [x]).events[0].result.state, 'FINAL');
});

test('missing HHAD quote does not borrow HAD SP; old independent policies do not acquire invented single anchors', () => {
  const d = frozen(1, { quote: false, primaryPolicy: 'independent-market-primary-v1' });
  const r = build([d], [head(d)]), item = r.events[0].items.find(i => i.kind === 'frozenHHAD');
  assert(item); assert.equal(item.selectedOdds, null); assert.equal(item.marketProbabilities, null);
  assert.equal(item.quoteState, 'missing-same-market-odds'); assert.equal(item.valueDiagnostic.passes, false);
  assert.equal(r.coverage.missingExplicitPrimary, 1); assert.equal(r.tracks.originalPrimary.hitOnly.denominator, 0);
});

test('proper scores use full same-market vectors, exact ties abstain, and zero truth probability stays infinite', () => {
  const one = { kind: 'research', market: 'HAD', line: 0, code: '1', p: { '1': .5, X: .3, '2': .2 },
    marketProbabilities: { '1': .6, X: .2, '2': .2 }, marketCode: '1', side: 'market-favorite', actual: '1', won: true,
    marketWon: true, resultState: 'FINAL', quoteState: 'frozen-fresh-same-market', valueDiagnostic: { passes: false } };
  const r = m.metrics([one]); assert(Math.abs(r.model.brier - .38) < 1e-14); assert.equal(r.model.logLoss, Math.log(2));
  assert(Math.abs(r.paired.market.brier - .24) < 1e-14); assert.equal(m.uniqueLeader({ '1': .4, X: .4, '2': .2 }), null);
  const zero = m.metrics([{ ...one, p: { '1': 0, X: .5, '2': .5 } }]);
  assert.equal(zero.model.logLoss, null); assert.equal(zero.model.logLossInfinite, true); assert.equal(zero.model.logLossZeroProbabilityCount, 1);
});

test('same-market value gates require both strict PRD conditions and do not alter frozen selections', () => {
  const d = frozen(1, { line: null, p: { home: 70, draw: 20, away: 10 } }), r = build([d], [head(d)]);
  const i = r.events[0].items.find(v => v.kind === 'hadArgmaxResearch');
  assert.equal(i.valueDiagnostic.passes, true); assert(Math.abs(i.valueDiagnostic.expectedReturn - .7 * 1.8) < 1e-14);
  assert(i.valueDiagnostic.edge > .05); assert.equal(i.valueDiagnostic.formalEligible, false);
  assert.equal(r.events[0].items.find(v => v.kind === 'frozenHAD').code, d.tipCode);
  const lowReturn = frozen(2, { line: null, p: { home: 58, draw: 32, away: 10 } });
  const a = build([lowReturn]).events[0].items.find(v => v.kind === 'hadArgmaxResearch').valueDiagnostic;
  assert(a.edge > .05); assert(a.expectedReturn <= 1.05); assert.equal(a.passes, false);
  const lowEdge = frozen(3, { line: null, p: { home: 49, draw: 30, away: 21 }, odds: { odds1: 2.2, oddsX: 6, odds2: 6 } });
  const b = build([lowEdge]).events[0].items.find(v => v.kind === 'hadArgmaxResearch').valueDiagnostic;
  assert(b.expectedReturn > 1.05); assert(b.edge <= .05); assert.equal(b.passes, false);
});

test('old conditional companion vector is never evaluated as an unconditional three-outcome p', () => {
  const d = frozen(), h = structuredClone(d); delete h.handicapAnalysis.overallProbabilities;
  h.handicapAnalysis.probabilityBasis = 'conditional-on-straight-primary';
  const selected = m.frozenHandicap(h); assert.equal(selected.p, null); assert.equal(selected.probabilityBasis, 'conditional-or-unavailable');
});

test('retained official KLeague regulation evidence is revalidated in a distinct subset, without promotion', () => {
  const kickoff = '2026-09-26T08:30:00.000Z', at = Date.parse('2026-09-26T06:00:00Z'), observed = '2026-09-26T10:30:00Z';
  const source = withVerifiedInputEvidence(match('2041558', at, { businessDate: '2026-09-26',
    homeTeamName: '安养FC', awayTeamName: '蔚山现代', kickoffTime: kickoff, eventVersion: kickoff }));
  const d = makeDecision(source, { now: at, publication: publication(at) }).decision; assert(d);
  const fixture = buildFixtureSignal({ match: source, rows: [{ gameId: 2041558, gameDate: '2026.09.26', gameTime: '17:30',
    homeTeam: 'K27', awayTeam: 'K01', homeTeamName: 'ANYANG', awayTeamName: 'ULSAN', homeGoal: 2, awayGoal: 1, gameStatus: 'FE' }],
    observedAt: observed, sourceUrl: 'https://www.kleague.com/getScheduleList.do', responseSha256: 'e'.repeat(64) });
  const official = applyKLeagueOfficialResult({ ...source, externalSignals: { kLeagueOfficial: { fixture } } });
  const h = collectResults([official], new Map(), officialResultValidators(Date.parse(observed)), Date.parse(observed)).updates[0]; assert(h);
  const input = envelope([d], [h], { observedAt: '2026-09-26T10:31:00Z', from: '2026-09-26', through: '2026-09-26',
    generation: { data_publication_mode: 'active-generation', data_generation_id: 'g-' + 'c'.repeat(64), manifest_hash: 'd'.repeat(64), committed_at: '2026-09-26T10:30:00Z' },
    resultEvidenceRows: [official] });
  const r = m.buildMarketSeparatedRegression(input), metric = r.tracks.frozenHAD.byMarketAndLine['HAD:0'];
  assert.equal(metric.verified90Metrics.hit.denominator, 1); assert.equal(r.events[0].result.settlementOnly, true);
  assert.equal(r.provider90Reverified, false); assert.equal(r.formalPromotion, false);
  const altered = structuredClone(input); altered.resultHeads[0].officialResultEvidence.provenance.scoreKind = 'extra-time';
  assert.equal(m.buildMarketSeparatedRegression(altered).tracks.frozenHAD.hitOnly.denominator, 0);
});

test('page memberships, range/write claims and snapshot clocks fail closed; partial page coverage is explicit', () => {
  const d = frozen(), x = envelope([d]);
  for (const edit of [r => r.productionWrites = 1, r => r.runtime.completeSha = 'f'.repeat(64), r => r.from = '2026-02-30',
    r => r.reviewPages[0].filters.state = 'WON', r => { r.reviewPages[0].rows[0].decision = structuredClone(r.reviewPages[0].rows[0].decision); r.reviewPages[0].rows[0].decision.recordHash = 'f'.repeat(64); },
    r => r.reviewPages[0].updatedAt = '2026-09-18T08:00:00.123456001Z']) {
    const clone = structuredClone(x); edit(clone); assert.throws(() => m.buildMarketSeparatedRegression(clone), /MARKET_REGRESSION_/);
  }
  assert.equal(m.buildMarketSeparatedRegression(x).windows.last30.fullyCoveredByExportRange, false);
});

test('local CLI output is create-only and report hash, frozen originals and input bytes remain unchanged', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'market-regression-test-')), input = path.join(temp, 'in.json'), output = path.join(temp, 'out.json');
  try {
    const original = JSON.stringify(envelope([frozen()])); fs.writeFileSync(input, original, { flag: 'wx' });
    m.runLocal({ input, output }); const saved = JSON.parse(fs.readFileSync(output));
    const { contentHash, ...body } = saved.report; assert.equal(hash(body), contentHash);
    assert.equal(fs.readFileSync(input, 'utf8'), original); assert.throws(() => m.runLocal({ input, output }), /CREATE_ONLY_OUTPUT/);
    assert.throws(() => m.parseArgs(['--input', input, '--input', input, '--output', output]), /ARGUMENTS/);
  } finally { for (const file of [output, input]) if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(temp); }
});
