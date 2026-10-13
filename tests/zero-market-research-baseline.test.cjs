'use strict';
// Synthetic fixtures only. This test never reads the real277/history/online inputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../scripts/zeroMarketResearchBaseline.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const copy = v => structuredClone(v);
const hash = v => m.hash(v);
const isoAgo = ms => new Date(Date.now() - ms).toISOString();
const namespace = 'synthetic/research-only/source-season-2000';
const h = 'a'.repeat(64);
function input() {
  const names = ['alpha', 'bravo', 'charlie', 'delta'];
  const entities = names.map((literalName, i) => ({ literalName, namespace, entityRef: namespace + '#research-entity/' + (i + 1) }));
  const rows = [];
  const attack = [3, 2, 1, 1], defense = [1, 0, 0, -1];
  let k = 0;
  for (let round = 0; round < 6; round++) for (let home = 0; home < 4; home++) for (let away = 0; away < 4; away++) {
    if (home === away) continue;
    const day = new Date(Date.UTC(2000, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    const noise = round % 3 - 1;
    rows.push({ sourceRecordRef: namespace + '#line/' + (++k), sourceNominalDate: day,
      homeEntityRef: entities[home].entityRef, awayEntityRef: entities[away].entityRef,
      homeGoals: Math.max(0, attack[home] - defense[away] + noise), awayGoals: Math.max(0, attack[away] - defense[home] - noise),
      sourceFormat: 'ordinary-ft', knownAt: isoAgo(3000), neutral: null, historicalAsOf: null, actualEndedAt: null });
  }
  const request = { version: m.INPUT_VERSION, researchOnly: true,
    source: { namespace, rawSha256: h, license: 'CC0-1.0', licenseRawSha256: h, formatEvidenceSha256: h,
      observedAt: isoAgo(7000), formatKnownAt: isoAgo(6000), coverageThrough: '2000-03-12', completeCompetitionHistory: false },
    entities, rows, approval: { version: m.APPROVAL_VERSION, approved: true, researchOnly: true,
      reviewId: 'synthetic-reviewed-metadata', reviewer: 'synthetic-test-only', reviewedAt: isoAgo(4000),
      scope: 'future-only-source-format-ft', venuePolicy: 'venue-agnostic', sourceNamespace: namespace,
      approvedInputHash: null, sourceEntityMapApproved: true, partialCoverageAccepted: true }, config: { iterations: 800 } };
  request.approval.approvedInputHash = m.researchInputHash(request);
  return request;
}
function reapprove(request) { request.approval.approvedInputHash = m.researchInputHash(request); return request; }
function fit() { const value = m.fitZeroMarketResearch(input()); assert.equal(value.status, 'research-fitted', JSON.stringify(value.reasons)); return value.artifact; }
function eventRequest(artifact, overrides = {}) {
  const eventVersion = new Date(Date.now() + 86400000).toISOString();
  const cutoffAt = new Date(Date.now() + 82800000).toISOString();
  const event = { sourceEventRef: namespace + '#future/alpha-bravo', recordedSourceMatchId: 'synthetic-next-match', eventVersion,
    sourceNominalDate: eventVersion.slice(0, 10), cutoffAt, homeTeamId: 'synthetic-provider-a', awayTeamId: 'synthetic-provider-b',
    homeEntityRef: artifact.entities[0].entityRef, awayEntityRef: artifact.entities[1].entityRef,
    observedAt: isoAgo(1000), knownAt: isoAgo(500), status: 'SCHEDULED', saleStatus: 'OPEN', neutral: null,
    integerHandicap: -1, ...overrides };
  const approval = { version: m.EVENT_APPROVAL_VERSION, approved: true, researchOnly: true,
    reviewId: 'synthetic-future-ordered-event', reviewer: 'synthetic-test-only', reviewedAt: isoAgo(700),
    inputHash: artifact.inputHash, sourceEventRef: event.sourceEventRef, eventVersion: event.eventVersion,
    cutoffAt: event.cutoffAt, orderedTeamIds: [event.homeTeamId, event.awayTeamId],
    orderedEntityRefs: [event.homeEntityRef, event.awayEntityRef], sourceNominalDate: event.sourceNominalDate,
    sourceTimezoneMappingApproved: true, sourceAliasApproved: true, approvedEventHash: hash(event), eventEvidenceSha256: h };
  return { artifact, event, approval };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 3));
const reseal = a => { const body = { ...a }; delete body.contentHash; a.contentHash = hash(body); return a; };
function independentObjective(artifact, parameters = artifact.parameters) {
  const index = new Map(artifact.entities.map((e, i) => [e.entityRef, i])); let total = 0;
  for (const row of artifact.trainingRows) for (const [own, other, score] of [
    [row.homeEntityRef, row.awayEntityRef, row.homeGoals], [row.awayEntityRef, row.homeEntityRef, row.awayGoals]]) {
    const eta = parameters.intercept + parameters.attack[index.get(own)] + parameters.defense[index.get(other)];
    let constant = 0; for (let k = 2; k <= score; k++) constant += Math.log(k);
    total += Math.exp(eta) - score * eta + constant;
  }
  return total / (2 * artifact.trainingRows.length) + artifact.config.regularization
    * [...parameters.attack, ...parameters.defense].reduce((sum, x) => sum + x * x, 0) / (2 * artifact.entities.length);
}
function fixedMathSnapshot(sourceText, foreign = false) {
  const filename = require.resolve('../scripts/zeroMarketResearchBaseline.cjs'), RealDate = Date;
  let fixedNow = Date.parse('2026-01-02T00:00:00.000Z');
  class FixedResearchDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Date: FixedResearchDate, structuredClone };
  vm.runInNewContext(sourceText, sandbox, { filename });
  const baseline = sandbox.module.exports, sample = input();
  sample.source.observedAt = '2026-01-01T00:00:00.000Z';
  sample.source.formatKnownAt = '2026-01-01T00:00:01.000Z';
  sample.approval.reviewedAt = '2026-01-01T00:00:02.000Z';
  sample.rows.forEach(row => { row.knownAt = '2026-01-01T00:00:03.000Z'; });
  sample.approval.approvedInputHash = baseline.researchInputHash(sample);
  const foreignJson = value => vm.runInNewContext('JSON.parse(text)', { text: JSON.stringify(value) });
  const fitted = baseline.fitZeroMarketResearch(foreign ? foreignJson(sample) : sample);
  assert.equal(fitted.status, 'research-fitted');
  assert.equal(baseline.verifyResearchArtifact(fitted.artifact), true);
  fixedNow += 1000;
  const request = eventRequest(fitted.artifact, { eventVersion: '2026-01-03T00:00:00.000Z',
    cutoffAt: '2026-01-02T22:00:00.000Z', sourceNominalDate: '2026-01-03',
    observedAt: '2026-01-02T00:00:00.100Z', knownAt: '2026-01-02T00:00:00.900Z' });
  request.approval.reviewedAt = '2026-01-02T00:00:00.500Z';
  const predicted = baseline.forecastZeroMarketResearch(foreign ? foreignJson(request) : request);
  assert.equal(predicted.status, 'research-frozen');
  return { artifactHash: fitted.artifact.contentHash, parametersHash: fitted.artifact.parametersHash,
    forecastHash: predicted.forecast.contentHash, predictionHash: predicted.forecast.predictionHash,
    gridHash: baseline.hash(predicted.forecast.grid) };
}

