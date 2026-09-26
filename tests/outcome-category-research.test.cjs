'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withVerifiedInputEvidence } = require('./fixtures/recommendation-input-helper.cjs');
const { makeDecision, validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { selectionQuality } = require('../src/services/recommendationSelectionQuality.cjs');
const { classifyOutcomeResearch, VERSION } = require('../src/services/outcomeCategoryResearch.cjs');
const { createRuntime } = require('../scripts/recommendationPlatform/runtime.cjs');
const { NOW, match, memoryPorts, validators } = require('./recommendationFixture.cjs');
const { bindPublicReferenceDecision } = require('../src/services/publicReferenceDecision.cjs');

const now = Date.parse('2026-09-26T09:00:00Z');
const publication = { generationId: 'category-research-fixture', manifestHash: 'a'.repeat(64) };

function published(id, probabilities, quotes, evidenceOptions = {}) {
  const match = withVerifiedInputEvidence({
    id: `sporttery_${id}`, sourceMatchId: id, businessDate: '2026-09-26',
    status: 'SCHEDULED', homeTeamId: `home_${id}`, awayTeamId: `away_${id}`,
    homeTeamName: `Home ${id}`, awayTeamName: `Away ${id}`,
    kickoffTime: '2026-09-26T14:00:00Z', eventVersion: '2026-09-26T14:00:00Z',
    probabilityModel: { generatedAt: new Date(now).toISOString(),
      oneXTwo: { final: { home: probabilities[0], draw: probabilities[1], away: probabilities[2] } } },
    odds: { odds1: quotes[0], oddsX: quotes[1], odds2: quotes[2] },
    oddsSource: 'sporttery:had', oddsUpdatedAt: new Date(now).toISOString(),
  }, evidenceOptions);
  const result = makeDecision(match, { now, publication });
  assert.equal(result.reason, null);
  assert.equal(validDecision(result.decision), true);
  return result.decision;
}

test('same frozen triplets produce deterministic all-outcome fair prices and ranks', () => {
  const decision = published('favorite', [.62, .21, .17], [1.75, 4.1, 5]);
  const before = structuredClone(decision);
  const row = { decision, selectionQuality: selectionQuality(decision) };
  const result = classifyOutcomeResearch(row);
  assert.equal(result.version, VERSION);
  assert.equal(result.decisionId, decision.decisionId);
  assert.equal(result.recordHash, decision.recordHash);
  assert.equal(result.category, 'strong-favorite');
  assert.equal(result.candidateCode, '1');
  assert.equal(result.researchQualified, true);
  assert.deepEqual(result.evidenceCodes, ['model-market-favorite-aligned', 'model-lead-strong']);
  assert.equal(result.researchOnly, true);
  assert.equal(result.formalPromotionEligible, false);
  assert.deepEqual(result.outcomes.map(item => item.code), ['1', 'X', '2']);
  assert.ok(Math.abs(result.outcomes.reduce((sum, item) => sum + item.fairMarketProbability, 0) - 1) < 1e-12);
  assert.equal(result.outcomes[0].modelRank, 1);
  assert.equal(result.outcomes[0].marketRank, 1);
  assert.ok(Math.abs(result.outcomes[0].expectedValue - (.62 * 1.75 - 1)) < 1e-12);
  assert.deepEqual(classifyOutcomeResearch(row), result);
  assert.deepEqual(decision, before, 'research must not alter the published decision');
});

test('a value-supported balanced draw stays an observation until independent validation', () => {
  const decision = published('draw', [.40, .34, .26], [2.25, 3.45, 3.8]);
  assert.equal(decision.tipCode, '1');
  const result = classifyOutcomeResearch({ decision, selectionQuality: selectionQuality(decision) });
  assert.equal(result.category, 'balanced-draw');
  assert.equal(result.candidateCode, 'X');
  assert.equal(result.researchQualified, false);
  assert.ok(result.reasons.includes('category-holdout-unvalidated'));
  assert.ok(result.evidenceCodes.includes('draw-near-model-leader'));
  assert.equal(result.outcomes.find(item => item.code === 'X').modelRank, 2);
  assert.equal(decision.tipCode, '1');
});

test('a nonfavorite side has a structural signal but cannot qualify before holdout validation', () => {
  const decision = published('upset', [.39, .29, .32], [1.65, 3.8, 5.5]);
  const result = classifyOutcomeResearch(decision);
  assert.equal(result.category, 'upset-signal');
  assert.equal(result.candidateCode, '2');
  assert.equal(result.researchQualified, false);
  assert.ok(result.reasons.includes('category-holdout-unvalidated'));
  assert.ok(result.evidenceCodes.includes('nonfavorite-positive-price-edge'));
  assert.equal(result.outcomes.find(item => item.code === '2').marketRank, 3);
});

test('a negative-price favorite remains a football pattern but cannot qualify as value research', () => {
  const result = classifyOutcomeResearch(published('negative', [.55, .25, .20], [1.6, 3.6, 4.9]));
  assert.equal(result.category, 'strong-favorite');
  assert.equal(result.researchQualified, false);
  assert.ok(result.reasons.includes('price-edge-insufficient'));
  assert.ok(result.reasons.includes('expected-value-insufficient'));
});

test('no supported draw or upset becomes watch, without category quotas', () => {
  const result = classifyOutcomeResearch(published('watch', [.47, .25, .28], [2.4, 3.2, 3.1]));
  assert.equal(result.category, 'watch');
  assert.equal(result.candidateCode, null);
  assert.equal(result.researchQualified, false);
  assert.deepEqual(result.reasons, ['no-category-signal']);
});

test('missing team samples or input proof cannot qualify a draw or upset', () => {
  const missingSamples = published('no-samples', [.40, .34, .26], [2.25, 3.45, 3.8],
    { eloHome: 0, eloAway: 0, formHome: 0, formAway: 0 });
  const draw = classifyOutcomeResearch(missingSamples);
  assert.equal(draw.category, 'balanced-draw');
  assert.equal(draw.researchQualified, false);
  assert.ok(draw.reasons.includes('team-samples-insufficient'));

  const missingProof = structuredClone(published('no-proof', [.39, .29, .32], [1.65, 3.8, 5.5]));
  missingProof.inputEvidence.model.inputEvidence = null;
  const upset = classifyOutcomeResearch(missingProof);
  assert.equal(upset.category, 'upset-signal');
  assert.equal(upset.researchQualified, false);
  assert.ok(upset.reasons.includes('input-evidence-unavailable'));
});

test('inconsistent quality, nonofficial quote and malformed triplets fail closed', () => {
  const decision = published('guard', [.62, .21, .17], [1.75, 4.1, 5]);
  const fakeQuality = { ...selectionQuality(decision), qualified: false };
  const mismatch = classifyOutcomeResearch({ decision, selectionQuality: fakeQuality });
  assert.equal(mismatch.researchQualified, false);
  assert.ok(mismatch.reasons.includes('selection-quality-mismatch'));
  const unverified = classifyOutcomeResearch({ ...decision, quoteSource: 'other:HAD' });
  assert.equal(unverified.researchQualified, false);
  assert.ok(unverified.reasons.includes('official-had-quote-unverified'));
  const malformed = classifyOutcomeResearch({ ...decision, quoteOdds: { ...decision.quoteOdds, X: null } });
  assert.equal(malformed.category, 'watch');
  assert.deepEqual(malformed.reasons, ['published-had-triplet-invalid']);
});

test('publishing cycle exposes research on current open rows without changing the frozen ledger', async () => {
  const ports = memoryPorts();
  const input = (id, p, q, options = {}) => {
    const current = match(id, NOW);
    current.probabilityModel.oneXTwo.final = { home: p[0], draw: p[1], away: p[2] };
    current.odds = { odds1: q[0], oddsX: q[1], odds2: q[2] };
    return withVerifiedInputEvidence(current, options);
  };
  ports.current = [
    input(1, [.62, .21, .17], [1.75, 4.1, 5]),
    input(2, [.40, .34, .26], [2.25, 3.45, 3.8]),
    input(3, [.39, .29, .32], [1.65, 3.8, 5.5]),
    input(4, [.40, .34, .26], [2.25, 3.45, 3.8], { eloHome: 0, eloAway: 0 }),
  ];
  const runtime = createRuntime(ports, { validators });
  const cycle = await runtime.publishingCycle();
  assert.equal(cycle.publication.ok, true);
  assert.equal(cycle.projection.ok, true);
  const ledger = structuredClone({ decisions: ports.state.decisions, combos: ports.state.combos });
  const response = JSON.parse(JSON.stringify({ recommendationCenter: ports.state.view }));
  const rows = response.recommendationCenter.current;
  assert.equal(rows.length, 4);
  const bySource = Object.fromEntries(rows.map(row => [row.decision.sourceMatchId, row]));
  assert.deepEqual(['1', '2', '3', '4'].map(id => bySource[id].outcomeResearch.category),
    ['strong-favorite', 'balanced-draw', 'upset-signal', 'balanced-draw']);
  assert.equal(bySource['4'].outcomeResearch.researchQualified, false);
  assert.ok(bySource['4'].outcomeResearch.reasons.includes('team-samples-insufficient'));
  for (const row of rows) {
    assert.equal(row.outcomeResearch.decisionId, row.decision.decisionId);
    assert.equal(row.outcomeResearch.recordHash, row.decision.recordHash);
    assert.equal(row.outcomeResearch.outcomes.length, 3);
    assert.equal(row.outcomeResearch.researchOnly, true);
    assert.equal(row.outcomeResearch.formalPromotionEligible, false);
  }
  assert.ok(response.recommendationCenter.review.singles.every(row => row.outcomeResearch === undefined),
    'settlement review must not acquire a retroactive research classification');
  assert.deepEqual({ decisions: ports.state.decisions, combos: ports.state.combos }, ledger);

  const opposite = structuredClone(ports.current[0]);
  opposite.predictions = [{ marketType: 'BEST', recommendationAction: 'reference',
    oddsPoolCode: 'HAD', tipCode: '2', odds: 5 }];
  opposite.predictionMeta = { decisionGeneratedAt: new Date(NOW).toISOString(),
    decisionId: 'later-opposite-reference', modelVersion: opposite.probabilityModel.version,
    policyVersion: 'reference-test-v1', featureSnapshot: {
      sourceMatchId: '1', kickoffTime: opposite.kickoffTime,
      capturedAt: new Date(NOW - 1000).toISOString(),
    } };
  const bound = bindPublicReferenceDecision(opposite, null, new Date(NOW + 60000).toISOString());
  ports.current = [bound, ...ports.current.slice(1)];
  ports.now = NOW + 2 * 60000;
  await runtime.view();
  const warned = ports.state.view.current.find(row => row.decision.sourceMatchId === '1');
  assert.equal(warned.outcomeResearch.researchQualified, false);
  assert.ok(warned.outcomeResearch.reasons.includes('cross-track-direction-conflict'));
  assert.ok(!warned.outcomeResearch.reasons.includes('selection-quality-mismatch'));
  assert.deepEqual({ decisions: ports.state.decisions, combos: ports.state.combos }, ledger);

  ports.now = NOW + 16 * 60000;
  await runtime.view();
  const expired = ports.state.view.current.find(row => row.decision.sourceMatchId === '2');
  assert.equal(expired.outcomeResearch.researchQualified, false);
  assert.ok(expired.outcomeResearch.reasons.includes('quote-stale'));
  assert.equal(expired.outcomeResearch.candidateCode, 'X', 'the old price is retained as history, not a live study candidate');

  ports.now = Date.parse('2026-09-17T16:00:00Z');
  const projected = await runtime.view();
  assert.equal(projected.ok, true);
  assert.ok(ports.state.view.current.every(row => row.outcomeResearch === undefined),
    'after cutoff, the current page does not relabel frozen directions as new research');
  assert.deepEqual({ decisions: ports.state.decisions, combos: ports.state.combos }, ledger);
});
