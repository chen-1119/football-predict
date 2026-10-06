'use strict';
// Only bounded, pinned, readonly production PG reads. No collectors or sync.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { strictInstant } = require('../src/services/strictInstant.cjs');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_MODEL_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MODEL_ARTIFACT_KEYS = Object.freeze(['prematch-v3-baseline', 'prematch-v3-parameters']);
const MAX_MATCHES = 128, MAX_INVENTORY = 24, CLOCK_SKEW_MS = 120000;
const VERSION = 'prematch-v3-online-readonly-v2';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function check(value, code) { if (!value) throw Error(`V3_READER_${code}`); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const instant = epochNanoseconds;
const displayMilliseconds = nanoseconds => Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1000000;
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Boolean(strictInstant(`${date}T00:00:00Z`));
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function parseArgs(args) {
  check(Array.isArray(args) && args.length === 4 && args.every(value => typeof value === 'string'), 'ARGS');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    check(['--date', '--output'].includes(args[i]) && !values[args[i]] && args[i + 1] && !args[i + 1].startsWith('--'), 'ARGS');
    values[args[i]] = args[i + 1];
  }
  const date = values['--date'];
  check(validDate(date) && text(values['--output'], 4096), 'ARGS');
  return {date, output: values['--output']};
}
function query(date) {
  check(validDate(date), 'DATE');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15000';
SET LOCAL lock_timeout='2000';
SELECT jsonb_build_object(
 'version','${VERSION}','observedAt',clock_timestamp(),
 'readOnly',current_setting('transaction_read_only'),'productionWrites',0,
 'businessDate','${date}',
 'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_generation_id','manifest_hash','committed_at')),
 'matches',(SELECT COALESCE(jsonb_agg(payload ORDER BY kickoff_time,source_match_id),'[]'::jsonb)
   FROM (SELECT payload,kickoff_time,source_match_id FROM football.match_snapshots
     WHERE dataset='current' AND payload->>'businessDate'='${date}' ORDER BY kickoff_time,source_match_id LIMIT ${MAX_MATCHES + 1}) bounded),
 'modelArtifactInventory',(SELECT COALESCE(jsonb_agg(jsonb_build_object('key',artifact_key,'version',artifact_version,'generatedAt',generated_at,'sha256',payload_sha256,'bytes',payload_bytes)),'[]'::jsonb)
   FROM (SELECT artifact_key,artifact_version,generated_at,payload_sha256,payload_bytes FROM football.private_model_artifacts
     WHERE artifact_key ~ '(dynamic-goal|prematch-v3)' ORDER BY artifact_key LIMIT ${MAX_INVENTORY + 1}) bounded),
 'modelArtifacts',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'artifactKey',artifact_key,'artifactVersion',artifact_version,'generatedAt',generated_at,'updatedAt',updated_at,
   'payloadSha256',payload_sha256,'payloadBytes',payload_bytes,
   'oversized',payload_bytes>${MAX_MODEL_ARTIFACT_BYTES} OR octet_length(payload::text)>${MAX_MODEL_ARTIFACT_BYTES},
   'payloadJson',CASE WHEN payload_bytes<=${MAX_MODEL_ARTIFACT_BYTES} AND octet_length(payload::text)<=${MAX_MODEL_ARTIFACT_BYTES}
     THEN payload::text ELSE NULL END)),'[]'::jsonb)
   FROM (SELECT artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes
     FROM football.private_model_artifacts
     WHERE artifact_key IN ('prematch-v3-baseline','prematch-v3-parameters') ORDER BY artifact_key LIMIT 3) bounded)
);
ROLLBACK;
`;
}
function validateResponse(value, date) {
  check(validDate(date), 'DATE');
  check(object(value) && value.version === VERSION && value.readOnly === 'on' && value.productionWrites === 0
    && value.businessDate === date && instant(value.observedAt) !== null
    && Array.isArray(value.matches) && value.matches.length <= MAX_MATCHES
    && Array.isArray(value.modelArtifactInventory) && value.modelArtifactInventory.length <= MAX_INVENTORY
    && Array.isArray(value.modelArtifacts) && value.modelArtifacts.length <= MODEL_ARTIFACT_KEYS.length
    && object(value.generation), 'RESPONSE');
  check(text(value.generation.data_generation_id, 256) && typeof value.generation.manifest_hash === 'string'
    && /^[a-f0-9]{64}$/.test(value.generation.manifest_hash)
    && (value.generation.committed_at == null || instant(value.generation.committed_at) !== null), 'GENERATION_METADATA');
  const missingFields = [];
  value.matches.forEach((match, index) => {
    check(object(match) && match.businessDate === date, 'MATCH_BUSINESS_DATE');
    const id = match.id, sourceId = match.sourceMatchId;
    check((text(id, 256) || text(sourceId, 256)) && (id == null || text(id, 256))
      && (sourceId == null || text(sourceId, 256)), 'MATCH_IDENTITY');
    const normalize = id => id.replace(/^sporttery_/, '');
    check((id == null || text(normalize(id), 256)) && (sourceId == null || text(normalize(sourceId), 256)), 'MATCH_IDENTITY');
    check(id == null || sourceId == null || normalize(id) === normalize(sourceId), 'MATCH_IDENTITY');
    for (const field of ['kickoffTime', 'eventVersion', 'buyEndTime']) {
      if (match[field] != null) check(instant(match[field]) !== null, 'MATCH_CLOCK');
    }
    if (match.eventVersion != null && match.kickoffTime != null)
      check(instant(match.eventVersion) === instant(match.kickoffTime), 'MATCH_EVENT_CONFLICT');
    for (const field of ['matchDate', 'kickoffDate']) {
      if (match[field] != null) check(validDate(match[field]), 'MATCH_CALENDAR');
    }
    check(match.predictionMeta == null || object(match.predictionMeta), 'MATCH_CUTOFF');
    const cutoffs = [match.cutoffAt, match.cutoffTime, match.predictionMeta?.cutoffTime].filter(value => value != null);
    check(cutoffs.every(value => instant(value) !== null), 'MATCH_CUTOFF');
    if (match.cutoffAt != null && match.cutoffTime != null)
      check(instant(match.cutoffAt) === instant(match.cutoffTime), 'MATCH_CUTOFF');
    const missing = [];
    if (sourceId == null) missing.push('sourceMatchId');
    if (match.kickoffTime == null) missing.push('kickoffTime');
    if (!cutoffs.length && match.buyEndTime == null) missing.push('cutoff');
    if (missing.length) missingFields.push({ index, fields: missing });
  });
  const artifactKeys = new Set();
  for (const artifact of value.modelArtifactInventory) {
    check(object(artifact) && text(artifact.key, 256) && text(artifact.version, 128)
      && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256)
      && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && instant(artifact.generatedAt) !== null
      && !artifactKeys.has(artifact.key), 'ARTIFACT_METADATA');
    artifactKeys.add(artifact.key);
  }
  const modelKeys = new Set();
  for (const packet of value.modelArtifacts) {
    check(object(packet) && MODEL_ARTIFACT_KEYS.includes(packet.artifactKey) && !modelKeys.has(packet.artifactKey)
      && text(packet.artifactVersion, 128) && typeof packet.payloadSha256 === 'string' && /^[a-f0-9]{64}$/.test(packet.payloadSha256)
      && Number.isSafeInteger(packet.payloadBytes) && packet.payloadBytes > 0
      && instant(packet.generatedAt) !== null && instant(packet.updatedAt) !== null
      && instant(packet.generatedAt) <= instant(packet.updatedAt) && typeof packet.oversized === 'boolean', 'MODEL_ARTIFACT_PACKET');
    if (packet.oversized) check(packet.payloadJson === null && packet.payloadBytes > MAX_MODEL_ARTIFACT_BYTES, 'MODEL_ARTIFACT_OVERSIZED');
    else check(typeof packet.payloadJson === 'string' && packet.payloadBytes <= MAX_MODEL_ARTIFACT_BYTES
      && Buffer.byteLength(packet.payloadJson) === packet.payloadBytes && hash(packet.payloadJson) === packet.payloadSha256,
      'MODEL_ARTIFACT_PAYLOAD');
    modelKeys.add(packet.artifactKey);
  }
  return { matches: value.matches.length, inventory: value.modelArtifactInventory.length, modelArtifacts: value.modelArtifacts.length, missingFields };
}
function validateTransport(transport, observedAt) {
  check(object(transport) && transport.hostKeyPinVerified === true
    && typeof transport.hostKeyFingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(transport.hostKeyFingerprint)
    && typeof transport.remoteResponseSha256 === 'string' && /^[a-f0-9]{64}$/.test(transport.remoteResponseSha256)
    && text(transport.remoteResponseFile, 255) && path.basename(transport.remoteResponseFile) === transport.remoteResponseFile
    && !/[\\/]/.test(transport.remoteResponseFile) && Number.isSafeInteger(transport.bytes)
    && transport.bytes > 0 && transport.bytes <= MAX_BYTES, 'TRANSPORT');
  const started = instant(transport.startedAt), finished = instant(transport.finishedAt), observed = instant(observedAt);
  const toleranceNs = BigInt(CLOCK_SKEW_MS) * 1000000n;
  check(started !== null && finished !== null && observed !== null && started <= finished
    && observed >= started - toleranceNs && observed <= finished + toleranceNs, 'TRANSPORT_CLOCK');
  const observedClockSkewMs = displayMilliseconds(observed < started ? observed - started : observed > finished ? observed - finished : 0n);
  return { observedClockSkewMs, clockSkewToleranceMs: CLOCK_SKEW_MS,
    observedClockOrder: observedClockSkewMs === 0 ? 'inside-actual-transport-window' : 'within-recorded-clock-skew-tolerance',
    providerClockVerification: 'not-established-by-transport-clock' };
}
function parseResponse(raw) {
  check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_BYTES, 'RESPONSE_BOUND');
  try { return JSON.parse(raw.toString('utf8')); } catch { throw Error('V3_READER_RESPONSE_JSON'); }
}
function verifyOnlineRead(value, { date, rawResponse } = {}) {
  try {
    const original = parseResponse(rawResponse), { transport, ...payload } = value;
    validateResponse(original, date); validateTransport(transport, original.observedAt);
    if (hash(rawResponse) !== transport.remoteResponseSha256 || rawResponse.length !== transport.bytes
      || canonicalJson(original) !== canonicalJson(payload)) return false;
    const expected = validateTransport(transport, original.observedAt);
    return Object.entries(expected).every(([key, entry]) => transport[key] === entry);
  } catch { return false; }
}
function readInputs({date, output}, env = process.env, execute = cp.execFileSync) {
  check(Number(process.versions.node.split('.')[0]) === 22, 'NODE22_REQUIRED');
  check(validDate(date), 'DATE'); check(text(output, 4096), 'OUTPUT');
  const destination = path.resolve(output), rawFile = `${destination}.remote-response.json`;
  let outputReady = false;
  try { outputReady = !fs.existsSync(destination) && !fs.existsSync(rawFile) && fs.statSync(path.dirname(destination)).isDirectory(); } catch {}
  check(outputReady, 'NEW_OUTPUT_REQUIRED');
  const host = env.RELEASE_DEPLOY_HOST, user = env.RELEASE_DEPLOY_USER;
  check(typeof host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)
    && typeof user === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(user) && text(env.RELEASE_DEPLOY_KEY, 4096), 'SSH_CONFIG');
  let pin;
  try { pin = validateReleaseSshHostKeyPin({knownHostsPath: env.RELEASE_DEPLOY_KNOWN_HOSTS, host, port: 22, expectedFingerprint: env.RELEASE_DEPLOY_HOST_KEY_SHA256}); }
  catch { throw Error('V3_READER_SSH_PIN_INVALID'); }
  const remote = `'use strict';const cp=require('node:child_process');try{const bytes=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--dbname=football'],{input:${JSON.stringify(query(date))},timeout:22000,maxBuffer:${MAX_BYTES},stdio:['pipe','pipe','pipe']});const value=JSON.parse(bytes.toString('utf8'));if(value.readOnly!=='on'||value.productionWrites!==0)throw Error();process.stdout.write(bytes);}catch{process.stderr.write('V3_READER_REMOTE_FAILED\\n');process.exitCode=1;}`;
  const startedAt = new Date().toISOString();
  let raw;
  try { raw = execute('ssh', [...buildPinnedSshBaseOptions({keyPath: env.RELEASE_DEPLOY_KEY, pin}), '-p', '22', `${user}@${host}`, 'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'], {input: remote, timeout:45000, maxBuffer:MAX_BYTES, windowsHide:true, stdio:['pipe','pipe','pipe']}); }
  catch { throw Error('V3_READER_PINNED_READ_FAILED'); }
  const finishedAt = new Date().toISOString();
  const value = parseResponse(raw), validation = validateResponse(value, date);
  check(!Object.hasOwn(value, 'transport'), 'REMOTE_TRANSPORT_FORBIDDEN');
  const transport = {hostKeyPinVerified:true, hostKeyFingerprint:pin.fingerprint, startedAt, finishedAt,
    remoteResponseSha256:hash(raw), remoteResponseFile:path.basename(rawFile), bytes:raw.length};
  Object.assign(transport, validateTransport(transport, value.observedAt));
  try {
    fs.writeFileSync(rawFile, raw, {flag:'wx', mode:0o600});
    fs.writeFileSync(destination, JSON.stringify({...value, transport}, null, 2) + '\n', {flag:'wx', mode:0o600});
  } catch { throw Error('V3_READER_OUTPUT_COMMIT_FAILED'); }
  return {output:destination, observedAt:value.observedAt, matches:validation.matches, inventory:validation.inventory, modelArtifacts:validation.modelArtifacts,
    missingFields:validation.missingFields, productionWrites:0, remoteResponseSha256:transport.remoteResponseSha256};
}
if (require.main === module) {
  try { console.log(JSON.stringify(readInputs(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(/^V3_READER_[A-Z0-9_]+$/.test(error.message) ? error.message : 'V3_READER_VALIDATION_FAILED'); process.exitCode=1; }
}
module.exports={VERSION, MAX_BYTES, MAX_MODEL_ARTIFACT_BYTES, MODEL_ARTIFACT_KEYS, MAX_MATCHES, MAX_INVENTORY, CLOCK_SKEW_MS, validDate, parseArgs, query,
  validateResponse, validateTransport, verifyOnlineRead, readInputs};
