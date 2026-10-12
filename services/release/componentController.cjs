'use strict';
// Independently installed, root-owned controller. Never execute this CLI from
// an uploaded component or the mutable production APP. No path/env overrides.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process');
const INSTALL = '/usr/local/libexec/football-component-release';
const ROOT = '/var/lib/football-release/components/read-api';
const INCOMING = '/var/lib/football-release/components/incoming';
const RELEASES = '/opt/football-services/read-api/releases';
const NODE = '/opt/node-v22.22.1/bin/node', APP = '/opt/football-predict';
const HASH = /^[a-f0-9]{64}$/;
const FILES = ['services/release/componentController.cjs', 'services/release/componentActivationAuthorization.cjs',
  'services/release/componentTransaction.cjs', 'services/release/componentSigning.cjs', 'services/release/componentPolicy.cjs'];
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const ENV = { PATH: '/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
function fail(code) { throw Object.assign(new Error(code), { code }); }
function directory(name) {
  if (!path.isAbsolute(name) || fs.realpathSync(name) !== name) fail('UNTRUSTED_COMPONENT_PATH');
  for (let item = name; ; item = path.dirname(item)) {
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('UNTRUSTED_COMPONENT_DIRECTORY');
    if (item === '/') break;
  }
}
function read(file, limit) {
  directory(path.dirname(file)); const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022)
    || before.size < 0 || before.size > limit) fail('UNTRUSTED_COMPONENT_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('COMPONENT_FILE_CHANGED');
    const raw = fs.readFileSync(fd), after = fs.lstatSync(file), end = fs.fstatSync(fd);
    if (end.ino !== after.ino || end.dev !== after.dev || end.size !== opened.size || end.mtimeMs !== opened.mtimeMs
      || end.ctimeMs !== opened.ctimeMs || after.mtimeMs !== end.mtimeMs || after.ctimeMs !== end.ctimeMs) fail('COMPONENT_FILE_CHANGED');
    return raw;
  } finally { fs.closeSync(fd); }
}
function run(command, args, timeout = 30_000) {
  const result = cp.spawnSync(command, args, { env: ENV, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail('COMPONENT_FIXED_COMMAND_FAILED'); return result.stdout.trim();
}
function inheritedLock() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.execPath !== NODE || process.version !== 'v22.22.1'
    || process.execArgv.length || ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].some(k => process.env[k])) fail('FIXED_CLEAN_ROOT_COMPONENT_CONTROLLER_REQUIRED');
  const lock = fs.lstatSync('/run/lock/football-release.lock'), fd = fs.fstatSync(9);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== 0 || lock.nlink !== 1 || (lock.mode & 0o022)
    || fd.ino !== lock.ino || fd.dev !== lock.dev) fail('COMPONENT_RELEASE_LOCK_REQUIRED');
  const lockRows = raw => raw.split('\n').map(row => /(?:^|\s)(FLOCK)\s+(ADVISORY)\s+(WRITE)\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(row)).filter(Boolean).map(row => row.slice(1).join(':'));
  const own = lockRows(fs.readFileSync('/proc/self/fdinfo/9', 'utf8')), global = lockRows(fs.readFileSync('/proc/locks', 'utf8'));
  if (own.length !== 1 || !global.includes(own[0])) fail('COMPONENT_EXCLUSIVE_LOCK_UNPROVEN');
}
function controllerIdentity() {
  inheritedLock();
  if (__dirname !== INSTALL + '/services/release') fail('INSTALLED_COMPONENT_CONTROLLER_REQUIRED');
  const baseline = JSON.parse(read('/etc/football-release/component-controller-baseline.json', 16 * 1024));
  if (baseline.version !== 'installed-component-controller-baseline-v1' || !Array.isArray(baseline.files)
    || baseline.files.length !== FILES.length || baseline.files.some((row, i) => row.path !== FILES[i]
      || !HASH.test(row.sha256 || '') || sha(read(INSTALL + '/' + row.path, 1024 * 1024)) !== row.sha256)) fail('INSTALLED_COMPONENT_CONTROLLER_DRIFT');
  return sha(JSON.stringify(baseline.files));
}
function unitState(unit) {
  const raw = run('/usr/bin/systemctl', ['show', unit, '--property=LoadState,ActiveState,MainPID,ControlPID,Job,InvocationID,WorkingDirectory,ControlGroup']);
  return Object.fromEntries(raw.split('\n').map(row => { const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1)]; }));
}
function schemaHash(root) {
  const folder = root + '/server/postgres/migrations'; directory(folder);
  const inventory = fs.readdirSync(folder).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => ({
    path: 'server/postgres/migrations/' + name, sha256: sha(read(folder + '/' + name, 1024 * 1024).toString('utf8').replace(/\r\n/g, '\n')) }));
  if (!inventory.length) fail('COMPONENT_SCHEMA_UNPROVEN'); return sha(JSON.stringify(inventory));
}
function originalBoundary() {
  inheritedLock();
  for (const file of ['/var/lib/football-release/recovery/current', '/var/lib/football-release/reference-repairs/current']) if (fs.existsSync(file)) fail('PRODUCTION_RECOVERY_PENDING');
  const appSha256 = read(APP + '/.release-bundle-sha256', 128).toString('utf8').trim();
  const completeSha256 = read(APP + '/.release-live-complete', 128).toString('utf8').trim();
  const api = unitState('football-predict.service'), worker = unitState('football-sync-worker.service');
  if (!HASH.test(appSha256) || appSha256 !== completeSha256 || [api, worker].some(s => s.ActiveState !== 'active'
    || !/^[1-9][0-9]*$/.test(s.MainPID || '') || s.ControlPID !== '0' || s.Job !== '')) fail('ORIGINAL_PRODUCTION_BOUNDARY_CHANGED');
  return { appSha256, completeSha256, apiPid: api.MainPID, workerPid: worker.MainPID, schemaSha256: schemaHash(APP) };
}
function validateTree(root, manifest) {
  directory(root);
  if (!Array.isArray(manifest.inventory) || manifest.inventory.length < 1 || manifest.inventory.length > 20_000) fail('COMPONENT_INVENTORY_BOUND');
  const expected = new Map(), aliases = new Set(); let total = 0;
  for (const row of manifest.inventory) {
    if (!row || typeof row.path !== 'string' || !row.path || row.path.length > 1024 || /[\\:]/.test(row.path)
      || [...row.path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || row.path.split('/').some(p => !p || p === '.' || p === '..') || /(?:^|\/)(?:\.env(?:\..*)?|server-data|\.codex-tmp)(?:\/|$)/.test(row.path)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 128 * 1024 * 1024 || !HASH.test(row.sha256 || '')
      || aliases.has(row.path.toLowerCase())) fail('INVALID_COMPONENT_INVENTORY');
    total += row.bytes; if (total > 512 * 1024 * 1024) fail('COMPONENT_EXPANDED_BOUND');
    aliases.add(row.path.toLowerCase()); expected.set(row.path, row);
  }
  const found = new Set();
  function walk(folder, prefix = '') {
    directory(folder);
    for (const name of fs.readdirSync(folder)) {
      const relative = prefix + name, full = folder + '/' + name, stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (![...expected.keys()].some(p => p.startsWith(relative + '/'))) fail('COMPONENT_EXTRA_DIRECTORY');
        walk(full, relative + '/');
      } else {
        if (relative === 'component-manifest.json') {
          const { archive, archiveSha256, archiveBytes, ...internal } = manifest;
          void archive; void archiveSha256; void archiveBytes;
          if (!read(full, 4 * 1024 * 1024).equals(Buffer.from(JSON.stringify(internal, null, 2)))) fail('COMPONENT_INTERNAL_MANIFEST_CHANGED');
          continue;
        }
        const row = expected.get(relative);
        if (!row || found.has(relative) || stat.size !== row.bytes || sha(read(full, 128 * 1024 * 1024)) !== row.sha256) fail('COMPONENT_TREE_DRIFT');
        found.add(relative);
      }
    }
  }
  walk(root);
  if (found.size !== expected.size || total !== manifest.sourceBytes || found.size !== manifest.sourceFiles) fail('COMPONENT_TREE_MEMBERSHIP_CHANGED');
}
function capacity(manifest) {
  directory(RELEASES); const stat = fs.statfsSync(RELEASES);
  const required = manifest.sourceBytes * 2 + manifest.archiveBytes * 2 + 64 * 1024 * 1024;
  if (!Number.isSafeInteger(required) || stat.bavail * stat.bsize < required) fail('COMPONENT_CAPACITY_UNPROVEN');
}
function installImage(source, manifest) {
  const target = RELEASES + '/' + manifest.archiveSha256;
  if (fs.existsSync(target)) { validateTree(target, manifest); return target; }
  capacity(manifest); fs.mkdirSync(target, { mode: 0o755 });
  // Files are ordinary, immutable, root-owned and verified before and after copy.
  // No tar extraction, package installation or candidate code runs as root.
  for (const row of manifest.inventory) {
    const destination = target + '/' + row.path;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 }); directory(path.dirname(destination));
    const raw = read(source + '/' + row.path, 128 * 1024 * 1024);
    if (raw.length !== row.bytes || sha(raw) !== row.sha256) fail('COMPONENT_COPY_INPUT_CHANGED');
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  validateTree(target, manifest);
  for (const row of manifest.inventory) fs.chmodSync(target + '/' + row.path, 0o444);
  const directories = new Set(manifest.inventory.map(row => path.dirname(target + '/' + row.path)));
  directories.add(target);
  for (const folder of [...directories].sort((a, b) => b.length - a.length)) {
    const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return target;
}
async function get(port, endpoint) {
  const response = await fetch('http://127.0.0.1:' + port + endpoint, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const type = response.headers.get('content-type') || '', chunks = []; let bytes = 0;
  if (!type.startsWith('application/json')) { await response.body?.cancel(); fail('COMPONENT_HTTP_CONTRACT'); }
  for await (const chunk of response.body) {
    bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail('COMPONENT_HTTP_BOUND'); chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return { status: response.status, body: JSON.parse(raw) };
}
function listenerOwned(state, port) {
  if (state.ActiveState !== 'active' || !/^[1-9][0-9]*$/.test(state.MainPID || '')) fail('COMPONENT_LISTENER_UNPROVEN');
  const address = '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0');
  const sockets = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').map(row => row.trim().split(/\s+/)).filter(row => row[1] === address && row[3] === '0A');
  if (sockets.length !== 1) fail('COMPONENT_LISTENER_UNPROVEN');
  const folder = '/proc/' + state.MainPID + '/fd';
  if (fs.readdirSync(folder).length > 4096 || !fs.readdirSync(folder).some(name => {
    try { return fs.readlinkSync(folder + '/' + name) === 'socket:[' + sockets[0][9] + ']'; } catch { return false; }
  })) fail('COMPONENT_LISTENER_OWNER_CHANGED');
}
function unitText(candidate) {
  if (!candidate || !/^[a-f0-9]{24}$/.test(candidate.attemptId || '') || !HASH.test(candidate.archiveSha256 || '')
    || ![8790, 8791].includes(candidate.port) || candidate.unit !== 'football-read-api-component-' + candidate.attemptId + '.service') fail('INVALID_COMPONENT_UNIT');
  const image = RELEASES + '/' + candidate.archiveSha256;
  return '[Unit]\nDescription=Football independent read API ' + candidate.attemptId + '\nAfter=network-online.target postgresql.service\nWants=network-online.target\n\n'
    + '[Service]\nType=simple\nUser=football\nGroup=football\nWorkingDirectory=' + image + '\nEnvironmentFile=/etc/football-predict/env\n'
    + 'Environment=READ_API_HOST=127.0.0.1\nEnvironment=READ_API_PORT=' + candidate.port + '\nEnvironment="PGOPTIONS=-c default_transaction_read_only=on"\n'
    + 'ExecStart=' + NODE + ' ' + image + '/services/read-api/server.cjs\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\n'
    + 'MemoryMax=512M\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n';
}
function verifyUnitFile(candidate) {
  if (!read('/etc/systemd/system/' + candidate.unit, 8192).equals(Buffer.from(unitText(candidate)))) fail('COMPONENT_UNIT_DEFINITION_CHANGED');
}
async function main() {
  const controllerSha256 = controllerIdentity();
  const transaction = require('./componentTransaction.cjs'), authority = require('./componentActivationAuthorization.cjs');
  const signing = require('./componentSigning.cjs');
  const s = transaction.store({ base: ROOT, uid: 0, boundary: '/' });
  const publicKey = crypto.createPublicKey(read('/etc/football-release/signing-public.pem', 16 * 1024));
  const keyId = sha(publicKey.export({ format: 'der', type: 'spki' }));
  const action = process.argv[2], archiveSha256 = process.argv[3], attemptId = process.argv[4];
  if (!['prepare', 'activate', 'rollback', 'recover'].includes(action)
    || (action === 'recover' ? archiveSha256 !== undefined : !HASH.test(archiveSha256 || '') || !/^[a-f0-9]{24}$/.test(attemptId || ''))
    || process.argv.length !== (action === 'recover' ? 3 : 5)) fail('INVALID_COMPONENT_CONTROLLER_ARGUMENT');
  let image, artifact, body, received, proofHash, incoming;
  const startedMonotonic = process.hrtime.bigint(), startedWall = Date.now();
  function lease() {
    if (Date.now() < startedWall || Date.now() - startedWall >= 900_000
      || Number((process.hrtime.bigint() - startedMonotonic) / 1_000_000n) >= 900_000) fail('COMPONENT_ACTIVATION_LEASE_EXPIRED');
  }
  async function ownedUnit(candidate, allowAbsent = false) {
    transaction.safeSelection(candidate); const state = unitState(candidate.unit);
    if (state.LoadState === 'not-found' && allowAbsent) return state;
    if (state.WorkingDirectory !== RELEASES + '/' + candidate.archiveSha256) fail('COMPONENT_UNIT_OWNERSHIP_CHANGED');
    verifyUnitFile(candidate);
    return state;
  }
  const runtime = {
    wallNow: Date.now,
    async assertActivationBoundary(auth, selected) {
      lease(); const boundary = originalBoundary();
      if (controllerIdentity() !== controllerSha256) fail('INSTALLED_COMPONENT_CONTROLLER_DRIFT');
      const selector = s.read(ROOT + '/selection.json', true);
      const expected = selected?.selected ? transaction.hash(Buffer.from(JSON.stringify(selected.selected) + '\n')) : auth.previousSelectionSha256;
      if ((selector?.sha256 || null) !== expected) fail('COMPONENT_PREVIOUS_SELECTION_CHANGED');
      authority.bind(auth, artifact.envelope, { ...boundary, controllerSha256, runtimeProofSha256: proofHash,
        previousSelectionSha256: auth.previousSelectionSha256, databaseOid: received.databaseOid, databaseReadOnly: received.databaseReadOnly, port: auth.port });
      validateTree(image, artifact.manifest);
    },
    async assertRecoveryBoundary(record) {
      inheritedLock(); if (controllerIdentity() !== controllerSha256) fail('INSTALLED_COMPONENT_CONTROLLER_DRIFT');
      authority.validate(record.authorization);
      // Authenticate durable intent without reusing an expired activation grant.
      const receipt = JSON.parse(read(INCOMING + '/' + record.candidate.archiveSha256 + '/authorizations/' + record.id + '.json', 8192));
      const recoveryAuthority = authority.verify(receipt, publicKey, keyId, receipt.body.issuedAtMs);
      if (JSON.stringify(recoveryAuthority) !== JSON.stringify(record.authorization) || recoveryAuthority.controllerSha256 !== controllerSha256) fail('COMPONENT_RECOVERY_AUTHORITY_CHANGED');
    },
    async startCandidate(candidate) {
      const listener = require('node:net').createServer();
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(candidate.port, '127.0.0.1', resolve); });
      await new Promise(resolve => listener.close(resolve));
      if (unitState(candidate.unit).LoadState !== 'not-found') fail('COMPONENT_UNIT_ALREADY_EXISTS');
      const unitPath = '/etc/systemd/system/' + candidate.unit;
      directory(path.dirname(unitPath));
      const fd = fs.openSync(unitPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      try { fs.writeFileSync(fd, unitText(candidate)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const directoryFd = fs.openSync(path.dirname(unitPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      run('/usr/bin/systemctl', ['daemon-reload']); run('/usr/bin/systemctl', ['start', candidate.unit]);
      await ownedUnit(candidate);
    },
    async verifyCandidate(candidate) {
      const deadline = process.hrtime.bigint() + 180_000_000_000n; let consecutive = 0;
      while (process.hrtime.bigint() < deadline) {
        lease(); const state = await ownedUnit(candidate);
        if (state.ActiveState === 'failed') fail('COMPONENT_CANDIDATE_FAILED');
        try {
          const value = await get(candidate.port, '/api/v2/health');
          listenerOwned(await ownedUnit(candidate), candidate.port);
          if (value.status !== 200 || value.body.role !== 'read-api' || value.body.version !== 'separated-read-api-v1'
            || value.body.writesEnabled !== false || value.body.database?.oid !== '28598409'
            || value.body.database?.transactionReadOnly !== true || value.body.storage !== 'postgres') fail('COMPONENT_HEALTH_CONTRACT');
          if (++consecutive >= 2) break;
        } catch { consecutive = 0; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (consecutive < 2) fail('COMPONENT_HEALTH_TIMEOUT');
      const fixtures = await get(candidate.port, '/api/v2/fixtures?limit=1'), rejected = await get(candidate.port, '/api/v2/fixtures?limit=101');
      if (fixtures.status !== 200 || fixtures.body.ok !== true || !Array.isArray(fixtures.body.matches)
        || fixtures.body.matches.length > 1 || rejected.status !== 400 || rejected.body.error !== 'INVALID_LIMIT') fail('COMPONENT_READ_CONTRACT');
      const denied = await get(candidate.port, '/api/v2/recommendations');
      if (denied.status !== 401 || denied.body.error !== 'ACCESS_REQUIRED') fail('COMPONENT_ACCESS_CONTRACT');
    },
    async stopCandidate(candidate) {
      const unitPath = '/etc/systemd/system/' + candidate.unit;
      if (fs.existsSync(unitPath)) { verifyUnitFile(candidate); run('/usr/bin/systemctl', ['daemon-reload']); }
      const state = await ownedUnit(candidate, true); if (state.LoadState === 'not-found') return;
      run('/usr/bin/systemctl', ['stop', candidate.unit], 30_000);
      run('/usr/bin/systemctl', ['disable', candidate.unit]);
      const stopped = await ownedUnit(candidate);
      if (stopped.MainPID !== '0' || stopped.ControlPID !== '0' || stopped.Job !== '' || !['inactive', 'failed'].includes(stopped.ActiveState)) fail('COMPONENT_STOP_UNPROVEN');
      if (stopped.ControlGroup) {
        const cgroup = '/sys/fs/cgroup' + stopped.ControlGroup;
        const expectedGroup = '/system.slice/' + candidate.unit;
        if (!(stopped.ControlGroup === expectedGroup || stopped.ControlGroup.startsWith(expectedGroup + '/')) || /[.][.]/.test(stopped.ControlGroup)) fail('COMPONENT_CGROUP_CHANGED');
        if (fs.existsSync(cgroup)) {
          for (const file of ['cgroup.procs', 'cgroup.threads']) if (fs.readFileSync(cgroup + '/' + file, 'utf8').trim()) fail('COMPONENT_CONSUMERS_REMAIN');
        }
      }
    },
    async finalizeAccepted(record) {
      await runtime.assertRecoveryBoundary(record);
      const selected = s.read(ROOT + '/selection.json');
      if (JSON.stringify(selected.value) !== JSON.stringify(record.candidate)) fail('COMPONENT_SELECTION_RECOVERY_CONFLICT');
      const state = await ownedUnit(record.candidate); listenerOwned(state, record.candidate.port);
      run('/usr/bin/systemctl', ['enable', record.candidate.unit]);
      if (record.previous) {
        await ownedUnit(record.previous);
        // Keep the previous component process available for immediate rollback.
        // Only the accepted component is enabled at boot; original units are untouched.
        run('/usr/bin/systemctl', ['disable', record.previous.unit]);
      }
    }
  };
  if (action === 'recover') return transaction.recover(s, runtime);
  incoming = INCOMING + '/' + archiveSha256; directory(incoming);
  const manifestRaw = read(incoming + '/artifact.manifest.json', 4 * 1024 * 1024), manifest = JSON.parse(manifestRaw);
  const signature = JSON.parse(read(incoming + '/artifact.signed.json', 32 * 1024));
  const envelope = signing.envelope(manifest, manifestRaw, keyId);
  if (JSON.stringify(envelope) !== JSON.stringify(signature.envelope) || !signing.verify(envelope, signature.signature, publicKey, keyId)
    || envelope.component !== 'read-api' || envelope.artifactPlatform !== 'linux' || manifest.runtimeDependenciesInstalled !== true
    || envelope.archiveSha256 !== archiveSha256 || sha(read(incoming + '/artifact.tgz', 512 * 1024 * 1024)) !== archiveSha256) fail('COMPONENT_RUNTIME_IMAGE_SIGNATURE_REQUIRED');
  const proofRaw = read(incoming + '/runtime-proof.json', 32 * 1024); proofHash = sha(proofRaw);
  received = JSON.parse(proofRaw);
  if (received.version !== 'readonly-component-runtime-proof-v1' || received.archiveSha256 !== archiveSha256
    || received.head !== envelope.head || received.platform !== 'linux' || received.databaseOid !== '28598409'
    || received.databaseReadOnly !== true || received.dependenciesFromArtifact !== true || received.runtimeVerified !== true) fail('EXACT_COMPONENT_RUNTIME_PROOF_REQUIRED');
  body = authority.verify(JSON.parse(read(incoming + '/authorizations/' + attemptId + '.json', 8192)), publicKey, keyId);
  if (body.attemptId !== attemptId || (action !== 'prepare' && body.action !== action)) fail('COMPONENT_ACTION_AUTHORITY_MISMATCH');
  artifact = { envelope, manifest };
  image = incoming + '/image'; validateTree(image, manifest); capacity(manifest);
  await runtime.assertActivationBoundary(body);
  if (action === 'prepare') return { prepared: true, installed: false, component: 'read-api', archiveSha256, productionWrites: 0 };
  image = installImage(image, manifest);
  return transaction.activate(s, runtime, body);
}
if (require.main === module) main().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.code || 'COMPONENT_CONTROLLER_FAILED'); process.exitCode = 1; });
module.exports = { main, FILES, unitText };
