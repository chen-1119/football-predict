'use strict';

// Explicit research input only. No directory discovery, datastore access,
// synchronization, registry registration or active-model publication occurs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const { learnPrematchV3Candidate, VERSION: LEARNER_VERSION, RECORD_VERSION } = require('../src/services/prematchV3Learning.cjs');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const feedback = require('../src/services/prematchV3FeedbackLoop.cjs');

const VERSION = 'prematch-v3-learning-run-report-v1';
const REQUEST_VERSION = 'prematch-v3-learning-request-v1';
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const IMPLEMENTATION_FILES = Object.freeze(['scripts/runPrematchV3Learning.cjs',
  'src/services/prematchV3Learning.cjs', 'src/services/prematchV3FeedbackLoop.cjs', 'src/services/prematchTeamEvidenceV3.cjs',
  'src/services/prematchV3Clock.cjs', 'src/services/strictInstant.cjs',
  'src/services/webConsensusEvidence.cjs', 'src/services/goalDistribution.cjs',
  'src/services/matchLifecycle.cjs', 'scripts/modelLearningRegistry.cjs']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(`V3_LEARNING_${code}`); };

function parseArgs(args) {
  const found = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    check(['--input', '--output'].includes(key) && !Object.hasOwn(found, key)
      && typeof value === 'string' && value.trim() && !value.startsWith('--'), 'ARGS');
    found[key] = value;
  }
  check(found['--input'] && found['--output'], 'ARGS');
  // No --as-of is supported: training receipts always use the actual run
  // clock. Historical timestamps belong inside the frozen research records.
  return { input: found['--input'], output: found['--output'] };
}
function validateRequest(request) {
  check(object(request) && request.version === REQUEST_VERSION && request.researchOnly === true, 'RESEARCH_REQUEST_REQUIRED');
  check(!['asOf', 'createdAt', 'availableAt', 'fittedAt', 'clock'].some(key => Object.hasOwn(request, key)), 'CALLER_FIT_CLOCK_FORBIDDEN');
  check(Array.isArray(request.records) && request.records.length <= 100000
    && request.records.every(record => object(record) && record.version === RECORD_VERSION), 'EXPLICIT_V3_RECORDS_REQUIRED');
  check(Array.isArray(request.featureNames) && request.featureNames.length > 0
    && request.featureNames.every(name => typeof name === 'string' && name.trim()), 'FEATURE_NAMES_REQUIRED');
  check(request.featureSchema === undefined || object(request.featureSchema), 'FEATURE_SCHEMA_INVALID');
  check(request.featureSchemaHash === undefined || /^[a-f0-9]{64}$/.test(request.featureSchemaHash), 'FEATURE_SCHEMA_HASH_INVALID');
  check(request.split === undefined || object(request.split), 'SPLIT_INVALID');
  check(request.fitOptions === undefined || object(request.fitOptions), 'FIT_OPTIONS_INVALID');
}
function implementationHashes(repo) {
  return Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, sha256(fs.readFileSync(path.join(repo, file)))]));
}
function completeCandidateReceipt(result, completedAt) {
  if (result.status !== 'shadow-candidate') return result;
  const { contentHash: previousHash, ...body } = result.artifact;
  body.createdAt = completedAt; body.availableAt = completedAt;
  const artifact = { ...body, contentHash: stableHash(body) };
  // Only availability metadata changed. Keep every evaluated row bound to the
  // completed candidate instead of retaining the temporary fit-start hash.
  const rebind = section => section && { ...section, rows: section.rows.map(row => ({ ...row,
    parameterArtifactHash: row.parameterArtifactHash === previousHash ? artifact.contentHash : row.parameterArtifactHash })) };
  return { ...result, artifact, validation: rebind(result.validation), calibration: rebind(result.calibration) };
}
function run({ input, output } = {}) {
  check(require.main===module,'STANDALONE_CLI_REQUIRED');
  check(Number(process.versions.node.split('.')[0]) === 22, 'NODE22_REQUIRED');
  check(typeof input === 'string' && input.trim() && typeof output === 'string' && output.trim(), 'PATHS_REQUIRED');
  const inputPath = path.resolve(input), outputPath = path.resolve(output);
  check(inputPath.toLowerCase() !== outputPath.toLowerCase(), 'INPUT_OVERWRITE_FORBIDDEN');
  check(!fs.existsSync(outputPath) && fs.statSync(path.dirname(outputPath)).isDirectory(), 'NEW_OUTPUT_REQUIRED');
  const stat = fs.statSync(inputPath);
  check(stat.isFile() && stat.size > 0 && stat.size <= MAX_INPUT_BYTES, 'INPUT_BOUND');
  const inputBytes = fs.readFileSync(inputPath), inputSha256 = sha256(inputBytes);
  let request;
  try { request = JSON.parse(inputBytes.toString('utf8')); } catch { throw new Error('V3_LEARNING_INPUT_JSON_INVALID'); }
  validateRequest(request);
  const repo = path.resolve(__dirname, '..'), implementationBefore = implementationHashes(repo);
  const fitStartedAt = new Date().toISOString();
  const fitted = learnPrematchV3Candidate({ records: request.records, featureSchema: request.featureSchema,
    featureSchemaHash: request.featureSchemaHash, featureNames: request.featureNames,
    split: request.split, fitOptions: request.fitOptions, asOf: fitStartedAt });
  const fitCompletedAt = new Date().toISOString();
  check(epochNanoseconds(fitCompletedAt) >= epochNanoseconds(fitStartedAt), 'ACTUAL_CLOCK_REGRESSED');
  const learning = completeCandidateReceipt(fitted, fitCompletedAt);
  let feedbackPacket = null, feedbackBlockers = [];
  if (learning.artifact) {
    try { feedbackPacket = feedback.buildValidatedParameterPacket({ artifact: learning.artifact,
      records: request.records, asOf: fitCompletedAt }); }
    catch (error) { feedbackBlockers = [/^V3_FEEDBACK_[A-Z_]+$/.test(error.message) ? error.message : 'V3_FEEDBACK_PACKET_INVALID']; }
  } else feedbackBlockers = ['V3_FEEDBACK_TRAINING_BLOCKED'];
  const implementationAfter = implementationHashes(repo);
  check(stableHash(implementationBefore) === stableHash(implementationAfter), 'IMPLEMENTATION_CHANGED_DURING_FIT');
  check(sha256(fs.readFileSync(inputPath)) === inputSha256 && stableHash(request) === stableHash(JSON.parse(inputBytes.toString('utf8'))), 'INPUT_CHANGED');
  const body = { version: VERSION, status: learning.status, researchOnly: true,
    formalEligible: false, productionEligible: false, shadowOnly: true,
    fitStartedAt, fitCompletedAt, actualFittedAt: fitCompletedAt,
    input: { path: inputPath, bytes: inputBytes.length, sha256: inputSha256, requestVersion: REQUEST_VERSION,
      requestContentHash: stableHash(request), recordVersion: RECORD_VERSION, recordCount: request.records.length,
      featureNames: request.featureNames, requestedSplit: request.split || null },
    implementation: { learnerVersion: LEARNER_VERSION, nodeVersion: process.version, nodeMajor: 22,
      files: implementationBefore },
    evidenceScope: 'explicit-frozen-V3-research-records;held-out-probability-metrics-are-not-formal-accuracy-or-promotion-proof',
    calibrated: false, registryStatus: 'not-registered', activeModelPublished: false,
    invariants: { inputChanged: false, originalPredictionsChanged: false, registryWrites: 0,
      productionWrites: 0, datasetWrites: 0, modelPointerWrites: 0 }, learning, feedbackPacket, feedbackBlockers };
  const report = { ...body, contentHash: stableHash(body) };
  // wx also protects against a file created between the check and this write.
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output: outputPath, status: report.status, contentHash: report.contentHash,
    actualFittedAt: report.actualFittedAt, parameterArtifactHash: learning.artifact?.contentHash || null,
    pairedTestRows: learning.coverage?.pairedTestRows || 0, formalEligible: false,
    registryWrites: 0, productionWrites: 0, feedbackReady: feedbackPacket !== null, feedbackBlockers };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(run(parseArgs(process.argv.slice(2)))) + '\n'); }
  catch (error) {
    process.stderr.write(/^V3_LEARNING_[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'V3_LEARNING_FAILED\n');
    process.exitCode = 1;
  }
}
module.exports = { VERSION, REQUEST_VERSION, MAX_INPUT_BYTES, IMPLEMENTATION_FILES, parseArgs, validateRequest, run };
