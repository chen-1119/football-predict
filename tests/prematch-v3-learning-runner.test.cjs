'use strict';

// Synthetic CLI fixtures validate workflow/integrity only. Their results are
// not real match accuracy, formal evidence, or permission to publish a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const team = require('../src/services/prematchTeamEvidenceV3.cjs');
const learner = require('../src/services/prematchV3Learning.cjs');
const runner = require('../scripts/runPrematchV3Learning.cjs');
const repo = path.resolve(__dirname, '..'), cli = path.join(repo, 'scripts/runPrematchV3Learning.cjs');
const FEATURE = 'home.roster.confirmed.attackReplacementGapPer90', FATIGUE = 'away.fatigue.restDays';
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const tagHash = tag => stableHash({ synthetic: tag });
const stamp = value => { const { contentHash, ...body } = value; return { ...body, contentHash: stableHash(body) }; };
function request() {
  const days = [1, 2, 3, 4].map(day => `2026-09-0${day}`);
  const records = days.flatMap((date, day) => Array.from({ length: 4 }, (_, index) => {
    const sourceMatchId = `synthetic-cli-${day}-${index}`, depleted = index % 2 === 1;
    const event = { sourceMatchId, eventVersion: `${date}T12:00:00.000Z`, cutoffAt: `${date}T11:00:00.000Z`,
      homeTeamId: 'cli-home', awayTeamId: 'cli-away' };
    const result = stamp({ regulationMinutes: 90, confirmation: 'research-confirmed-90min',
      source: 'sporttery:official-api', sourceHash: tagHash(`result-${sourceMatchId}`),
      observedAt: `${date}T14:00:00.000Z`, receivedAt: `${date}T14:01:00.000Z`,
      match: { ...event, kickoffTime: event.eventVersion, status: 'FINISHED',
        scoreHome: depleted ? 0 : 3, scoreAway: depleted ? 3 : 0,
        resultSource: 'sporttery:official-api', sourceUrl: 'https://webapi.sporttery.cn/synthetic-cli-result' } });
    const record = { version: learner.RECORD_VERSION, frozen: true, event, asOf: `${date}T10:00:00.000Z`,
      frozenAt: `${date}T10:00:00.000Z`, featureKnownAt: `${date}T09:59:00.000Z`,
      featureSchemaHash: team.FEATURE_SCHEMA_HASH, featureSnapshotHash: tagHash(`features-${sourceMatchId}`),
      featureVector: { [FEATURE]: Number(depleted), [FATIGUE]: depleted ? 5 : 1 },
      baseRates: { home: 1, away: 1 }, baseRatesEvidence: { kind: 'zero-market-team-strength', marketIncluded: false,
        artifactHash: tagHash('synthetic-base'), trainedThrough: '2026-08-01T12:00:00.000Z', availableAt: '2026-08-02T12:00:00.000Z' },
      market: { source: 'synthetic-cli-market', sourceHash: tagHash(`market-${sourceMatchId}`),
        asOf: `${date}T10:00:00.000Z`, observedAt: `${date}T09:58:00.000Z`, receivedAt: `${date}T09:59:00.000Z`,
        probabilities: { '1': 0.4, X: 0.25, '2': 0.35 } }, result };
    record.predictionHash = learner.predictionRecordHash(record);
    return stamp(record);
  }));
  return { version: runner.REQUEST_VERSION, researchOnly: true, synthetic: true,
    accuracyEvidence: false, records, featureSchema: team.FEATURE_SCHEMA, featureNames: [FEATURE, FATIGUE],
    split: { trainDays: days.slice(0, 2), calibrationDays: days.slice(2, 3), testDays: days.slice(3) } };
}
function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prematch-v3-learning-cli-'));
  t.after(() => {
    const resolved = path.resolve(directory), root = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(root));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const input = path.join(directory, 'new-v3-research-request.json'), output = path.join(directory, 'new-shadow-learning-report.json');
  return { directory, input, output };
}
function execute(input, output, extra = []) {
  return cp.spawnSync(process.execPath, [cli, '--input', input, '--output', output, ...extra],
    { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

test('CLI fits explicit synthetic V3 records, emits all four test metrics, and binds actual input/code/runtime receipts', t => {
  const { input, output } = sandbox(t), value = request();
  fs.writeFileSync(input, JSON.stringify(value, null, 2) + '\n');
  const original = fs.readFileSync(input), before = Date.now(), result = execute(input, output), after = Date.now();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  const summary = JSON.parse(result.stdout), report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(summary.status, 'shadow-candidate'); assert.equal(summary.formalEligible, false);
  assert.equal(report.version, runner.VERSION); assert.equal(report.registryStatus, 'not-registered');
  assert.equal(report.formalEligible, false); assert.equal(report.productionEligible, false);
  assert.equal(report.activeModelPublished, false); assert.equal(report.learning.originalDeployment, false);
  assert.equal(report.input.sha256, bytesHash(original)); assert.equal(report.input.requestContentHash, stableHash(value));
  assert.deepEqual(fs.readFileSync(input), original);
  assert.ok(Date.parse(report.fitStartedAt) >= before && Date.parse(report.fitCompletedAt) <= after);
  assert.equal(report.actualFittedAt, report.fitCompletedAt);
  assert.equal(report.learning.artifact.createdAt, report.fitCompletedAt);
  assert.equal(report.learning.artifact.availableAt, report.fitCompletedAt);
  assert.equal(report.learning.artifact.trainedThrough, '2026-09-02T14:01:00.000Z');
  assert.equal(report.implementation.nodeMajor, 22); assert.equal(report.implementation.nodeVersion, process.version);
  for (const file of runner.IMPLEMENTATION_FILES) assert.equal(report.implementation.files[file], bytesHash(fs.readFileSync(path.join(repo, file))));
  const { contentHash, ...body } = report;
  assert.equal(stableHash(body), contentHash); assert.equal(summary.contentHash, contentHash);
  const artifact = report.learning.artifact, { contentHash: artifactHash, ...artifactBody } = artifact;
  assert.equal(artifactHash, stableHash(artifactBody)); assert.equal(summary.parameterArtifactHash, artifactHash);
  for (const row of [...report.learning.validation.rows, ...report.learning.calibration.rows]) assert.equal(row.parameterArtifactHash, artifactHash);
  for (const name of ['candidate', 'baseline', 'marketOnly', 'hybrid']) {
    assert.equal(report.learning.validation.metrics[name].rows, 4);
    assert.ok(Number.isFinite(report.learning.validation.metrics[name].brier));
    assert.ok(Number.isFinite(report.learning.validation.metrics[name].logLoss));
  }
  const evaluated = learner.evaluatePrematchV3Records({ records: value.records, artifact,
    asOf: report.fitCompletedAt, testDays: value.split.testDays });
  assert.equal(evaluated.status, 'shadow-evaluated');
  assert.deepEqual(evaluated.validation.metrics, report.learning.validation.metrics);
  assert.deepEqual(report.invariants, { inputChanged: false, originalPredictionsChanged: false,
    registryWrites: 0, productionWrites: 0, datasetWrites: 0, modelPointerWrites: 0 });
});

test('no independent training/test records produces a new blocked report without probabilities or invented artifact', t => {
  const { input, output } = sandbox(t), value = request(); value.records = []; delete value.split;
  fs.writeFileSync(input, JSON.stringify(value));
  const result = execute(input, output); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.status, 'blocked'); assert.equal(report.learning.artifact, null);
  assert.equal(report.learning.probabilities, null); assert.equal(report.learning.rates, null);
  assert.equal(JSON.parse(result.stdout).parameterArtifactHash, null);
  assert.equal(report.registryStatus, 'not-registered'); assert.equal(report.formalEligible, false);
});

test('output is append-only and cannot overwrite the input or an existing report', t => {
  const { input, output } = sandbox(t); fs.writeFileSync(input, JSON.stringify(request()));
  fs.writeFileSync(output, 'preserve-existing-output\n');
  const first = execute(input, output); assert.notEqual(first.status, 0);
  assert.match(first.stderr, /NEW_OUTPUT_REQUIRED/); assert.equal(fs.readFileSync(output, 'utf8'), 'preserve-existing-output\n');
  const bytes = fs.readFileSync(input), second = execute(input, input);
  assert.notEqual(second.status, 0); assert.match(second.stderr, /INPUT_OVERWRITE_FORBIDDEN/);
  assert.deepEqual(fs.readFileSync(input), bytes);
});

test('historical/future --as-of and caller-supplied fit clocks cannot backdate candidate availability', t => {
  const { input, output } = sandbox(t); fs.writeFileSync(input, JSON.stringify(request()));
  for (const asOf of ['2026-09-01T10:00:00Z', '2099-01-01T00:00:00Z', 'unparsed']) {
    const result = execute(input, output, ['--as-of', asOf]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /V3_LEARNING_ARGS/); assert.equal(fs.existsSync(output), false);
  }
  for (const key of ['asOf', 'createdAt', 'availableAt', 'fittedAt', 'clock']) {
    fs.writeFileSync(input, JSON.stringify({ ...request(), [key]: '2026-09-01T10:00:00Z' }));
    const result = execute(input, output);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /CALLER_FIT_CLOCK_FORBIDDEN/); assert.equal(fs.existsSync(output), false);
  }
});

test('legacy business-shaped files, invalid request kinds and old records cannot enter the research CLI', t => {
  const { input, output } = sandbox(t);
  for (const value of [{ matches: [] }, { ...request(), researchOnly: false },
    { ...request(), version: 'historical-business-dataset' }, { ...request(), records: [{ version: 'old-free-football-result' }] }]) {
    fs.writeFileSync(input, JSON.stringify(value)); const result = execute(input, output);
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(output), false);
    assert.match(result.stderr, /RESEARCH_REQUEST_REQUIRED|EXPLICIT_V3_RECORDS_REQUIRED/);
  }
});