test('explicit metadata default is blocked even when labels and entities look complete', () => {
  for (const change of [v => delete v.approval, v => { v.approval.approved = false; },
    v => { v.approval.scope = 'historical-backtest'; }, v => { v.approval.sourceEntityMapApproved = false; }]) {
    const v = input(); change(v);
    const out = m.fitZeroMarketResearch(v);
    assert.equal(out.status, 'blocked'); assert.equal(out.artifact, null); assert.equal(out.p, null);
  }
});
test('source hash, CC0, known-at and partial-coverage approval are mandatory', () => {
  for (const change of [v => { v.source.license = 'unknown'; }, v => { v.source.rawSha256 = ''; },
    v => { v.source.formatKnownAt = new Date(Date.now() + 30000).toISOString(); },
    v => { v.approval.partialCoverageAccepted = false; }, v => { v.source.completeCompetitionHistory = true; }]) {
    const v = input(); change(v); reapprove(v); assert.equal(m.fitZeroMarketResearch(v).status, 'blocked');
  }
});
test('market and factor fields are rejected at input depth instead of ignored', () => {
  for (const [key, value] of [['odds', 1.3], ['marketProbability', 0.6], ['SP', 1.3], ['injuries', []]]) {
    const v = input(); v.rows[0][key] = value; reapprove(v);
    const out = m.fitZeroMarketResearch(v); assert.equal(out.status, 'blocked');
    assert.ok(out.reasons.includes('input-schema-or-market-field-forbidden'));
  }
});
test('no normalized-name fallback, missing neutral=>false, historical clock or inferred end time', () => {
  for (const change of [v => { delete v.entities[0].entityRef; }, v => { v.rows[0].homeEntityRef = 'alpha'; },
    v => { delete v.rows[0].neutral; }, v => { v.rows[0].neutral = false; },
    v => { v.rows[0].historicalAsOf = '2000-01-01T00:00:00Z'; }, v => { v.rows[0].actualEndedAt = '2000-01-01T01:30:00Z'; }]) {
    const v = input(); change(v); reapprove(v); assert.equal(m.fitZeroMarketResearch(v).status, 'blocked');
  }
});
test('duplicate IDs, duplicate source event tuples, unknown/unobserved entities and future dates fail', () => {
  for (const change of [v => { v.rows.push(copy(v.rows[0])); },
    v => { const r = copy(v.rows[0]); r.sourceRecordRef += '-different-line'; v.rows.push(r); },
    v => { v.rows[0].awayEntityRef = namespace + '#research-entity/99'; },
    v => { v.entities.push({ namespace, entityRef: namespace + '#research-entity/5', literalName: 'unobserved' }); },
    v => { v.rows[0].sourceNominalDate = '2099-01-01'; }]) {
    const v = input(); change(v); reapprove(v); assert.equal(m.fitZeroMarketResearch(v).status, 'blocked');
  }
});
test('nanosecond knowledge after the inspection clock is not rounded into available evidence', () => {
  const v = input(), boundary = '2026-10-07T06:00:00.000000100Z';
  v.rows[0].knownAt = '2026-10-07T06:00:00.000000101Z'; reapprove(v);
  // Move all acquisition/approval clocks to genuinely earlier synthetic boundaries.
  v.source.observedAt = '2026-10-07T05:00:00Z'; v.source.formatKnownAt = '2026-10-07T05:01:00Z';
  v.approval.reviewedAt = '2026-10-07T05:02:00Z';
  for (let i = 1; i < v.rows.length; i++) v.rows[i].knownAt = '2026-10-07T05:03:00Z'; reapprove(v);
  assert.equal(m.inspectResearchAdmission(v, boundary).status, 'blocked');
});
test('bounded regularized Poisson fitting lowers real objective and learns attack/defense without home term', () => {
  const v = input(), original = copy(v), out = m.fitZeroMarketResearch(v);
  assert.equal(out.status, 'research-fitted'); const a = out.artifact;
  assert.ok(a.optimization.completedIterations > 0);
  assert.ok(a.optimization.finalObjective < a.optimization.initialObjective - 0.02);
  assert.ok(a.parameters.attack[0] > a.parameters.attack[3]);
  assert.ok(a.parameters.defense[3] > a.parameters.defense[0]);
  assert.ok(Math.abs(a.parameters.attack.reduce((s, x) => s + x, 0)) < 1e-9);
  assert.ok(Math.abs(a.parameters.defense.reduce((s, x) => s + x, 0)) < 1e-9);
  assert.equal(a.parameters.homeAdvantage, 0); assert.equal(a.neutralEvidence, null);
  assert.equal(a.historicalBacktestAllowed, false); assert.equal(a.accuracyMeasured, false);
  assert.equal(m.verifyResearchArtifact(a), true); assert.deepEqual(v, original);
});
test('source order does not alter parameter mathematics or approval binding', () => {
  const a = input(), b = copy(a); b.rows.reverse(); b.entities.reverse();
  assert.equal(m.researchInputHash(a), m.researchInputHash(b));
  const aa = m.fitZeroMarketResearch(a).artifact, bb = m.fitZeroMarketResearch(b).artifact;
  assert.deepEqual(aa.parameters, bb.parameters); assert.deepEqual(aa.optimization, bb.optimization);
});
test('constant-label synthetic likelihood optimum matches mean goals rather than an odds prior', () => {
  const v = input(); for (const r of v.rows) { r.homeGoals = 2; r.awayGoals = 2; } reapprove(v);
  const a = m.fitZeroMarketResearch(v).artifact;
  assert.ok(Math.abs(Math.exp(a.parameters.intercept) - 2) < 1e-12);
  assert.ok(a.parameters.attack.every(x => Math.abs(x) < 1e-12));
  assert.ok(a.parameters.defense.every(x => Math.abs(x) < 1e-12));
});
test('finite-grid Poisson mass and marginals match analytical symmetric and handicap identities', () => {
  const g = m.goalGrid(1, 1, 16, -1);
  assert.ok(Math.abs(g.had.H - g.had.A) < 1e-12);
  assert.ok(Math.abs(g.had.H + g.had.D + g.had.A - 1) < 1e-12);
  assert.ok(Math.abs(g.hhad.probabilities.H + g.hhad.probabilities.D + g.hhad.probabilities.A - 1) < 1e-12);
  assert.ok(Math.abs(g.cells.find(c => c.home === 0 && c.away === 0).rawProbability - Math.exp(-2)) < 1e-15);
  const winByOne = g.cells.filter(c => c.home - c.away === 1).reduce((s, c) => s + c.probability, 0);
  assert.ok(Math.abs(winByOne - g.hhad.probabilities.D) < 1e-12);
  assert.equal(g.primary, null); assert.equal(g.companion, null);
});
test('truncation loss is visible instead of renormalization concealing it; top3 is global grid order', () => {
  const narrow = m.goalGrid(5, 4, 4, 2), broad = m.goalGrid(5, 4, 30, 2);
  assert.ok(narrow.tailMass > 0.1); assert.ok(broad.tailMass < 1e-10);
  assert.ok(Math.abs(narrow.rawMass + narrow.tailMass - 1) < 1e-12);
  assert.equal(narrow.probabilityBasis, 'conditional-on-finite-grid-support');
  assert.ok(Math.abs(narrow.cells.reduce((s, c) => s + c.rawProbability, 0) - narrow.rawMass) < 1e-12);
  assert.deepEqual(narrow.top3, [...narrow.cells].sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away).slice(0, 3));
});
test('numerical helper rejects unsafe rate/grid/handicap domains and permits the zero-goal limiting distribution', () => {
  for (const args of [[-1, 1, 16, 0], [13, 1, 16, 0], [NaN, 1, 16, 0], [1, 1, 10000, 0], [1, 1, 16, 0.5]])
    assert.throws(() => m.goalGrid(...args), /numerical-domain-invalid/);
  const zero = m.goalGrid(0, 0, 4, -1);
  assert.deepEqual(zero.had, { H: 0, D: 1, A: 0 });
  assert.deepEqual(zero.hhad.probabilities, { H: 0, D: 0, A: 1 });
  assert.equal(zero.rawMass, 1); assert.equal(zero.tailMass, 0);
});
test('actual forecast freezes one grid, stays research and is symmetric to swapped team roles', async () => {
  const a = fit(); await pause();
  const r = eventRequest(a), out = m.forecastZeroMarketResearch(r);
  assert.equal(out.status, 'research-frozen', JSON.stringify(out.reasons));
  assert.equal(out.forecast.neutral, null); assert.equal(out.forecast.homeAdvantage, 0);
  assert.equal(out.primary, null); assert.equal(out.companion, null);
  assert.equal(out.forecast.formalEligible, false); assert.equal(out.forecast.marketComparator, null);
  assert.deepEqual(Object.values(out.forecast.factors), [null, null, null, null, null]);
  const swapped = eventRequest(a, { homeEntityRef: r.event.awayEntityRef, awayEntityRef: r.event.homeEntityRef,
    homeTeamId: r.event.awayTeamId, awayTeamId: r.event.homeTeamId });
  const s = m.forecastZeroMarketResearch(swapped);
  assert.equal(s.status, 'research-frozen');
  assert.ok(Math.abs(out.lambda.home - s.lambda.away) < 1e-12);
  assert.ok(Math.abs(out.lambda.away - s.lambda.home) < 1e-12);
});
test('future events require explicit source-alias/time review even with a valid fitted model', async () => {
  const a = fit(); await pause();
  for (const change of [r => { delete r.approval; }, r => { r.approval.sourceAliasApproved = false; },
    r => { r.approval.sourceTimezoneMappingApproved = false; }, r => { r.approval.orderedEntityRefs.reverse(); },
    r => { r.event.neutral = false; }, r => { r.event.homeEntityRef = 'alpha'; },
    r => { r.event.saleStatus = 'UNKNOWN'; }]) {
    const r = eventRequest(a); change(r); assert.equal(m.forecastZeroMarketResearch(r).status, 'blocked');
  }
});
test('passed sales cutoff, started match, future knowledge, caller forecast clock and odds are rejected', async () => {
  const a = fit(); await pause();
  for (const change of [r => { r.event.cutoffAt = isoAgo(200); }, r => { r.event.status = 'LIVE'; },
    r => { r.event.knownAt = new Date(Date.now() + 10000).toISOString(); }, r => { r.asOf = '2000-01-01T00:00:00Z'; },
    r => { r.event.odds = { H: 1.2 }; }]) {
    const r = eventRequest(a); change(r); assert.equal(m.forecastZeroMarketResearch(r).status, 'blocked');
  }
});
test('model clock must precede actual forecast; recomputed outer hash cannot mask approval/input mutation', async () => {
  const a = fit(); await pause();
  const bad = copy(a); bad.trainingRows[0].homeGoals++; bad.trainingRowsHash = hash(bad.trainingRows);
  reseal(bad);
  assert.equal(m.verifyResearchArtifact(bad), false);
  assert.equal(m.forecastZeroMarketResearch(eventRequest(bad)).status, 'blocked');
  const future = copy(a); future.fitCompletedAt = future.availableAt = future.createdAt = new Date(Date.now() + 10000).toISOString();
  reseal(future);
  assert.equal(m.forecastZeroMarketResearch(eventRequest(future)).status, 'blocked');
});
test('parameter effects and index ordering remain bound to labels after outer resealing', () => {
  const a = fit();
  const wrongEffects = copy(a); wrongEffects.parameters.attack[0] += 0.2; wrongEffects.parameters.attack[1] -= 0.2;
  wrongEffects.parametersHash = hash(wrongEffects.parameters);
  reseal(wrongEffects);
  assert.equal(m.verifyResearchArtifact(wrongEffects), false, 'recorded objective must replay against source labels');
  const wrongIndex = copy(a); wrongIndex.entities.reverse();
  reseal(wrongIndex);
  assert.equal(m.verifyResearchArtifact(wrongIndex), false, 'canonical source-ref parameter index must stay fixed');
});
test('same training event is blocked using source record or independently ordered source tuple', async () => {
  const a = fit(); await pause(); const row = a.trainingRows[0];
  for (const event of [{ sourceEventRef: row.sourceRecordRef },
    { sourceNominalDate: row.sourceNominalDate, homeEntityRef: row.homeEntityRef, awayEntityRef: row.awayEntityRef }]) {
    const out = m.forecastZeroMarketResearch(eventRequest(a, event));
    assert.equal(out.status, 'blocked'); assert.ok(out.reasons.includes('current-event-in-training'));
  }
});
test('malformed/null records and missing clocks fail closed without any artifact or implicit zero score', () => {
  for (const value of [null, {}, { source: null, entities: [null], rows: [null] }]) {
    const out = m.fitZeroMarketResearch(value); assert.equal(out.status, 'blocked'); assert.equal(out.artifact, null);
  }
  const v = input(); v.rows[0].homeGoals = null; reapprove(v);
  assert.equal(m.fitZeroMarketResearch(v).status, 'blocked');
});
test('full optimizer replay rejects fabricated likelihood reports and never-trained initializer after resealing', () => {
  const a = fit();
  const forged = copy(a); forged.parameters.intercept = Math.log(4);
  forged.parameters.attack.fill(0); forged.parameters.defense.fill(0); forged.parametersHash = hash(forged.parameters);
  forged.optimization.initialObjective = 1000; forged.optimization.finalObjective = independentObjective(forged);
  forged.optimization.algorithm = 'never-ran'; forged.optimization.completedIterations = 999999;
  forged.optimization.finalGradientNorm = 0; forged.optimization.finalProjectedGradientNorm = 0;
  forged.optimization.converged = true; reseal(forged);
  assert.equal(m.verifyResearchArtifact(forged), false);
  assert.equal(m.forecastZeroMarketResearch(eventRequest(forged)).status, 'blocked');
  const initial = copy(a), mean = initial.trainingRows.reduce((s, r) => s + r.homeGoals + r.awayGoals, 0) / (2 * initial.trainingRows.length);
  initial.parameters.intercept = Math.log(mean); initial.parameters.attack.fill(0); initial.parameters.defense.fill(0);
  initial.parametersHash = hash(initial.parameters); initial.optimization.finalObjective = independentObjective(initial);
  initial.optimization.completedIterations = 0; initial.optimization.converged = true;
  initial.optimization.finalGradientNorm = 0; initial.optimization.finalProjectedGradientNorm = 0;
  initial.optimization.stopReason = 'projected-kkt-converged'; reseal(initial);
  assert.equal(m.verifyResearchArtifact(initial), false);
});
test('optimizer report, required complete config, parameter keys and honest authority flags cannot be rewritten', () => {
  const a = fit();
  const mutations = [v => { delete v.config; }, v => { v.config = {}; }, v => { v.odds = { H: 1.2 }; },
    v => { v.parameters.extra = 0; v.parametersHash = hash(v.parameters); },
    v => { v.optimization.initialObjective += 10; }, v => { v.optimization.completedIterations = 999999; },
    v => { v.optimization.converged = !v.optimization.converged; }, v => { v.optimization.finalGradientNorm = 0; },
    v => { v.optimization.stopReason = 'made-up'; }, v => { v.invariants.publisherWrites = 1; },
    v => { v.canonicalAdmission = true; }, v => { v.trustedOfficial90Minute = true; },
    v => { v.accuracyMeasured = true; }, v => { v.calibrationMeasured = true; }, v => { v.hitRate = 0.9; }];
  for (const change of mutations) { const bad = copy(a); change(bad); reseal(bad); assert.equal(m.verifyResearchArtifact(bad), false); }
});
test('cyclic, sparse, getter, excessively nested and invalid-clock inputs fail closed without throwing', () => {
  const circular = input(); circular.loop = circular;
  assert.equal(m.fitZeroMarketResearch(circular).status, 'blocked');
  const cyclicArtifact = fit(); cyclicArtifact.loop = cyclicArtifact;
  assert.equal(m.verifyResearchArtifact(cyclicArtifact), false);
  assert.equal(m.forecastZeroMarketResearch({ artifact: cyclicArtifact, event: {}, approval: {} }).status, 'blocked');
  assert.equal(m.inspectResearchAdmission(input(), null).status, 'blocked');
  const sparse = input(); delete sparse.rows[0]; assert.equal(m.fitZeroMarketResearch(sparse).status, 'blocked');
  const getter = input(); Object.defineProperty(getter, 'untrustedGetter', { enumerable: true, get() { throw Error('must-not-execute'); } });
  assert.equal(m.fitZeroMarketResearch(getter).status, 'blocked');
  const nested = input(); let child = nested; for (let k = 0; k < 40; k++) child = child.extra = {};
  assert.equal(m.fitZeroMarketResearch(nested).status, 'blocked');
});
test('array subclasses and native prototype overrides fail before untrusted method dispatch', () => {
  let dispatches = 0;
  class BadArray extends Array { some() { dispatches++; throw Error('must-not-dispatch'); } }
  const v = input(); v.rows = BadArray.from(v.rows);
  assert.equal(m.fitZeroMarketResearch(v).status, 'blocked'); assert.equal(dispatches, 0);
  const artifact = fit(); artifact.trainingRows = BadArray.from(artifact.trainingRows);
  assert.equal(m.verifyResearchArtifact(artifact), false); assert.equal(dispatches, 0);
  const overridden = vm.runInNewContext('const value = JSON.parse(text); Array.prototype.some = function some() { throw Error("must-not-dispatch"); }; value', { text: JSON.stringify(input()) });
  assert.equal(m.fitZeroMarketResearch(overridden).status, 'blocked');
});
test('prototype constructor accessors are rejected without dispatch at all research boundaries', () => {
  let dispatches = 0;
  const prototype = Object.create(null);
  Object.defineProperty(prototype, 'constructor', { configurable: true, get() { dispatches++; throw Error('must-not-dispatch'); } });
  const request = input(); Object.setPrototypeOf(request, prototype);
  assert.equal(m.fitZeroMarketResearch(request).status, 'blocked');
  const nested = input(); Object.setPrototypeOf(nested.rows[0], prototype);
  assert.equal(m.inspectResearchAdmission(nested).status, 'blocked');
  const artifact = fit(); Object.setPrototypeOf(artifact.parameters, prototype);
  assert.equal(m.verifyResearchArtifact(artifact), false);
  const forecast = eventRequest(fit()); Object.setPrototypeOf(forecast.event, prototype);
  assert.equal(m.forecastZeroMarketResearch(forecast).status, 'blocked');
  assert.equal(dispatches, 0);
});
test('foreign array constructor and callable source accessors cannot dispatch or spoof native admission', () => {
  let dispatches = 0;
  const rows = vm.runInNewContext('const value=JSON.parse(text); Object.defineProperty(Object.prototype,"constructor", {get(){dispatch(); throw Error("must-not-dispatch");}}); value',
    { text: JSON.stringify(input().rows), dispatch: () => { dispatches++; } });
  const request = input(); request.rows = rows;
  assert.equal(m.fitZeroMarketResearch(request).status, 'blocked');
  const spoofed = vm.runInNewContext('const value=JSON.parse(text); Array.prototype.some=function some(){dispatch(); throw Error("must-not-dispatch");}; Object.defineProperty(Array.prototype.some,"toString", {get(){dispatch(); throw Error("must-not-inspect-input-source");}}); value',
    { text: JSON.stringify(input()), dispatch: () => { dispatches++; } });
  assert.equal(m.fitZeroMarketResearch(spoofed).status, 'blocked');
  assert.equal(dispatches, 0);
});
test('array own keys must be contiguous indices even when a hole is offset by a named property', () => {
  const v = input(); delete v.rows[0]; v.rows.extra = v.rows[1];
  assert.equal(Object.keys(v.rows).length, v.rows.length, 'adversary preserves naive count');
  assert.equal(m.fitZeroMarketResearch(v).status, 'blocked');
  const artifact = fit(); delete artifact.parameters.attack[0]; artifact.parameters.attack.extra = 0;
  assert.equal(m.verifyResearchArtifact(artifact), false);
});
test('genuine cross-realm native arrays remain admitted and complete deterministic fit replay', () => {
  const v = vm.runInNewContext('JSON.parse(text)', { text: JSON.stringify(input()) });
  assert.equal(Array.isArray(v.rows), true); assert.notEqual(Object.getPrototypeOf(v.rows), Array.prototype);
  assert.equal(m.inspectResearchAdmission(v).status, 'research-metadata-admitted');
  const fitted = m.fitZeroMarketResearch(v); assert.equal(fitted.status, 'research-fitted');
  const crossArtifact = vm.runInNewContext('JSON.parse(text)', { text: JSON.stringify(fitted.artifact) });
  assert.equal(m.verifyResearchArtifact(crossArtifact), true);
});
test('host and foreign native JSON preserve the original fixed-clock fit and forecast hashes', () => {
  const source = fs.readFileSync(require.resolve('../scripts/zeroMarketResearchBaseline.cjs'), 'utf8');
  // Pinned from the pre-inspector implementation using these synthetic labels and exact clocks.
  const expected = { artifactHash: '04d93fd13826e22112019bf8d109e9c92ae46fb59f8395d122d51dcf81704fd3',
    parametersHash: '5b21f54cc39d2669f9a7b8933ff8f1b221a2afd0a75b9eeb88609e14316dc8dd',
    forecastHash: '951d13d8d715948db5aa5ffc892d5b099c7b664552c8ac00dffc6fef3ea834ff',
    predictionHash: '06d11207047484787194085be32cd724bbaae360bf68339628f33aaee7834b27',
    gridHash: 'b974a063079e53a07f6a5271549cbad167d9d9033f775ee4607e5c9e18a51932' };
  assert.deepEqual(fixedMathSnapshot(source), expected);
  assert.deepEqual(fixedMathSnapshot(source, true), expected);
});
test('box-constrained optimum retains feasible intercept progress and satisfies independent local direction checks', () => {
  const v = input(); v.config = { iterations: 2000, maxAbsGoalEffect: 0.2 };
  const out = m.fitZeroMarketResearch(v); assert.equal(out.status, 'research-fitted'); const a = out.artifact;
  assert.equal(a.optimization.converged, true); assert.equal(a.optimization.lineSearchStopped, false);
  assert.ok(a.optimization.completedIterations > 12);
  assert.ok(a.optimization.finalObjective < 1.5062311667190391 - 1e-4, 'improves on independently documented feasible counterexample');
  assert.ok(a.optimization.finalProjectedGradientNorm < a.config.gradientTolerance);
  assert.ok(a.optimization.finalGradientNorm > a.optimization.finalProjectedGradientNorm, 'active constraints use KKT mapping instead of demanding raw zero gradient');
  const base = independentObjective(a), epsilon = 1e-4;
  for (const sign of [-1, 1]) { const p = copy(a.parameters); p.intercept += sign * epsilon; assert.ok(independentObjective(a, p) >= base - 1e-9); }
  for (const key of ['attack', 'defense']) for (let i = 0; i < a.entities.length; i++) for (let j = 0; j < a.entities.length; j++) {
    if (i === j) continue; const p = copy(a.parameters); p[key][i] += epsilon; p[key][j] -= epsilon;
    if (p[key].some(x => Math.abs(x) > 0.2)) continue;
    assert.ok(independentObjective(a, p) >= base - 1e-9, 'no feasible local pair direction improves objective');
  }
});
test('a valid bounded fit that exhausts its budget remains diagnostic and cannot freeze', async () => {
  const v = input(); v.config = { iterations: 20, gradientTolerance: 1e-10 };
  const out = m.fitZeroMarketResearch(v); assert.equal(out.status, 'research-fitted');
  assert.equal(out.artifact.optimization.converged, false); assert.equal(m.verifyResearchArtifact(out.artifact), true);
  await pause(); const predicted = m.forecastZeroMarketResearch(eventRequest(out.artifact));
  assert.equal(predicted.status, 'blocked'); assert.ok(predicted.reasons.includes('research-fit-not-converged'));
});
test('freeze rechecks the actual completion clock so crossing the cutoff during replay cannot publish', async () => {
  const artifact = fit(); await pause(); const request = eventRequest(artifact);
  const start = Date.now(), finish = start + 10;
  request.event.cutoffAt = new Date(start + 1).toISOString(); request.approval.cutoffAt = request.event.cutoffAt;
  request.approval.approvedEventHash = hash(request.event);
  const RealDate = Date; let calls = 0;
  class SequentialDate extends RealDate { constructor(...args) { super(...(args.length ? args : [calls++ === 0 ? start : finish])); } }
  const filename = require.resolve('../scripts/zeroMarketResearchBaseline.cjs');
  const sandbox = { module: { exports: {} }, require: createRequire(filename), Date: SequentialDate, structuredClone };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const out = sandbox.module.exports.forecastZeroMarketResearch(request);
  assert.equal(out.status, 'blocked', JSON.stringify(out.reasons));
  assert.ok(out.reasons.includes('actual-freeze-clock-regressed-or-at-after-cutoff'));
});
