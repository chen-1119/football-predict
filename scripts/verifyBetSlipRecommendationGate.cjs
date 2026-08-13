const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(rootDir, 'src/services/generator.ts'), 'utf8');
const pageSource = fs.readFileSync(path.join(rootDir, 'src/pages/BetSlipGenerator.tsx'), 'utf8');
const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const hasAll = (...needles) => needles.every((needle) => source.includes(needle));

check('probability leader is sorted instead of fixed to home', hasAll(
  '.sort((a, b) => b.probability - a.probability)',
  'const isLeader = sourceEntries[0]?.code === outcome.code'
));

check('reference odds cannot enter an executable bet slip', hasAll(
  "if (selection.generatedFrom !== 'existing-prediction') return false",
  "if (selection.prediction.marketType !== 'BEST') return false",
  "if (selection.prediction.recommendationAction !== 'recommend') return false",
  "pool === 'HHAD' ? officialPool.handicap : 0"
) && !source.includes("candidateSelections.push(...getOfficialPickCandidates"));

check('retained cutover snapshots cannot enter an executable bet slip', [
  "dataSync.dataChannel !== 'retained'",
  'dataSync.serviceTransitioning !== true',
  'dataSync.currentRefreshHealthy === true',
  'const canGenerateCombination = liveDataReadyForCombination && formalRecommendationCount >= 2',
  "liveDataReadyForCombination ? t('unavailableReason') : t('retainedDataReason')"
].every((needle) => pageSource.includes(needle)));

check('odds-dropping option has real behavior', hasAll(
  'onlyOddsDropping: boolean',
  'if (onlyOddsDropping)',
  'change > -0.02'
));

check('combination rank prioritizes calibrated joint probability', hasAll(
  'jointNegativeLogProbability',
  'getCalibratedModelProbability(selection.match, selection.prediction)',
  'calibratedModelProbability / 100',
  'marketImpliedProbability',
  'jointNegativeLogProbability * 2',
  'targetDistance * 0.25'
) && !source.includes('marketBoost')
  && !source.includes('multiFactorEvidence?.modelProbability'));

const ok = checks.every((row) => row.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  summary: {
    total: checks.length,
    passed: checks.filter((row) => row.ok).length,
    failed: checks.filter((row) => !row.ok).length,
  },
  checks,
}, null, 2));
if (!ok) process.exitCode = 1;
