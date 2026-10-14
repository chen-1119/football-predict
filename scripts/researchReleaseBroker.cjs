'use strict';
// Install as a root-owned module with the normal signed release. Invoke through
// flock --no-fork; no sudo permission, network listener or timer is added here.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { findHeldReleaseLock, releaseBoundary } = require('../server/researchReleaseLock.cjs');
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
  for (const file of ['scripts/researchBrokerWorker.cjs', 'deploy/light-server/collector-trust-registry.json']) visit(ROOT + '/' + file);
  return binding;
}
function syncNew(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const d = fs.openSync(path.dirname(file), fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
async function main() {
  const lockFd = findHeldReleaseLock(), binding = verifyInstalledBinding();
  const directory = fs.lstatSync(JOURNAL);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o077)) fail('RESEARCH_JOURNAL_IDENTITY');
  const chunks = []; let count = 0;
  for await (const b of process.stdin) { count += b.length; if (count > MAX_BYTES) fail('RESEARCH_REQUEST_BOUND'); chunks.push(b); }
  const request = Buffer.concat(chunks), requestSha = sha(request);
  // Parse in the unprivileged child. Root accepts bounded bytes only.
  const intent = path.join(JOURNAL, requestSha + '.intent.json'), receipt = path.join(JOURNAL, requestSha + '.receipt.json');
  if (fs.existsSync(receipt)) {
    const saved = trustedFile(receipt, 3 * 1024 * 1024), result = JSON.parse(saved);
    if (result.requestSha !== requestSha || result.releaseSha !== binding.releaseSha) fail('RESEARCH_RECEIPT_BINDING');
    process.stdout.write(saved); if (result.code !== 0 || result.overflow) process.exitCode = 1; return;
  }
  if (fs.existsSync(intent)) fail('RESEARCH_PREVIOUS_REQUEST_UNCONFIRMED_READ_FIRST');
  syncNew(intent, JSON.stringify({ version: 'research-broker-intent-v1', requestSha, releaseSha: binding.releaseSha, admittedAt: new Date().toISOString(), automaticWriteRetry: false }));
  const beforePid = cp.execFileSync('/usr/bin/systemctl', ['show', 'football-predict.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (!/^[1-9][0-9]*$/.test(beforePid)) fail('RESEARCH_API_NOT_ACTIVE');
  const environmentBytes = fs.readFileSync('/proc/' + beforePid + '/environ');
  if (environmentBytes.length > 131072) fail('RESEARCH_ENV_BOUND');
  const source = Object.fromEntries(environmentBytes.toString().split('\0').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  const env = { PATH: '/usr/bin:/bin', NODE_ENV: 'production' };
  for (const key of ['FOOTBALL_POSTGRES_URL', 'DATABASE_URL', 'FOOTBALL_POSTGRES_SSL_MODE', 'SPORTTERY_RELAY_FAST_LANE_SNAPSHOT', 'SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH', 'SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH', 'SERVER_STORE_DIR', 'DATA_STORE_DIR']) if (source[key]) env[key] = source[key];
  if (!(env.FOOTBALL_POSTGRES_URL || env.DATABASE_URL) || env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH !== ROOT + '/deploy/light-server/collector-trust-registry.json') fail('RESEARCH_ENV_IDENTITY');
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
  syncNew(receipt, JSON.stringify(result) + '\n'); process.stdout.write(JSON.stringify(result) + '\n');
  if (code !== 0 || overflow) process.exitCode = 1;
}
if (require.main === module) main().catch(e => {
  process.stderr.write(JSON.stringify({ ok: false, error: /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'RESEARCH_BROKER_UNCONFIRMED_READ_FIRST', retryWriteAutomatically: false }) + '\n'); process.exitCode = 1;
});
module.exports = { trustedFile, syncNew };
