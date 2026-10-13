'use strict';

// A source inventory for review. It never acquires a lock, reads live owners,
// issues a fencing token, connects to PostgreSQL or starts a process.
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
const ROLE_NAMES = Object.freeze(['official', 'market', 'team', 'recommendation', 'settlement', 'combo-archive']);
const RESOURCE_CATALOG = freeze([
  { id: 'native-publication', kind: 'filesystem-and-postgres',
    targets: ['immutable generation and publication pointers', 'football.projection_meta', 'football.match_snapshots'],
    coordination: ['native publication lock', 'football-postgres-projection-sync-v1'],
    evidence: ['scripts/runSyncWorker.cjs', 'scripts/postgresProjectionSync.cjs'],
    scope: 'The legacy worker creates generations and commits their PostgreSQL projection.' },
  { id: 'private-model-artifacts', kind: 'postgres', targets: ['football.private_model_artifacts'],
    coordination: ['football-postgres-projection-sync-v1'],
    evidence: ['scripts/postgresProjectionSync.cjs', 'scripts/teamEvidenceStore.cjs',
      'scripts/recommendationPlatform/leagueBaselineRuntime.cjs', 'services/tasks/combo-archive.cjs'],
    scope: 'Different key namespaces share the existing projection transaction lock; table overlap does not imply equal payload ownership.' },
  { id: 'legacy-model-files', kind: 'filesystem',
    targets: ['public/data/model-evaluation.json', 'model-artifacts/model-learning-registry.json',
      'model-artifacts/model-learning.db', 'model-artifacts/model-learning-head.json'],
    coordination: ['locks/sync-enrichment-artifacts.lock (installed r853 contract)'],
    evidence: ['scripts/runSyncWorker.cjs', 'scripts/runModelBacktest.cjs',
      'scripts/runModelLearningCycle.cjs', 'scripts/runAutonomousModelCycle.cjs'],
    scope: 'Known default locations only. Configured paths, all writers and the r853 implementation must be verified before handover.' },
  { id: 'market-observations', kind: 'postgres',
    targets: ['football.market_collector_runs', 'football.market_observations', 'football.market_latest', 'football.market_feature_latest'],
    coordination: ['football-market-collector:500.com:jczq'],
    evidence: ['scripts/runMarketCollector.cjs', 'collectors/market/store.cjs', 'collectors/market/features.cjs'],
    scope: 'The collector session lock spans network acquisition; persistence has its own transaction.' },
  { id: 'recommendation-decisions', kind: 'postgres',
    targets: ['football.recommendation_decisions', 'football.recommendation_combo_records', 'football.recommendation_combo_legs'],
    coordination: ['recommendation-center:publish', 'recommendation-center:combos'],
    evidence: ['scripts/recommendationPlatform/runtime.cjs', 'scripts/recommendationPlatform/repository.cjs'],
    scope: 'The publishing cycle owns decisions and frozen combination records; enabled policy controls which writes actually occur.' },
  { id: 'recommendation-results', kind: 'postgres',
    targets: ['football.recommendation_result_events', 'football.recommendation_result_heads'],
    coordination: ['recommendation-center:settlement'],
    evidence: ['scripts/recommendationPlatform/runtime.cjs', 'scripts/recommendationPlatform/repository.cjs'],
    scope: 'The settlement cycle retains result events and their selected heads.' },
  { id: 'recommendation-view', kind: 'postgres', targets: ['football.daily_featured_combo_state:recommendationCenter'],
    coordination: ['recommendation-center:view'],
    evidence: ['scripts/recommendationPlatform/runtime.cjs', 'scripts/recommendationPlatform/repository.cjs'],
    scope: 'Both publishingCycle and settlementCycle call view and write the same recommendationCenter field.' },
]);
const ROLES = freeze({
  official: { entry: 'scripts/runSyncWorker.cjs', legacyUnit: 'football-sync-worker.service',
    ownership: 'legacy-composite-worker',
    reads: [], writes: ['native-publication', 'private-model-artifacts', 'legacy-model-files'],
    unresolved: ['official-source-and-postprocessing-extraction', 'all-model-and-enrichment-writers', 'configured-filesystem-paths'] },
  market: { entry: 'scripts/runMarketCollector.cjs', legacyUnit: 'football-market-collector.service',
    ownership: 'existing-independent-unit', reads: [], writes: ['market-observations'],
    unresolved: ['market-commit-outcome-reconciliation'] },
  team: { entry: 'services/tasks/team.cjs', legacyUnit: 'football-sync-worker.service',
    ownership: 'inside-legacy-composite-worker', reads: ['native-publication'], writes: ['private-model-artifacts'],
    unresolved: ['legacy-team-consumer-extraction'] },
  recommendation: { entry: 'scripts/dailyFeaturedComboLedger.cjs', legacyUnit: 'football-featured-combo.service',
    ownership: 'existing-independent-unit', reads: ['native-publication', 'market-observations', 'recommendation-results'],
    writes: ['private-model-artifacts', 'recommendation-decisions', 'recommendation-view'],
    unresolved: ['publisher-policy-dependent-write-closure'] },
  settlement: { entry: 'services/tasks/settlement.cjs', legacyUnit: 'football-recommendation-settlement.service',
    ownership: 'existing-independent-unit', reads: ['native-publication', 'private-model-artifacts', 'recommendation-decisions'],
    writes: ['recommendation-results', 'recommendation-view'], unresolved: [] },
  'combo-archive': { entry: 'services/tasks/combo-archive.cjs', legacyUnit: null,
    ownership: 'installed-owner-unresolved', reads: ['native-publication', 'recommendation-view'],
    writes: ['private-model-artifacts'], unresolved: ['combo-archive-installed-owner'] },
});
const EXTERNAL_WRITERS = freeze([
  { entry: 'scripts/publishReviewedAnalysis.cjs', resource: 'private-model-artifacts',
    reason: 'Manual reviewed publication uses two transactions, including a separate ACK; it is outside the six task roles.' },
  { entry: 'scripts/runModelBacktest.cjs', resource: 'legacy-model-files',
    reason: 'Direct model entry points and configured paths require a complete writer inventory.' },
]);
const GLOBAL_UNRESOLVED = Object.freeze([
  'installed-root-writer-controller-and-domain-signature',
  'postgres-fence-storage-and-every-write-transaction',
  'live-unit-cgroup-and-database-consumer-drain',
  'legacy-owner-role-mapping-in-handover-schema',
  'r853-hardening-preserved-in-integration-base',
  'complete-external-writer-inventory',
]);
function invalid(code) { throw Object.assign(new Error(code), { code }); }
function writerResourcePlan(selectedRoles, options = {}) {
  if (!Array.isArray(selectedRoles) || selectedRoles.length < 1 || selectedRoles.length > ROLE_NAMES.length)
    invalid('INVALID_WRITER_RESOURCE_ROLES');
  const requested = new Set();
  for (const role of selectedRoles) {
    if (typeof role !== 'string' || !ROLE_NAMES.includes(role)) invalid('UNKNOWN_WRITER_RESOURCE_ROLE');
    if (requested.has(role)) invalid('DUPLICATE_WRITER_RESOURCE_ROLE');
    requested.add(role);
  }
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => key !== 'observedResourceIds')) invalid('INVALID_WRITER_RESOURCE_OPTIONS');
  const observed = Object.hasOwn(options, 'observedResourceIds') ? options.observedResourceIds : [];
  if (!Array.isArray(observed) || observed.length > 128
    || [...observed].some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(id)))
    invalid('INVALID_OBSERVED_WRITER_RESOURCES');
  const names = ROLE_NAMES.filter(role => requested.has(role));
  const roles = names.map(role => ({ role, ...ROLES[role] }));
  const ids = new Set(roles.flatMap(role => [...role.reads, ...role.writes]));
  const resources = RESOURCE_CATALOG.filter(resource => ids.has(resource.id)).map(resource => ({ ...resource,
    readers: names.filter(role => ROLES[role].reads.includes(resource.id)),
    writers: names.filter(role => ROLES[role].writes.includes(resource.id)),
    liveVerified: false,
  }));
  const conflicts = [], dependencies = [], handoverCouplings = [];
  for (const resource of resources) {
    for (let i = 0; i < resource.writers.length; i++) for (let j = i + 1; j < resource.writers.length; j++)
      conflicts.push({ resourceId: resource.id, roles: [resource.writers[i], resource.writers[j]],
        kind: 'shared-write-resource', coordination: resource.coordination, ownershipTransferProven: false });
    for (const writer of resource.writers) for (const reader of resource.readers)
      if (writer !== reader) dependencies.push({ resourceId: resource.id, writer, reader, kind: 'committed-data-dependency' });
  }
  for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++)
    if (roles[i].legacyUnit && roles[i].legacyUnit === roles[j].legacyUnit)
      handoverCouplings.push({ roles: [roles[i].role, roles[j].role], legacyUnit: roles[i].legacyUnit,
        reason: 'Stopping this legacy unit affects both roles; separate ownership has not been proved.' });
  const knownIds = new Set(RESOURCE_CATALOG.map(resource => resource.id));
  const unresolved = GLOBAL_UNRESOLVED.map(code => ({ code, role: null }));
  for (const role of roles) for (const code of role.unresolved) unresolved.push({ code, role: role.role });
  for (const resourceId of [...new Set(observed)].sort()) {
    if (!knownIds.has(resourceId)) unresolved.push({ code: 'unknown-resource', resourceId, role: null });
    else if (!ids.has(resourceId)) unresolved.push({ code: 'resource-not-mapped-to-selected-roles', resourceId, role: null });
  }
  return freeze({ version: 'writer-resource-plan-v1', purpose: 'source-review-only',
    activationEligible: false, executionPermit: false, sqlFenceImplemented: false, liveVerified: false,
    scopeComplete: false, noListedConflictProvesIsolation: false,
    roles, resources, conflicts, dependencies, handoverCouplings, unresolved,
    externalWriters: EXTERNAL_WRITERS.filter(writer => ids.has(writer.resource)),
    evidenceBasis: 'Source inventory only; legacy unit names come from native release configuration, not a live systemd observation.',
  });
}
module.exports = { ROLE_NAMES, RESOURCE_CATALOG, writerResourcePlan };
