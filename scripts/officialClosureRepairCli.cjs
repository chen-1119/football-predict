'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const policy = require('./officialClosureRepairPolicy.cjs');
const root = path.resolve(__dirname, '..');
const SOURCE_COMMIT = '1d0daef3924f7ef875d6de93b4f54e8463162883';
const BEFORE = Object.freeze({
  'scripts/syncData.cjs': '02e70e8129351e42fcdd3c0ac6d6031be7e2c2ce57f992c4bdf4ee2628dab02b',
  'scripts/validateData.cjs': '97f9bffe1268372b2c58f8e418d3b2d7d3744c7adef464f4b6b562cdbf70f4f8',
});
const HELPER_SHA = '90dd4b7f2c4521a8beb54e5692414122756796fba2926f1b1e3c9e185ccb51c5';
const PATCH_SHA = '945a9b6bc11572cc3c7d43a6983c126f5038354c40e01ee9decd3ac366ac9162';
// No official first-party contract has established the two SaleStatus fields'
// 0/1 meaning. Synthetic proof fixtures cannot authorize production. Removing
// this fixed block requires a separately reviewed code change backed by that
// official semantic contract; there is deliberately no runtime override.
const SEMANTIC_CONTRACT_BLOCK = 'official closure semantic contract unverified; create/prepare/activate disabled pending separately reviewed official evidence';
const AFTER = Object.freeze({
  'scripts/syncData.cjs': '6be7a3af234b7bb2901130936c484ce378a76084786cc05614d4b984a5d9c703',
  'scripts/validateData.cjs': '0ab9f9af87bfc9d23b0008cadb371fea5747e2422d8e71ae0d680c193ff15e93',
  'scripts/officialClosedScheduleEvidence.cjs': HELPER_SHA,
});
function existingDirectory(directory) {
  assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'absolute local directory required');
  const value = path.resolve(directory), stat = fs.lstatSync(value);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'local directory must not be a link');
  assert.equal(fs.realpathSync(value), value, 'local directory must not alias another path'); return value;
}
function localBytes(file, limit = 8 * 1024 ** 2) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'absolute local file required');
  file = path.resolve(file);
  existingDirectory(path.dirname(file)); const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit), 'unsafe local material');
  assert.equal(fs.realpathSync(file), file, 'local material path must not alias');
  const fd = fs.openSync(file, 'r');
  try {
    const same = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key]);
    assert.ok(same(fs.fstatSync(fd, { bigint: true })), 'local material changed before read');
    const bytes = fs.readFileSync(fd); assert.ok(same(fs.fstatSync(fd, { bigint: true })) && same(fs.lstatSync(file, { bigint: true })), 'local material changed during read');
    assert.equal(BigInt(bytes.length), before.size); return bytes;
  } finally { fs.closeSync(fd); }
}
function newOutput(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'absolute new output required');
  const output = path.resolve(file), roots = [path.join(root, '.codex-tmp'), path.join(root, 'outputs')];
  assert.ok(roots.some(directory => output.startsWith(directory + path.sep)), 'maintenance output must remain in checkout outputs or .codex-tmp');
  existingDirectory(path.dirname(output));
  try { fs.lstatSync(output); assert.fail('maintenance output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}
function material(file) { const bytes = localBytes(file); return { sha256: policy.hash(bytes), base64: bytes.toString('base64') }; }
function parseArgs(args) {
  const options = {}, seen = new Set();
  for (const arg of args) { const match = /^--(action|observation|baseline|capsule|output)=(.+)$/.exec(arg);
    assert.ok(match && !seen.has(match[1]), 'unknown or duplicate maintenance argument'); seen.add(match[1]); options[match[1]] = match[2]; }
  const required = { inspect: ['output'], sources: ['baseline', 'output'], create: ['observation', 'baseline'], prepare: ['capsule'], activate: ['capsule'], status: ['capsule'], recover: ['capsule'] };
  assert.ok(required[options.action], 'explicit maintenance action required');
  const allowed = new Set(['action', ...required[options.action], ...(options.action === 'create' ? ['output'] : [])]);
  assert.ok(Object.keys(options).every(key => allowed.has(key)), 'argument is not allowed for this maintenance action');
  for (const key of required[options.action]) assert.ok(options[key], 'missing maintenance argument: ' + key);
  for (const [key, value] of Object.entries(options)) if (key !== 'action') assert.ok(path.isAbsolute(value), 'maintenance paths must be absolute');
  return options;
}
function createSources(baseline, output) {
  baseline = existingDirectory(baseline); output = newOutput(output);
  const originals = Object.entries(BEFORE).map(([file, expected]) => { const bytes = localBytes(path.join(baseline, file));
    assert.equal(policy.hash(bytes), expected, 'original signed r785 source differs: ' + file); return { file, bytes }; });
  const patch = cp.execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', SOURCE_COMMIT + '^', SOURCE_COMMIT, '--', ...Object.keys(BEFORE)], { cwd: root, windowsHide: true });
  assert.ok(patch.length > 100 && patch.length < 16384, 'unexpected reviewed delta size');
  assert.equal(policy.hash(patch), PATCH_SHA, 'reviewed patch bytes changed');
  const helper = cp.execFileSync('git', ['show', SOURCE_COMMIT + ':scripts/officialClosedScheduleEvidence.cjs'], { cwd: root, windowsHide: true });
  assert.equal(policy.hash(helper), HELPER_SHA);
  // Admission precedes the first write; mkdir also atomically claims this new
  // output so concurrent callers cannot apply a second patch to it.
  newOutput(output); fs.mkdirSync(output, { recursive: false });
  for (const { file, bytes } of originals) { const target = path.join(output, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' }); }
  // Apply only the exact reviewed incident delta to authenticated original bytes.
  const relative = path.relative(root, output).split(path.sep).join('/'); assert.ok(relative && !relative.startsWith('../') && !path.isAbsolute(relative), 'source staging must remain inside this checkout');
  cp.execFileSync('git', ['apply', '--whitespace=error', '--directory=' + relative], { cwd: root, input: patch, windowsHide: true });
  fs.writeFileSync(path.join(output, policy.FILES[2]), helper, { flag: 'wx' });
  const files = policy.FILES.map(file => ({ path: file, beforeSha256: BEFORE[file] || null, ...material(path.join(output, file)) }));
  for (const file of files) assert.equal(file.sha256, AFTER[file.path], 'incident after-hash differs: ' + file.path);
  const report = { version: 'official-closure-repair-source-v1', sourceCommit: SOURCE_COMMIT, baseRuntimeSha256: policy.BASE_RUNTIME,
    patchSha256: policy.hash(patch), files: files.map(({ base64, ...file }) => file), productionWrites: 0 };
  fs.writeFileSync(path.join(output, 'source-receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return { report, files };
}
function createCapsule(observation, baseline, output) {
  policy.validateObservation(observation);
  assert.fail(SEMANTIC_CONTRACT_BLOCK);
  baseline = existingDirectory(baseline); if (output) output = newOutput(output);
  assert.ok(process.env.RELEASE_SIGNING_PRIVATE_KEY && path.isAbsolute(process.env.RELEASE_SIGNING_PRIVATE_KEY));
  assert.ok(process.env.RELEASE_SIGNING_PUBLIC_KEY && path.isAbsolute(process.env.RELEASE_SIGNING_PUBLIC_KEY));
  const key = localBytes(process.env.RELEASE_SIGNING_PRIVATE_KEY, 65536), publicKey = localBytes(process.env.RELEASE_SIGNING_PUBLIC_KEY, 65536);
  // Do not sign editable local eligibility declarations. Re-read the real
  // source over the existing pinned SSH channel immediately before derivation.
  const live = transport(observationSource()); policy.validateObservation(live);
  for (const field of ['runtime', 'complete', 'frontendSequence', 'frontendSha256', 'frontendStateSha256', 'generation', 'postgres',
    'files', 'dependencies', 'signedBaseline', 'frozenRecords', 'relay', 'registry', 'entrypoint', 'flags']) assert.deepEqual(live[field], observation[field], 'live observation changed: ' + field);
  observation = live;
  const sources = path.join(root, '.codex-tmp', 'closure-sources-' + crypto.randomUUID()); fs.mkdirSync(path.dirname(sources), { recursive: true });
  const built = createSources(baseline, sources);
  for (const file of built.files) assert.equal(file.beforeSha256, observation.files.find(row => row.path === file.path).sha256);
  const now = Date.now(), target = policy.guardedEntrypoint(Buffer.from(observation.entrypoint.base64, 'base64'));
  const plan = { version: policy.VERSION, site: 'football-predict', channel: 'production', baseRuntimeSha256: policy.BASE_RUNTIME, baseSequence: 785,
    baseFrontendSequence: policy.BASE_FRONTEND.sequence, baseFrontendSha256: policy.BASE_FRONTEND.sha256,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60000).toISOString(), observation, files: built.files,
    sourceDerivation: built.report, artifacts: Object.fromEntries([['controller', 'officialClosureRepairController.cjs'], ['policy', 'officialClosureRepairPolicy.cjs'], ['proof', 'proveOfficialClosureRepair.cjs']].map(([name, file]) => [name, material(path.join(__dirname, file))])),
    entrypointGuard: { path: policy.ENTRYPOINT, beforeSha256: observation.entrypoint.sha256, sha256: policy.hash(target), base64: target.toString('base64'), preserveOnRollback: true },
    modelPromotion: false, storageMigration: false, dataRewrite: false };
  policy.validateObservation(observation, Date.now());
  const bytes = Buffer.from(JSON.stringify(plan) + '\n');
  const signature = crypto.sign('sha256', bytes, key); policy.verify(bytes, signature, publicKey); const id = policy.hash(bytes);
  const directory = newOutput(output || path.join(root, '.codex-tmp', 'closure-capsule-' + id)); fs.mkdirSync(directory, { recursive: false });
  fs.writeFileSync(path.join(directory, 'capsule.json'), bytes, { flag: 'wx' }); fs.writeFileSync(path.join(directory, 'capsule.sig'), signature, { flag: 'wx' });
  return { ok: true, capsuleSha256: id, directory, productionWrites: 0, activated: false, sourceDerivation: built.report };
}
function transport(source) {
  const { validateReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
  const keyPath = process.env.RELEASE_DEPLOY_KEY, knownHostsPath = process.env.RELEASE_DEPLOY_KNOWN_HOSTS;
  assert.ok(keyPath && path.isAbsolute(keyPath) && knownHostsPath && path.isAbsolute(knownHostsPath), 'explicit existing SSH identity and known-hosts paths required');
  const fingerprint = 'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to';
  const pin = validateReleaseSshHostKeyPin({ host: '134.175.132.183', port: 22, knownHostsPath, expectedFingerprint: fingerprint });
  const result = cp.spawnSync('ssh', ['-p', '22', ...buildPinnedSshBaseOptions({ keyPath, pin }), 'ubuntu@134.175.132.183',
    'sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/opt/node-v22.22.1/bin/node', '--max-old-space-size=1152', '-'],
    { input: source, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 ** 2, windowsHide: true });
  if (result.status !== 0) throw Error('signed maintenance operation failed: ' + String(result.stderr || result.error?.message || '').slice(-800));
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
function observationSource() {
  const policySource = fs.readFileSync(path.join(__dirname, 'officialClosureRepairPolicy.cjs'), 'utf8'), controller = fs.readFileSync(path.join(__dirname, 'officialClosureRepairController.cjs'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, 'officialClosedScheduleEvidence.cjs')); assert.equal(policy.hash(helper), HELPER_SHA);
  return `const Module=require('node:module');const p=new Module('/tmp/closure-readonly/policy.cjs');p._compile(${JSON.stringify(policySource)},p.id);const c=new Module('/tmp/closure-readonly/controller.cjs');const original=c.require.bind(c);c.require=name=>name==='./officialClosureRepairPolicy.cjs'?p.exports:original(name);c._compile(${JSON.stringify(controller)},c.id);c.exports.observe(Buffer.from(${JSON.stringify(helper.toString('base64'))},'base64')).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});`;
}
function remoteSigned(input) {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), Module = require('node:module'), assert = require('node:assert/strict');
  assert.equal(process.getuid(), 0, 'maintenance bootstrap requires root');
  assert.ok(input && ['prepare', 'activate', 'status', 'recover'].includes(input.action), 'unsupported signed action');
  const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const directory = (file, mode) => { const stat = fs.lstatSync(file); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe root directory');
    assert.equal(stat.uid, 0, 'root directory owner changed'); assert.equal(stat.mode & 0o022, 0, 'root directory is writable by others');
    if (mode !== undefined) assert.equal(stat.mode & 0o777, mode); assert.equal(fs.realpathSync(file), file); return stat; };
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  const read = (file, maximum, mode) => {
    directory(path.dirname(file)); const before = fs.lstatSync(file, { bigint: true });
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === 0n
      && (before.mode & 0o022n) === 0n && before.size > 0n && before.size <= BigInt(maximum), 'unsafe root material');
    if (mode !== undefined) assert.equal(Number(before.mode & 0o777n), mode); assert.equal(fs.realpathSync(file), file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { assert.ok(same(before, fs.fstatSync(fd, { bigint: true }))); const value = fs.readFileSync(fd);
      assert.ok(same(before, fs.fstatSync(fd, { bigint: true })) && same(before, fs.lstatSync(file, { bigint: true })), 'root material changed during read');
      assert.equal(BigInt(value.length), before.size); return value; } finally { fs.closeSync(fd); }
  };
  const decode = (value, maximum) => { assert.ok(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maximum / 3) * 4, 'invalid signed material size');
    const bytes = Buffer.from(value, 'base64'); assert.ok(bytes.length <= maximum); assert.equal(bytes.toString('base64'), value, 'noncanonical signed material'); return bytes; };
  const bytes = decode(input.bytes, 8 * 1024 ** 2), sig = decode(input.signature, 16384);
  // Authenticate against the already installed root-owned public key before
  // parsing/compiling any capsule-supplied policy or controller code.
  const key = read('/etc/football-release/signing-public.pem', 65536);
  assert.equal(hash(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })), input.keyId);
  assert.ok(crypto.verify('sha256', bytes, key, sig), 'untrusted maintenance signature');
  // Keep recovery available, but even an authenticated capsule cannot turn
  // unverified SaleStatus semantics into authority to stage or activate.
  if (input.action === 'prepare' || input.action === 'activate') {
    assert.fail('official closure semantic contract unverified; create/prepare/activate disabled pending separately reviewed official evidence');
  }
  const raw = JSON.parse(bytes), artifactBytes = {};
  for (const name of ['policy', 'controller', 'proof']) { const item = raw.artifacts?.[name], value = decode(item?.base64, 2 * 1024 ** 2);
    assert.equal(hash(value), item.sha256, 'signed executable hash mismatch'); artifactBytes[name] = value; }
  const expected = {
    'scripts/syncData.cjs': ['02e70e8129351e42fcdd3c0ac6d6031be7e2c2ce57f992c4bdf4ee2628dab02b', '6be7a3af234b7bb2901130936c484ce378a76084786cc05614d4b984a5d9c703'],
    'scripts/validateData.cjs': ['97f9bffe1268372b2c58f8e418d3b2d7d3744c7adef464f4b6b562cdbf70f4f8', '0ab9f9af87bfc9d23b0008cadb371fea5747e2422d8e71ae0d680c193ff15e93'],
    'scripts/officialClosedScheduleEvidence.cjs': [null, '90dd4b7f2c4521a8beb54e5692414122756796fba2926f1b1e3c9e185ccb51c5'],
  };
  assert.deepEqual(raw.files?.map(row => row.path).sort(), Object.keys(expected).sort(), 'unreviewed incident source scope');
  for (const file of raw.files) { assert.equal(file.beforeSha256, expected[file.path][0]); assert.equal(file.sha256, expected[file.path][1]);
    assert.equal(hash(decode(file.base64, 2 * 1024 ** 2)), file.sha256, 'incident after bytes changed'); }
  const module = new Module('/tmp/verified-closure-repair-policy.cjs'); module._compile(artifactBytes.policy.toString('utf8'), module.id);
  const allowExpiredRecovery = ['status', 'recover'].includes(input.action);
  const plan = module.exports.verify(bytes, sig, key, allowExpiredRecovery ? Date.parse(raw.createdAt) : Date.now());
  const id = hash(bytes), parent = '/var/lib/football-release/closure-repairs', dir = parent + '/' + id;
  const syncDir = file => { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  const write = (file, value) => { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDir(path.dirname(file)); };
  directory('/var/lib/football-release');
  if (!exists(parent)) { assert.equal(input.action, 'prepare', 'maintenance capsule directory unavailable');
    try { fs.mkdirSync(parent, { mode: 0o700 }); syncDir(path.dirname(parent)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  directory(parent, 0o700);
  // Parent's protected lock serializes all staging readers/writers, including
  // concurrent prepare/status calls. Inherited FD shares flock ownership with
  // this parent until finally closes it; no stale PID lockfile convention.
  const stageLock = parent + '/stage.lock';
  const lockFd = fs.openSync(stageLock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const lockStat = fs.fstatSync(lockFd); assert.ok(lockStat.isFile() && lockStat.nlink === 1 && lockStat.uid === 0 && (lockStat.mode & 0o777) === 0o600, 'unsafe staging lock');
    assert.equal(fs.realpathSync(stageLock), stageLock);
    cp.execFileSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', lockFd], timeout: 5000 });
    if (input.action === 'prepare' && !exists(dir)) {
      for (const file of ['/var/lib/football-release/recovery/current', '/var/lib/football-release/reference-repairs/current', parent + '/current'])
        assert.equal(exists(file), false, 'another repair is unresolved');
      fs.mkdirSync(dir, { mode: 0o700 }); syncDir(parent);
      write(dir + '/capsule.json', bytes); write(dir + '/capsule.sig', sig);
      for (const [name, file] of [['policy', 'officialClosureRepairPolicy.cjs'], ['controller', 'controller.cjs'], ['proof', 'proof.cjs']]) write(dir + '/' + file, artifactBytes[name]);
      syncDir(dir); syncDir(parent);
    }
    directory(dir, 0o700);
    assert.equal(hash(read(dir + '/capsule.json', 8 * 1024 ** 2, 0o600)), id);
    assert.deepEqual(read(dir + '/capsule.sig', 16384, 0o600), sig);
    for (const [name, file] of [['policy', 'officialClosureRepairPolicy.cjs'], ['controller', 'controller.cjs'], ['proof', 'proof.cjs']])
      assert.equal(hash(read(dir + '/' + file, 2 * 1024 ** 2, 0o600)), plan.artifacts[name].sha256);
    const controller = require(dir + '/controller.cjs'); controller.load(dir, !allowExpiredRecovery);
    const node = '/opt/node-v22.22.1/bin/node', lock = '/run/lock/football-release.lock';
    if (input.action === 'activate') {
      assert.equal(exists(dir + '/activation-started.json'), false); assert.equal(exists(parent + '/current'), false);
      const unit = 'football-closure-repair-' + id.slice(0, 12);
      cp.execFileSync('/usr/bin/systemd-run', ['--unit=' + unit, '--property=Type=exec', '--property=RuntimeMaxSec=1800', '--property=TimeoutStopSec=900',
        '--property=KillMode=mixed', '--property=MemoryMax=1536M', '--property=MemorySwapMax=256M',
        '--property=ExecStopPost=/usr/bin/flock -w 120 ' + lock + ' /usr/bin/env -i PATH=/usr/bin:/bin ' + node + ' ' + dir + '/controller.cjs recover ' + dir,
        '/usr/bin/flock', '--no-fork', '-n', lock, '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', node, dir + '/controller.cjs', 'supervise', dir], { encoding: 'utf8', timeout: 30000 });
      return { ok: true, dispatched: true, accepted: false, unit, directory: dir, fullReleaseDeployed: false };
    }
    const output = cp.execFileSync('/usr/bin/flock', ['-n', lock, node, dir + '/controller.cjs', input.action, dir], { encoding: 'utf8', timeout: 280000, maxBuffer: 8 * 1024 ** 2 });
    return JSON.parse(output.trim().split('\n').at(-1));
  } finally { fs.closeSync(lockFd); }
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args); let report;
  if (options.action === 'inspect') { newOutput(options.output); report = transport(observationSource()); fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ ok: true, output: options.output, checkedAt: report.checkedAt, closure: report.closureAudit, productionWrites: 0 })); return; }
  if (options.action === 'sources') { assert.ok(options.baseline && options.output); report = createSources(options.baseline, options.output).report; }
  else if (options.action === 'create') { report = createCapsule(JSON.parse(localBytes(options.observation)), options.baseline, options.output); }
  else { existingDirectory(options.capsule); assert.ok(process.env.RELEASE_SIGNING_PUBLIC_KEY); const bytes = localBytes(path.join(options.capsule, 'capsule.json')), sig = localBytes(path.join(options.capsule, 'capsule.sig'), 16384),
    key = localBytes(process.env.RELEASE_SIGNING_PUBLIC_KEY, 65536), at = ['status', 'recover'].includes(options.action) ? Date.parse(JSON.parse(bytes).createdAt) : Date.now(); policy.verify(bytes, sig, key, at);
    const input = { action: options.action, bytes: bytes.toString('base64'), signature: sig.toString('base64'), keyId: policy.hash(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })) };
    report = transport('try{console.log(JSON.stringify((' + remoteSigned.toString() + ')(' + JSON.stringify(input) + ')));}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}'); }
  console.log(JSON.stringify(report)); return report;
}
module.exports = { parseArgs, createSources, createCapsule, observationSource, remoteSigned, transport, main, BEFORE, AFTER, PATCH_SHA, HELPER_SHA, SOURCE_COMMIT, SEMANTIC_CONTRACT_BLOCK };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
