'use strict';

// A bounded result reader for the sealed seven-event comparison. No collector,
// synchronization, model calculation, or production mutation is invoked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { strictInstant } = require('../src/services/strictInstant.cjs');
const { VERSION: COMPARISON_VERSION, validSeal } = require('./recommendationPlatform/strategyVersionComparison.cjs');
const { validPublicReferenceArchive } = require('./recommendationPlatform/publicStrategyReferenceComparison.cjs');
const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');

const VERSION = 'recommendation-result-heads-readonly-v1';
const REMOTE_COMMAND = 'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function check(value, reason) { if (!value) throw new Error(`RESULT_READER_${reason}`); }
function instant(value) {
  check(strictInstant(value), 'INVALID_CLOCK');
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  return BigInt(Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, ''))) * 1000000n
    + BigInt(fraction.padEnd(9, '0'));
}
function targetKey(row) {
  check(typeof row?.sourceMatchId === 'string' && /^[0-9]{1,16}$/.test(row.sourceMatchId), 'INVALID_SOURCE_ID');
  const ns = instant(row.eventVersion);
  // PostgreSQL timestamptz has microsecond precision. Never round another event
  // into this one, even when a caller re-seals a malformed manifest.
  check(ns % 1000n === 0n, 'EVENT_PRECISION_UNSUPPORTED');
  return JSON.stringify([row.sourceMatchId, ns.toString()]);
}
function validateTargets(rows) {
  check(Array.isArray(rows) && rows.length === 7, 'EXACT_SEVEN_TARGETS_REQUIRED');
  const seen = new Set();
  return rows.map(row => {
    const key = targetKey(row);
    check(!seen.has(key), 'DUPLICATE_EVENT'); seen.add(key);
    return { sourceMatchId: row.sourceMatchId, eventVersion: row.eventVersion };
  });
}
function validateExperiment(shadow, archive, publicArchive) {
  check(validSeal(shadow) && validSeal(archive) && validPublicReferenceArchive(publicArchive), 'MANIFEST_HASH_INVALID');
  check(shadow.version === COMPARISON_VERSION && archive.version === COMPARISON_VERSION
    && shadow.kind === 'shadow-experiment' && archive.kind === 'original-archive'
    && shadow.productionWrites === 0 && archive.productionWrites === 0 && shadow.formalHitRateEligible === false,
  'MANIFEST_CONTRACT_INVALID');
  check(isSha(shadow.sourceSha256) && shadow.sourceSha256 === archive.sourceSha256
    && shadow.archiveContentHash === archive.contentHash
    && shadow.publicReferenceArchiveContentHash === publicArchive.contentHash, 'MANIFEST_BINDING_INVALID');
  instant(shadow.generatedAt); instant(shadow.sourceObservedAt);
  const targets = validateTargets(shadow.rows);
  check(Array.isArray(archive.rows) && archive.rows.length > 0 && archive.rows.length <= 10000, 'ARCHIVE_BOUND');
  const allowed = new Set(targets.map(targetKey));
  for (const row of archive.rows) check(allowed.has(targetKey(row)), 'ARCHIVE_EVENT_OUTSIDE_EXPERIMENT');
  for (const row of shadow.rows) {
    check(isSha(row.decisionRecordHash) && typeof row.decisionId === 'string' && row.decisionId.length > 0,
      'FINAL_DECISION_BINDING_INVALID');
    check(archive.rows.some(old => targetKey(old) === targetKey(row) && old.decisionId === row.decisionId
      && old.recordHash === row.decisionRecordHash && old.homeTeamId === row.homeTeamId && old.awayTeamId === row.awayTeamId),
    'FINAL_DECISION_BINDING_INVALID');
  }
  return targets;
}
function readManifest(directory, name) {
  const filename = path.join(directory, name);
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_MANIFEST_BYTES, 'MANIFEST_FILE_INVALID');
  const bytes = fs.readFileSync(filename);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) };
}
function loadExperiment(directory) {
  const root = path.resolve(directory);
  check(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'EXPERIMENT_DIRECTORY_INVALID');
  const shadow = readManifest(root, 'shadow-manifest.json');
  const archive = readManifest(root, 'original-archive-manifest.json');
  const publicArchive = readManifest(root, 'public-reference-archive-manifest.json');
  const targets = validateExperiment(shadow.value, archive.value, publicArchive.value);
  return { targets, generatedAt: shadow.value.generatedAt, binding: {
    shadowContentHash: shadow.value.contentHash, archiveContentHash: archive.value.contentHash,
    publicReferenceArchiveContentHash: publicArchive.value.contentHash, sourceSha256: shadow.value.sourceSha256,
    manifestByteHashes: { shadow: shadow.sha256, archive: archive.sha256, publicReferenceArchive: publicArchive.sha256 }
  } };
}
function buildResultQuery(rows) {
  const targets = validateTargets(rows);
  // Both interpolated columns are strictly allowlisted before SQL construction.
  const values = targets.map(row => `('${row.sourceMatchId}'::text,'${row.eventVersion}'::timestamptz)`).join(',\n');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15000';
SET LOCAL lock_timeout='2000';
WITH targets(source_match_id,event_version) AS (VALUES ${values})
SELECT jsonb_build_object(
 'version','${VERSION}',
 'observedAt',clock_timestamp(),
 'readOnly',current_setting('transaction_read_only'),
 'productionWrites',0,
 'currentResultHeads',(SELECT COALESCE(jsonb_agg(e.payload ORDER BY h.source_match_id,h.event_version),'[]'::jsonb)
   FROM targets t JOIN football.recommendation_result_heads h
   ON h.source_match_id=t.source_match_id AND h.event_version=t.event_version
   JOIN football.recommendation_result_events e ON e.id=h.event_id
   AND e.source_match_id=h.source_match_id AND e.event_version=h.event_version),
 'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta
   WHERE key IN ('data_generation_id','manifest_hash','committed_at','fast_result_revision')));
