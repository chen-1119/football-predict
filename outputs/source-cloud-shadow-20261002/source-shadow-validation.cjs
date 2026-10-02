'use strict';
// Read historical receipts only. Never fetch, import a run, schedule or write outside this output directory.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { adaptSourceCollectorSnapshot } = require('../../scripts/sourceCollectorShadowAdapter.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const out = __dirname;
const dotRoot = 'C:/Users/86188/Documents/football/outputs/dot-football';
const archive = path.join(dotRoot, 'verified-archive-20260930/bootstrap-20260930-0955');
const manifest = read(path.join(archive, 'manifest.json'));
const archiveFiles = manifest.files.map(entry => {
  const target = path.resolve(archive, entry.path);
  if (!target.startsWith(path.resolve(archive) + path.sep)) throw new Error('Archive path outside named directory');
  const raw = fs.readFileSync(target);
  return { path: entry.path, bytes: raw.length, bytesMatch: raw.length === entry.bytes, sha256Matches: hash(raw) === entry.sha256 };
});
if (archiveFiles.some(f => !f.sha256Matches || !f.bytesMatch)) throw new Error('Archived contract hash mismatch');
const contracts = require(path.join(archive, 'scripts/dotFootballEvidence.cjs'));
const registry = read(path.join(archive, 'deploy/dot-football/source-registry.json'));
const registryCheck = contracts.validateSourceRegistry(registry);
const templateCheck = contracts.validateRun(read(path.join(archive, 'deploy/dot-football/run-template.json')), registry);
const readback = read(path.join(dotRoot, 'cloud-offline-readback-receipt-20260930.json'));
const readbackChecks = readback.files.map(f => { const raw = fs.readFileSync(path.join(dotRoot, f.name));
  return { name: f.name, bytes: raw.length, sha256: hash(raw), recordedSha256: f.sha256,
    hashMatches: hash(raw) === f.sha256, priorLocalExactCopyFlag: f.localExactCopy }; });
const migration = read(path.join(dotRoot, 'migration-receipts-20260930.json'));
const coordination = read(path.join(dotRoot, 'football-coordination-setup-receipt-20261002.json'));
const terminal = read(path.join(dotRoot, 'cloud-terminal-execution-20260930.json'));
const summary = {
  version: 'source-cloud-readonly-handoff-v1', historicalReceiptsOnly: true,
  localEnvironment: { platform: process.platform, node: process.version }, cloudEnvironmentCurrentlyVerified: false,
  archiveFiles, sourceRegistryValidation: { ok: registryCheck.ok, errors: registryCheck.errors?.map(e => e.code) || [] },
  emptyTemplateValidation: { ok: templateCheck.ok, errorCodes: templateCheck.errors.map(e => e.code), expectedFailure: !templateCheck.ok },
  readbackChecks, migration: {
    phase: migration.phase, cloudComputerConnectedVerifiedHistorically: migration.cloudComputerConnectedVerified,
    cloudExecutionVerified: migration.cloudExecutionVerified, cloudExecutionVerifiedScope: migration.cloudExecutionVerifiedScope,
    cloudSchedulesConfirmed: migration.cloudSchedulesConfirmed, productionEligible: migration.productionEligible,
    websiteMigrationCompleted: migration.websiteMigrationCompleted, legacyCollectorsDisabled: migration.legacyCollectorsDisabled,
  }, historicalTerminalCommands: terminal.map(t => ({ label: t.label, cwd: t.cwd, startedAt: t.startedAt, completedAt: t.completedAt, exitCode: t.exitCode })),
  coordinationSchedules: coordination.schedules.map(s => ({ title: s.title, timezone: s.timezone, time: s.time,
    nextRunUiHistorical: s.nextRunUi, toolNextRunTime: s.toolNextRunTime, uiSavedAndEnabledHistorical: s.uiSavedAndEnabled })),
  pending: ['current persistent cloud runtime/version', 'raw HTTP live-source evidence and authorization',
    'actual order/budget', 'continuous collector run receipts', 'seven-day comparison including sales reopening', 'rollback acceptance'],
  productionWrites: 0, networkRequests: 0, resourcesCreated: 0,
};
fs.writeFileSync(path.join(out, 'dot-cloud-readonly-evidence.json'), JSON.stringify(summary, null, 2) + '\n');
const sourceReceiptPath = 'C:/Users/86188/.codex/worktrees/football-release-oct02/football/outputs/release-oct02/source-diagnostics/receipt.json';
const sourceReceipt = read(sourceReceiptPath), originalRaw = fs.readFileSync(sourceReceipt.evidence.diagnosticsFile);
if (hash(originalRaw) !== sourceReceipt.evidence.diagnosticsSha256) throw new Error('Historical production diagnostics hash mismatch');
const original = JSON.parse(originalRaw.toString('utf8'));
const replay = adaptSourceCollectorSnapshot({ endpoints: original.relay.endpointSummaries }, { asOf: original.capturedAt });
if (replay.state !== 'unknown-evidence') throw new Error('Summary must not become verified raw response');
fs.writeFileSync(path.join(out, 'online-summary-shadow-diagnostic.json'), JSON.stringify({
  version: 'source-shadow-online-summary-replay-v1', observedAt: original.capturedAt,
  inputFileSha256: hash(originalRaw), sourceReceiptPath,
  inputScope: 'Hash-verified historical production response summary, not raw HTTP response or fresh source health',
  sourceClockBorrowed: false, result: replay, productionWrites: 0, networkRequests: 0,
}, null, 2) + '\n');
const patch = read(path.join(out, 'worker-patch-check.json'));
const tests = fs.readFileSync(path.join(out, 'test-output.txt'), 'utf8');
if (!tests.includes('tests 28') || !tests.includes('fail 0') || !tests.includes('"checks":31')) throw new Error('Test receipt incomplete');
fs.writeFileSync(path.join(out, 'validation-receipt.json'), JSON.stringify({
  version: 'source-cloud-shadow-validation-v1', baseCommit: '5ee205fc2bea2dcca4f49b3dcd467503d760f326',
  testScope: 'Real existing collector and signature code with synthetic HTTP transport/test keys; no official network collection',
  testsPassed: 28, workerCompatibilityChecksPassed: 31, testOutputSha256: hash(tests),
  workerPatch: patch, rawOnlineSummaryReplay: replay.state, historicalDiagnosticsHashMatches: true,
  archiveHashesChecked: archiveFiles.length, dotReadbackHashesChecked: readbackChecks.length,
  dotReadbackHashesMatch: readbackChecks.every(f => f.hashMatches), emptyTemplateRejected: !templateCheck.ok,
  sharedWorkerModified: false, productionWrites: 0, schedulesChanged: 0, legacyCollectorsDisabled: false,
  costResourcesCreated: 0, productionDeployed: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ archiveHashesChecked: archiveFiles.length, readbackHashesMatch: readbackChecks.every(f => f.hashMatches),
  sourceRegistryOk: registryCheck.ok, emptyTemplateRejected: !templateCheck.ok, onlineSummaryState: replay.state }, null, 2));
