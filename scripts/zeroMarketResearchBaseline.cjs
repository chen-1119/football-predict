'use strict';

// Isolated research math. No filesystem, datastore, publisher or registry access.
const { createHash } = require('node:crypto');
const { epochNanoseconds: clock } = require('../src/services/prematchV3Clock.cjs');

const VERSION = 'zero-market-source-scoped-poisson-research-v1';
const INPUT_VERSION = 'zero-market-source-scoped-ft-input-v1';
const APPROVAL_VERSION = 'zero-market-research-metadata-approval-v1';
const EVENT_APPROVAL_VERSION = 'zero-market-research-event-approval-v1';
const ARTIFACT_VERSION = 'zero-market-source-scoped-poisson-artifact-v1';
const FORECAST_VERSION = 'zero-market-source-scoped-poisson-freeze-v1';
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_CONFIG = Object.freeze({ regularization: 0.1, iterations: 1200, learningRate: 0.5,
  gradientTolerance: 1e-7, maxAbsGoalEffect: 2, maxGoals: 16 });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim() === v && v.length > 0;
const stable = v => Array.isArray(v) ? v.map(stable) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(stable(v)) ?? 'undefined').digest('hex');
const clone = v => structuredClone(v);
const seal = body => ({ ...body, contentHash: hash(body) });
function sealed(v) { if (!object(v) || !HASH.test(v.contentHash || '')) return false; const { contentHash, ...body } = v; return hash(body) === contentHash; }
const noLater = (a, b) => clock(a) !== null && clock(b) !== null && clock(a) <= clock(b);
const before = (a, b) => clock(a) !== null && clock(b) !== null && clock(a) < clock(b);
const equalClock = (a, b) => clock(a) !== null && clock(a) === clock(b);
const exactKeys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const completeKeys = (v, required) => exactKeys(v, required) && required.every(k => Object.hasOwn(v, k));
// Inspect callable source with this realm's intrinsic; never invoke input code.
const nativeSourceInspector = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function nativeSourceProbe() {}), 'toString').value;
const nativeCallableSource = value => Reflect.apply(nativeSourceInspector, value, []);
function nativeArrayPrototype(prototype) {
  if (!Array.isArray(prototype)) return false;
  const parent = Object.getPrototypeOf(prototype), parentConstructor = parent && Object.getOwnPropertyDescriptor(parent, 'constructor');
  if (!parent || Object.getPrototypeOf(parent) !== null || !parentConstructor || !Object.hasOwn(parentConstructor, 'value')
    || typeof parentConstructor.value !== 'function' || nativeCallableSource(parentConstructor.value) !== 'function Object() { [native code] }'
    || parentConstructor.value.prototype !== parent) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !Object.hasOwn(constructor, 'value') || typeof constructor.value !== 'function'
    || nativeCallableSource(constructor.value) !== 'function Array() { [native code] }'
    || constructor.value.prototype !== prototype) return false;
  const expected = Reflect.ownKeys(Array.prototype), keys = Reflect.ownKeys(prototype);
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return false;
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(prototype, key), baseline = Object.getOwnPropertyDescriptor(Array.prototype, key);
    if (!Object.hasOwn(d, 'value') || d.enumerable !== baseline.enumerable || d.configurable !== baseline.configurable
      || d.writable !== baseline.writable) return false;
    if (typeof d.value === 'function') {
      const name = key === 'constructor' ? 'Array' : key === Symbol.iterator ? 'values' : key;
      if (nativeCallableSource(d.value) !== `function ${name}() { [native code] }`) return false;
    } else if (key === 'length') { if (d.value !== 0) return false; }
    else if (key === Symbol.unscopables) {
      if (!object(d.value) || Object.getPrototypeOf(d.value) !== null || Reflect.ownKeys(d.value).some(k => typeof k !== 'string')) return false;
      const entries = Object.getOwnPropertyDescriptors(d.value), expectedEntries = Object.getOwnPropertyDescriptors(baseline.value);
      if (hash(entries) !== hash(expectedEntries)) return false;
    } else return false;
  }
  return true;
}
function plainJson(value) {
  const ancestors = new Set(); let nodes = 0, characters = 0;
  function visit(v, depth) {
    if (++nodes > 350000 || depth > 32) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') { characters += v.length; return characters <= 16 * 1024 * 1024; }
    if (typeof v !== 'object' || ancestors.has(v) || Object.getOwnPropertySymbols(v).length) return false;
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      if (Object.getPrototypeOf(prototype) !== null || !constructor || !Object.hasOwn(constructor, 'value')
        || typeof constructor.value !== 'function' || nativeCallableSource(constructor.value) !== 'function Object() { [native code] }') return false;
    }
    if (array && !nativeArrayPrototype(prototype)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v), names = Object.keys(v);
    if (array && (v.length > 10000 || names.length !== v.length || names.some((key, i) => key !== String(i)))) return false;
    if (names.length > (array ? 10000 : 100)) return false;
    if (Object.entries(descriptors).some(([key, d]) => key !== 'length' && (!Object.hasOwn(d, 'value') || !d.enumerable))) return false;
    ancestors.add(v);
    const ok = names.every(key => visit(descriptors[key].value, depth + 1));
    ancestors.delete(v); return ok;
  }
  try { return visit(value, 0); } catch { return false; }
}
const date = v => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z'))
  && new Date(Date.parse(v + 'T00:00:00Z')).toISOString().slice(0, 10) === v;
