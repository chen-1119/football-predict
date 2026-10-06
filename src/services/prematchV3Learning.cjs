'use strict';

// Pure, offline research fitting. No datastore, synchronization, registry write,
// active-model pointer, or production calibration authorization is involved.
const { strictInstant } = require('./strictInstant.cjs');
const { stableHash } = require('./webConsensusEvidence.cjs');
const { scoreMatrix } = require('./goalDistribution.cjs');
const { isTrustedOfficialFinal } = require('./matchLifecycle.cjs');
const { DEFAULT_THRESHOLDS, REGISTRY_VERSION } = require('../../scripts/modelLearningRegistry.cjs');

const VERSION = 'prematch-v3-learning-v1';
const RECORD_VERSION = 'prematch-v3-learning-record-v1';
const PARAMETER_VERSION = 'prematch-team-parameters-v3';
const CODE_VERSION = VERSION;
const CODES = Object.freeze(['1', 'X', '2']);
const HASH = /^[a-f0-9]{64}$/;
const SIDES = Object.freeze(['home', 'away']);
const RESEARCH_FLOORS = Object.freeze({ trainingRows: 8, trainingDays: 2, testRows: 2, testDays: 1 });
const FIT_LIMITS = Object.freeze({ maxIterations: 500, maxLearningRate: 0.1, minRegularization: 0.05,
  maxRegularization: 10, maxAbsCoefficient: 0.3, maxAbsIntercept: 0.2, maxAbsLogShift: 0.35,
  minRate: 0.05, maxRate: 12, maxFeatureMagnitude: 100000, maxFeatures: 46 });
const COMPARATORS = Object.freeze({ hybridCandidateWeight: 0.5, hybridMarketWeight: 0.5,
  probabilityModel: 'independent-poisson-90min', tuning: 'none' });
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => { try { return stableHash(value); } catch { return null; } };
const hashBody = (value, field = 'contentHash') => {
  const body = { ...(value || {}) }; delete body[field]; return digest(body);
};
const bounded = (value, low, high) => finite(value) && value >= low && value <= high;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const clone = value => structuredClone(value);

// Keep nanoseconds: Date.parse alone treats distinct sub-millisecond clocks as
// equal and could accept knowledge arriving just after a prediction.
function instant(value) {
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9, '0'));
}
function predictionRecordHash(record) {
  const body = { ...(record || {}) };
  delete body.predictionHash; delete body.contentHash; delete body.result;
  return digest(body);
}
function canonicalEvent(event) {
  const at = instant(event?.eventVersion), cutoff = instant(event?.cutoffAt);
  if (!text(event?.sourceMatchId) || !text(event?.homeTeamId) || !text(event?.awayTeamId)
    || event.homeTeamId === event.awayTeamId || at === null || cutoff === null || cutoff > at) return null;
  return { sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
    homeTeamId: event.homeTeamId, awayTeamId: event.awayTeamId, cutoffAt: event.cutoffAt,
    eventId: `${event.sourceMatchId}|${new Date(Number(at / 1000000n)).toISOString()}`,
    // An entire Shanghai match day belongs to one split; caller labels cannot
    // move a later version of the same match into another split.
    matchDay: new Date(Number(at / 1000000n) + 8 * 3600000).toISOString().slice(0, 10) };
}
const vector = value => value && CODES.every(code => bounded(value[code], 0, 1))
  && Math.abs(CODES.reduce((sum, code) => sum + value[code], 0) - 1) <= 1e-10;
