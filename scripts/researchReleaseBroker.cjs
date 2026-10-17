'use strict';
// Install as a root-owned module with the normal signed release. Invoke through
// flock --no-fork; no sudo permission, network listener or timer is added here.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { findHeldReleaseLock, releaseBoundary } = require('../server/researchReleaseLock.cjs');
const { readResearchRequestBody } = require('../server/researchRequestBody.cjs');
const ROOT = '/opt/football-predict';
const CONFIG = '/usr/local/libexec/football-research-broker/runtime-binding.json';
const JOURNAL = '/var/lib/football-research-broker';
const NODE = '/opt/node-v22.22.1/bin/node';
const MAX_BYTES = 1024 * 1024;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
function trustedFile(file, max) {
  let cursor = file;
  while (true) {
    const s = fs.lstatSync(cursor);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) fail('RESEARCH_ROOT_OWNERSHIP');
    if (cursor === '/') break;
    cursor = path.dirname(cursor);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || stat.uid !== 0 || (stat.mode & 0o022)) fail('RESEARCH_TRUSTED_FILE_BOUND');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function verifyInstalledBinding() {
  const binding = JSON.parse(trustedFile(CONFIG, 16384));
  if (binding.version !== 'research-broker-binding-v1' || !/^[a-f0-9]{64}$/.test(binding.releaseSha || '')
    || !/^[a-f0-9]{64}$/.test(binding.manifestSha || '') || !/^[a-f0-9]{64}$/.test(binding.nodeSha || '')) fail('RESEARCH_BINDING_SCHEMA');
  // The installer supplies these trusted paths; requests cannot select a key,
  // manifest, program, source directory, database, user, or environment.
  for (const field of ['manifestPath', 'signaturePath', 'publicKeyPath']) if (typeof binding[field] !== 'string' || !path.isAbsolute(binding[field])) fail('RESEARCH_BINDING_PATH');
  const bytes = trustedFile(binding.manifestPath, 16 * 1024 * 1024);
  if (sha(bytes) !== binding.manifestSha || sha(trustedFile(NODE, 128 * 1024 * 1024)) !== binding.nodeSha) fail('RESEARCH_BINDING_HASH');
  const publicKey = crypto.createPublicKey(trustedFile(binding.publicKeyPath, 16384));
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048
    || !crypto.verify('sha256', bytes, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, trustedFile(binding.signaturePath, 16384))) fail('RESEARCH_MANIFEST_SIGNATURE');
  const manifest = JSON.parse(bytes);
  if (manifest.ok !== true || manifest.sha256 !== binding.releaseSha || !Number.isSafeInteger(manifest.releaseSequence)) fail('RESEARCH_MANIFEST_IDENTITY');
  releaseBoundary(ROOT, binding.releaseSha);
  const inventory = new Map(manifest.archiveSourceEvidence?.inventory?.entries?.map(r => [r.path, r.sha256]));
  if (!inventory.size) fail('RESEARCH_SOURCE_INVENTORY');
  const seen = new Set();
  function visit(file) {
    if (!file.startsWith(ROOT + '/')) fail('RESEARCH_SOURCE_PATH');
    if (seen.has(file)) return; seen.add(file);
    const body = trustedFile(file, 8 * 1024 * 1024), relative = path.relative(ROOT, file);
    if (inventory.get(relative) !== sha(body)) fail('RESEARCH_SOURCE_HASH');
    for (const m of body.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) visit(require.resolve(path.resolve(path.dirname(file), m[1])));
  }
  for (const file of ['scripts/researchReleaseBroker.cjs', 'scripts/researchBrokerWorker.cjs', 'deploy/light-server/collector-trust-registry.json']) visit(ROOT + '/' + file);
  const dependencies = trustedFile('/usr/local/libexec/football-research-broker/dependencies.json', 1024*1024);
  if (sha(dependencies) !== binding.dependenciesSha256) fail('RESEARCH_DEPENDENCY_BINDING');
  require('../server/researchBrokerDependencies.cjs').verify(ROOT,JSON.parse(dependencies),file=>trustedFile(file,4*1024*1024));
  return binding;
}
function syncNew(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const d = fs.openSync(path.dirname(file), fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
function requestJournalIdentity(request) {
  let purpose; try { purpose = JSON.parse(request.toString('utf8')); } catch { fail('RESEARCH_REQUEST_JSON'); }
  if (purpose?.version !== 'research-broker-request-v1' || !['archive','archive-read','publish','publication-read','revision-publish','revision-read','combo-revision-publish','combo-revision-read','publication-retry','archive-retry'].includes(purpose.action)) fail('RESEARCH_REQUEST_ACTION');
  const requestSha = sha(request), readOnly = ['archive-read','publication-read','revision-read','combo-revision-read'].includes(purpose.action);
  // Read requests need a fresh database observation. A cached not-observed read
  // must never hide a later COMMIT. Mutation identities remain durable/exact.
  return { requestSha, readOnly, journalId: purpose.action==='archive-retry'?require('../server/researchArchiveRetry.cjs').journalId(purpose):purpose.action==='publication-retry'?require('../server/researchPublicationRetry.cjs').journalId(purpose):requestSha + (readOnly ? '-read-' + crypto.randomBytes(12).toString('hex') : '') };
}
function replayEnvelope(saved, requestSha, releaseSha, now = new Date().toISOString()) {
  if (!Buffer.isBuffer(saved) || saved.length > 3*1024*1024-4096) fail('RESEARCH_RECEIPT_BOUND');
  const result = JSON.parse(saved);
  if (result.version !== 'research-broker-result-v1' || result.requestSha !== requestSha || result.releaseSha !== releaseSha
    || result.automaticWriteRetry !== false || !Number.isFinite(Date.parse(result.finishedAt))
    || new Date(result.finishedAt).toISOString() !== result.finishedAt || Date.parse(result.finishedAt) > Date.parse(now)) fail('RESEARCH_RECEIPT_BINDING');
  // Preserve the original completion clock and bytes. deliveredAt is a new
  // transport observation, never a new database commit or publication clock.
  return { version: 'research-broker-replay-v1', requestSha, releaseSha, deliveredAt: now,
    originalReceiptBase64: saved.toString('base64'), originalReceiptSha256: sha(saved), automaticWriteRetry: false };
}
async function main() {
  const lockFd = findHeldReleaseLock(), binding = verifyInstalledBinding();
  const directory = fs.lstatSync(JOURNAL);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o077)) fail('RESEARCH_JOURNAL_IDENTITY');
  const request = await readResearchRequestBody(process.stdin, { maxBytes: MAX_BYTES });
  const { requestSha, readOnly, journalId } = requestJournalIdentity(request);
  const purpose=JSON.parse(request.toString('utf8'));
  if(purpose.action==='publication-retry')require('../server/researchPublicationRetry.cjs').verifyFailure(purpose,trustedFile);
  if(purpose.action==='archive-retry')require('../server/researchArchiveRetry.cjs').verifyFailure(purpose,trustedFile);
  // Full request/draft validation stays in the unprivileged child. Root only
  // classifies the four fixed purposes and journals the original bounded bytes.
  const intent = path.join(JOURNAL, journalId + '.intent.json'), receipt = path.join(JOURNAL, journalId + '.receipt.json');
  if (!readOnly && fs.existsSync(receipt)) {
    const saved = trustedFile(receipt, 3 * 1024 * 1024), result = JSON.parse(saved);
    process.stdout.write(JSON.stringify(replayEnvelope(saved, requestSha, binding.releaseSha)) + '\n');
    if (result.code !== 0 || result.overflow) process.exitCode = 1; return;
  }
  if (!readOnly && fs.existsSync(intent)) fail('RESEARCH_PREVIOUS_REQUEST_UNCONFIRMED_READ_FIRST');
  require('../server/researchBrokerJournal.cjs').journalBudget(JOURNAL, request.length + 4 * 1024 * 1024);
  syncNew(intent, JSON.stringify({ version: 'research-broker-intent-v1', requestSha, releaseSha: binding.releaseSha, admittedAt: new Date().toISOString(), automaticWriteRetry: false }));
  const beforePid = cp.execFileSync('/usr/bin/systemctl', ['show', 'football-predict.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (!/^[1-9][0-9]*$/.test(beforePid)) fail('RESEARCH_API_NOT_ACTIVE');
  const environmentBytes = fs.readFileSync('/proc/' + beforePid + '/environ');
  if (environmentBytes.length > 131072) fail('RESEARCH_ENV_BOUND');
  const source = Object.fromEntries(environmentBytes.toString().split('\0').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  const env = { PATH: '/usr/bin:/bin', NODE_ENV: 'production' };
  for (const key of ['FOOTBALL_POSTGRES_URL', 'DATABASE_URL', 'FOOTBALL_POSTGRES_SSL_MODE', 'SPORTTERY_RELAY_FAST_LANE_SNAPSHOT', 'SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH', 'SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH', 'SERVER_STORE_DIR', 'DATA_STORE_DIR']) if (source[key]) env[key] = source[key];
  if (!(env.FOOTBALL_POSTGRES_URL || env.DATABASE_URL) || env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH !== ROOT + '/deploy/light-server/collector-trust-registry.json') fail('RESEARCH_ENV_IDENTITY');
  const capabilities=/^CapEff:\s+([a-f0-9]+)$/mi.exec(fs.readFileSync('/proc/self/status','utf8'));
  if(!capabilities||(BigInt('0x'+capabilities[1])&0xc0n)!==0xc0n)fail('RESEARCH_FIXED_UID_TRANSITION_UNAVAILABLE');
  const child = cp.spawn('/usr/sbin/runuser', ['-u', 'football', '--', NODE, ROOT + '/scripts/researchBrokerWorker.cjs'], {
    env, stdio: ['pipe', 'pipe', 'pipe', lockFd], cwd: ROOT,
  });
  const output = [], errors = []; let outputBytes = 0;
  let overflow = false;
  const collect = list => b => { outputBytes += b.length; if (outputBytes > 3 * 1024 * 1024) { overflow = true; child.kill('SIGTERM'); } else list.push(b); };
  child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors));
  child.stdin.on('error', () => {}); child.stdin.end(request);
  // FD3 is inherited by runuser and Node. The lock survives a killed parent
  // until the actual database worker exits; a timer must use KillMode=control-group.
  const forward = () => child.kill('SIGTERM');
  process.on('SIGTERM', forward); process.on('SIGINT', forward);
  const timeout = setTimeout(forward, 45000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); process.off('SIGTERM', forward); process.off('SIGINT', forward); }
  releaseBoundary(ROOT, binding.releaseSha);
  if (cp.execFileSync('/usr/bin/systemctl', ['show', 'football-predict.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim() !== beforePid) fail('RESEARCH_API_CHANGED');
  const stdout = Buffer.concat(output).toString(), stderr = Buffer.concat(errors).toString();
  const result = { version: 'research-broker-result-v1', requestSha, releaseSha: binding.releaseSha, finishedAt: new Date().toISOString(), code, overflow, stdout, stderr, automaticWriteRetry: false };
  const resultBytes = Buffer.from(JSON.stringify(result) + '\n');
  if (resultBytes.length > 3*1024*1024-4096) fail('RESEARCH_RECEIPT_BOUND');
  syncNew(receipt, resultBytes); process.stdout.write(resultBytes);
  if (code !== 0 || overflow) process.exitCode = 1;
}
if (require.main === module) main().catch(e => {
  process.stdin.destroy();
  process.stderr.write(JSON.stringify({ ok: false, error: /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'RESEARCH_BROKER_UNCONFIRMED_READ_FIRST', retryWriteAutomatically: false }) + '\n'); process.exitCode = 1;
});
module.exports = { trustedFile, syncNew, requestJournalIdentity, verifyInstalledBinding, replayEnvelope };