const integer = (v, a, b) => Number.isSafeInteger(v) && v >= a && v <= b;
const finite = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
function forbiddenField(value) {
  if (Array.isArray(value)) return value.some(forbiddenField);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => /market|odds|^(?:sp|price|prices|probabilities|handicapOdds|roster|injuries|fatigue|xg)$/i.test(key) || forbiddenField(child));
}
const blocked = reasons => ({ version: VERSION, status: 'blocked', reasons: [...new Set(reasons)].sort(),
  formalEligible: false, productionEligible: false, primary: null, companion: null,
  artifact: null, forecast: null, lambda: null, p: null, features: null, fit: null });
function researchInputHash(input) {
  return hash({ source: input?.source,
    entities: Array.isArray(input?.entities) ? [...input.entities].sort((a, b) => String(a?.entityRef).localeCompare(String(b?.entityRef))) : input?.entities,
    rows: Array.isArray(input?.rows) ? [...input.rows].sort((a, b) => String(a?.sourceRecordRef).localeCompare(String(b?.sourceRecordRef))) : input?.rows });
}
function configFrom(input) {
  if (input !== undefined && !exactKeys(input, Object.keys(DEFAULT_CONFIG))) return null;
  const c = { ...DEFAULT_CONFIG, ...input };
  if (!finite(c.regularization, 0.01, 10) || !integer(c.iterations, 20, 2000)
    || !finite(c.learningRate, 0.001, 1) || !finite(c.gradientTolerance, 1e-10, 0.001)
    || !finite(c.maxAbsGoalEffect, 0.2, 2) || !integer(c.maxGoals, 4, 40)) return null;
  return c;
}

