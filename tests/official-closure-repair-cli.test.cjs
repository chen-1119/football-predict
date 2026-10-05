'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const cp = require('node:child_process');
const cli = require('../scripts/officialClosureRepairCli.cjs');
const policy = require('../scripts/officialClosureRepairPolicy.cjs');
const root = path.resolve(__dirname, '..'), temporaryRoot = path.join(root, '.codex-tmp');
const baseline = path.join(root, 'outputs/maintenance-20261003/candidate-before');
const candidates = path.join(root, 'outputs/maintenance-20261003/candidate-after');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sha = 'a'.repeat(64);
const material = bytes => ({ sha256: policy.hash(bytes), base64: Buffer.from(bytes).toString('base64') });
function temporary(fn) {
  fs.mkdirSync(temporaryRoot, { recursive: true }); const directory = fs.mkdtempSync(path.join(temporaryRoot, 'closure-cli-test-'));
  try { return fn(directory); } finally {
    assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep)); fs.rmSync(directory, { recursive: true, force: true });
  }
}
function fixture(at = Date.now() - 100) {
  const iso = offset => new Date(at + offset).toISOString();
  const entry = Buffer.from('#!/bin/bash\nacquire_release_lock() {\n  exec 9>"$LOCK_FILE"\n  flock -n 9 || die "another release or recovery is active"\n}\n');
  const generation = { generationId: 'g-' + sha, manifestHash: sha, sourceCycleId: 'old-cycle', committedAt: iso(-3600000) };
  const observation = {
    checkedAt: iso(-1000), runtime: policy.BASE_RUNTIME, complete: policy.BASE_RUNTIME, productionWrites: 0,
    frontendStateSha256: sha, frontendSequence: policy.BASE_FRONTEND.sequence, frontendSha256: policy.BASE_FRONTEND.sha256,
    generation, postgres: { database: 'football', oid: '28598409', systemIdentifier: '1234567890123456789', publication: { mode: 'active-generation', ...generation } },
    workerFault: { pid: 123, invocationId: 'a'.repeat(32), statusCheckedAt: iso(-1500), lastCycleStartedAt: iso(-90000), lastCycleFinishedAt: iso(-2000),
      phase: 'official-result-failed', error: 'npm run validate:data exited with 1', assertion: 'matches-current.json must contain a non-empty array.',
      journalEntries: [{ pid: 124, at: iso(-3000), messageSha256: sha }] },
    relay: { path: '/var/lib/football-relay/active.json', bytes: 2780000, sha256: sha, capturedAt: iso(-60000), sourceCycleId: 'new-cycle', emptyCurrentIntegrityEligible: true, proofHash: sha },
    registry: { path: '/etc/football-predict/trust-registry.json', bytes: 1240, sha256: sha },
    files: policy.FILES.map(file => ({ path: file, sha256: cli.BEFORE[file] || null })),
    dependencies: policy.DEPENDENCIES.map(file => ({ path: file, sha256: sha })),
    frozenRecords: Object.fromEntries(policy.FROZEN_GROUPS.map(group => [group, [{ id: group + '-1', hash: sha }]])),
    entrypoint: { path: policy.ENTRYPOINT, ...material(entry) },
  };
  return { version: policy.VERSION, site: 'football-predict', channel: 'production', createdAt: iso(0), expiresAt: iso(15 * 60000),
    baseRuntimeSha256: policy.BASE_RUNTIME, baseSequence: 785, baseFrontendSequence: 787, baseFrontendSha256: policy.BASE_FRONTEND.sha256,
    observation, files: policy.FILES.map(file => ({ path: file, beforeSha256: cli.BEFORE[file] || null, ...material(fs.readFileSync(path.join(candidates, file))) })),
    artifacts: { policy: material(fs.readFileSync(path.join(root, 'scripts/officialClosureRepairPolicy.cjs'))), controller: material('// isolated controller fixture\n'), proof: material('// isolated proof fixture\n') },
    entrypointGuard: { path: policy.ENTRYPOINT, beforeSha256: observation.entrypoint.sha256, ...material(policy.guardedEntrypoint(entry)), preserveOnRollback: true },
    modelPromotion: false, storageMigration: false, dataRewrite: false };
}
function sign(plan, action = 'prepare') {
  const bytes = Buffer.from(JSON.stringify(plan)), signature = crypto.sign('sha256', bytes, keys.privateKey);
  return { action, bytes: bytes.toString('base64'), signature: signature.toString('base64'), keyId: policy.hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
}

// An in-memory Linux root filesystem. No SSH, production path, real child
// process or capsule-supplied controller is executed by these bootstrap tests.
function remoteHarness(input, { staged = false, lockBusy = false, bypassSemanticContractForMechanicsOnly = false } = {}) {
  const plan = JSON.parse(Buffer.from(input.bytes, 'base64')), id = policy.hash(Buffer.from(input.bytes, 'base64'));
  const parent = '/var/lib/football-release/closure-repairs', directory = parent + '/' + id;
  const nodes = new Map(), fds = new Map(), events = []; let ino = 1, nextFd = 10;
  const put = (file, type, bytes = Buffer.alloc(0), extra = {}) => nodes.set(file, { type, bytes: Buffer.from(bytes), ino: ino++, mode: type === 'dir' ? 0o700 : 0o600, uid: 0, nlink: 1, ...extra });
  for (const dir of ['/etc/football-release', '/var/lib/football-release', parent]) put(dir, 'dir');
  put('/etc/football-release/signing-public.pem', 'file', publicKey, { mode: 0o644 });
  const stage = () => {
    put(directory, 'dir'); put(directory + '/capsule.json', 'file', Buffer.from(input.bytes, 'base64')); put(directory + '/capsule.sig', 'file', Buffer.from(input.signature, 'base64'));
    for (const [name, file] of [['policy', 'officialClosureRepairPolicy.cjs'], ['controller', 'controller.cjs'], ['proof', 'proof.cjs']]) put(directory + '/' + file, 'file', Buffer.from(plan.artifacts[name].base64, 'base64'));
  };
  if (staged) stage();
  const missing = () => Object.assign(new Error('missing test path'), { code: 'ENOENT' });
  const get = file => { if (!nodes.has(file)) throw missing(); return nodes.get(file); };
  const stat = (node, big = false) => {
    const convert = v => big ? BigInt(v) : v;
    return { isFile: () => node.type === 'file', isDirectory: () => node.type === 'dir', isSymbolicLink: () => node.type === 'link',
      uid: convert(node.uid), nlink: convert(node.nlink), mode: convert(node.mode), dev: convert(1), ino: convert(node.ino), size: convert(node.bytes.length), mtimeNs: 1n, ctimeNs: 1n };
  };
  const fakeFs = {
    constants: { O_RDONLY: 0, O_RDWR: 2, O_CREAT: 64, O_NOFOLLOW: 131072 },
    lstatSync: (file, options) => stat(get(file), options?.bigint),
    realpathSync: file => { const node = get(file); return node.alias || file; },
    fstatSync: (fd, options) => stat(get(fds.get(fd)), options?.bigint),
    openSync: (file, flags, mode) => {
      if (flags === 'wx') { if (nodes.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); put(file, 'file', '', { mode }); events.push(['write-open', file]); }
      else if (typeof flags === 'number' && (flags & 64) && !nodes.has(file)) put(file, 'file', '', { mode });
      const node = get(file); if (typeof flags === 'number' && (flags & 131072) && node.type === 'link') throw new Error('NOFOLLOW');
      const fd = nextFd++; fds.set(fd, file); return fd;
    },
    closeSync: fd => { events.push(['close', fds.get(fd)]); fds.delete(fd); },
    readFileSync: fd => Buffer.from(get(fds.get(fd)).bytes),
    writeFileSync: (fd, bytes) => { const file = fds.get(fd); get(file).bytes = Buffer.from(bytes); events.push(['write', file]); },
    fsyncSync: fd => events.push(['fsync', fds.get(fd)]),
    mkdirSync: (file, options) => { if (nodes.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); put(file, 'dir', '', { mode: options.mode }); events.push(['mkdir', file]); },
  };
  const fakeCp = { execFileSync: (file, args, options) => {
    events.push(['exec', file, [...args]]);
    if (file === '/usr/bin/flock' && args[1] === '3') { assert.ok(fds.has(options.stdio[3])); if (lockBusy) throw new Error('stage lock busy'); return Buffer.alloc(0); }
    assert.ok(file === '/usr/bin/flock' || file === '/usr/bin/systemd-run'); return '{"ok":true,"isolated":true}\n';
  } };
  class FakeModule { constructor(id) { this.id = id; } _compile(source) { events.push(['compile']); assert.equal(policy.hash(source), plan.artifacts.policy.sha256); this.exports = policy; } }
  const fakeRequire = name => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:path') return path.posix;
    if (name === 'node:child_process') return fakeCp;
    if (name === 'node:module') return FakeModule;
    if (name === directory + '/controller.cjs') { events.push(['require-controller']); return { load: (dir, fresh) => { assert.equal(dir, directory); events.push(['load', fresh]); } }; }
    assert.ok(['node:crypto', 'node:assert/strict'].includes(name)); return require(name);
  };
  let source = cli.remoteSigned.toString();
  if (bypassSemanticContractForMechanicsOnly) {
    // This VM-only source injection exercises dormant mechanics; it is never
    // passed to transport or exported by the CLI, and establishes no official
    // source semantics or production activation eligibility.
    const rejection = "assert.fail('" + cli.SEMANTIC_CONTRACT_BLOCK + "');";
    assert.equal(source.split(rejection).length, 2);
    source = source.replace(rejection, 'semanticContractTestBypass();');
  }
  const run = () => vm.runInNewContext('(' + source + ')(input)', { require: fakeRequire, process: { getuid: () => 0 }, Buffer, input,
    semanticContractTestBypass: () => events.push(['test-only-semantic-bypass-not-business-evidence']) });
  return { run, nodes, events, directory, parent, put, fds };
}