function schemaContext(options) {
  let schema = options.featureSchema;
  if (!schema) {
    try { schema = require('./prematchTeamEvidenceV3.cjs').FEATURE_SCHEMA; } catch { return null; }
  }
  const names = schema?.features;
  const schemaHash = digest(schema);
  const selected = options.featureNames || names?.filter(name => /\.(roster|injuries|fatigue)\./.test(name));
  if (!text(schema?.version) || !Array.isArray(names) || names.some(name => !text(name))
    || new Set(names).size !== names.length || !HASH.test(schemaHash || '')
    || (options.featureSchemaHash && options.featureSchemaHash !== schemaHash)
    || !Array.isArray(selected) || !selected.length || selected.length > FIT_LIMITS.maxFeatures
    || new Set(selected).size !== selected.length
    || selected.some(name => !names.includes(name) || !/^(home|away)\.(roster|injuries|fatigue)\./.test(name))) return null;
  return { schema: clone(schema), schemaHash, featureNames: [...selected].sort() };
}
function verifiedMarket(record) {
  const market = record?.market, asOf = instant(record?.asOf);
  const observed = instant(market?.observedAt), received = instant(market?.receivedAt);
  if (!text(market?.source) || !HASH.test(market?.sourceHash || '') || !vector(market?.probabilities)
    || instant(market?.asOf) !== asOf || observed === null || received === null
    || observed > received || received > asOf) return null;
  return clone(market.probabilities);
}
function validateRecord(record, context, evaluatedAt) {
  const reasons = [], event = canonicalEvent(record?.event);
  const predicted = instant(record?.asOf), frozen = instant(record?.frozenAt), featureAt = instant(record?.featureKnownAt);
  if (record?.version !== RECORD_VERSION || record?.frozen !== true) reasons.push('prediction-not-explicitly-frozen');
  if (!event) reasons.push('event-identity-or-cutoff-invalid');
  if (!HASH.test(record?.contentHash || '') || hashBody(record) !== record?.contentHash) reasons.push('record-hash-mismatch');
  if (!HASH.test(record?.predictionHash || '') || predictionRecordHash(record) !== record?.predictionHash) reasons.push('frozen-prediction-hash-mismatch');
  if (record?.featureSchemaHash !== context.schemaHash || !HASH.test(record?.featureSnapshotHash || '')) reasons.push('feature-schema-or-snapshot-hash-invalid');
  if (predicted === null || frozen === null || featureAt === null || frozen > predicted || featureAt > predicted
    || predicted > evaluatedAt || (event && predicted >= instant(event.cutoffAt))) reasons.push('prediction-or-feature-clock-invalid');
  if (record?.matchDay !== undefined && event && record.matchDay !== event.matchDay) reasons.push('match-day-identity-mismatch');
  const values = record?.featureVector;
  if (!values || context.featureNames.some(name => !bounded(values[name], -FIT_LIMITS.maxFeatureMagnitude, FIT_LIMITS.maxFeatureMagnitude))) reasons.push('selected-feature-unknown-or-invalid');
  const rates = record?.baseRates, base = record?.baseRatesEvidence;
  const baseAt = instant(base?.availableAt), trainedAt = instant(base?.trainedThrough);
  if (!SIDES.every(side => bounded(rates?.[side], FIT_LIMITS.minRate, 8))
    || base?.kind !== 'zero-market-team-strength' || base?.marketIncluded !== false
    || !HASH.test(base?.artifactHash || '') || baseAt === null || trainedAt === null
    || (baseAt !== null && trainedAt !== null && trainedAt > baseAt)
    || (predicted !== null && (baseAt > predicted || trainedAt >= predicted))
    || (event && Array.isArray(base?.trainingSourceMatchIds) && base.trainingSourceMatchIds.includes(event.sourceMatchId))) reasons.push('zero-market-base-rates-unverified');
  const result = record?.result, match = result?.match;
  const resultAt = instant(result?.observedAt), receivedAt = instant(result?.receivedAt);
  const goals = [match?.scoreHome, match?.scoreAway];
  if (result?.regulationMinutes !== 90 || result?.confirmation !== 'research-confirmed-90min'
    || !text(result?.source) || !HASH.test(result?.sourceHash || '') || result?.disputed === true
    || result?.voided === true || match?.resultDisposition === 'VOID' || match?.resultObservationFallback === true
    || !goals.every(goal => Number.isInteger(goal) && goal >= 0 && goal <= 20)
    || !isTrustedOfficialFinal(match)) reasons.push('90min-result-unknown-void-disputed-or-untrusted');
  if (!HASH.test(result?.contentHash || '') || hashBody(result) !== result?.contentHash) reasons.push('result-hash-mismatch');
  // An explicit fixture revision cannot mask a contradictory kickoff. Every
  // supplied anchor must be valid and name the frozen event at full precision.
  const resultAnchors = [match?.eventVersion, match?.kickoffTime].filter(value => value !== undefined);
  if (!event || match?.sourceMatchId !== event.sourceMatchId
    || !resultAnchors.length || resultAnchors.some(value => instant(value) === null || instant(value) !== instant(event?.eventVersion))
    || match?.homeTeamId !== event.homeTeamId || match?.awayTeamId !== event.awayTeamId) reasons.push('result-event-identity-mismatch');
  if (resultAt === null || receivedAt === null || resultAt > receivedAt || receivedAt > evaluatedAt
    || (event && resultAt < instant(event.eventVersion) + 90n * 60n * 1000000000n)) reasons.push('result-clock-invalid-or-future');
  return { record, event, reasons, knownAt: receivedAt, market: verifiedMarket(record) };
}
function prepareRecords(records, context, asOf) {
  const groups = new Map(), exclusions = [], eligible = [];
  for (const [index, record] of records.entries()) {
    const key = text(record?.event?.sourceMatchId) || `invalid-record:${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...validateRecord(record, context, asOf), index });
  }
  const exclude = (entry, reasons) => exclusions.push({ recordIndex: entry.index,
    sourceMatchId: entry.event?.sourceMatchId || text(entry.record?.event?.sourceMatchId),
    predictionHash: entry.record?.predictionHash || null, reasons: [...new Set(reasons)] });
  for (const entries of groups.values()) {
    const identities = new Set(entries.filter(entry => entry.event).map(entry => digest({
      sourceMatchId: entry.event.sourceMatchId, at: instant(entry.event.eventVersion).toString(),
      home: entry.event.homeTeamId, away: entry.event.awayTeamId, cutoff: instant(entry.event.cutoffAt).toString() })));
    const outcomes = new Set(entries.filter(entry => Number.isInteger(entry.record?.result?.match?.scoreHome)
      && Number.isInteger(entry.record?.result?.match?.scoreAway)).map(entry => `${entry.record.result.match.scoreHome}:${entry.record.result.match.scoreAway}`));
    const disputed = entries.some(entry => entry.record?.result?.disputed === true || entry.record?.result?.voided === true
      || ['VOID', 'CANCELLED', 'CANCELED', 'ABANDONED'].includes(entry.record?.result?.match?.status)
      || entry.record?.result?.match?.resultDisposition === 'VOID');
    if (identities.size > 1 || outcomes.size > 1 || disputed) {
      const reason = identities.size > 1 ? 'same-event-identity-conflict' : outcomes.size > 1 ? 'same-event-result-conflict' : 'same-event-void-or-disputed';
      entries.forEach(entry => exclude(entry, [reason, ...entry.reasons])); continue;
    }
    const valid = entries.filter(entry => !entry.reasons.length);
    entries.filter(entry => entry.reasons.length).forEach(entry => exclude(entry, entry.reasons));
    if (!valid.length) continue;
    valid.sort((a, b) => instant(a.record.asOf) < instant(b.record.asOf) ? -1
      : instant(a.record.asOf) > instant(b.record.asOf) ? 1 : a.record.predictionHash.localeCompare(b.record.predictionHash));
    const first = valid[0];
    const sameClock = valid.filter(entry => instant(entry.record.asOf) === instant(first.record.asOf));
    if (new Set(sameClock.map(entry => entry.record.predictionHash)).size > 1) {
      valid.forEach(entry => exclude(entry, ['same-clock-prediction-conflict'])); continue;
    }
    eligible.push(first);
    valid.slice(1).forEach(entry => exclude(entry, ['duplicate-event-version']));
  }
  eligible.sort((a, b) => a.event.matchDay.localeCompare(b.event.matchDay) || a.event.eventId.localeCompare(b.event.eventId));
  return { eligible, exclusions, inputRecordCount: records.length, independentEventCount: groups.size };
}
function chronologicalSplit(entries, requested) {
  const days = [...new Set(entries.map(entry => entry.event.matchDay))].sort();
  let split = requested;
  if (!split) {
    if (days.length < 4) return { reasons: ['independent-match-days-insufficient'] };
    const testDays = Math.max(1, Math.floor(days.length * 0.2));
    const calibrationDays = Math.max(1, Math.floor(days.length * 0.2));
    split = { trainDays: days.slice(0, -testDays - calibrationDays),
      calibrationDays: days.slice(-testDays - calibrationDays, -testDays), testDays: days.slice(-testDays) };
  }
  const reasons = [], parts = ['trainDays', 'calibrationDays', 'testDays'];
  if (parts.some(part => !Array.isArray(split?.[part]))) return { reasons: ['split-match-days-invalid'] };
  const assigned = parts.flatMap(part => split[part]);
  if (new Set(assigned).size !== assigned.length || assigned.some(day => !days.includes(day))) reasons.push('split-overlap-or-unknown-match-day');
  const train = [...split.trainDays].sort(), calibration = [...split.calibrationDays].sort(), test = [...split.testDays].sort();
  if (!train.length || !test.length || train.at(-1) >= (calibration[0] || test[0])
    || (calibration.length && calibration.at(-1) >= test[0])) reasons.push('split-not-strictly-chronological');
  if (assigned.length !== days.length) reasons.push('split-unassigned-match-day');
  return { reasons, split: { trainDays: train, calibrationDays: calibration, testDays: test },
    train: entries.filter(entry => train.includes(entry.event.matchDay)),
    calibration: entries.filter(entry => calibration.includes(entry.event.matchDay)),
    test: entries.filter(entry => test.includes(entry.event.matchDay)) };
}
function fitConfiguration(options = {}) {
  const config = { iterations: options.iterations ?? 300, learningRate: options.learningRate ?? 0.05,
    regularization: options.regularization ?? 0.5 };
  if (!Number.isInteger(config.iterations) || config.iterations < 1 || config.iterations > FIT_LIMITS.maxIterations
    || !bounded(config.learningRate, 0.0001, FIT_LIMITS.maxLearningRate)
    || !bounded(config.regularization, FIT_LIMITS.minRegularization, FIT_LIMITS.maxRegularization)) return null;
  return config;
}
function fittedRates(record, model) {
  const output = {};
  for (const side of SIDES) {
    let shift = model.intercept[side];
    for (const [name, coefficient] of Object.entries(model.coefficients[side])) {
      if (!finite(record.featureVector?.[name])) return null;
      shift += record.featureVector[name] * coefficient;
    }
    output[side] = clamp(record.baseRates[side] * Math.exp(clamp(shift, -model.maxAbsLogShift, model.maxAbsLogShift)), model.lambdaFloor, model.lambdaCeiling);
  }
  return output;
}
function fitPoisson(entries, names, config) {
  // Training-only RMS scaling controls step size for rest days/minutes/km.
  // Convert fitted weights back to raw flat-feature coefficients for apply().
  const scales = Object.fromEntries(names.map(name => [name, Math.max(1,
    Math.sqrt(entries.reduce((sum, entry) => sum + entry.record.featureVector[name] ** 2, 0) / entries.length))]));
  const theta = Object.fromEntries(SIDES.map(side => [side, Array(names.length + 1).fill(0)]));
  const loss = parameters => {
    let total = 0;
    for (const entry of entries) for (const side of SIDES) {
      const values = [1, ...names.map(name => entry.record.featureVector[name] / scales[name])];
      const eta = clamp(parameters[side].reduce((sum, coefficient, index) => sum + coefficient * values[index], 0), -FIT_LIMITS.maxAbsLogShift, FIT_LIMITS.maxAbsLogShift);
      const lambda = clamp(entry.record.baseRates[side] * Math.exp(eta), FIT_LIMITS.minRate, FIT_LIMITS.maxRate);
      const goals = side === 'home' ? entry.record.result.match.scoreHome : entry.record.result.match.scoreAway;
      total += lambda - goals * Math.log(lambda);
    }
    const penalty = SIDES.reduce((sum, side) => sum + parameters[side].reduce((n, coefficient) => n + coefficient ** 2, 0), 0);
    return total / (2 * entries.length) + config.regularization * penalty / 2;
  };
  const initialObjective = loss(theta); let currentObjective = initialObjective, completed = 0;
  for (let iteration = 0; iteration < config.iterations; iteration++) {
    const gradient = Object.fromEntries(SIDES.map(side => [side, theta[side].map(coefficient => config.regularization * coefficient)]));
    for (const entry of entries) {
      const values = [1, ...names.map(name => entry.record.featureVector[name] / scales[name])];
      for (const side of SIDES) {
        const eta = theta[side].reduce((sum, coefficient, index) => sum + coefficient * values[index], 0);
        const rawRate = entry.record.baseRates[side] * Math.exp(clamp(eta, -FIT_LIMITS.maxAbsLogShift, FIT_LIMITS.maxAbsLogShift));
        if (Math.abs(eta) >= FIT_LIMITS.maxAbsLogShift || rawRate <= FIT_LIMITS.minRate || rawRate >= FIT_LIMITS.maxRate) continue;
        const goals = side === 'home' ? entry.record.result.match.scoreHome : entry.record.result.match.scoreAway;
        const residual = (rawRate - goals) / (2 * entries.length);
        values.forEach((value, index) => { gradient[side][index] += residual * value; });
      }
    }
    let accepted = false, step = config.learningRate;
    for (let attempt = 0; attempt < 14; attempt++, step /= 2) {
      const next = Object.fromEntries(SIDES.map(side => [side, theta[side].map((coefficient, index) =>
        clamp(coefficient - step * clamp(gradient[side][index], -2, 2),
          -(index ? FIT_LIMITS.maxAbsCoefficient : FIT_LIMITS.maxAbsIntercept), index ? FIT_LIMITS.maxAbsCoefficient : FIT_LIMITS.maxAbsIntercept))]));
      const objective = loss(next);
      if (finite(objective) && objective <= currentObjective + 1e-12) {
        SIDES.forEach(side => { theta[side] = next[side]; }); currentObjective = objective; accepted = true; break;
      }
    }
    if (!accepted) break;
    completed++;
  }
  return { model: { kind: 'lambda-loglinear', intercept: Object.fromEntries(SIDES.map(side => [side, theta[side][0]])),
    coefficients: Object.fromEntries(SIDES.map(side => [side, Object.fromEntries(names.map((name, index) => [name, theta[side][index + 1] / scales[name]]))])),
    maxAbsLogShift: FIT_LIMITS.maxAbsLogShift, lambdaFloor: FIT_LIMITS.minRate, lambdaCeiling: FIT_LIMITS.maxRate }, optimization: { ...config, completedIterations: completed,
    objective: 'regularized-poisson-90min-goal-count-nll', initialObjective, finalObjective: currentObjective,
    trainingOnlyRmsScales: scales, parameterLimits: FIT_LIMITS } };
}
function goalProbabilities(rates) {
  const matrix = scoreMatrix(rates?.home, rates?.away);
  if (!matrix.length) return null;
  const p = { '1': 0, X: 0, '2': 0 };
  for (const row of matrix) p[row.home > row.away ? '1' : row.home === row.away ? 'X' : '2'] += row.probability;
  const mass = CODES.reduce((sum, code) => sum + p[code], 0);
  if (!finite(mass) || mass < 1 - 1e-9) return null;
  CODES.forEach(code => { p[code] /= mass; }); return p;
}
function parameterBlockers(artifact, context) {
  const reasons = [], model = artifact?.model, training = artifact?.training;
  if (artifact?.version !== PARAMETER_VERSION || artifact?.codeVersion !== CODE_VERSION
    || artifact?.formalEligible !== false || artifact?.productionEligible !== false || artifact?.shadowOnly !== true
    || artifact?.status !== 'shadow-candidate') reasons.push('parameter-artifact-identity-or-shadow-boundary-invalid');
  if (!HASH.test(artifact?.contentHash || '') || hashBody(artifact) !== artifact?.contentHash) reasons.push('parameter-artifact-hash-mismatch');
  if (artifact?.featureSchemaHash !== context.schemaHash || digest(artifact?.featureSchema) !== context.schemaHash
    || digest(artifact?.featureNames) !== digest(context.featureNames)) reasons.push('parameter-feature-schema-mismatch');
  if (!HASH.test(artifact?.parametersHash || '') || digest(model) !== artifact?.parametersHash) reasons.push('parameters-hash-mismatch');
  const trained = instant(artifact?.trainedThrough), created = instant(artifact?.createdAt), available = instant(artifact?.availableAt);
  if (trained === null || created === null || available === null || trained > created || created > available) reasons.push('parameter-training-clock-invalid');
  if (model?.kind !== 'lambda-loglinear' || model?.maxAbsLogShift !== FIT_LIMITS.maxAbsLogShift
    || model?.lambdaFloor !== FIT_LIMITS.minRate || model?.lambdaCeiling !== FIT_LIMITS.maxRate
    || !SIDES.every(side => bounded(model?.intercept?.[side], -FIT_LIMITS.maxAbsIntercept, FIT_LIMITS.maxAbsIntercept)
      && model?.coefficients?.[side] && Object.keys(model.coefficients[side]).length === context.featureNames.length
      && context.featureNames.every(name => bounded(model.coefficients[side][name], -FIT_LIMITS.maxAbsCoefficient, FIT_LIMITS.maxAbsCoefficient)))) reasons.push('fitted-parameters-outside-bounds');
  if (!training || training.split !== 'time-ordered' || !Number.isInteger(training.sampleCount)
    || training.sampleCount < RESEARCH_FLOORS.trainingRows || !Array.isArray(training.trainingEventIds)
    || !Array.isArray(training.trainingSourceMatchIds) || !Array.isArray(training.inputHashes)
    || training.inputHashes.length !== training.sampleCount || training.inputHashes.some(hash => !HASH.test(hash || ''))
    || training.trainingSourceMatchIds.length !== training.sampleCount
    || new Set(training.trainingSourceMatchIds).size !== training.sampleCount
    || training.trainingEventIds.length !== training.sampleCount || new Set(training.trainingEventIds).size !== training.sampleCount
    || digest(training.inputHashes) !== training.artifactHash || training.knowledgeThrough !== artifact.trainedThrough
    || training.codeVersion !== CODE_VERSION || !Array.isArray(training.trainingMatchDays)
    || training.trainingMatchDays.length < RESEARCH_FLOORS.trainingDays) reasons.push('parameter-training-binding-invalid');
  const plan = artifact?.evaluationPlan, parts = ['trainDays', 'calibrationDays', 'testDays'];
  if (!plan || plan.mode !== 'retrospective-shadow-replay' || plan.calibrated !== false
    || parts.some(part => !Array.isArray(plan[part]) || plan[part].some(day => !strictInstant(`${day}T00:00:00Z`))
      || digest(plan[part]) !== digest([...plan[part]].sort()))
    || !plan.trainDays?.length || !plan.testDays?.length
    || digest(plan.trainDays) !== digest(training?.trainingMatchDays)
    || new Set(parts.flatMap(part => plan[part] || [])).size !== parts.reduce((sum, part) => sum + (plan[part]?.length || 0), 0)
    || plan.trainDays.at(-1) >= (plan.calibrationDays[0] || plan.testDays[0])
    || (plan.calibrationDays.length && plan.calibrationDays.at(-1) >= plan.testDays[0])) reasons.push('parameter-evaluation-split-invalid');
  if (artifact?.registration?.status !== 'not-registered' || artifact?.registration?.allowedAutomaticState !== 'REGISTERED_SHADOW'
    || artifact?.registration?.registryVersion !== REGISTRY_VERSION || artifact?.registration?.prospectiveGateRequired !== true
    || digest(artifact?.registration?.promotionThresholds) !== digest(DEFAULT_THRESHOLDS)) reasons.push('parameter-registration-boundary-invalid');
  if (digest(artifact?.comparators) !== digest(COMPARATORS)) reasons.push('comparator-policy-mismatch');
  return [...new Set(reasons)];
}
const exclusionCounts = exclusions => Object.fromEntries([...new Set(exclusions.flatMap(row => row.reasons))]
  .sort().map(reason => [reason, exclusions.filter(row => row.reasons.includes(reason)).length]));
function coverage(prepared, extra = {}) {
  return { inputRecordCount: prepared?.inputRecordCount || 0, independentEventCount: prepared?.independentEventCount || 0,
    eligibleIndependentEvents: prepared?.eligible?.length || 0, excludedRecordCount: prepared?.exclusions?.length || 0,
    exclusionReasons: exclusionCounts(prepared?.exclusions || []), ...extra };
}
function blocked(reasons, prepared = null, extra = {}) {
  return { version: VERSION, status: 'blocked', formalEligible: false, productionEligible: false,
    probabilities: null, rates: null, artifact: null, reasons: [...new Set(reasons)],
    coverage: coverage(prepared), exclusions: prepared?.exclusions || [], ...extra };
}
function summarize(rows, key) {
  if (!rows.length) return { rows: 0, brier: null, logLoss: null };
  let brier = 0, logLoss = 0;
  for (const row of rows) {
    brier += CODES.reduce((sum, code) => sum + (row[key][code] - Number(code === row.outcome)) ** 2, 0);
    logLoss -= Math.log(Math.max(1e-15, row[key][row.outcome]));
  }
  return { rows: rows.length, brier: brier / rows.length, logLoss: logLoss / rows.length };
}
function evaluateEntries(entries, artifact, mode, phase = 'test') {
  const rows = [], exclusions = [];
  for (const entry of entries) {
    const record = entry.record, at = instant(record.asOf), reasons = [];
    if (artifact.training.trainingSourceMatchIds.includes(entry.event.sourceMatchId)
      || artifact.training.trainingEventIds.includes(entry.event.eventId)
      || entry.event.matchDay <= artifact.training.trainingMatchDays.at(-1)) reasons.push('training-and-test-not-independent');
    if (phase === 'test' && (artifact.evaluationPlan.calibrationDays.includes(entry.event.matchDay)
      || entry.event.matchDay < artifact.evaluationPlan.testDays[0])) reasons.push('calibration-and-test-not-independent');
    if (instant(artifact.trainedThrough) >= at) reasons.push('training-knowledge-not-before-prediction');
    if (mode === 'prospective-frozen' && (instant(artifact.availableAt) >= at || instant(artifact.createdAt) >= at
      || record.parameterArtifactHash !== artifact.contentHash)) reasons.push('candidate-not-frozen-before-prediction');
    if (!entry.market) reasons.push('same-time-market-comparator-unavailable');
    const rates = fittedRates(record, artifact.model), candidate = rates && goalProbabilities(rates), baseline = goalProbabilities(record.baseRates);
    if (!candidate || !baseline) reasons.push('lambda-probability-computation-invalid');
    if (reasons.length) {
      exclusions.push({ recordIndex: entry.index, sourceMatchId: entry.event.sourceMatchId,
        predictionHash: record.predictionHash, reasons }); continue;
    }
    const hybrid = Object.fromEntries(CODES.map(code => [code, COMPARATORS.hybridCandidateWeight * candidate[code] + COMPARATORS.hybridMarketWeight * entry.market[code]]));
    const home = record.result.match.scoreHome, away = record.result.match.scoreAway;
    rows.push({ eventId: entry.event.eventId, sourceMatchId: entry.event.sourceMatchId, matchDay: entry.event.matchDay,
      predictionAt: record.asOf, inputHash: record.contentHash, predictionHash: record.predictionHash,
      featureSnapshotHash: record.featureSnapshotHash, parameterArtifactHash: artifact.contentHash,
      outcome: home > away ? '1' : home === away ? 'X' : '2', rates, candidate, baseline, marketOnly: entry.market, hybrid });
  }
  const metrics = Object.fromEntries(['candidate', 'baseline', 'marketOnly', 'hybrid'].map(key => [key, summarize(rows, key)]));
  return { rows, exclusions, metrics, independentMatchDays: new Set(rows.map(row => row.matchDay)).size,
    dailyMetrics: [...new Set(rows.map(row => row.matchDay))].sort().map(matchDay => ({ matchDay,
      metrics: Object.fromEntries(['candidate', 'baseline', 'marketOnly', 'hybrid'].map(key => [key, summarize(rows.filter(row => row.matchDay === matchDay), key)])) })) };
}

/**
 * records carry a pre-match predictionHash separately from a later joined
 * result hash. Result labels must explicitly mean normal 90-minute goals;
 * ET/shootout totals, nulls and fixture-only source claims are rejected.
 * This is research evidence, not cryptographic production authentication.
 */
function learnPrematchV3Candidate(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return blocked(['learning-input-schema-clock-or-fit-options-invalid']);
  const context = schemaContext(options), at = instant(options.asOf), config = fitConfiguration(options.fitOptions);
  if (!context || at === null || !Array.isArray(options.records) || options.records.length > 100000 || !config)
    return blocked(['learning-input-schema-clock-or-fit-options-invalid']);
  const prepared = prepareRecords(options.records, context, at), plan = chronologicalSplit(prepared.eligible, options.split);
  if (plan.reasons.length) return blocked(plan.reasons, prepared);
  if (plan.train.length < RESEARCH_FLOORS.trainingRows || plan.split.trainDays.length < RESEARCH_FLOORS.trainingDays
    || plan.test.length < RESEARCH_FLOORS.testRows || plan.split.testDays.length < RESEARCH_FLOORS.testDays)
    return blocked(['independent-training-or-test-data-insufficient'], prepared, { split: plan.split });
  const heldOut = [...plan.calibration, ...plan.test];
  const earliestPrediction = heldOut.reduce((minimum, entry) => instant(entry.record.asOf) < minimum ? instant(entry.record.asOf) : minimum, at);
  const latestKnowledge = plan.train.reduce((latest, entry) => entry.knownAt > latest ? entry.knownAt : latest, 0n);
  if (latestKnowledge >= earliestPrediction) return blocked(['training-knowledge-clock-overlaps-holdout'], prepared, { split: plan.split });
  const trainedThrough = plan.train.reduce((latest, entry) => entry.knownAt > instant(latest) ? entry.record.result.receivedAt : latest, plan.train[0].record.result.receivedAt);
  const fitted = fitPoisson(plan.train, context.featureNames, config);
  if (!finite(fitted.optimization.finalObjective) || fitted.optimization.completedIterations < 1)
    return blocked(['parameter-fit-failed'], prepared, { split: plan.split });
  const inputHashes = plan.train.map(entry => entry.record.contentHash).sort();
  const body = { version: PARAMETER_VERSION, codeVersion: CODE_VERSION, status: 'shadow-candidate',
    formalEligible: false, productionEligible: false, shadowOnly: true,
    createdAt: options.asOf, availableAt: options.asOf, trainedThrough,
    featureSchema: context.schema, featureSchemaHash: context.schemaHash, featureNames: context.featureNames,
    model: fitted.model, parametersHash: digest(fitted.model), comparators: COMPARATORS,
    training: { sampleCount: plan.train.length, split: 'time-ordered', artifactHash: digest(inputHashes),
      trainingEventIds: plan.train.map(entry => entry.event.eventId).sort(),
      trainingSourceMatchIds: plan.train.map(entry => entry.event.sourceMatchId).sort(),
      trainingMatchDays: plan.split.trainDays, knowledgeThrough: trainedThrough, inputHashes, codeVersion: CODE_VERSION,
      optimization: fitted.optimization },
    evaluationPlan: { ...plan.split, mode: 'retrospective-shadow-replay', calibrated: false },
    registration: { status: 'not-registered', allowedAutomaticState: 'REGISTERED_SHADOW', registryVersion: REGISTRY_VERSION,
      promotionThresholds: DEFAULT_THRESHOLDS, prospectiveGateRequired: true } };
  const artifact = { ...body, contentHash: digest(body) };
  const validation = evaluateEntries(plan.test, artifact, 'retrospective-shadow-replay');
  if (validation.rows.length < RESEARCH_FLOORS.testRows || validation.independentMatchDays < RESEARCH_FLOORS.testDays)
    return blocked(['independent-paired-test-data-insufficient'], prepared, { split: plan.split,
      exclusions: [...prepared.exclusions, ...validation.exclusions], validation: { ...validation, rows: [], metrics: null } });
  const calibration = evaluateEntries(plan.calibration, artifact, 'retrospective-shadow-replay', 'calibration');
  return { version: VERSION, status: 'shadow-candidate', formalEligible: false, productionEligible: false,
    sourceVerification: 'research-labels-only', calibrated: false, originalDeployment: false, prospectiveEligible: false,
    artifact, validation, calibration: { status: 'reserved-diagnostic-only', fitted: false, ...calibration },
    split: plan.split, coverage: coverage(prepared, { trainingRows: plan.train.length,
      calibrationRows: plan.calibration.length, testRows: plan.test.length, pairedTestRows: validation.rows.length }),
    exclusions: prepared.exclusions, reasons: ['shadow-only-independent-prospective-gate-required'] };
}

function evaluatePrematchV3Records(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return blocked(['evaluation-input-schema-clock-or-mode-invalid']);
  const artifact = options.artifact, context = schemaContext({ ...options,
    featureSchema: options.featureSchema || artifact?.featureSchema,
    featureNames: options.featureNames || artifact?.featureNames });
  const at = instant(options.asOf), mode = options.mode || 'retrospective-shadow-replay';
  if (!context || at === null || !Array.isArray(options.records) || options.records.length > 100000
    || !['retrospective-shadow-replay', 'prospective-frozen'].includes(mode)) return blocked(['evaluation-input-schema-clock-or-mode-invalid']);
  const blockers = parameterBlockers(artifact, context);
  if (instant(artifact?.createdAt) > at || instant(artifact?.availableAt) > at) blockers.push('parameter-artifact-not-yet-available');
  if (blockers.length) return blocked(blockers);
  const prepared = prepareRecords(options.records, context, at);
  const requestedDays = options.testDays || options.split?.testDays || artifact.evaluationPlan?.testDays;
  if (!Array.isArray(requestedDays) || !requestedDays.length || new Set(requestedDays).size !== requestedDays.length)
    return blocked(['test-match-days-missing-or-invalid'], prepared);
  const entries = prepared.eligible.filter(entry => requestedDays.includes(entry.event.matchDay));
  const validation = evaluateEntries(entries, artifact, mode);
  const exclusions = [...prepared.exclusions, ...validation.exclusions];
  const audit = { ...prepared, exclusions };
  if (validation.rows.length < RESEARCH_FLOORS.testRows || validation.independentMatchDays < RESEARCH_FLOORS.testDays)
    return blocked(['independent-paired-test-data-insufficient'], audit, { validation: { ...validation, rows: [], metrics: null } });
  const body = { version: VERSION, status: 'shadow-evaluated', formalEligible: false, productionEligible: false,
    mode, calibrated: false, originalDeployment: false, prospectiveEligible: false,
    sourceVerification: 'research-labels-only', parameterArtifactHash: artifact.contentHash,
    evaluatedAt: options.asOf, validation, exclusions,
    coverage: coverage(audit, { requestedTestRows: entries.length, pairedTestRows: validation.rows.length,
      independentTestMatchDays: validation.independentMatchDays }),
    reasons: ['research-evaluation-does-not-authorize-promotion'] };
  return { ...body, contentHash: digest(body) };
}

function verifyPrematchV3ParameterArtifact(artifact, options = {}) {
  const context = schemaContext({...options,featureSchema:options.featureSchema || artifact?.featureSchema,
    featureNames:options.featureNames || artifact?.featureNames});
  if (!context) return {valid:false,reasons:['parameter-feature-schema-mismatch']};
  const reasons = parameterBlockers(artifact,context);
  return {valid:!reasons.length,reasons};
}
module.exports = { VERSION, RECORD_VERSION, PARAMETER_VERSION, CODE_VERSION, RESEARCH_FLOORS, FIT_LIMITS,
  verifyPrematchV3ParameterArtifact,
  COMPARATORS, predictionRecordHash, goalProbabilities, learnPrematchV3Candidate, evaluatePrematchV3Records };