function inspectResearchAdmission(input, actualClock = new Date().toISOString()) {
  const reasons = [];
  if (clock(actualClock) === null) return blocked(['actual-inspection-clock-invalid']);
  if (!plainJson(input) || !object(input) || forbiddenField(input)) return blocked(['input-schema-or-market-field-forbidden']);
  if (!exactKeys(input, ['version', 'researchOnly', 'source', 'entities', 'rows', 'approval', 'config'])
    || input.version !== INPUT_VERSION || input.researchOnly !== true || clock(actualClock) === null)
    reasons.push('research-input-schema-invalid');
  const source = input.source, approval = input.approval;
  if (!exactKeys(source, ['namespace', 'rawSha256', 'license', 'licenseRawSha256', 'formatEvidenceSha256', 'observedAt', 'formatKnownAt', 'coverageThrough', 'completeCompetitionHistory'])
    || !text(source.namespace) || !HASH.test(source.rawSha256 || '') || source.license !== 'CC0-1.0'
    || !HASH.test(source.licenseRawSha256 || '') || !HASH.test(source.formatEvidenceSha256 || '')
    || !before(source.observedAt, actualClock) || !noLater(source.observedAt, source.formatKnownAt)
    || !before(source.formatKnownAt, actualClock) || !date(source.coverageThrough)
    || source.completeCompetitionHistory !== false) reasons.push('fixed-cc0-format-source-invalid-or-future');
  if (!exactKeys(approval, ['version', 'approved', 'researchOnly', 'reviewId', 'reviewer', 'reviewedAt', 'scope', 'venuePolicy', 'sourceNamespace', 'approvedInputHash', 'sourceEntityMapApproved', 'partialCoverageAccepted'])
    || approval.version !== APPROVAL_VERSION || approval.approved !== true || approval.researchOnly !== true
    || !text(approval.reviewId) || !text(approval.reviewer) || approval.scope !== 'future-only-source-format-ft'
    || approval.venuePolicy !== 'venue-agnostic' || approval.sourceNamespace !== source?.namespace
    || approval.approvedInputHash !== researchInputHash(input) || approval.sourceEntityMapApproved !== true
    || approval.partialCoverageAccepted !== true || !noLater(source?.formatKnownAt, approval.reviewedAt)
    || !before(approval.reviewedAt, actualClock)) reasons.push('explicit-research-metadata-approval-required');
  const entities = Array.isArray(input.entities) ? input.entities : [];
  if (!integer(entities.length, 2, 200) || entities.some(e => !exactKeys(e, ['entityRef', 'literalName', 'namespace'])
    || !text(e.entityRef) || !text(e.literalName) || e.namespace !== source?.namespace
    || !e.entityRef.startsWith(source?.namespace + '#research-entity/')
    || !/^#research-entity\/[1-9]\d*$/.test(e.entityRef.slice(String(source?.namespace).length)))
    || new Set(entities.map(e => e?.entityRef)).size !== entities.length
    || new Set(entities.map(e => e?.literalName)).size !== entities.length)
    reasons.push('explicit-source-scoped-entities-invalid');
  const entityRefs = new Set(entities.map(e => e?.entityRef)), rows = Array.isArray(input.rows) ? input.rows : [];
  const rowIds = new Set(), eventTuples = new Set(), used = new Set();
  if (!integer(rows.length, 1, 10000)) reasons.push('explicit-ft-label-rows-required');
  for (const row of rows) {
    if (!object(row)) { reasons.push('label-identity-format-knowledge-or-venue-invalid'); continue; }
    if (!exactKeys(row, ['sourceRecordRef', 'sourceNominalDate', 'homeEntityRef', 'awayEntityRef', 'homeGoals', 'awayGoals', 'sourceFormat', 'knownAt', 'neutral', 'historicalAsOf', 'actualEndedAt'])
      || !text(row.sourceRecordRef) || !row.sourceRecordRef.startsWith(source?.namespace + '#')
      || !date(row.sourceNominalDate) || row.sourceNominalDate > source?.coverageThrough
      || row.sourceNominalDate >= actualClock.slice(0, 10) || row.sourceFormat !== 'ordinary-ft'
      || !entityRefs.has(row.homeEntityRef) || !entityRefs.has(row.awayEntityRef) || row.homeEntityRef === row.awayEntityRef
      || !integer(row.homeGoals, 0, 20) || !integer(row.awayGoals, 0, 20)
      || row.neutral !== null || row.historicalAsOf !== null || row.actualEndedAt !== null
      || !noLater(approval?.reviewedAt, row.knownAt) || !before(row.knownAt, actualClock)) reasons.push('label-identity-format-knowledge-or-venue-invalid');
    const tuple = [row.sourceNominalDate, row.homeEntityRef, row.awayEntityRef].join('|');
    if (rowIds.has(row.sourceRecordRef) || eventTuples.has(tuple)) reasons.push('duplicate-research-label-event');
    rowIds.add(row.sourceRecordRef); eventTuples.add(tuple); used.add(row.homeEntityRef); used.add(row.awayEntityRef);
  }
  if ([...entityRefs].some(ref => !used.has(ref))) reasons.push('unobserved-entity-cannot-be-fitted');
  if (!configFrom(input.config)) reasons.push('fit-config-invalid');
  return reasons.length ? blocked(reasons) : { version: VERSION, status: 'research-metadata-admitted',
    formalEligible: false, productionEligible: false, primary: null, companion: null,
    inputHash: researchInputHash(input), researchOnly: true, canonicalAdmission: false,
    trustedOfficial90Minute: false, venuePolicy: 'venue-agnostic', historicalBacktestAllowed: false };
}
const logFactorial = n => { let sum = 0; for (let k = 2; k <= n; k++) sum += Math.log(k); return sum; };
function objective(parameters, rows, count, regularization, gradients = false) {
  let value = 0;
  const g = { intercept: 0, attack: Array(count).fill(0), defense: Array(count).fill(0) };
  for (const row of rows) for (const [own, other, goals] of [[row.h, row.a, row.hg], [row.a, row.h, row.ag]]) {
    const eta = parameters.intercept + parameters.attack[own] + parameters.defense[other], lambda = Math.exp(eta);
    value += lambda - goals * eta + logFactorial(goals);
    if (gradients) { const error = lambda - goals; g.intercept += error; g.attack[own] += error; g.defense[other] += error; }
  }
  const denominator = 2 * rows.length;
  value /= denominator;
  g.intercept /= denominator;
  for (let i = 0; i < count; i++) {
    value += regularization * (parameters.attack[i] ** 2 + parameters.defense[i] ** 2) / (2 * count);
    g.attack[i] = g.attack[i] / denominator + regularization * parameters.attack[i] / count;
    g.defense[i] = g.defense[i] / denominator + regularization * parameters.defense[i] / count;
  }
  // Sum-to-zero attack/defense constraints identify the intercept without a home parameter.
  for (const key of ['attack', 'defense']) {
    const mean = g[key].reduce((a, b) => a + b, 0) / count;
    g[key] = g[key].map(v => v - mean);
  }
  return { value, gradient: g };
}
function withinParameterDomain(p, config) {
  return finite(p.intercept, Math.log(0.05), Math.log(6))
    && [...p.attack, ...p.defense].every(v => finite(v, -config.maxAbsGoalEffect, config.maxAbsGoalEffect));
}
function projectZeroSumBox(values, bound) {
  // Euclidean projection: x_i=clip(y_i-tau,-bound,bound), with sum(x)=0.
  if (values.every(v => Math.abs(v) <= bound) && Math.abs(values.reduce((s, v) => s + v, 0)) < 1e-14) return [...values];
  let low = Math.min(...values) - bound, high = Math.max(...values) + bound;
  for (let iteration = 0; iteration < 100; iteration++) {
    const tau = (low + high) / 2;
    const sum = values.reduce((s, v) => s + Math.max(-bound, Math.min(bound, v - tau)), 0);
    if (sum > 0) low = tau; else high = tau;
  }
  const tau = (low + high) / 2;
  return values.map(v => Math.max(-bound, Math.min(bound, v - tau)));
}
function projectedStep(parameters, gradient, step, config) {
  return { intercept: Math.max(Math.log(0.05), Math.min(Math.log(6), parameters.intercept - step * gradient.intercept)),
    attack: projectZeroSumBox(parameters.attack.map((v, i) => v - step * gradient.attack[i]), config.maxAbsGoalEffect),
    defense: projectZeroSumBox(parameters.defense.map((v, i) => v - step * gradient.defense[i]), config.maxAbsGoalEffect) };
}
function direction(from, to) { return { intercept: to.intercept - from.intercept,
  attack: from.attack.map((v, i) => to.attack[i] - v), defense: from.defense.map((v, i) => to.defense[i] - v) }; }
function dot(a, b) { return a.intercept * b.intercept + a.attack.reduce((s, v, i) => s + v * b.attack[i], 0)
  + a.defense.reduce((s, v, i) => s + v * b.defense[i], 0); }
function optimize(rows, count, config) {
  const avg = rows.reduce((s, r) => s + r.hg + r.ag, 0) / (2 * rows.length);
  let parameters = { intercept: Math.log(Math.max(0.05, Math.min(6, avg))), attack: Array(count).fill(0), defense: Array(count).fill(0) };
  const initialObjective = objective(parameters, rows, count, config.regularization).value;
  let completedIterations = 0, lineSearchStopped = false;
  for (let iteration = 0; iteration < config.iterations; iteration++) {
    const current = objective(parameters, rows, count, config.regularization, true), g = current.gradient;
    const mapping = direction(parameters, projectedStep(parameters, g, 1, config));
    if (Math.sqrt(dot(mapping, mapping)) < config.gradientTolerance) break;
    let step = config.learningRate, accepted = false;
    for (let attempt = 0; attempt < 30; attempt++, step /= 2) {
      const next = projectedStep(parameters, g, step, config), d = direction(parameters, next), descent = dot(g, d);
      const candidate = objective(next, rows, count, config.regularization).value;
      if (Number.isFinite(candidate) && descent < 0 && candidate <= current.value + 1e-4 * descent) {
        parameters = next; accepted = true; completedIterations++; break;
      }
    }
    if (!accepted) { lineSearchStopped = true; break; }
  }
  const audit = objective(parameters, rows, count, config.regularization, true);
  const finalGradientNorm = Math.sqrt(dot(audit.gradient, audit.gradient));
  const mapping = direction(parameters, projectedStep(parameters, audit.gradient, 1, config));
  const finalProjectedGradientNorm = Math.sqrt(dot(mapping, mapping));
  const converged = finalProjectedGradientNorm < config.gradientTolerance;
  return { parameters, optimization: {
    algorithm: 'deterministic-full-batch-box-sum-zero-projected-gradient-with-Armijo-backtracking',
    initialObjective, finalObjective: audit.value, completedIterations, converged, lineSearchStopped,
    finalGradientNorm, finalProjectedGradientNorm,
    stopReason: converged ? 'projected-kkt-converged' : lineSearchStopped ? 'line-search-stalled' : 'maximum-iterations' } };
}
function fitZeroMarketResearch(input) {
  const fitStartedAt = new Date().toISOString(), admission = inspectResearchAdmission(input, fitStartedAt);
  if (admission.status === 'blocked') return admission;
  const config = configFrom(input.config), entities = [...input.entities].sort((a, b) => a.entityRef.localeCompare(b.entityRef));
  const index = new Map(entities.map((e, i) => [e.entityRef, i]));
  const rows = [...input.rows].sort((a, b) => a.sourceRecordRef.localeCompare(b.sourceRecordRef)).map(r => ({
    h: index.get(r.homeEntityRef), a: index.get(r.awayEntityRef), hg: r.homeGoals, ag: r.awayGoals }));
  const optimized = optimize(rows, entities.length, config), { parameters, optimization } = optimized;
  if (!Number.isFinite(optimization.finalObjective) || optimization.finalObjective > optimization.initialObjective + 1e-12
    || !withinParameterDomain(parameters, config)) return blocked(['optimization-invalid']);
  const fitCompletedAt = new Date().toISOString();
  if (!noLater(fitStartedAt, fitCompletedAt)) return blocked(['actual-fit-clock-regressed']);
  const latestKnownAt = input.rows.reduce((a, r) => clock(r.knownAt) > clock(a) ? r.knownAt : a, input.approval.reviewedAt);
  const body = { version: ARTIFACT_VERSION, codeVersion: VERSION, researchOnly: true,
    formalEligible: false, productionEligible: false, canonicalAdmission: false, trustedOfficial90Minute: false,
    venuePolicy: 'venue-agnostic', neutralEvidence: null, historicalBacktestAllowed: false,
    source: clone(input.source), metadataApproval: clone(input.approval), inputHash: researchInputHash(input),
    entities: clone(entities), trainingRows: clone([...input.rows].sort((a, b) => a.sourceRecordRef.localeCompare(b.sourceRecordRef))),
    trainingRowsHash: hash([...input.rows].sort((a, b) => a.sourceRecordRef.localeCompare(b.sourceRecordRef))), config, parameters: { ...parameters, defenseMeaning: 'positive means opponent scores more',
      identifiability: 'sum attack=0;sum defense=0', homeAdvantage: 0 },
    objective: 'mean two-team Poisson negative log likelihood including log(goal!);plus regularization/(2*teamCount)*sum(attack^2+defense^2)',
    optimization,
    fitStartedAt, fitCompletedAt, createdAt: fitCompletedAt, availableAt: fitCompletedAt, trainedThrough: latestKnownAt,
    historicalAsOf: null, actualEndedAt: null, roster: null, injuries: null, fatigue: null, xg: null,
    accuracyMeasured: false, calibrationMeasured: false, hitRate: null,
    invariants: { marketInputs: 0, registryWrites: 0, publisherWrites: 0, productionWrites: 0 } };
  body.parametersHash = hash(body.parameters);
  return { version: VERSION, status: 'research-fitted', formalEligible: false, productionEligible: false,
    primary: null, companion: null, artifact: seal(body), lambda: null, p: null, features: null,
    fit: clone(optimization) };
}

function verifyResearchArtifact(artifact) {
  const artifactKeys = ['version', 'codeVersion', 'researchOnly', 'formalEligible', 'productionEligible', 'canonicalAdmission',
    'trustedOfficial90Minute', 'venuePolicy', 'neutralEvidence', 'historicalBacktestAllowed', 'source', 'metadataApproval',
    'inputHash', 'entities', 'trainingRows', 'trainingRowsHash', 'config', 'parameters', 'objective', 'optimization',
    'fitStartedAt', 'fitCompletedAt', 'createdAt', 'availableAt', 'trainedThrough', 'historicalAsOf', 'actualEndedAt',
    'roster', 'injuries', 'fatigue', 'xg', 'accuracyMeasured', 'calibrationMeasured', 'hitRate', 'invariants', 'parametersHash', 'contentHash'];
  if (!plainJson(artifact) || !completeKeys(artifact, artifactKeys) || !sealed(artifact) || artifact.version !== ARTIFACT_VERSION || artifact.codeVersion !== VERSION
    || artifact.formalEligible !== false || artifact.productionEligible !== false || artifact.researchOnly !== true
    || artifact.venuePolicy !== 'venue-agnostic' || artifact.neutralEvidence !== null || artifact.historicalBacktestAllowed !== false
    || artifact.canonicalAdmission !== false || artifact.trustedOfficial90Minute !== false
    || artifact.accuracyMeasured !== false || artifact.calibrationMeasured !== false || artifact.hitRate !== null
    || ['historicalAsOf', 'actualEndedAt', 'roster', 'injuries', 'fatigue', 'xg'].some(k => artifact[k] !== null)
    || !completeKeys(artifact.invariants, ['marketInputs', 'registryWrites', 'publisherWrites', 'productionWrites'])
    || Object.values(artifact.invariants).some(v => v !== 0)
    || !Array.isArray(artifact.entities) || !Array.isArray(artifact.trainingRows)
    || !completeKeys(artifact.config, Object.keys(DEFAULT_CONFIG)) || !configFrom(artifact.config)
    || !object(artifact.metadataApproval)
    || !completeKeys(artifact.parameters, ['intercept', 'attack', 'defense', 'defenseMeaning', 'identifiability', 'homeAdvantage'])
    || artifact.parameters.defenseMeaning !== 'positive means opponent scores more'
    || artifact.parameters.identifiability !== 'sum attack=0;sum defense=0'
    || artifact.parameters.homeAdvantage !== 0 || hash(artifact.parameters) !== artifact.parametersHash
    || !Array.isArray(artifact.parameters.attack) || !Array.isArray(artifact.parameters.defense)
    || artifact.parameters.attack.length !== artifact.entities.length || artifact.parameters.defense.length !== artifact.entities.length
    || !withinParameterDomain(artifact.parameters, artifact.config)
    || ['attack', 'defense'].some(k => Math.abs(artifact.parameters[k].reduce((a, b) => a + b, 0)) > 1e-7)
    || !noLater(artifact.fitStartedAt, artifact.fitCompletedAt) || !equalClock(artifact.createdAt, artifact.fitCompletedAt)
    || !equalClock(artifact.availableAt, artifact.fitCompletedAt) || !before(artifact.trainedThrough, artifact.fitStartedAt)
    || artifact.objective !== 'mean two-team Poisson negative log likelihood including log(goal!);plus regularization/(2*teamCount)*sum(attack^2+defense^2)'
    || !completeKeys(artifact.optimization, ['algorithm', 'initialObjective', 'finalObjective', 'completedIterations', 'converged',
      'lineSearchStopped', 'finalGradientNorm', 'finalProjectedGradientNorm', 'stopReason'])) return false;
  const input = { version: INPUT_VERSION, researchOnly: true, source: artifact.source, entities: artifact.entities,
    rows: artifact.trainingRows, approval: artifact.metadataApproval, config: artifact.config };
  if (hash(artifact.entities) !== hash([...artifact.entities].sort((a, b) => String(a?.entityRef).localeCompare(String(b?.entityRef))))
    || hash(artifact.trainingRows) !== hash([...artifact.trainingRows].sort((a, b) => String(a?.sourceRecordRef).localeCompare(String(b?.sourceRecordRef))))) return false;
  // Approval binds the complete source/row/entity set in stable source-reference order.
  if (artifact.metadataApproval.approvedInputHash !== artifact.inputHash || researchInputHash(input) !== artifact.inputHash
    || hash(artifact.trainingRows) !== artifact.trainingRowsHash) return false;
  const check = inspectResearchAdmission(input, artifact.fitStartedAt);
  if (check.status === 'blocked') return false;
  const latestKnownAt = artifact.trainingRows.reduce((a, r) => clock(r.knownAt) > clock(a) ? r.knownAt : a, artifact.metadataApproval.reviewedAt);
  if (!equalClock(latestKnownAt, artifact.trainedThrough)) return false;
  const indexes = new Map(artifact.entities.map((e, i) => [e.entityRef, i]));
  const rows = artifact.trainingRows.map(r => ({ h: indexes.get(r.homeEntityRef), a: indexes.get(r.awayEntityRef), hg: r.homeGoals, ag: r.awayGoals }));
  // Full deterministic fit replay binds the declared procedure, not just one likelihood value.
  const replay = optimize(rows, artifact.entities.length, artifact.config);
  const parameters = { ...replay.parameters, defenseMeaning: 'positive means opponent scores more',
    identifiability: 'sum attack=0;sum defense=0', homeAdvantage: 0 };
  return hash(parameters) === artifact.parametersHash && hash(replay.optimization) === hash(artifact.optimization);
}

function poissonValues(lambda, maxGoals) {
  const probabilities = [Math.exp(-lambda)];
  for (let k = 1; k <= maxGoals; k++) probabilities.push(probabilities[k - 1] * lambda / k);
  return probabilities;
}
function goalGrid(homeLambda, awayLambda, maxGoals, handicap) {
  if (!finite(homeLambda, 0, 12) || !finite(awayLambda, 0, 12) || !integer(maxGoals, 4, 40) || !integer(handicap, -5, 5))
    throw new RangeError('research-score-grid-numerical-domain-invalid');
  const home = poissonValues(homeLambda, maxGoals), away = poissonValues(awayLambda, maxGoals);
  const cells = home.flatMap((hp, h) => away.map((ap, a) => ({ home: h, away: a, rawProbability: hp * ap })));
  const rawMass = cells.reduce((s, r) => s + r.rawProbability, 0);
  const had = { H: 0, D: 0, A: 0 }, hhad = { H: 0, D: 0, A: 0 };
  for (const cell of cells) {
    cell.probability = cell.rawProbability / rawMass;
    had[cell.home > cell.away ? 'H' : cell.home < cell.away ? 'A' : 'D'] += cell.probability;
    const diff = cell.home + handicap - cell.away;
    hhad[diff > 0 ? 'H' : diff < 0 ? 'A' : 'D'] += cell.probability;
  }
  const top3 = [...cells].sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away).slice(0, 3);
  return { maxGoals, cells, rawMass, tailMass: Math.max(0, 1 - rawMass), probabilityBasis: 'conditional-on-finite-grid-support',
    had, hhad: { handicap, probabilities: hhad, meaning: 'home goals+integer handicap compared with away goals' }, top3,
    marginalTailErrorBound: Math.max(0, 1 - rawMass), primary: null, companion: null };
}
function forecastZeroMarketResearch(request) {
  const forecastStartedAt = new Date().toISOString();
  if (!plainJson(request) || !completeKeys(request, ['artifact', 'event', 'approval']) || forbiddenField({ event: request?.event, approval: request?.approval })) return blocked(['forecast-schema-or-market-field-forbidden']);
  const { artifact, event, approval } = request;
  if (!verifyResearchArtifact(artifact)) return blocked(['research-artifact-invalid']);
  if (artifact.optimization.converged !== true || artifact.optimization.lineSearchStopped !== false) return blocked(['research-fit-not-converged']);
  const asOf = forecastStartedAt;
  const reasons = [], refs = new Set(artifact.entities.map(e => e.entityRef));
  if (!before(artifact.availableAt, asOf)) reasons.push('model-not-available-before-actual-forecast');
  if (!exactKeys(event, ['sourceEventRef', 'recordedSourceMatchId', 'eventVersion', 'sourceNominalDate', 'cutoffAt', 'homeTeamId', 'awayTeamId', 'homeEntityRef', 'awayEntityRef', 'observedAt', 'knownAt', 'status', 'saleStatus', 'neutral', 'integerHandicap'])
    || !text(event.sourceEventRef) || !event.sourceEventRef.startsWith(artifact.source.namespace + '#')
    || !text(event.recordedSourceMatchId) || !text(event.homeTeamId) || !text(event.awayTeamId)
    || event.homeTeamId === event.awayTeamId || !refs.has(event.homeEntityRef) || !refs.has(event.awayEntityRef)
    || event.homeEntityRef === event.awayEntityRef || !date(event.sourceNominalDate)
    || !before(asOf, event.eventVersion) || !before(asOf, event.cutoffAt) || !noLater(event.cutoffAt, event.eventVersion)
    || !noLater(event.observedAt, event.knownAt) || !noLater(event.knownAt, asOf)
    || event.status !== 'SCHEDULED' || event.saleStatus !== 'OPEN' || event.neutral !== null
    || !integer(event.integerHandicap, -5, 5)) reasons.push('future-ordered-event-clock-or-identity-invalid');
  if (!exactKeys(approval, ['version', 'approved', 'researchOnly', 'reviewId', 'reviewer', 'reviewedAt', 'inputHash', 'sourceEventRef', 'eventVersion', 'cutoffAt', 'orderedTeamIds', 'orderedEntityRefs', 'sourceNominalDate', 'sourceTimezoneMappingApproved', 'sourceAliasApproved', 'approvedEventHash', 'eventEvidenceSha256'])
    || approval.version !== EVENT_APPROVAL_VERSION || approval.approved !== true || approval.researchOnly !== true
    || !text(approval.reviewId) || !text(approval.reviewer) || !noLater(event?.observedAt, approval.reviewedAt)
    || !noLater(approval.reviewedAt, event?.knownAt) || approval.approvedEventHash !== hash(event)
    || !HASH.test(approval.eventEvidenceSha256 || '')
    || !noLater(artifact.metadataApproval.reviewedAt, approval.reviewedAt) || approval.inputHash !== artifact.inputHash
    || approval.sourceEventRef !== event?.sourceEventRef || !equalClock(approval.eventVersion, event?.eventVersion)
    || !equalClock(approval.cutoffAt, event?.cutoffAt) || approval.sourceNominalDate !== event?.sourceNominalDate
    || hash(approval.orderedTeamIds) !== hash([event?.homeTeamId, event?.awayTeamId])
    || hash(approval.orderedEntityRefs) !== hash([event?.homeEntityRef, event?.awayEntityRef])
    || approval.sourceTimezoneMappingApproved !== true || approval.sourceAliasApproved !== true)
    reasons.push('explicit-future-event-alias-clock-approval-required');
  if (artifact.trainingRows.some(r => r.sourceRecordRef === event?.sourceEventRef
    || [r.sourceNominalDate, r.homeEntityRef, r.awayEntityRef].join('|') === [event?.sourceNominalDate, event?.homeEntityRef, event?.awayEntityRef].join('|')))
    reasons.push('current-event-in-training');
  if (artifact.trainingRows.some(r => r.sourceNominalDate >= event?.sourceNominalDate)) reasons.push('future-or-same-source-day-label-at-target');
  if (reasons.length) return blocked(reasons);
  const hi = artifact.entities.findIndex(e => e.entityRef === event.homeEntityRef), ai = artifact.entities.findIndex(e => e.entityRef === event.awayEntityRef);
  const p = artifact.parameters;
  const lambda = { home: Math.exp(p.intercept + p.attack[hi] + p.defense[ai]), away: Math.exp(p.intercept + p.attack[ai] + p.defense[hi]) };
  if (!finite(lambda.home, 0.05, 12) || !finite(lambda.away, 0.05, 12)) return blocked(['fitted-rate-outside-research-numerical-bound']);
  const grid = goalGrid(lambda.home, lambda.away, artifact.config.maxGoals, event.integerHandicap);
  const forecastCompletedAt = new Date().toISOString();
  if (!noLater(forecastStartedAt, forecastCompletedAt) || !before(artifact.availableAt, forecastCompletedAt)
    || !before(forecastCompletedAt, event.cutoffAt) || !before(forecastCompletedAt, event.eventVersion)
    || !noLater(event.knownAt, forecastCompletedAt) || !noLater(approval.reviewedAt, forecastCompletedAt))
    return blocked(['actual-freeze-clock-regressed-or-at-after-cutoff']);
  const body = { version: FORECAST_VERSION, frozen: true, researchOnly: true, formalEligible: false,
    productionEligible: false, canonicalAdmission: false, trustedOfficial90Minute: false, primary: null, companion: null,
    asOf: forecastCompletedAt, forecastStartedAt, forecastCompletedAt, frozenAt: forecastCompletedAt,
    actualModelAvailableAt: artifact.availableAt, trainedThrough: artifact.trainedThrough,
    artifactHash: artifact.contentHash, trainingInputHash: artifact.inputHash, event: clone(event), eventApproval: clone(approval),
    venuePolicy: 'venue-agnostic', neutral: null, homeAdvantage: 0, lambda, grid,
    baselineKind: 'fitted-independent-poisson-goals-only', distributionKind: 'independent-poisson-not-dixon-coles',
    marketComparator: null, factors: { roster: null, injuries: null, fatigue: null, xg: null, restDays: null },
    sourceLabelScope: 'CC0 ordinary FT-format research;not confirmed official90-minute results',
    historicalAsOf: null, historicalBacktestAllowed: false, accuracyMeasured: false, calibrationMeasured: false, hitRate: null };
  body.predictionHash = hash(body);
  return { version: VERSION, status: 'research-frozen', formalEligible: false, productionEligible: false,
    primary: null, companion: null, forecast: seal(body), artifact: null, lambda, p: grid.had, features: null, fit: null };
}

module.exports = { VERSION, INPUT_VERSION, APPROVAL_VERSION, EVENT_APPROVAL_VERSION, ARTIFACT_VERSION, FORECAST_VERSION,
  DEFAULT_CONFIG, researchInputHash, inspectResearchAdmission, fitZeroMarketResearch, forecastZeroMarketResearch,
  verifyResearchArtifact, goalGrid, hash };
