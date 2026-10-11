'use strict';
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const OFFICIAL_ENV = Object.freeze({ ENABLE_500_SYNC: '0', ENABLE_500_DETAILS_SYNC: '0', ENABLE_WEATHER_SYNC: '0',
  ENABLE_TEAM_EVIDENCE_SYNC: '0', ENABLE_OPENFOOTBALL_OBSERVATIONS: '0', ENABLE_FOOTBALL_DATA_FIXTURES_SYNC: '0',
  ENABLE_FOOTBALL_DATA_RESULTS_SYNC: '0', ENABLE_OPEN_RESEARCH_SYNC: '0', ENABLE_WEB_CONSENSUS_SYNC: '0',
  ENABLE_API_FOOTBALL_SYNC: '0', API_FOOTBALL_ENABLED: '0', ENABLE_MODEL_BACKTEST_ON_SYNC: '0', ENABLE_MODEL_STRATEGY_ON_SYNC: '0' });
const ROLES = Object.freeze({
  official: { script: 'scripts/runSyncWorker.cjs', args: ['--loop'], env: OFFICIAL_ENV },
  market: { script: 'scripts/runMarketCollector.cjs', args: ['--loop'], env: {} },
  team: { script: 'services/tasks/team.cjs', args: [], env: {}, intervalMs: 30 * 60_000 },
  recommendation: { script: 'scripts/dailyFeaturedComboLedger.cjs', args: ['--watch'], env: {} },
  'combo-archive': { script: 'services/tasks/combo-archive.cjs', args: [], env: {}, intervalMs: 30_000 },
  settlement: { script: 'services/tasks/settlement.cjs', args: ['--watch'], env: {} },
});
function rolePlan(role) {
  const plan = ROLES[role];
  if (!plan) throw Object.assign(new Error('Unknown task role'), { code: 'INVALID_TASK_ROLE' });
  return { role, root: ROOT, script: path.join(ROOT, plan.script), args: [...plan.args], env: { ...plan.env }, intervalMs: plan.intervalMs || null };
}
module.exports = { ROLES, rolePlan };
