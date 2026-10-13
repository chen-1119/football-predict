'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { ROLE_NAMES, RESOURCE_CATALOG, writerResourcePlan } = require('../services/tasks/writerResourcePlan.cjs');
const { rolePlan } = require('../services/tasks/roles.cjs');
const root = path.resolve(__dirname, '..');

test('every nonempty role subset remains a nonexecuting incomplete source plan', () => {
  for (let mask = 1; mask < 1 << ROLE_NAMES.length; mask++) {
    const result = writerResourcePlan(ROLE_NAMES.filter((_, index) => mask & (1 << index)));
    a.equal(result.activationEligible, false); a.equal(result.executionPermit, false);
    a.equal(result.sqlFenceImplemented, false); a.equal(result.liveVerified, false);
    a.equal(result.scopeComplete, false); a.equal(result.noListedConflictProvesIsolation, false);
    a(result.unresolved.length > 0);
  }
});
test('plan entries match the actual task launch plans without launching tasks', () => {
  for (const role of writerResourcePlan(ROLE_NAMES).roles)
    a.equal(path.resolve(root, role.entry), rolePlan(role.role).script);
});
test('official and team retain their composite legacy owner and stop coupling', () => {
  const result = writerResourcePlan(['official', 'team']);
  a.equal(result.roles[0].ownership, 'legacy-composite-worker');
  a.deepEqual(result.handoverCouplings[0].roles, ['official', 'team']);
  a.equal(result.handoverCouplings[0].legacyUnit, 'football-sync-worker.service');
  a(result.unresolved.some(item => item.code === 'official-source-and-postprocessing-extraction'));
  a(result.resources.some(item => item.id === 'legacy-model-files'));
});
test('existing independent owners are not relabeled as the legacy sync worker', () => {
  const result = writerResourcePlan(['market', 'recommendation', 'settlement']);
  a.deepEqual(result.roles.map(role => role.legacyUnit), ['football-market-collector.service',
    'football-featured-combo.service', 'football-recommendation-settlement.service']);
  a.equal(result.handoverCouplings.length, 0);
});
test('publisher and settlement conflict on their shared materialized view', () => {
  const result = writerResourcePlan(['recommendation', 'settlement']);
  a(result.conflicts.some(item => item.resourceId === 'recommendation-view'
    && item.roles.join('/') === 'recommendation/settlement'
    && item.coordination.includes('recommendation-center:view') && !item.ownershipTransferProven));
});
test('artifact writers retain shared serialization and external reviewed publication', () => {
  const result = writerResourcePlan(['official', 'team', 'recommendation', 'combo-archive']);
  a.equal(result.conflicts.filter(item => item.resourceId === 'private-model-artifacts').length, 6);
  a(result.externalWriters.some(item => item.entry === 'scripts/publishReviewedAnalysis.cjs'));
  a(result.unresolved.some(item => item.code === 'complete-external-writer-inventory'));
});
test('read dependencies are not misreported as an additional writer', () => {
  const result = writerResourcePlan(['market', 'recommendation']);
  a(!result.conflicts.some(item => item.resourceId === 'market-observations'));
  a(result.dependencies.some(item => item.resourceId === 'market-observations'
    && item.writer === 'market' && item.reader === 'recommendation'));
});
test('unmapped resources remain unresolved, including duplicates and known resources', () => {
  const result = writerResourcePlan(['market'], { observedResourceIds: ['unknown-output', 'market-observations', 'unknown-output', 'native-publication'] });
  a.deepEqual(result.unresolved.filter(item => item.code === 'unknown-resource'),
    [{ code: 'unknown-resource', resourceId: 'unknown-output', role: null }]);
  a(result.unresolved.some(item => item.code === 'resource-not-mapped-to-selected-roles' && item.resourceId === 'native-publication'));
  a.equal(result.activationEligible, false);
});
test('combo archive has no fabricated installed previous owner', () => {
  const result = writerResourcePlan(['combo-archive']);
  a.equal(result.roles[0].legacyUnit, null);
  a(result.unresolved.some(item => item.code === 'combo-archive-installed-owner'));
});
test('duplicate roles are rejected instead of collapsing two requested writers', () => {
  a.throws(() => writerResourcePlan(['market', 'market']), { code: 'DUPLICATE_WRITER_RESOURCE_ROLE' });
});
test('unknown and prototype property names cannot become roles', () => {
  for (const role of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'unknown', 'official ', null, {}])
    a.throws(() => writerResourcePlan([role]), { code: 'UNKNOWN_WRITER_RESOURCE_ROLE' });
});
test('empty, malformed, sparse or excessive requests are rejected', () => {
  for (const roles of [null, {}, 'official', [], [...ROLE_NAMES, 'extra']])
    a.throws(() => writerResourcePlan(roles), { code: 'INVALID_WRITER_RESOURCE_ROLES' });
  a.throws(() => writerResourcePlan(new Array(1)), { code: 'UNKNOWN_WRITER_RESOURCE_ROLE' });
  for (const ids of [null, 'unknown', [null], ['../output'], new Array(1), Array(129).fill('unknown')])
    a.throws(() => writerResourcePlan(['market'], { observedResourceIds: ids }), { code: 'INVALID_OBSERVED_WRITER_RESOURCES' });
});
test('caller configuration cannot grant execution or replace resource ownership', () => {
  for (const options of [null, { activationEligible: true }, { resources: [] }, { executionPermit: true },
    Object.create({ observedResourceIds: [] })])
    a.throws(() => writerResourcePlan(['market'], options), { code: 'INVALID_WRITER_RESOURCE_OPTIONS' });
});
test('catalog and nested result are frozen against later mutation', () => {
  const result = writerResourcePlan(ROLE_NAMES);
  a.throws(() => RESOURCE_CATALOG[0].targets.push('extra'), TypeError);
  a.throws(() => result.roles[0].writes.push('unknown'), TypeError);
  a.throws(() => { result.activationEligible = true; }, TypeError);
  a.throws(() => { result.conflicts[0].ownershipTransferProven = true; }, TypeError);
  a.throws(() => { ROLE_NAMES[0] = 'unknown'; }, TypeError);
  a.equal(writerResourcePlan(['official']).activationEligible, false);
});
test('role order is deterministic and caller arrays are untouched', () => {
  const names = ['settlement', 'official'], observed = ['unknown-z', 'unknown-a'];
  const before = JSON.stringify([names, observed]);
  const result = writerResourcePlan(names, { observedResourceIds: observed });
  a.deepEqual(result, writerResourcePlan(['official', 'settlement'], { observedResourceIds: ['unknown-a', 'unknown-z'] }));
  a.equal(JSON.stringify([names, observed]), before);
});
test('real CLI plan exposes resource blockers without activating a writer', () => {
  const run = cp.spawnSync(process.execPath, [path.join(root, 'services/tasks/run.cjs'), 'official', '--plan'],
    { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  a.equal(run.status, 0, run.stderr); a.equal(run.stderr, '');
  const plan = JSON.parse(run.stdout);
  a.equal(plan.role, 'official');
  a.deepEqual(plan.writerResources, writerResourcePlan(['official']));
});
test('normal CLI and default runner continue refusing real writer startup', () => {
  const env = { ...process.env, FOOTBALL_SERVICE_LAYOUT: 'separated-v1' };
  const run = cp.spawnSync(process.execPath, [path.join(root, 'services/tasks/run.cjs'), 'official'],
    { cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  a.equal(run.status, 75); a.equal(run.stdout, '');
  a.equal(run.stderr.trim(), 'WRITER_HANDOVER_UNIMPLEMENTED');
  a.throws(() => require('../services/tasks/run.cjs').runTask('official', { env }),
    { code: 'WRITER_HANDOVER_UNIMPLEMENTED' });
});
