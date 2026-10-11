'use strict';
const COMPONENTS = Object.freeze({
  web: { roots: ['apps/web'], units: ['football-web.service'], databaseWrites: false, build: 'node scripts/buildSeparatedWeb.cjs', entry: 'apps/web/server.js' },
  'read-api': { roots: ['services/read-api', 'services/recommendation', 'server', 'scripts', 'src/services', 'collectors/market/signalBridge.cjs', 'collectors/market/policy.cjs', 'deploy/light-server/collector-trust-registry.json'], units: ['football-read-api.service'], databaseWrites: false, entry: 'services/read-api/server.cjs' },
  collector: { roots: ['services/tasks', 'server', 'scripts', 'collectors', 'src/services', 'deploy/light-server/collector-trust-registry.json'], units: ['football-collector@official.service', 'football-collector@market.service', 'football-collector@team.service'], databaseWrites: true, entry: 'services/tasks/run.cjs' },
  recommendation: { roots: ['services/tasks', 'services/read-api', 'services/recommendation', 'server', 'scripts', 'src/services', 'collectors/market/signalBridge.cjs', 'collectors/market/policy.cjs', 'deploy/light-server/collector-trust-registry.json'], units: ['football-recommendation@recommendation.service', 'football-recommendation@settlement.service','football-recommendation@combo-archive.service'], databaseWrites: true, entry: 'services/tasks/run.cjs' },
});
function plan(component) {
  const policy = COMPONENTS[component];
  if (!policy) throw new Error('INVALID_COMPONENT');
  return { version: 'independent-component-release-plan-v1', component, ...policy,
    databaseCopies: 0, migrations: false, frontendRestart: component === 'web',
    requiresSignedActivation: true, requiresCompatibleApiContract: true,
    rollback: 'Only restore this component code pointer; preserve PostgreSQL commits, predictions and settlement.' };
}
module.exports = { COMPONENTS, plan };
