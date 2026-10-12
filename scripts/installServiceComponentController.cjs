'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const FILES = require('../services/release/componentController.cjs').FILES;
const DOMAIN = Buffer.from('football-component-controller-install-v1\0');
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
// The bootstrap installs trusted controller source only. It cannot start a
// component, restart an original unit, alter APP, use PostgreSQL, or run npm.
function bootstrapRoot(wire) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
  const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const fail = code => { throw new Error(code); };
  const names = ['services/release/componentController.cjs', 'services/release/componentActivationAuthorization.cjs',
    'services/release/componentTransaction.cjs', 'services/release/componentSigning.cjs', 'services/release/componentPolicy.cjs'];
  const install = '/usr/local/libexec/football-component-release', release = '/var/lib/football-release';
  const env = { PATH: '/opt/node-v22.22.1/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.execPath !== '/opt/node-v22.22.1/bin/node'
    || process.version !== 'v22.22.1' || process.execArgv.length
    || ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].some(k => process.env[k])) fail('FIXED_COMPONENT_BOOTSTRAP_REQUIRED');
  function directory(name) {
    if (fs.realpathSync(name) !== name) fail('COMPONENT_BOOTSTRAP_PATH');
    for (let item = name; ; item = path.dirname(item)) {
      const s = fs.lstatSync(item);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) fail('COMPONENT_BOOTSTRAP_DIRECTORY');
      if (item === '/') break;
    }
  }
  function read(name, maximum) {
    directory(path.dirname(name)); const before = fs.lstatSync(name);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size > maximum) fail('COMPONENT_BOOTSTRAP_FILE');
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd); if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('COMPONENT_BOOTSTRAP_FILE_CHANGED');
      const raw = fs.readFileSync(fd), end = fs.fstatSync(fd), after = fs.lstatSync(name);
      if (opened.size !== end.size || opened.mtimeMs !== end.mtimeMs || opened.ctimeMs !== end.ctimeMs
        || end.ino !== after.ino || end.dev !== after.dev || end.mtimeMs !== after.mtimeMs || end.ctimeMs !== after.ctimeMs) fail('COMPONENT_BOOTSTRAP_FILE_CHANGED');
      return raw;
    } finally { fs.closeSync(fd); }
  }
  function syncDirectory(name) { const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  function writeNew(name, raw, mode) {
    directory(path.dirname(name)); const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDirectory(path.dirname(name));
  }
  const lock = fs.lstatSync('/run/lock/football-release.lock'), fd = fs.fstatSync(9);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== 0 || lock.nlink !== 1 || (lock.mode & 0o022)
    || lock.dev !== fd.dev || lock.ino !== fd.ino) fail('COMPONENT_BOOTSTRAP_LOCK');
  const locks = raw => raw.split('\n').map(row => /(?:^|\s)(FLOCK)\s+(ADVISORY)\s+(WRITE)\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(row)).filter(Boolean).map(row => row.slice(1).join(':'));
  const own = locks(fs.readFileSync('/proc/self/fdinfo/9', 'utf8'));
  if (own.length !== 1 || !locks(fs.readFileSync('/proc/locks', 'utf8')).includes(own[0])) fail('COMPONENT_BOOTSTRAP_EXCLUSIVE_LOCK');
  const { body, signature, payloads } = wire;
  const fields = ['version', 'attemptId', 'head', 'installerSha256', 'controllerSha256', 'expectedAppSha256', 'expectedApiPid', 'expectedWorkerPid', 'issuedAtMs', 'expiresAtMs', 'keyId', 'files'];
  if (!body || Object.keys(body).sort().join(',') !== fields.sort().join(',') || body.version !== 'component-controller-install-v1'
    || !/^[a-f0-9]{24}$/.test(body.attemptId || '') || !/^[a-f0-9]{40}$/.test(body.head || '')
    || ['installerSha256', 'controllerSha256', 'expectedAppSha256', 'keyId'].some(k => !/^[a-f0-9]{64}$/.test(body[k] || ''))
    || ['expectedApiPid', 'expectedWorkerPid'].some(k => !/^[1-9][0-9]*$/.test(body[k] || ''))
    || !Number.isSafeInteger(body.issuedAtMs) || !Number.isSafeInteger(body.expiresAtMs) || body.issuedAtMs > Date.now()
    || body.expiresAtMs <= Date.now() || body.expiresAtMs - body.issuedAtMs <= 0 || body.expiresAtMs - body.issuedAtMs > 900000
    || body.installerSha256 !== sha(bootstrapRoot.toString()) || !Array.isArray(body.files) || body.files.length !== names.length
    || !Array.isArray(payloads) || payloads.length !== names.length || typeof signature !== 'string' || signature.length > 2048) fail('COMPONENT_BOOTSTRAP_AUTHORITY');
  const key = crypto.createPublicKey(read('/etc/football-release/signing-public.pem', 16384));
  if (sha(key.export({ type: 'spki', format: 'der' })) !== body.keyId
    || !crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from('football-component-controller-install-v1\0'), Buffer.from(JSON.stringify(body))]),
      { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64'))) fail('COMPONENT_BOOTSTRAP_SIGNATURE');
  const baselineFiles = body.files.map((row, i) => {
    if (!row || Object.keys(row).sort().join(',') !== 'bytes,path,sha256' || row.path !== names[i]
      || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 1024 * 1024
      || typeof payloads[i] !== 'string' || payloads[i].length > 2 * 1024 * 1024) fail('COMPONENT_BOOTSTRAP_SOURCE_BOUND');
    const raw = Buffer.from(payloads[i], 'base64');
    if (raw.length !== row.bytes || sha(raw) !== row.sha256) fail('COMPONENT_BOOTSTRAP_SOURCE_CHANGED');
    return { path: row.path, sha256: row.sha256 };
  });
  if (sha(JSON.stringify(baselineFiles)) !== body.controllerSha256) fail('COMPONENT_BOOTSTRAP_BASELINE_CHANGED');
  function state() {
    for (const name of ['.release-bundle-sha256', '.release-live-complete']) if (read('/opt/football-predict/' + name, 128).toString('utf8').trim() !== body.expectedAppSha256) fail('COMPONENT_BOOTSTRAP_ORIGINAL_RELEASE_CHANGED');
    for (const name of [release + '/recovery/current', release + '/reference-repairs/current']) if (fs.existsSync(name)) fail('COMPONENT_BOOTSTRAP_PRODUCTION_RECOVERY_PENDING');
    for (const [unit, expected] of [['football-predict.service', body.expectedApiPid], ['football-sync-worker.service', body.expectedWorkerPid]]) {
      const raw = cp.execFileSync('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ActiveState,ControlPID,Job'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 4096 });
      const value = Object.fromEntries(raw.trim().split('\n').map(row => { const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1)]; }));
      if (value.MainPID !== expected || value.ActiveState !== 'active' || value.ControlPID !== '0' || value.Job !== '') fail('COMPONENT_BOOTSTRAP_ORIGINAL_UNIT_CHANGED');
    }
  }
  state(); directory(release); directory('/usr/local/libexec'); directory('/etc/football-release'); directory('/opt');
  if (fs.existsSync(install) || fs.existsSync('/etc/football-release/component-controller-baseline.json')) fail('COMPONENT_CONTROLLER_ALREADY_INSTALLED_OR_PENDING');
  if (fs.statfsSync('/usr/local/libexec').bavail * fs.statfsSync('/usr/local/libexec').bsize < 64 * 1024 * 1024) fail('COMPONENT_BOOTSTRAP_CAPACITY');
  const intent = release + '/component-controller-install-' + body.attemptId + '.json';
  writeNew(intent, Buffer.from(JSON.stringify({ body, signature, scope: 'controller-code-only-no-startup-no-production-data', startedAt: new Date().toISOString() }) + '\n'), 0o600);
  fs.mkdirSync(install, { mode: 0o755 }); syncDirectory(path.dirname(install));
  for (let i = 0; i < names.length; i++) {
    const destination = install + '/' + names[i]; fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeNew(destination, Buffer.from(payloads[i], 'base64'), 0o444);
  }
  for (const [folder, mode] of [['/var/lib/football-release/components', 0o700], ['/var/lib/football-release/components/read-api', 0o700],
    ['/var/lib/football-release/components/incoming', 0o700], ['/opt/football-services', 0o755], ['/opt/football-services/read-api', 0o755], ['/opt/football-services/read-api/releases', 0o755]]) {
    if (!fs.existsSync(folder)) { directory(path.dirname(folder)); fs.mkdirSync(folder, { mode }); syncDirectory(path.dirname(folder)); }
    directory(folder); if ((fs.statSync(folder).mode & 0o777) !== mode) fail('COMPONENT_BOOTSTRAP_DIRECTORY_MODE');
  }
  for (const row of baselineFiles) if (sha(read(install + '/' + row.path, 1024 * 1024)) !== row.sha256) fail('COMPONENT_BOOTSTRAP_INSTALLED_SOURCE_CHANGED');
  state();
  writeNew('/etc/football-release/component-controller-baseline.json', Buffer.from(JSON.stringify({ version: 'installed-component-controller-baseline-v1', head: body.head, files: baselineFiles }) + '\n'), 0o600);
  const result = { version: 'component-controller-install-result-v1', installedAt: new Date().toISOString(), head: body.head,
    controllerSha256: body.controllerSha256, originalAppSha256: body.expectedAppSha256, originalPids: [body.expectedApiPid, body.expectedWorkerPid],
    controllerInstalled: true, componentStarted: false, nextHttpStarted: false, productionDataWrites: 0, databaseMigrations: 0 };
  writeNew(release + '/component-controller-installed-' + body.attemptId + '.json', Buffer.from(JSON.stringify(result) + '\n'), 0o600);
  console.log(JSON.stringify(result));
}
function packageController(boundary, key) {
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (cp.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Committed clean controller source required');
  if (boundary.release !== 844 || !Number.isFinite(Date.parse(boundary.observedAt)) || Date.now() - Date.parse(boundary.observedAt) > 60_000
    || Date.parse(boundary.observedAt) > Date.now() || boundary.services?.length !== 2) throw new Error('Fresh original-release boundary required');
  const payloads = FILES.map(file => cp.execFileSync('git', ['cat-file', 'blob', head + ':' + file], { cwd: root, maxBuffer: 1024 * 1024 }));
  const files = FILES.map((file, i) => ({ path: file, bytes: payloads[i].length, sha256: hash(payloads[i]) }));
  const issuedAtMs = Date.now();
  const body = { version: 'component-controller-install-v1', attemptId: crypto.randomBytes(12).toString('hex'), head,
    installerSha256: hash(bootstrapRoot.toString()), controllerSha256: hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))),
    expectedAppSha256: 'e3a6855b19b143377973bb2364aba7d8ec8d7d3a5601522dc59635e180ede9d1',
    expectedApiPid: boundary.services.find(s => s.unit === 'football-predict.service')?.pid,
    expectedWorkerPid: boundary.services.find(s => s.unit === 'football-sync-worker.service')?.pid,
    issuedAtMs, expiresAtMs: issuedAtMs + 900000, keyId: key.keyId, files };
  const signature = crypto.sign('RSA-SHA256', Buffer.concat([DOMAIN, Buffer.from(JSON.stringify(body))]), { key: key.key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
  return { body, signature, payloads: payloads.map(raw => raw.toString('base64')) };
}
function main() {
  const mode = process.argv[2], boundaryPath = process.argv[3];
  if (!['--prepare', '--install'].includes(mode) || !path.isAbsolute(boundaryPath || '') || process.argv.length !== 4) throw new Error('Use --prepare or --install with an absolute fresh boundary receipt');
  const wrapper = JSON.parse(fs.readFileSync(boundaryPath)), boundary = wrapper.stdout ? JSON.parse(wrapper.stdout) : wrapper;
  if (wrapper.status !== undefined && wrapper.status !== 0) throw new Error('Successful boundary receipt required');
  const wire = packageController(boundary, require('./releaseSigning.cjs').loadReleasePrivateKey());
  const output = path.join(root, '.codex-tmp', 'component-controller-install-' + wire.body.attemptId + '.json');
  fs.writeFileSync(output + '.signed-request.json', JSON.stringify(wire) + '\n', { flag: 'wx', mode: 0o600 });
  if (mode === '--prepare') return { output: output + '.signed-request.json', head: wire.body.head, controllerSha256: wire.body.controllerSha256, installed: false };
  const pinLib = require('./releaseSshHostKeyPin.cjs');
  const pin = pinLib.resolveReleaseSshHostKeyPin({ rootDir: root, tmpDir: path.dirname(output), host: '134.175.132.183', port: 22 });
  const remote = bootstrapRoot.toString() + '\nbootstrapRoot(' + JSON.stringify(wire) + ');';
  const command = "sudo -n /bin/bash -c 'exec 9>/run/lock/football-release.lock; /usr/bin/flock -n 9 || exit 73; exec /usr/bin/env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'";
  const result = cp.spawnSync('ssh', ['-p', '22', ...pinLib.buildPinnedSshBaseOptions({ keyPath: process.env.RELEASE_DEPLOY_KEY, pin }), 'ubuntu@134.175.132.183', command],
    { input: remote, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
  fs.writeFileSync(output, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code || null, stdout: result.stdout, stderr: result.stderr }) + '\n', { flag: 'wx' });
  if (result.status !== 0) throw Object.assign(new Error('COMPONENT_CONTROLLER_INSTALL_FAILED'), { receipt: output });
  return { output, sha256: hash(fs.readFileSync(output)), ...JSON.parse(result.stdout) };
}
if (require.main === module) { try { console.log(JSON.stringify(main())); } catch (error) { console.error(JSON.stringify({ error: error.code || error.message, receipt: error.receipt || null })); process.exitCode = 1; } }
module.exports = { bootstrapRoot, packageController };
