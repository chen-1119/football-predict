'use strict';
const { strictInstant } = require('./strictInstant.cjs');
const { stableHash } = require('./webConsensusEvidence.cjs');

const VERSION = 'prematch-team-evidence-v3';
const PARAMETER_VERSION = 'prematch-team-parameters-v3';
const SIDES = ['home', 'away'];
const FAMILIES = ['roster', 'injuries', 'fatigue', 'history', 'xg'];
const ROSTER_FEATURES = ['attackContributionPer90', 'defenseContributionPer90', 'attackReplacementGapPer90', 'defenseReplacementGapPer90'];
const FAMILY_FEATURES = {
  injuries: ['knownUnavailablePlayers', 'knownUnavailableAttackGapPer90', 'knownUnavailableDefenseGapPer90'],
  fatigue: ['restDays', 'minutesLast7Days', 'minutesLast14Days', 'travelKm', 'rotationCount'],
  history: ['sampleCount', 'goalsForPerMatch', 'goalsAgainstPerMatch', 'pointsPerMatch'],
  xg: ['sampleCount', 'observedXgForPerMatch', 'observedXgAgainstPerMatch'],
};
const FEATURE_SCHEMA = Object.freeze({
  version: 'prematch-team-feature-schema-v3',
  features: Object.freeze(SIDES.flatMap(side => [
    ...['confirmed', 'projected'].flatMap(kind => ROSTER_FEATURES.map(name => `${side}.roster.${kind}.${name}`)),
    ...Object.entries(FAMILY_FEATURES).flatMap(([family, names]) => names.map(name => `${side}.${family}.${name}`)),
  ])),
  missing: 'null; never zero-filled or inferred from odds',
  contribution: 'provider-sourced per90 contribution and replacement rates with explicit metric labels; not predicted or observed match xG',
  xg: 'observed prior-match measurements only; estimated or odds-fitted xG is ineligible',
  sourceVerification: 'unverified; content and time checks are not external source admission',
});
const FEATURE_SCHEMA_HASH = stableHash(FEATURE_SCHEMA);
const HASH = /^[a-f0-9]{64}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
const id = v => text(v) || (Number.isSafeInteger(v) && v >= 0 ? String(v) : null);
// Preserve signed/source bytes and compare all nine fraction digits. Date.parse
// alone silently treats a future microsecond within the same millisecond as known.
const iso = v => strictInstant(v);
function clockNanoseconds(value) {
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d{1,9})(?=Z$|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d{1,9}(?=Z$|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9, '0'));
}
const strictlyBefore = (a, b) => clockNanoseconds(a) !== null && clockNanoseconds(b) !== null && clockNanoseconds(a) < clockNanoseconds(b);
const notAfter = (a, b) => clockNanoseconds(a) !== null && clockNanoseconds(b) !== null && clockNanoseconds(a) <= clockNanoseconds(b);
const sameClock = (a, b) => clockNanoseconds(a) !== null && clockNanoseconds(a) === clockNanoseconds(b);
const number = (v, low = -Infinity, high = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high ? v : null;
const integer = (v, low = 0, high = Infinity) => Number.isSafeInteger(v) && v >= low && v <= high ? v : null;
const unique = values => [...new Set(values)].sort();
const stamp = value => ({ ...value, contentHash: stableHash(value) });
const emptyFeatures = names => Object.fromEntries(names.map(name => [name, null]));
const clone = v => JSON.parse(JSON.stringify(v));

function sourceFor(value) {
  const source = object(value) ? value : {};
  return {
    provider: text(source.provider), endpoint: text(source.endpoint),
    receiptHash: HASH.test(source.receiptHash || '') ? source.receiptHash : null,
    rawPayloadHash: HASH.test(source.rawPayloadHash || '') ? source.rawPayloadHash : null,
    suppliedRowHash: HASH.test(source.suppliedRowHash || source.rowHash || '') ? source.suppliedRowHash || source.rowHash : null,
    sourceVerification: 'unverified',
  };
}
function eventFor(value) {
  const event = object(value) ? value : {};
  return {
    sourceMatchId: id(event.sourceMatchId), eventVersion: iso(event.eventVersion),
    homeTeamId: id(event.homeTeamId), awayTeamId: id(event.awayTeamId), cutoffAt: iso(event.cutoffAt),
    status: text(event.status), isOnSale: typeof event.isOnSale === 'boolean' ? event.isOnSale : null,
    saleStatus: text(event.saleStatus),
  };
}
function eventIssues(event, asOf) {
  const issues = [];
  if (!event.sourceMatchId || !event.eventVersion || !event.homeTeamId || !event.awayTeamId || !event.cutoffAt) issues.push('event-binding-incomplete');
  if (event.homeTeamId === event.awayTeamId) issues.push('event-teams-not-distinct');
  if (!asOf) issues.push('as-of-clock-invalid');
  if (asOf && event.cutoffAt && !strictlyBefore(asOf, event.cutoffAt)) issues.push('as-of-at-or-after-cutoff');
  if (asOf && event.eventVersion && !strictlyBefore(asOf, event.eventVersion)) issues.push('as-of-at-or-after-event');
  if (event.cutoffAt && event.eventVersion && !notAfter(event.cutoffAt, event.eventVersion)) issues.push('cutoff-after-event');
  if (event.status && !['SCHEDULED', 'TIMED', 'PENDING', 'NOT_STARTED'].includes(event.status.toUpperCase())) issues.push('event-not-prematch');
  if (event.isOnSale === false || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(event.saleStatus || '').toUpperCase())) issues.push('sale-not-open');
  return unique(issues);
}
function playerFor(value) {
  const player = object(value) ? value : {};
  const rates = input => ({ attack: number(input?.attack, -100, 100), defense: number(input?.defense, -100, 100) });
  return {
    playerId: id(player.playerId), availability: text(player.availability),
    expectedMinutes: number(player.expectedMinutes, 0, 120),
    contributionPer90: rates(player.contributionPer90), replacementPer90: rates(player.replacementPer90),
  };
}
function historyRowFor(value, family) {
  const row = object(value) ? value : {};
  const body = {
    sourceMatchId: id(row.sourceMatchId), eventVersion: iso(row.eventVersion), teamId: id(row.teamId),
    providerObservedAt: iso(row.providerObservedAt), receivedAt: iso(row.receivedAt), source: sourceFor(row.source),
    status: text(row.status),
    ...(family === 'history' ? { goalsFor: integer(row.goalsFor, 0, 30), goalsAgainst: integer(row.goalsAgainst, 0, 30) }
      : { observed: row.observed === true, observedXgFor: number(row.observedXgFor, 0, 20), observedXgAgainst: number(row.observedXgAgainst, 0, 20) }),
  };
  return { ...body, rowHash: stableHash(body) };
}
function dataFor(family, value) {
  const data = object(value) ? value : {};
  if (family === 'roster' || family === 'injuries') return {
    ...(family === 'roster' ? { status: text(data.status) } : {}),
    contributionMetric: { attack: text(data.contributionMetric?.attack), defense: text(data.contributionMetric?.defense) },
    players: Array.isArray(data.players) ? data.players.map(playerFor).sort((a, b) => String(a.playerId).localeCompare(String(b.playerId))) : [],
  };
  if (family === 'fatigue') return {
    lastMatchEndedAt: iso(data.lastMatchEndedAt), minutesLast7Days: number(data.minutesLast7Days, 0, 1000000),
    minutesLast14Days: number(data.minutesLast14Days, 0, 2000000), travelKm: number(data.travelKm, 0, 100000),
    rotationCount: integer(data.rotationCount, 0, 11),
  };
  return { rows: Array.isArray(data.rows) ? data.rows.map(row => historyRowFor(row, family)).sort((a, b) => a.rowHash.localeCompare(b.rowHash)) : [] };
}
function observationFor(value) {
  const observation = object(value) ? value : {};
  const family = FAMILIES.includes(observation.family) ? observation.family : null;
  const body = {
    family, side: SIDES.includes(observation.side) ? observation.side : null,
    sourceMatchId: id(observation.sourceMatchId), eventVersion: iso(observation.eventVersion), teamId: id(observation.teamId),
    source: sourceFor(observation.source), providerObservedAt: iso(observation.providerObservedAt), receivedAt: iso(observation.receivedAt),
    data: family ? dataFor(family, observation.data) : null,
  };
  return { ...body, rowHash: stableHash(body) };
}
function observationIssues(observation, event, asOf) {
  const issues = [];
  if (!observation.family || !observation.side) issues.push('observation-family-or-side-invalid');
  if (observation.sourceMatchId !== event.sourceMatchId || !sameClock(observation.eventVersion, event.eventVersion)) issues.push('observation-event-mismatch');
  if (!observation.teamId || observation.teamId !== event[`${observation.side}TeamId`]) issues.push('observation-team-mismatch');
  if (!observation.source.provider) issues.push('observation-source-missing');
  if (!observation.providerObservedAt || !observation.receivedAt) issues.push('observation-clock-incomplete');
  if (observation.providerObservedAt && observation.receivedAt && !notAfter(observation.providerObservedAt, observation.receivedAt)) issues.push('provider-time-after-receipt');
  if (asOf && observation.receivedAt && !notAfter(observation.receivedAt, asOf)) issues.push('observation-not-known-at-as-of');
  if (asOf && observation.providerObservedAt && !notAfter(observation.providerObservedAt, asOf)) issues.push('provider-observation-in-future');
  return unique(issues);
}
function resultFor(names, issues = ['no-admissible-observation']) {
  return { status: 'unknown', features: emptyFeatures(names), evidenceHashes: [], issues, sourceVerification: 'unverified', formalEligible: false };
}
function selectObservation(observations, names) {
  if (!observations.length) return { result: resultFor(names) };
  const latest = observations.reduce((max, row) => clockNanoseconds(row.receivedAt) > max ? clockNanoseconds(row.receivedAt) : max, clockNanoseconds(observations[0].receivedAt));
  const rows = observations.filter(o => clockNanoseconds(o.receivedAt) === latest);
  const hashes = unique(rows.map(o => o.rowHash));
  // Two source rows known at the same receipt clock must agree on feature data.
  if (new Set(rows.map(o => stableHash(o.data))).size > 1) return {
    result: { ...resultFor(names, ['same-time-observation-conflict']), status: 'conflict', evidenceHashes: hashes },
  };
  return { observation: rows.sort((a, b) => a.rowHash.localeCompare(b.rowHash))[0], hashes };
}
function playerIssues(players, requireEleven) {
  const issues = [];
  if (requireEleven && players.length !== 11) issues.push('roster-requires-eleven-starters');
  if (!players.length) issues.push('source-empty-is-unknown');
  if (players.some(p => !p.playerId)) issues.push('player-identity-missing');
  if (new Set(players.map(p => p.playerId)).size !== players.length) issues.push('duplicate-player');
  return issues;
}
function summedRates(players, metric, key, replacement) {
  if (!metric || !players.length || players.some(p => p.contributionPer90[key] === null || (replacement && p.replacementPer90[key] === null))) return null;
  return players.reduce((sum, p) => sum + p.contributionPer90[key] - (replacement ? p.replacementPer90[key] : 0), 0);
}
function rosterResult(observations) {
  const selected = selectObservation(observations, ROSTER_FEATURES);
  if (selected.result) return selected.result;
  const { data } = selected.observation, issues = playerIssues(data.players, true);
  const result = { ...resultFor(ROSTER_FEATURES, issues), evidenceHashes: selected.hashes };
  if (issues.length) return result;
  result.features = {
    attackContributionPer90: summedRates(data.players, data.contributionMetric.attack, 'attack', false),
    defenseContributionPer90: summedRates(data.players, data.contributionMetric.defense, 'defense', false),
    attackReplacementGapPer90: summedRates(data.players, data.contributionMetric.attack, 'attack', true),
    defenseReplacementGapPer90: summedRates(data.players, data.contributionMetric.defense, 'defense', true),
  };
  result.issues = Object.entries(result.features).filter(([, v]) => v === null).map(([k]) => `contribution-unavailable:${k}`);
  result.status = result.issues.length ? 'partial' : 'available';
  return result;
}
function injuriesResult(observations) {
  const names = FAMILY_FEATURES.injuries, selected = selectObservation(observations, names);
  if (selected.result) return selected.result;
  const { data } = selected.observation, issues = playerIssues(data.players, false);
  const result = { ...resultFor(names, issues), evidenceHashes: selected.hashes };
  if (issues.length) return result;
  const unavailable = data.players.filter(p => ['out', 'suspended'].includes(p.availability));
  result.features = {
    knownUnavailablePlayers: data.players.every(p => ['out', 'suspended', 'doubtful', 'available'].includes(p.availability)) ? unavailable.length : null,
    knownUnavailableAttackGapPer90: summedRates(unavailable, data.contributionMetric.attack, 'attack', true),
    knownUnavailableDefenseGapPer90: summedRates(unavailable, data.contributionMetric.defense, 'defense', true),
  };
  result.issues = Object.entries(result.features).filter(([, v]) => v === null).map(([k]) => `injury-impact-unknown:${k}`);
  if (data.players.some(p => p.availability === 'doubtful')) result.issues.push('doubtful-players-have-no-assumed-absence-probability');
  result.status = result.issues.length ? 'partial' : 'available';
  return result;
}
function fatigueResult(observations, event, asOf) {
  const names = FAMILY_FEATURES.fatigue, selected = selectObservation(observations, names);
  if (selected.result) return selected.result;
  const { data, providerObservedAt } = selected.observation;
  const ended = clockNanoseconds(data.lastMatchEndedAt);
  const restValid = ended !== null && notAfter(data.lastMatchEndedAt, providerObservedAt)
    && notAfter(data.lastMatchEndedAt, asOf) && strictlyBefore(data.lastMatchEndedAt, event.eventVersion);
  const features = {
    restDays: restValid ? Number(clockNanoseconds(event.eventVersion) - ended) / 86400000000000 : null,
    minutesLast7Days: data.minutesLast7Days, minutesLast14Days: data.minutesLast14Days,
    travelKm: data.travelKm, rotationCount: data.rotationCount,
  };
  const issues = Object.entries(features).filter(([, v]) => v === null).map(([k]) => `fatigue-unknown:${k}`);
  if (features.minutesLast7Days !== null && features.minutesLast14Days !== null && features.minutesLast7Days > features.minutesLast14Days) {
    features.minutesLast7Days = null; features.minutesLast14Days = null; issues.push('load-windows-inconsistent');
  }
  return { ...resultFor(names, unique(issues)), features, evidenceHashes: selected.hashes, status: issues.length ? 'partial' : 'available' };
}
function priorRowsResult(observations, family, event, asOf) {
  const names = FAMILY_FEATURES[family], selected = selectObservation(observations, names);
  if (selected.result) return selected.result;
  const observation = selected.observation, { rows } = observation.data, valid = [], issues = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.sourceMatchId}|${clockNanoseconds(row.eventVersion)}`;
    if (seen.has(key)) return { ...resultFor(names, ['duplicate-history-event']), status: 'conflict', evidenceHashes: selected.hashes };
    seen.add(key);
    const clocksValid = row.eventVersion && row.providerObservedAt && row.receivedAt
      && strictlyBefore(row.eventVersion, row.providerObservedAt)
      && notAfter(row.providerObservedAt, row.receivedAt)
      && notAfter(row.receivedAt, observation.receivedAt)
      && notAfter(row.receivedAt, asOf);
    const valuesValid = family === 'history' ? row.goalsFor !== null && row.goalsAgainst !== null
      : row.observed === true && row.observedXgFor !== null && row.observedXgAgainst !== null;
    if (!row.sourceMatchId || row.teamId !== observation.teamId || !row.source.provider || !clocksValid
      || (row.sourceMatchId === event.sourceMatchId && sameClock(row.eventVersion, event.eventVersion))
      || row.status !== 'FINISHED' || !valuesValid) issues.push(`prior-row-ineligible:${row.rowHash}`);
    else valid.push(row);
  }
  if (!valid.length) return { ...resultFor(names, unique([...issues, 'no-observed-prior-samples'])), evidenceHashes: selected.hashes };
  const avg = field => valid.reduce((n, row) => n + row[field], 0) / valid.length;
  const features = family === 'history' ? {
    sampleCount: valid.length, goalsForPerMatch: avg('goalsFor'), goalsAgainstPerMatch: avg('goalsAgainst'),
    pointsPerMatch: valid.reduce((n, row) => n + (row.goalsFor > row.goalsAgainst ? 3 : row.goalsFor === row.goalsAgainst ? 1 : 0), 0) / valid.length,
  } : { sampleCount: valid.length, observedXgForPerMatch: avg('observedXgFor'), observedXgAgainstPerMatch: avg('observedXgAgainst') };
  return { ...resultFor(names, unique(issues)), features, evidenceHashes: selected.hashes, status: issues.length ? 'partial' : 'available' };
}
function sidesFor(event, asOf, observations) {
  return Object.fromEntries(SIDES.map(side => {
    const rows = observations.filter(o => o.side === side), familyRows = family => rows.filter(o => o.family === family);
    return [side, {
      teamId: event[`${side}TeamId`],
      roster: Object.fromEntries(['confirmed', 'projected'].map(kind => [kind, rosterResult(familyRows('roster').filter(o => o.data.status === kind))])),
      injuries: injuriesResult(familyRows('injuries')),
      fatigue: fatigueResult(familyRows('fatigue'), event, asOf),
      history: priorRowsResult(familyRows('history'), 'history', event, asOf),
      xg: priorRowsResult(familyRows('xg'), 'xg', event, asOf),
    }];
  }));
}
function flattenPrematchTeamFeatures(snapshot) {
  return Object.fromEntries(FEATURE_SCHEMA.features.map(key => {
    const parts = key.split('.'), name = parts.pop();
    const section = parts.reduce((value, part) => value?.[part], snapshot?.sides);
    return [key, number(section?.features?.[name])];
  }));
}
function bodyFor(event, asOf, observations, rejected) {
  const blockers = eventIssues(event, asOf), sides = sidesFor(event, asOf, observations);
  return {
    version: VERSION, featureSchemaHash: FEATURE_SCHEMA_HASH, event, asOf,
    status: blockers.length ? 'blocked' : 'shadow-ready', blockers,
    sourceVerification: 'unverified', formalEligible: false,
    knowledgePolicy: 'providerObservedAt <= receivedAt <= asOf < cutoffAt <= eventVersion; no external source signature or admission is asserted',
    observations, rejected, sides,
    features: flattenPrematchTeamFeatures({ sides }),
  };
}
function buildPrematchTeamSnapshot(input = {}) {
  input = object(input) ? input : {};
  const event = eventFor(input.event), asOf = iso(input.asOf), observations = [], rejected = [];
  const invalidEvent = eventIssues(event, asOf);
  const candidates = Array.isArray(input.observations) ? input.observations : [];
  const seen = new Set();
  for (const value of candidates) {
    const row = observationFor(value), issues = unique([...observationIssues(row, event, asOf), ...(invalidEvent.length ? ['snapshot-event-ineligible'] : [])]);
    if (issues.length) {
      // Rejection metadata preserves a hash without retaining future/other-event feature values.
      const { data, ...metadata } = row;
      rejected.push({ ...metadata, reasons: issues });
    } else if (!seen.has(row.rowHash)) {
      seen.add(row.rowHash); observations.push(row);
    }
  }
  observations.sort((a, b) => a.rowHash.localeCompare(b.rowHash));
  rejected.sort((a, b) => a.rowHash.localeCompare(b.rowHash));
  return stamp(bodyFor(event, asOf, observations, rejected));
}
function verifyPrematchTeamSnapshot(snapshot) {
  try {
    if (!object(snapshot) || snapshot.version !== VERSION || snapshot.featureSchemaHash !== FEATURE_SCHEMA_HASH
      || snapshot.sourceVerification !== 'unverified' || snapshot.formalEligible !== false
      || !Array.isArray(snapshot.observations) || !Array.isArray(snapshot.rejected) || eventIssues(snapshot.event, snapshot.asOf).length) return false;
    if (stableHash(eventFor(snapshot.event)) !== stableHash(snapshot.event) || iso(snapshot.asOf) !== snapshot.asOf) return false;
    const seen = new Set();
    for (const row of snapshot.observations) {
      if (stableHash(observationFor(row)) !== stableHash(row) || observationIssues(row, snapshot.event, snapshot.asOf).length || seen.has(row.rowHash)) return false;
      seen.add(row.rowHash);
    }
    for (const row of snapshot.rejected) {
      if (!object(row) || Object.hasOwn(row, 'data') || !HASH.test(row.rowHash || '') || !Array.isArray(row.reasons) || !row.reasons.length) return false;
      const actual = observationIssues(row, snapshot.event, snapshot.asOf);
      if (stableHash(actual) !== stableHash(row.reasons)) return false;
    }
    const expected = stamp(bodyFor(snapshot.event, snapshot.asOf, snapshot.observations, snapshot.rejected));
    return stableHash(snapshot) === stableHash(expected);
  } catch { return false; }
}
function applyPrematchTeamEffects(snapshot, baseRates, parameterArtifact) {
  const before = { home: number(baseRates?.home, Number.MIN_VALUE), away: number(baseRates?.away, Number.MIN_VALUE) }, blockers = [];
  if (!verifyPrematchTeamSnapshot(snapshot)) blockers.push('team-snapshot-invalid');
  if (before.home === null || before.away === null) blockers.push('base-goal-rates-invalid');
  const artifact = object(parameterArtifact) ? parameterArtifact : null;
  if (!artifact) blockers.push('trained-parameters-missing');
  else {
    const { contentHash, ...body } = artifact;
    if (!HASH.test(contentHash || '') || stableHash(body) !== contentHash) blockers.push('parameter-hash-invalid');
    if (artifact.parametersHash !== undefined && (!object(artifact.model) || !HASH.test(artifact.parametersHash || '') || stableHash(artifact.model) !== artifact.parametersHash)) blockers.push('parameter-model-hash-invalid');
    if (artifact.version !== PARAMETER_VERSION || artifact.featureSchemaHash !== FEATURE_SCHEMA_HASH) blockers.push('parameter-feature-schema-mismatch');
    if (artifact.featureSchema !== undefined && stableHash(artifact.featureSchema) !== FEATURE_SCHEMA_HASH) blockers.push('parameter-feature-schema-mismatch');
    if (artifact.formalEligible !== false || artifact.status !== 'shadow-candidate') blockers.push('parameter-shadow-policy-invalid');
    const times = ['trainedThrough', 'createdAt', 'availableAt'];
    if (!times.every(k => strictlyBefore(artifact[k], snapshot?.asOf))) blockers.push('parameters-not-known-before-as-of');
    if (iso(artifact.trainedThrough) && snapshot?.event?.eventVersion && !strictlyBefore(artifact.trainedThrough, snapshot.event.eventVersion)) blockers.push('parameter-training-not-before-event');
    if (iso(artifact.createdAt) && iso(artifact.availableAt) && (!notAfter(artifact.trainedThrough, artifact.createdAt) || !notAfter(artifact.createdAt, artifact.availableAt))) blockers.push('parameter-clock-order-invalid');
    if (!object(artifact.training) || integer(artifact.training.sampleCount, 1) === null || artifact.training.split !== 'time-ordered'
      || !Array.isArray(artifact.training.trainingEventIds) || !artifact.training.trainingEventIds.length
      || artifact.training.trainingEventIds.some(value => !text(value))) blockers.push('parameter-training-binding-missing');
    if (artifact.training?.inputHashes !== undefined && (!Array.isArray(artifact.training.inputHashes)
      || !HASH.test(artifact.training.artifactHash || '') || stableHash(artifact.training.inputHashes) !== artifact.training.artifactHash)) blockers.push('parameter-training-hash-invalid');
    if (artifact.training?.knowledgeThrough !== undefined && artifact.training.knowledgeThrough !== artifact.trainedThrough) blockers.push('parameter-training-clock-binding-invalid');
    const isCurrent = value => {
      if (typeof value !== 'string' || !snapshot?.event) return false;
      if (value === snapshot.event.sourceMatchId) return true;
      const separator = value.indexOf('|');
      return separator > 0 && value.slice(0, separator) === snapshot.event.sourceMatchId
        && sameClock(value.slice(separator + 1), snapshot.event.eventVersion);
    };
    if (Array.isArray(artifact.training?.trainingEventIds) && artifact.training.trainingEventIds.some(isCurrent)) blockers.push('current-event-in-parameter-training');
    if (Array.isArray(artifact.training?.trainingSourceMatchIds) && artifact.training.trainingSourceMatchIds.includes(snapshot?.event?.sourceMatchId)) blockers.push('current-event-in-parameter-training');
    if (artifact.model?.kind !== 'lambda-loglinear' || !object(artifact.model.coefficients)
      || !SIDES.every(side => number(artifact.model?.intercept?.[side]) !== null && object(artifact.model.coefficients[side]))
      || number(artifact.model.maxAbsLogShift, Number.MIN_VALUE, 10) === null
      || number(artifact.model.lambdaFloor, Number.MIN_VALUE, 12) === null
      || number(artifact.model.lambdaCeiling, Number.MIN_VALUE, 12) === null
      || artifact.model.lambdaFloor > artifact.model.lambdaCeiling) blockers.push('parameter-model-invalid');
  }
  const features = snapshot?.features || {}, terms = { home: [], away: [] };
  if (artifact?.model?.coefficients && object(artifact.model.coefficients)) for (const side of SIDES) {
    const coefficients = artifact.model.coefficients[side];
    if (!object(coefficients)) continue;
    for (const [key, coefficient] of Object.entries(coefficients)) {
      if (!FEATURE_SCHEMA.features.includes(key) || number(coefficient) === null) { blockers.push(`parameter-coefficient-invalid:${side}:${key}`); continue; }
      if (coefficient === 0) continue;
      if (number(features[key]) === null) { blockers.push(`required-feature-unknown:${key}`); continue; }
      terms[side].push({ feature: key, value: features[key], coefficient, contribution: features[key] * coefficient });
    }
  }
  if (artifact && !terms.home.length && !terms.away.length) blockers.push('parameter-feature-effects-empty');
  const blocked = () => ({ version: 'prematch-team-effects-v3', status: 'blocked', applied: false, formalEligible: false,
    sourceVerification: 'unverified', blockers: unique(blockers), before, after: { ...before }, receipt: null });
  if (blockers.length) return blocked();
  const shifts = {}, after = {};
  for (const side of SIDES) {
    const raw = artifact.model.intercept[side] + terms[side].reduce((sum, term) => sum + term.contribution, 0);
    if (!Number.isFinite(raw)) { blockers.push('parameter-effect-overflow'); return blocked(); }
    const bounded = Math.max(-artifact.model.maxAbsLogShift, Math.min(artifact.model.maxAbsLogShift, raw));
    after[side] = Math.max(artifact.model.lambdaFloor, Math.min(artifact.model.lambdaCeiling, before[side] * Math.exp(bounded)));
    if (number(after[side], Number.MIN_VALUE) === null) { blockers.push('parameter-effect-overflow'); return blocked(); }
    shifts[side] = { unclampedLogShift: raw, appliedLogShift: bounded, intercept: artifact.model.intercept[side], terms: terms[side] };
  }
  const receipt = stamp({ version: 'prematch-team-effect-receipt-v3', event: clone(snapshot.event), asOf: snapshot.asOf,
    snapshotHash: snapshot.contentHash, featureSchemaHash: FEATURE_SCHEMA_HASH, parameterHash: artifact.contentHash,
    trainedThrough: artifact.trainedThrough, parameterAvailableAt: artifact.availableAt,
    rateBounds: { floor: artifact.model.lambdaFloor, ceiling: artifact.model.lambdaCeiling }, before, after, shifts,
    sourceVerification: 'unverified', formalEligible: false, scope: 'shadow-team-goal-rate-effect-only; no formal prediction or publication authority' });
  return { version: 'prematch-team-effects-v3', status: 'shadow-applied', applied: true, formalEligible: false,
    sourceVerification: 'unverified', blockers: [], before, after, receipt };
}

module.exports = { VERSION, PARAMETER_VERSION, FEATURE_SCHEMA, FEATURE_SCHEMA_HASH, clockNanoseconds, buildPrematchTeamSnapshot,
  verifyPrematchTeamSnapshot, flattenPrematchTeamFeatures, applyPrematchTeamEffects };
