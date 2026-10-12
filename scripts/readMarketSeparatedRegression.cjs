'use strict';

// Bounded, repeatable-read production export. Never invokes a collector,
// publisher, settlement writer or model fitter. Originals are create-only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
const { epochNanoseconds: clock } = require('../src/services/prematchV3Clock.cjs');
const { buildRecommendationReviewPage, parseReviewQuery } = require('../server/recommendationReviewPage.cjs');

const VERSION = 'market-separated-production-readonly-export-v1';
const MAX_EVENTS = 500;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const TRANSPORT_CLOCK_SKEW_NS = 5n * 1000000000n;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, reason) => { if (!value) throw new Error(`MARKET_READER_${reason}`); };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function validateRange(from, through) {
  check(validDate(from) && validDate(through) && from <= through, 'INVALID_RANGE');
  check(Date.parse(through) - Date.parse(from) <= 31 * 86400000, 'RANGE_OVER_32_DAYS');
  return { from, through };
}
function buildSql(from, through) {
  validateRange(from, through);
  // Only validated ISO dates and constant bounds enter SQL text.
  return `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15000';
SET LOCAL lock_timeout='2000';
SET LOCAL idle_in_transaction_session_timeout='20000';
WITH chosen AS MATERIALIZED (
 SELECT DISTINCT ON (source_match_id,event_version) id,source_match_id,event_version,payload,sequence
 FROM football.recommendation_decisions
 WHERE business_date BETWEEN '${from}'::date AND '${through}'::date
 ORDER BY source_match_id,event_version,sequence DESC LIMIT ${MAX_EVENTS + 1}
), heads AS MATERIALIZED (
 SELECT e.payload FROM chosen d
 JOIN football.recommendation_result_heads h
 ON h.source_match_id=d.source_match_id AND h.event_version=d.event_version
 JOIN football.recommendation_result_events e ON e.id=h.event_id
 AND e.source_match_id=h.source_match_id AND e.event_version=h.event_version
 LIMIT ${MAX_EVENTS + 1}
), proofs AS MATERIALIZED (
 SELECT m.payload FROM chosen d JOIN football.match_snapshots m
 ON m.source_match_id=d.source_match_id AND m.kickoff_time=d.event_version
 WHERE m.dataset IN ('current','history') ORDER BY m.id LIMIT ${MAX_EVENTS * 2 + 1}
)
SELECT jsonb_build_object(
 'version','${VERSION}','observedAt',clock_timestamp(),
 'database',current_database(),'readOnly',current_setting('transaction_read_only'),
 'isolation',current_setting('transaction_isolation'),'productionWrites',0,
 'from','${from}','through','${through}',
 'maxEvents',${MAX_EVENTS},'latestPerEvent',true,
 'decisions',(SELECT COALESCE(jsonb_agg(payload ORDER BY sequence),'[]'::jsonb) FROM chosen),
 'resultHeads',(SELECT COALESCE(jsonb_agg(payload),'[]'::jsonb) FROM heads),
 'resultEvidenceRows',(SELECT COALESCE(jsonb_agg(payload),'[]'::jsonb) FROM proofs),
 'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta
 WHERE key IN ('data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at','fast_result_revision')),
 'currentCenter',(SELECT (payload->'recommendationCenter')-'review'-'todayDualResearch'
 FROM football.daily_featured_combo_state WHERE id=1));
ROLLBACK;
`;
}
function buildRemoteReader(from, through) {
  const sql = buildSql(from, through);
  return `'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
function marker(name){const file='/opt/football-predict/'+name,s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||s.size>128||(s.mode&0o022))throw Error('marker');const v=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(v))throw Error('marker');return v;}
const markers=()=>({runtimeSha:marker('.release-bundle-sha256'),completeSha:marker('.release-live-complete')});
try{const before=markers();if(before.runtimeSha!==before.completeSha)throw Error('runtime-incomplete');
const bytes=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--dbname=football'],{input:${JSON.stringify(sql)},timeout:25000,maxBuffer:${MAX_RESPONSE_BYTES},stdio:['pipe','pipe','pipe']});
const value=JSON.parse(bytes.toString('utf8')),after=markers();
if(JSON.stringify(before)!==JSON.stringify(after)||value.readOnly!=='on'||value.isolation!=='repeatable read'||value.productionWrites!==0)throw Error('changed-or-write');
process.stdout.write(JSON.stringify({...value,runtime:{...before,stable:true}})+'\\n');
}catch{process.stderr.write('MARKET_READER_REMOTE_REFUSED\\n');process.exitCode=1;}
`;
}
function validateResponse(value, range) {
  check(value?.version === VERSION && value.database === 'football' && value.readOnly === 'on'
    && value.isolation === 'repeatable read' && value.productionWrites === 0, 'NOT_READONLY');
  check(value.from === range.from && value.through === range.through && value.maxEvents === MAX_EVENTS
    && value.latestPerEvent === true && clock(value.observedAt) !== null, 'RESPONSE_RANGE_OR_CLOCK');
  check(Array.isArray(value.decisions) && value.decisions.length <= MAX_EVENTS
    && Array.isArray(value.resultHeads) && value.resultHeads.length <= value.decisions.length
    && Array.isArray(value.resultEvidenceRows) && value.resultEvidenceRows.length <= MAX_EVENTS * 2, 'EVENT_BOUND');
  check(value.runtime?.stable === true && /^[a-f0-9]{64}$/.test(value.runtime.runtimeSha || '')
    && value.runtime.runtimeSha === value.runtime.completeSha, 'RUNTIME_PAIR');
  check(value.generation?.data_publication_mode === 'active-generation'
    && /^g-[a-f0-9]{64}$/.test(value.generation.data_generation_id || '')
    && /^[a-f0-9]{64}$/.test(value.generation.manifest_hash || '')
    && clock(value.generation.committed_at) !== null
    && clock(value.generation.committed_at) <= clock(value.observedAt), 'GENERATION');
  const events = new Set();
  for (const d of value.decisions) {
    check(typeof d?.sourceMatchId === 'string' && /^[0-9]{1,16}$/.test(d.sourceMatchId)
      && clock(d.eventVersion) !== null && validDate(d.businessDate)
      && d.businessDate >= range.from && d.businessDate <= range.through
      && clock(d.publishedAt) !== null && clock(d.publishedAt) <= clock(value.observedAt), 'DECISION_IDENTITY_OR_CLOCK');
    const key = JSON.stringify([d.sourceMatchId, clock(d.eventVersion).toString()]);
    check(!events.has(key), 'DUPLICATE_DECISION_EVENT'); events.add(key);
  }
  const heads = new Set();
  for (const h of value.resultHeads) {
    check(clock(h?.eventVersion) !== null && clock(h.observedAt) !== null
      && clock(h.observedAt) <= clock(value.observedAt), 'HEAD_CLOCK');
    const key = JSON.stringify([h.sourceMatchId, clock(h.eventVersion).toString()]);
    check(events.has(key) && !heads.has(key), 'HEAD_IDENTITY_OR_DUPLICATE'); heads.add(key);
  }
  return value;
}
function reviewPages(value) {
  const source = { updatedAt: value.observedAt, decisions: value.decisions,
    resultEvents: value.resultHeads, combos: [], boundDecisions: [] };
  return ['HAD', 'HHAD'].flatMap(market => {
    const firstFilters = parseReviewQuery(new URL(`https://review.invalid/?kind=single&market=${market}&page=1&pageSize=50`));
    const first = buildRecommendationReviewPage(source, firstFilters, Date.parse(value.observedAt));
    check(first.pageCount <= 10, 'PAGE_BOUND');
    return Array.from({ length: Math.max(1, first.pageCount) }, (_, i) => i === 0 ? first
      : buildRecommendationReviewPage(source, { ...firstFilters, page: i + 1 }, Date.parse(value.observedAt)));
  });
}
function validateTransportClock(observedAt, startedAt, finishedAt) {
  const observed = clock(observedAt), started = clock(startedAt), finished = clock(finishedAt);
  check(observed !== null && started !== null && finished !== null && started <= finished
    && observed >= started - TRANSPORT_CLOCK_SKEW_NS && observed <= finished + TRANSPORT_CLOCK_SKEW_NS,
  'REMOTE_CLOCK_OUTSIDE_TRANSPORT');
  return { allowedSkewMs: 5000, observedMinusStartedMs: Number(observed - started) / 1e6,
    finishedMinusObservedMs: Number(finished - observed) / 1e6 };
}
function readOnline({ from, through, output }, { env = process.env, execute = cp.execFileSync } = {}) {
  check(process.version === 'v22.22.1', 'FIXED_NODE22_REQUIRED');
  const range = validateRange(from, through), destination = path.resolve(output), rawFile = destination + '.remote-response.json';
  check(!fs.existsSync(destination) && !fs.existsSync(rawFile)
    && fs.statSync(path.dirname(destination)).isDirectory(), 'CREATE_ONLY_OUTPUT');
  const host = env.RELEASE_DEPLOY_HOST, user = env.RELEASE_DEPLOY_USER, keyPath = env.RELEASE_DEPLOY_KEY;
  check(typeof host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)
    && typeof user === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(user)
    && keyPath && env.RELEASE_DEPLOY_KNOWN_HOSTS && env.RELEASE_DEPLOY_HOST_KEY_SHA256
    && (!env.RELEASE_DEPLOY_PORT || String(env.RELEASE_DEPLOY_PORT) === '22'), 'SSH_CONFIG');
  const pin = validateReleaseSshHostKeyPin({ knownHostsPath: env.RELEASE_DEPLOY_KNOWN_HOSTS,
    host, port: 22, expectedFingerprint: env.RELEASE_DEPLOY_HOST_KEY_SHA256 });
  const startedAt = new Date().toISOString(); let raw;
  try {
    raw = execute('C:/Windows/System32/OpenSSH/ssh.exe', [...buildPinnedSshBaseOptions({ keyPath, pin }),
      '-p', '22', `${user}@${host}`, 'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'],
    { input: buildRemoteReader(from, through), timeout: 45000, maxBuffer: MAX_RESPONSE_BYTES,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('MARKET_READER_PINNED_READ_FAILED'); }
  check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_RESPONSE_BYTES, 'RESPONSE_BYTES');
  const finishedAt = new Date().toISOString();
  // Save every successfully transported original, including a validation refusal.
  fs.writeFileSync(rawFile, raw, { flag: 'wx', mode: 0o600 });
  const value = validateResponse(JSON.parse(raw.toString('utf8')), range);
  const clockBinding = validateTransportClock(value.observedAt, startedAt, finishedAt);
  const record = { ...value, reviewPages: reviewPages(value),
    reviewScope: 'local projection of newly exported production records;not API page entitlement or source re-fetch proof',
    calibrationAllowed: false, trainingPerformed: false,
    transport: { hostKeyPinVerified: true, startedAt, finishedAt, clockBinding, remoteResponseSha256: hash(raw),
      remoteResponseBytes: raw.length, remoteResponseFile: path.basename(rawFile) } };
  fs.writeFileSync(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output: destination, observedAt: value.observedAt, decisions: value.decisions.length,
    resultHeads: value.resultHeads.length, runtimeSha: value.runtime.runtimeSha,
    productionWrites: 0, remoteResponseSha256: hash(raw) };
}
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    check(['--from', '--through', '--output'].includes(args[i]) && !Object.hasOwn(options, args[i])
      && typeof args[i + 1] === 'string' && args[i + 1].length > 0, 'ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  check(options['--output'], 'OUTPUT_REQUIRED');
  validateRange(options['--from'], options['--through']);
  return { from: options['--from'], through: options['--through'], output: options['--output'] };
}
if (require.main === module) {
  try { console.log(JSON.stringify(readOnline(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(/^MARKET_READER_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'MARKET_READER_VALIDATION_FAILED'); process.exitCode = 1; }
}
module.exports = { VERSION, MAX_EVENTS, MAX_RESPONSE_BYTES, validateRange, buildSql, buildRemoteReader,
  validateResponse, validateTransportClock, reviewPages, readOnline, parseArgs };