ROLLBACK;
`;
}
function buildRemoteReader(rows) {
  const sql = buildResultQuery(rows);
  return `'use strict';
const cp=require('node:child_process');
try {
 const out=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--dbname=football'],
  {input:${JSON.stringify(sql)},timeout:22000,maxBuffer:${MAX_RESPONSE_BYTES},stdio:['pipe','pipe','pipe']});
 if(!out.length||out.length>${MAX_RESPONSE_BYTES})throw new Error('bound');
 const value=JSON.parse(out.toString('utf8'));
 if(value.readOnly!=='on'||value.productionWrites!==0)throw new Error('readonly');
 process.stdout.write(out);
} catch {process.stderr.write('RESULT_READER_REMOTE_READ_FAILED\\n');process.exitCode=1;}
`;
}
function validateResultResponse(bytes, experiment) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RESPONSE_BYTES, 'RESPONSE_BOUND');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('RESULT_READER_RESPONSE_JSON_INVALID'); }
  check(value.version === VERSION && value.readOnly === 'on' && value.productionWrites === 0, 'RESPONSE_CONTRACT_INVALID');
  check(instant(value.observedAt) >= instant(experiment.generatedAt), 'RESPONSE_BEFORE_EXPERIMENT');
  check(Array.isArray(value.currentResultHeads) && value.currentResultHeads.length <= experiment.targets.length, 'HEAD_COUNT_INVALID');
  check(value.generation && typeof value.generation === 'object' && !Array.isArray(value.generation), 'GENERATION_MISSING');
  const allowed = new Set(experiment.targets.map(targetKey)), seen = new Set();
  for (const head of value.currentResultHeads) {
    const key = targetKey(head);
    check(allowed.has(key) && !seen.has(key), 'HEAD_EVENT_OUTSIDE_EXPERIMENT_OR_DUPLICATE'); seen.add(key);
    check(instant(head.observedAt) <= instant(value.observedAt), 'HEAD_AFTER_OBSERVATION');
    // Preserve FINAL / VOID / DISPUTED payload bytes. Settlement validity and
    // team identity are independently checked by the comparison module.
  }
  return value;
}
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    check(['--experiment', '--output'].includes(name) && !Object.hasOwn(result, name)
      && typeof args[i + 1] === 'string' && args[i + 1].length > 0 && !args[i + 1].startsWith('--'), 'ARGUMENTS_INVALID');
    result[name] = args[i + 1];
  }
  check(result['--experiment'] && result['--output'], 'ARGUMENTS_REQUIRED');
  return { experiment: result['--experiment'], output: result['--output'] };
}
function readResultHeads({ experiment, output }, { env = process.env, execute = cp.execFileSync } = {}) {
  check(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_22_REQUIRED');
  const loaded = loadExperiment(experiment), destination = path.resolve(output), rawPath = `${destination}.remote-response.json`;
  check(!fs.existsSync(destination) && !fs.existsSync(rawPath), 'OUTPUT_EXISTS');
  check(fs.statSync(path.dirname(destination)).isDirectory(), 'OUTPUT_DIRECTORY_MISSING');
  const host = env.RELEASE_DEPLOY_HOST, user = env.RELEASE_DEPLOY_USER, keyPath = env.RELEASE_DEPLOY_KEY;
  check(typeof host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)
    && typeof user === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(user)
    && typeof keyPath === 'string' && keyPath.length > 0
    && env.RELEASE_DEPLOY_KNOWN_HOSTS && env.RELEASE_DEPLOY_HOST_KEY_SHA256, 'SSH_CONFIG_INVALID');
  const pin = validateReleaseSshHostKeyPin({ knownHostsPath: env.RELEASE_DEPLOY_KNOWN_HOSTS, host, port: 22,
    expectedFingerprint: env.RELEASE_DEPLOY_HOST_KEY_SHA256 });
  const startedAt = new Date().toISOString();
  let raw;
  try {
    raw = execute('ssh', [...buildPinnedSshBaseOptions({ keyPath, pin }), '-p', '22', `${user}@${host}`, REMOTE_COMMAND],
      { input: buildRemoteReader(loaded.targets), timeout: 45000, maxBuffer: MAX_RESPONSE_BYTES,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('RESULT_READER_PINNED_SSH_READ_FAILED'); }
  const finishedAt = new Date().toISOString();
  const result = validateResultResponse(raw, loaded);
  const record = { ...result, experiment: loaded.binding, requestedEvents: loaded.targets,
    transport: { hostKeyPinVerified: true, hostKeyFingerprint: pin.fingerprint, startedAt, finishedAt,
      remoteResponseSha256: sha(raw), remoteResponseBytes: raw.length, remoteResponseFile: path.basename(rawPath) } };
  // Original response and parsed receipt are both append-only local evidence.
  fs.writeFileSync(rawPath, raw, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output: destination, observedAt: result.observedAt, heads: result.currentResultHeads.length,
    requestedEvents: loaded.targets.length, remoteResponseSha256: sha(raw), productionWrites: 0 };
}
function main() {
  try { console.log(JSON.stringify(readResultHeads(parseArgs(process.argv.slice(2))))); }
  catch (error) {
    // Never echo a raw SSH/psql error, source payload, or credential environment.
    console.error(/^RESULT_READER_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'RESULT_READER_VALIDATION_FAILED');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { VERSION, REMOTE_COMMAND, MAX_RESPONSE_BYTES, parseArgs, validateTargets, validateExperiment,
  loadExperiment, buildResultQuery, buildRemoteReader, validateResultResponse, readResultHeads };