test('action arguments are explicit, absolute and limited to their own action', () => {
  assert.equal(cli.parseArgs(['--action=inspect', '--output=' + path.join(temporaryRoot, 'result.json')]).action, 'inspect');
  for (const args of [[], ['--action=inspect'], ['--action=inspect', '--output=relative'], ['--action=inspect', '--output=C:/x', '--baseline=C:/b'],
    ['--action=inspect', '--action=inspect', '--output=C:/x'], ['--action=sources', '--baseline=C:/b', '--output=C:/x', '--sources=C:/y'],
    ['--action=recover', '--capsule=C:/x', '--observation=C:/y'], ['--action=rm', '--output=C:/x']]) assert.throws(() => cli.parseArgs(args));
});

test('source derivation reproduces only the authenticated three-file incident patch', () => temporary(dir => {
  const output = path.join(dir, 'source'); const result = cli.createSources(baseline, output);
  assert.equal(result.report.sourceCommit, cli.SOURCE_COMMIT); assert.equal(result.report.patchSha256, cli.PATCH_SHA);
  assert.deepEqual(Object.fromEntries(result.files.map(file => [file.path, file.sha256])), cli.AFTER);
  assert.deepEqual(fs.readdirSync(path.join(output, 'scripts')).sort(), ['officialClosedScheduleEvidence.cjs', 'syncData.cjs', 'validateData.cjs']);
  assert.equal(result.report.productionWrites, 0);
}));