test('invalid frozen hashes produce explicit exclusions and block instead of fitting an unverified request', t => {
  const { input, output } = sandbox(t), value = request();
  value.records.forEach(record => { record.featureVector[FEATURE] = 0.33; });
  fs.writeFileSync(input, JSON.stringify(value));
  const result = execute(input, output); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.status, 'blocked'); assert.equal(report.learning.artifact, null);
  assert.equal(report.learning.coverage.exclusionReasons['record-hash-mismatch'], 16);
  assert.equal(report.learning.coverage.exclusionReasons['frozen-prediction-hash-mismatch'], 16);
});

test('malformed JSON and unsupported flags fail without output or leaking input contents', t => {
  const { input, output } = sandbox(t); fs.writeFileSync(input, '{synthetic-private-marker');
  const result = execute(input, output); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INPUT_JSON_INVALID/); assert.doesNotMatch(result.stderr, /synthetic-private-marker/);
  assert.equal(fs.existsSync(output), false);
  assert.throws(() => runner.parseArgs(['--input', input]), /ARGS/);
  assert.throws(() => runner.parseArgs(['--input', input, '--input', input, '--output', output]), /ARGS/);
  assert.throws(() => runner.parseArgs(['--scan-directory', repo, '--output', output]), /ARGS/);
});
