'use strict';
// Only bounded, pinned, readonly production PG reads. No collectors or sync.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
const MAX_BYTES = 12 * 1024 * 1024;
const CLOCK_SKEW_MS = 120000;
const {VERSION, IDENTITY_VERSION, MAX_MODEL_ARTIFACT_BYTES, MODEL_ARTIFACT_KEYS, MAX_MATCHES, MAX_INVENTORY, validDate, validateResponse,identityContextFor} = require('../src/services/prematchV3OnlineResponse.cjs');
const {createPrematchV3InputIdentity,publicationFromMeta,CURRENT_SNAPSHOT_NAMESPACE}=require('../src/services/prematchV3InputIdentity.cjs');
const {loadCollectorTrustRegistry}=require('../src/services/collectorAttestation.cjs');
// Explicit runtime namespace, not a guessed server-data alias. The live path
// must be freshly verified at read time; no environment or secret is exported.
const LIVE_CURRENT_SNAPSHOT=CURRENT_SNAPSHOT_NAMESPACE;
const LIVE_TRUST_REGISTRY='/opt/football-predict/deploy/light-server/collector-trust-registry.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function check(value, code) { if (!value) throw Error(`V3_READER_${code}`); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const instant = epochNanoseconds;
const displayMilliseconds = nanoseconds => Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1000000;
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
 'version','${IDENTITY_VERSION}','observedAt',clock_timestamp(),
 'readOnly',current_setting('transaction_read_only'),'productionWrites',0,
 'businessDate','${date}',
 'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_generation_id','manifest_hash','committed_at','data_publication_mode','data_generation_source_cycle_id')),
 'matches',(SELECT COALESCE(jsonb_agg(payload ORDER BY kickoff_time,source_match_id),'[]'::jsonb)
   FROM (SELECT payload,kickoff_time,source_match_id FROM football.match_snapshots
     WHERE dataset='current' AND payload->>'businessDate'='${date}' ORDER BY kickoff_time,source_match_id LIMIT ${MAX_MATCHES + 1}) bounded),
 'matchRows',(SELECT COALESCE(jsonb_agg(jsonb_build_object('dataset',dataset,'match_id',match_id,
   'source_match_id',source_match_id,'kickoff_time',kickoff_time::text) ORDER BY kickoff_time,source_match_id),'[]'::jsonb)
   FROM (SELECT dataset,match_id,source_match_id,kickoff_time FROM football.match_snapshots
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
function trustedRegistry(env=process.env) {
  const registry=loadCollectorTrustRegistry(env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
    ||path.resolve(__dirname,'../deploy/light-server/collector-trust-registry.json'));
  check(object(registry),'COLLECTOR_TRUST_REQUIRED');return registry;
}
function admitIdentityResponse(original,trustRegistry) {
  check(original?.version===IDENTITY_VERSION&&!Object.hasOwn(original,'identityAdmissions'),'IDENTITY_RESPONSE_REQUIRED');
  check(Array.isArray(original.matches)&&original.matches.length<=MAX_MATCHES
    &&Array.isArray(original.matchRows)&&original.matchRows.length===original.matches.length
    &&object(original.identitySource),'IDENTITY_SIDECARS');
  const publication=publicationFromMeta(original.generation);
  const identityAdmissions=original.matches.map((match,index)=>createPrematchV3InputIdentity({match,
    row:original.matchRows[index],publication,endpoint:original.identitySource.endpoint,pgObservedAt:original.observedAt,
    inputCapturedAt:original.identitySource.inputCapturedAt,trustRegistry}));
  check(identityAdmissions.every(Boolean),'MATCH_IDENTITY');
  const value={...original,identityAdmissions};validateResponse(value,original.businessDate,{trustRegistry});return value;
}
function identityOptionsFor(value,index,trustRegistry) {
  if(value?.version===VERSION)return {};
  check(value?.version===IDENTITY_VERSION&&Number.isSafeInteger(index)&&index>=0&&index<value.matches?.length,'IDENTITY_CONTEXT');
  const context={...identityContextFor(value,index,trustRegistry),originalMatch:value.matches[index]};
  check(require('../src/services/prematchV3InputIdentity.cjs').verifyPrematchV3InputIdentity(
    value.identityAdmissions?.[index],{...context,match:value.matches[index]}),'MATCH_IDENTITY');
  return {identityAdmission:value.identityAdmissions[index],identityContext:context};
}
function verifyOnlineRead(value, { date, rawResponse, trustRegistry } = {}) {
  try {
    const original = parseResponse(rawResponse), { transport, ...payload } = value;
    const registry=original.version===IDENTITY_VERSION?(trustRegistry||trustedRegistry()):null;
    const expectedPayload=original.version===IDENTITY_VERSION?admitIdentityResponse(original,registry):original;
    validateResponse(expectedPayload, date,{trustRegistry:registry}); validateTransport(transport, original.observedAt);
    if(original.version===IDENTITY_VERSION) {
      const captured=instant(original.identitySource.inputCapturedAt),start=instant(transport.startedAt),finish=instant(transport.finishedAt),tolerance=BigInt(CLOCK_SKEW_MS)*1000000n;
      if(captured===null||captured<start-tolerance||captured>finish+tolerance)return false;
    }
    if (hash(rawResponse) !== transport.remoteResponseSha256 || rawResponse.length !== transport.bytes
      || canonicalJson(expectedPayload) !== canonicalJson(payload)) return false;
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
  const remote = `'use strict';const cp=require('node:child_process'),fs=require('node:fs'),crypto=require('node:crypto');try{
const bytes=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--dbname=football'],{input:${JSON.stringify(query(date))},timeout:22000,maxBuffer:${MAX_BYTES},stdio:['pipe','pipe','pipe']});
const value=JSON.parse(bytes.toString('utf8'));if(value.readOnly!=='on'||value.productionWrites!==0)throw Error();
function readFixed(file,limit){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const a=fs.fstatSync(fd);if(!a.isFile()||a.size<1||a.size>limit)throw Error();const b=fs.readFileSync(fd);const z=fs.fstatSync(fd);if(b.length!==a.size||a.dev!==z.dev||a.ino!==z.ino||a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs)throw Error();return b;}finally{if(fd!==undefined)fs.closeSync(fd);}}
const snapshot=JSON.parse(readFixed(${JSON.stringify(LIVE_CURRENT_SNAPSHOT)},${MAX_BYTES}).toString('utf8'));
const endpoint=(Array.isArray(snapshot.endpoints)?snapshot.endpoints:[]).filter(e=>e?.method==='current');if(endpoint.length!==1)throw Error();
const registry=JSON.parse(readFixed(${JSON.stringify(LIVE_TRUST_REGISTRY)},65536).toString('utf8'));
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';if(typeof v==='number'&&!Number.isFinite(v))throw Error();return JSON.stringify(v);}
const hashRegistry=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
value.identitySource={version:'prematch-v3-online-identity-source-v1',sourcePath:${JSON.stringify(LIVE_CURRENT_SNAPSHOT)},endpoint:endpoint[0],inputCapturedAt:new Date().toISOString(),collectorTrustRegistryHash:hashRegistry(registry)};
const out=Buffer.from(JSON.stringify(value));if(out.length>${MAX_BYTES})throw Error();process.stdout.write(out);
}catch{process.stderr.write('V3_READER_REMOTE_FAILED\\n');process.exitCode=1;}`;
  const startedAt = new Date().toISOString();
  let raw;
  try { raw = execute('ssh', [...buildPinnedSshBaseOptions({keyPath: env.RELEASE_DEPLOY_KEY, pin}), '-p', '22', `${user}@${host}`, 'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'], {input: remote, timeout:45000, maxBuffer:MAX_BYTES, windowsHide:true, stdio:['pipe','pipe','pipe']}); }
  catch { throw Error('V3_READER_PINNED_READ_FAILED'); }
  const finishedAt = new Date().toISOString();
  const original = parseResponse(raw);
  check(!Object.hasOwn(original, 'transport'), 'REMOTE_TRANSPORT_FORBIDDEN');
  const transport = {hostKeyPinVerified:true, hostKeyFingerprint:pin.fingerprint, startedAt, finishedAt,
    remoteResponseSha256:hash(raw), remoteResponseFile:path.basename(rawFile), bytes:raw.length};
  Object.assign(transport, validateTransport(transport, original.observedAt));
  const registry=trustedRegistry(env),value=admitIdentityResponse(original,registry),validation=validateResponse(value,date,{trustRegistry:registry});
  const captured=instant(value.identitySource.inputCapturedAt),finish=instant(finishedAt),start=instant(startedAt),tolerance=BigInt(CLOCK_SKEW_MS)*1000000n;
  check(captured!==null&&captured>=start-tolerance&&captured<=finish+tolerance,'IDENTITY_CAPTURE_TRANSPORT_CLOCK');
  try {
    fs.writeFileSync(rawFile, raw, {flag:'wx', mode:0o600});
    fs.writeFileSync(destination, JSON.stringify({...value, transport}, null, 2) + '\n', {flag:'wx', mode:0o600});
  } catch { throw Error('V3_READER_OUTPUT_COMMIT_FAILED'); }
  return {output:destination, observedAt:value.observedAt, matches:validation.matches, inventory:validation.inventory, modelArtifacts:validation.modelArtifacts,
    missingFields:validation.missingFields, clockNormalizations:validation.clockNormalizations, productionWrites:0, remoteResponseSha256:transport.remoteResponseSha256};
}
if (require.main === module) {
  try { console.log(JSON.stringify(readInputs(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(/^V3_READER_[A-Z0-9_]+$/.test(error.message) ? error.message : 'V3_READER_VALIDATION_FAILED'); process.exitCode=1; }
}
module.exports={VERSION,IDENTITY_VERSION,LIVE_CURRENT_SNAPSHOT,LIVE_TRUST_REGISTRY, MAX_BYTES, MAX_MODEL_ARTIFACT_BYTES, MODEL_ARTIFACT_KEYS, MAX_MATCHES, MAX_INVENTORY, CLOCK_SKEW_MS, validDate, parseArgs, query,
  validateResponse, validateTransport, verifyOnlineRead,admitIdentityResponse,identityOptionsFor,loadTrustedRegistry:trustedRegistry,readInputs};