test('bad before bytes and escaped or existing outputs fail before source staging', () => temporary(dir => {
  const invalid = path.join(dir, 'invalid'), output = path.join(dir, 'never-written'); fs.mkdirSync(path.join(invalid, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(invalid, 'scripts/syncData.cjs'), 'not the authenticated baseline');
  assert.throws(() => cli.createSources(invalid, output), /original signed r785/); assert.equal(fs.existsSync(output), false);
  const escaped = path.join(root, 'closure-cli-escaped-' + crypto.randomUUID());
  assert.throws(() => cli.createSources(baseline, escaped), /checkout outputs/); assert.equal(fs.existsSync(escaped), false);
  assert.throws(() => cli.createSources(baseline, dir), /already exists/);
}));

test('aliased baseline directories and hardlinked before files are rejected', () => temporary(dir => {
  const alias = path.join(dir, 'alias'); fs.symlinkSync(baseline, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cli.createSources(alias, path.join(dir, 'never-written')), /link/);
  const invalid = path.join(dir, 'hardlink'); fs.mkdirSync(path.join(invalid, 'scripts'), { recursive: true });
  const source = path.join(dir, 'source.cjs'); fs.copyFileSync(path.join(baseline, 'scripts/syncData.cjs'), source);
  fs.linkSync(source, path.join(invalid, 'scripts/syncData.cjs'));
  assert.throws(() => cli.createSources(invalid, path.join(dir, 'never-written')), /unsafe local material/);
}));

test('ineligible or stale local observation rejects before keys, signing or SSH', () => {
  const originalSign = crypto.sign, originalSpawn = cp.spawnSync; let signs = 0, transports = 0;
  crypto.sign = () => { signs++; throw new Error('must not sign'); }; cp.spawnSync = () => { transports++; throw new Error('must not connect'); };
  try {
    const rejected = fixture().observation; rejected.relay.emptyCurrentIntegrityEligible = false;
    assert.throws(() => cli.createCapsule(rejected, baseline, path.join(temporaryRoot, 'unused')), /false !== true/);
    assert.throws(() => cli.createCapsule(fixture(Date.now() - 3600000).observation, baseline), /stale/);
    assert.equal(signs, 0); assert.equal(transports, 0);
  } finally { crypto.sign = originalSign; cp.spawnSync = originalSpawn; }
});

test('otherwise valid create is always blocked before keys, output, signing or SSH until official semantics are reviewed', () => {
  const originalSign = crypto.sign, originalSpawn = cp.spawnSync; let signs = 0, transports = 0;
  crypto.sign = () => { signs++; throw new Error('must not sign'); }; cp.spawnSync = () => { transports++; throw new Error('must not connect'); };
  try {
    // Nonexistent baseline also proves the fixed block precedes path access.
    assert.throws(() => cli.createCapsule(fixture().observation, path.join(temporaryRoot, 'does-not-exist')), error => error.message === cli.SEMANTIC_CONTRACT_BLOCK);
    assert.equal(signs, 0); assert.equal(transports, 0);
    assert.throws(() => cli.parseArgs(['--action=create', '--observation=C:/x', '--baseline=C:/y', '--allow-unverified-semantics=true']), /unknown/);
  } finally { crypto.sign = originalSign; cp.spawnSync = originalSpawn; }
});

test('absolute forward-slash paths reach source admission without false Windows alias rejection', async () => {
  fs.mkdirSync(temporaryRoot, { recursive: true }); const directory = fs.mkdtempSync(path.join(temporaryRoot, 'closure-cli-test-'));
  try {
    const file = path.join(directory, 'observation.json'), observation = fixture().observation;
    observation.relay.emptyCurrentIntegrityEligible = false; fs.writeFileSync(file, JSON.stringify(observation));
    await assert.rejects(cli.main(['--action=create', '--observation=' + file.split(path.sep).join('/'), '--baseline=' + baseline.split(path.sep).join('/')]), /false !== true/);
    assert.deepEqual(fs.readdirSync(directory), ['observation.json']);
  } finally { assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bootstrap authenticates root key and signature before compiling signed executables', () => {
  const input = sign(fixture()); input.signature = Buffer.alloc(Buffer.from(input.signature, 'base64').length).toString('base64');
  const invalid = remoteHarness(input); assert.throws(invalid.run, /untrusted maintenance signature/); assert.equal(invalid.events.some(e => e[0] === 'compile'), false);
  for (const change of [{ uid: 1000 }, { nlink: 2 }, { mode: 0o666 }, { type: 'link' }]) {
    const h = remoteHarness(sign(fixture())); Object.assign(h.nodes.get('/etc/football-release/signing-public.pem'), change);
    assert.throws(h.run); assert.equal(h.events.some(e => e[0] === 'compile'), false); assert.equal(h.events.some(e => e[0] === 'mkdir'), false);
  }
});

test('real bootstrap defaults block even fresh valid signed prepare and activate before compilation or writes', () => {
  for (const action of ['prepare', 'activate']) {
    const h = remoteHarness(sign(fixture(), action));
    assert.throws(h.run, error => error.message === cli.SEMANTIC_CONTRACT_BLOCK);
    assert.equal(h.events.some(e => ['compile', 'mkdir', 'write-open', 'exec', 'require-controller', 'test-only-semantic-bypass-not-business-evidence'].includes(e[0])), false);
    assert.equal(h.nodes.has(h.directory), false);
  }
});

test('even a signed capsule cannot widen source scope or substitute incident bytes', () => {
  for (const mutate of [p => Object.assign(p.files[0], material('// other optimization\n')), p => p.files.push({ ...p.files[0], path: 'server/index.cjs' }),
    p => p.files[0].beforeSha256 = sha, p => p.artifacts.controller.sha256 = sha]) {
    const p = fixture(); mutate(p); const h = remoteHarness(sign(p, 'status')); assert.throws(h.run);
    assert.equal(h.events.some(e => e[0] === 'compile'), false); assert.equal(h.events.some(e => e[0] === 'mkdir'), false);
  }
});

test('VM-injected dormant staging mechanics fsync every material before load without establishing business semantics', () => {
  const h = remoteHarness(sign(fixture()), { bypassSemanticContractForMechanicsOnly: true }); assert.equal(h.run().ok, true);
  assert.ok(h.events.some(e => e[0] === 'test-only-semantic-bypass-not-business-evidence'));
  const loaded = h.events.findIndex(e => e[0] === 'load'); assert.ok(loaded > 0);
  for (const file of ['capsule.json', 'capsule.sig', 'officialClosureRepairPolicy.cjs', 'controller.cjs', 'proof.cjs']) {
    const full = h.directory + '/' + file, written = h.events.findIndex(e => e[0] === 'write' && e[1] === full);
    const synced = h.events.findIndex((e, i) => i > written && e[0] === 'fsync' && e[1] === full);
    const parentSynced = h.events.findIndex((e, i) => i > synced && e[0] === 'fsync' && e[1] === h.directory);
    assert.ok(written >= 0 && synced > written && parentSynced > synced && parentSynced < loaded, file);
  }
  assert.ok(h.events.some(e => e[0] === 'fsync' && e[1] === h.parent)); assert.equal(h.fds.size, 0);
});

test('VM-injected dormant preparation still rejects dangling current pointers in every recovery family', () => {
  for (const current of ['/var/lib/football-release/recovery/current', '/var/lib/football-release/reference-repairs/current', '/var/lib/football-release/closure-repairs/current']) {
    const h = remoteHarness(sign(fixture()), { bypassSemanticContractForMechanicsOnly: true }); h.put(current, 'link'); assert.throws(h.run, /another repair is unresolved/);
    assert.equal(h.nodes.has(h.directory), false); assert.equal(h.events.some(e => e[0] === 'require-controller'), false);
  }
});

test('staging lock contention, unsafe roots and staged material reject before execution', () => {
  const busy = remoteHarness(sign(fixture(), 'status'), { staged: true, lockBusy: true }); assert.throws(busy.run, /stage lock busy/); assert.equal(busy.events.some(e => e[0] === 'require-controller'), false);
  for (const change of [{ uid: 1000 }, { mode: 0o777 }, { type: 'link' }, { alias: '/elsewhere' }]) {
    const h = remoteHarness(sign(fixture(), 'status'), { staged: true }); Object.assign(h.nodes.get(h.parent), change); assert.throws(h.run); assert.equal(h.events.some(e => e[0] === 'require-controller'), false);
  }
  for (const change of [{ nlink: 2 }, { uid: 1000 }, { mode: 0o644 }, { type: 'link' }]) {
    const h = remoteHarness(sign(fixture(), 'status'), { staged: true }); Object.assign(h.nodes.get(h.directory + '/controller.cjs'), change);
    assert.throws(h.run); assert.equal(h.events.some(e => e[0] === 'require-controller'), false);
  }
});

test('expired capsules allow authenticated status and recovery but forbid prepare and activate', () => {
  const p = fixture(Date.now() - 3600000);
  for (const action of ['prepare', 'activate']) {
    const blocked = remoteHarness(sign(p, action), { staged: true }); assert.throws(blocked.run, /semantic contract unverified/);
    const dormant = remoteHarness(sign(p, action), { staged: true, bypassSemanticContractForMechanicsOnly: true }); assert.throws(dormant.run, /expired/); assert.equal(dormant.events.some(e => e[0] === 'exec'), false);
  }
  for (const action of ['status', 'recover']) { const h = remoteHarness(sign(p, action), { staged: true }); assert.equal(h.run().ok, true); assert.deepEqual(h.events.find(e => e[0] === 'load'), ['load', false]); }
});

test('VM-injected dormant activate mechanics preserve recovery allowance and block dangling markers without production eligibility', () => {
  const h = remoteHarness(sign(fixture(), 'activate'), { staged: true, bypassSemanticContractForMechanicsOnly: true }); const result = h.run();
  assert.equal(result.dispatched, true); assert.equal(result.accepted, false);
  const args = h.events.find(e => e[0] === 'exec' && e[1] === '/usr/bin/systemd-run')[2];
  assert.ok(args.includes('--property=TimeoutStopSec=900')); assert.ok(args.some(arg => arg.startsWith('--property=ExecStopPost=/usr/bin/flock -w 120 ')));
  for (const marker of ['activation-started.json', '../current']) {
    const blocked = remoteHarness(sign(fixture(), 'activate'), { staged: true, bypassSemanticContractForMechanicsOnly: true }); blocked.put(path.posix.resolve(blocked.directory, marker), 'link');
    assert.throws(blocked.run); assert.equal(blocked.events.some(e => e[1] === '/usr/bin/systemd-run'), false);
  }
});
