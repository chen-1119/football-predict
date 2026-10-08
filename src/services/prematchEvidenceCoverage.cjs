'use strict';
const {epochNanoseconds: clock} = require('./prematchV3Clock.cjs');
const SIDES = ['home', 'away'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function playerKey(row) {
  if (!object(row)) return null;
  const id = row.playerId ?? row.id ?? row.player?.id;
  if (typeof id === 'string' && id.trim()) return 'id:' + id.trim();
  if (Number.isSafeInteger(id) && id >= 0) return 'id:' + id;
  // A name is adequate for display deduplication only, never an entity mapping.
  const name = text(row.name ?? row.player?.name);
  return name ? 'name:' + name.normalize('NFKC').toLowerCase() : null;
}
function players(rows) {
  if (!Array.isArray(rows) || rows.length > 100) return [];
  return [...new Set(rows.map(playerKey).filter(Boolean))];
}
function evidenceWindow(value, asOf, cutoff) {
  const at = clock(asOf), end = clock(cutoff);
  const received = clock(value?.receivedAt ?? value?.sourceReceivedAt);
  const published = clock(value?.sourcePublishedAt ?? value?.sourceObservedAt);
  if (!text(value?.source) || at === null || received === null || published === null || published > received || received > at)
    return 'unknown';
  if (end === null) return 'cutoff-unknown';
  if (received >= end || value.usableForPreMatch === false || value.eligibleAtCutoff === false) return 'display-only';
  if (at - received > 24n * 60n * 60n * 1000000000n) return 'stale';
  return 'known-before-cutoff';
}
function summarizePrematchEvidence({signal = {}, asOf, cutoff} = {}) {
  const legacy = signal.lineups || {};
  const explicitlyConfirmed = legacy.confirmed === true || ['confirmed-lineup','official-starting-xi'].includes(legacy.evidenceType);
  const confirmed = signal.confirmedLineup || (explicitlyConfirmed ? legacy : {});
  const projected = signal.projectedRoster || (!explicitlyConfirmed ? legacy : {});
  const injuries = signal.injuries || {};
  const cw = evidenceWindow(confirmed, asOf, cutoff), pw = evidenceWindow(projected, asOf, cutoff);
  const iw = evidenceWindow(injuries, asOf, cutoff);
  const sides = Object.fromEntries(SIDES.map(side => {
    const official = players(confirmed[side]), expected = players(projected[side]), absences = players(injuries[side]);
    const complete = cw === 'known-before-cutoff' && confirmed.verified === true && official.length === 11;
    const probable = pw === 'known-before-cutoff' && expected.length > 0;
    return [side, {
      lineupStatus: complete ? 'confirmed' : probable ? 'projected' : 'unknown',
      confirmedPlayers: complete ? official.length : 0,
      projectedPlayers: probable ? expected.length : 0,
      lineupSource: complete ? confirmed.source : probable ? projected.source : null,
      injuryStatus: iw === 'known-before-cutoff' && absences.length ? 'reported' : 'unknown',
      injuryPlayers: iw === 'known-before-cutoff' && absences.length ? absences.length : null,
      conflicts: complete && probable ? expected.filter(id => !official.includes(id)).length : null,
    }];
  }));
  return {version:'prematch-evidence-coverage-v1',asOf,cutoff,sides,
    windows:{confirmed:cw,projected:pw,injuries:iw},
    confirmedBoth:SIDES.every(side => sides[side].lineupStatus === 'confirmed'),
    projectedAny:SIDES.some(side => sides[side].lineupStatus === 'projected'),
    degraded:SIDES.some(side => sides[side].lineupStatus !== 'confirmed' || sides[side].injuryStatus === 'unknown'),
    missingInjuriesMean:'unknown-not-healthy',numericProbabilityAdjustment:null,
    identityScope:'caller-bound-event;display-names-never-create-player-mappings',
    modelPolicy:'use-only-a-validated-model-whose-required-features-are-known;never-redistribute-missing-weights',
    formalEligible:false};
}
module.exports = {summarizePrematchEvidence, evidenceWindow};
