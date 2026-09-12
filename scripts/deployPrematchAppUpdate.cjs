'use strict';
// Small signed application update: built assets + the prematch HTTP route and
// collector sources. Existing PostgreSQL generations and the Worker keep running.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), zlib = require('node:zlib'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = bytes => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));

async function applyRemote(envelope) {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
  const crypto = require('node:crypto'), assert = require('node:assert/strict');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const app = '/opt/football-predict';
  const bytes = Buffer.from(envelope.payload, 'base64');
  const key = fs.readFileSync('/etc/football-release/signing-public.pem');
  assert.ok(crypto.verify('sha256', bytes, key, Buffer.from(envelope.signature, 'base64')), 'Invalid update signature');
  const manifest = JSON.parse(bytes), id = hash(bytes);
  assert.equal(manifest.version, 'prematch-app-update-v1');
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.ok(Date.now() < Date.parse(manifest.expiresAt), 'Update expired');
  assert.ok(Date.now() >= Date.parse(manifest.createdAt) - 60000, 'Future update');
  const base = fs.readFileSync(app + '/.release-bundle-sha256', 'utf8').trim();
  assert.equal(base, manifest.baseBundle, 'Application baseline changed');
  const release = '/var/lib/football-release/app-updates/' + id;
  fs.mkdirSync(path.dirname(release), { recursive: true, mode: 0o700 });
  if (fs.existsSync(release + '/deployed.json')) {
    assert.equal(fs.readFileSync(app + '/.release-app-update-sha256', 'utf8').trim(), id);
    console.log(fs.readFileSync(release + '/deployed.json', 'utf8')); return;
  }
  assert.ok(!fs.existsSync(release), 'Incomplete update exists; inspect before retry');
  const seen = new Set();
  for (const entry of manifest.files) {
    assert.ok(/^(?:dist\/(?:assets\/[^/]+|index\.html)|src\/[A-Za-z0-9_./-]+|collectors\/leisu-prematch\/[A-Za-z0-9_.\/-]+|server\/index\.cjs)$/.test(entry.path));
    assert.ok(!entry.path.split('/').some(part => !part || part === '..' || part === '.'));
    assert.ok(!seen.has(entry.path)); seen.add(entry.path);
    const content = Buffer.from(entry.content, 'base64');
    assert.equal(hash(content), entry.sha256);
    assert.ok(content.length <= 16 * 1024 ** 2);
    for (let dir = path.dirname(app + '/' + entry.path); dir.startsWith(app); dir = path.dirname(dir)) {
      if (fs.existsSync(dir)) assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
    }
    const target = app + '/' + entry.path;
    if (fs.existsSync(target)) assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
    if (entry.before !== undefined) {
      const current = fs.existsSync(target) ? hash(Buffer.from(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))) : null;
      assert.ok(current === entry.before || (entry.before === null && current === hash(Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n')))), 'Source baseline changed: ' + entry.path);
    }
  }
  assert.ok(seen.has('dist/index.html') && seen.has('server/index.cjs'));
  const status = cp.execFileSync('systemctl', ['is-active', 'football-predict.service'], { encoding: 'utf8' }).trim();
  assert.equal(status, 'active');
  fs.mkdirSync(release, { mode: 0o700 });
  fs.writeFileSync(release + '/manifest.json', bytes, { mode: 0o600 });
  // Stage and back up only files included in this signed application update.
  // Hashed assets are additive so tabs already open retain their old chunks.
  const modified = [];
  for (const entry of manifest.files) {
    const target = app + '/' + entry.path, staged = release + '/staged/' + entry.path;
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, Buffer.from(entry.content, 'base64'), { mode: 0o644 });
    const previous = fs.existsSync(target);
    if (previous) {
      fs.mkdirSync(path.dirname(release + '/backup/' + entry.path), { recursive: true });
      fs.copyFileSync(target, release + '/backup/' + entry.path);
    }
    modified.push({ ...entry, previous });
  }
  cp.execFileSync(process.execPath, ['--check', release + '/staged/server/index.cjs']);
  const started = Date.now();
  try {
    for (const entry of modified.sort((a, b) => Number(a.path === 'dist/index.html') - Number(b.path === 'dist/index.html'))) {
      const target = app + '/' + entry.path;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.copyFileSync(release + '/staged/' + entry.path, target + '.app-update');
      fs.chmodSync(target + '.app-update', 0o644);
      fs.renameSync(target + '.app-update', target);
    }
    cp.execFileSync('systemctl', ['restart', 'football-predict.service'], { timeout: 30000 });
    let healthy = false;
    for (let i = 0; i < 300; i++) {
      try { const r = await fetch('http://127.0.0.1:8788/api/v1/health', { signal: AbortSignal.timeout(1500) }); healthy = r.status === 200; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(healthy, 'HTTP startup failed');
    for (const entry of manifest.files) assert.equal(hash(fs.readFileSync(app + '/' + entry.path)), entry.sha256);
    const report = { ok: true, commit: manifest.commit, appUpdateSha256: id, baseBundle: base,
      files: manifest.files.length, deployedAt: new Date().toISOString(), switchMs: Date.now() - started,
      databaseMigration: false, sqliteExport: false, workerRestart: false, officialAcceptance: 'independent' };
    fs.writeFileSync(app + '/.release-app-update-sha256', id + '\n');
    fs.writeFileSync(app + '/.release-app-update.json', JSON.stringify(report, null, 2));
    fs.writeFileSync(release + '/deployed.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    // Restore only replaced application files. New hashed assets are harmless
    // and retained; no database state or Worker state is rolled back.
    for (const entry of modified) if (entry.previous) fs.copyFileSync(release + '/backup/' + entry.path, app + '/' + entry.path);
    cp.execFileSync('systemctl', ['restart', 'football-predict.service'], { timeout: 30000 });
    throw error;
  }
}

async function main() {
  const env = process.env, git = env.GIT_EXECUTABLE || 'git';
  const run = args => cp.execFileSync(git, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
  const commit = run(['rev-parse', 'HEAD']);
  assert.equal(run(['diff', '--name-only', 'HEAD', '--']), '', 'Commit reviewed changes first');
  assert.match(env.APP_UPDATE_BASE_BUNDLE || '', /^[0-9a-f]{64}$/);
  const base = env.APP_UPDATE_SOURCE_BASE || commit + '^';
  const files = [];
  const add = (relative, before) => {
    const content = fs.readFileSync(path.join(root, relative));
    files.push({ path: relative, sha256: digest(content), content: content.toString('base64'), ...(before !== undefined ? { before } : {}) });
  };
  add('dist/index.html');
  for (const entry of fs.readdirSync(path.join(root, 'dist/assets'), { withFileTypes: true })) if (entry.isFile()) add('dist/assets/' + entry.name);
  const changed = run(['diff', '--name-only', base, commit, '--', 'src', 'server/index.cjs']).split(/\r?\n/).filter(Boolean);
  for (const file of changed) {
    let before;
    if (file === 'server/index.cjs') before = digest(normalize(cp.execFileSync(git, ['show', base + ':' + file], { cwd: root, maxBuffer: 2e6 })));
    add(file, before);
  }
  for (const file of run(['ls-files', '--', 'collectors/leisu-prematch']).split(/\r?\n/).filter(Boolean)) {
    if (/\.cjs$|schema\.sql$|package(?:-lock)?\.json$/.test(file) && !/\.test\.cjs$/.test(file)) {
      const exists = cp.spawnSync(git, ['cat-file', '-e', base + ':' + file], { cwd: root, windowsHide: true }).status === 0;
      const before = exists ? digest(normalize(cp.execFileSync(git, ['show', base + ':' + file], { cwd: root, maxBuffer: 2e6 }))) : null;
      add(file, before);
    }
  }
  const manifest = { version: 'prematch-app-update-v1', commit, baseBundle: env.APP_UPDATE_BASE_BUNDLE,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), files };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const envelope = { payload: bytes.toString('base64'), signature: crypto.sign('sha256', bytes, fs.readFileSync(env.RELEASE_SIGNING_PRIVATE_KEY)).toString('base64') };
  const compressed = zlib.gzipSync(JSON.stringify(envelope));
  const { resolveReleaseSshHostKeyPin, buildPinnedSshBaseOptions } = require('./releaseSshHostKeyPin.cjs');
  const pin = resolveReleaseSshHostKeyPin({ rootDir: root, host: env.RELEASE_DEPLOY_HOST, port: Number(env.RELEASE_DEPLOY_PORT || 22) });
  const args = [...buildPinnedSshBaseOptions({ keyPath: env.RELEASE_DEPLOY_KEY, pin }),
    (env.RELEASE_DEPLOY_USER || 'ubuntu') + '@' + env.RELEASE_DEPLOY_HOST,
    'sudo', '-n', '/usr/bin/env', '-i', 'PATH=/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/opt/node-v22.22.1/bin/node', '-'];
  const code = `const envelope=JSON.parse(require('zlib').gunzipSync(Buffer.from('${compressed.toString('base64')}','base64'),{maxOutputLength:64*1024**2}));(${applyRemote.toString()})(envelope).catch(e=>{console.error(e.message);process.exitCode=1});`;
  const result = cp.spawnSync(env.SSH_EXECUTABLE || 'ssh', args, { input: code, encoding: 'utf8', timeout: 240000, maxBuffer: 1e6, windowsHide: true });
  const output = path.join(root, 'outputs', 'prematch-app-update-' + Date.now() + '.json');
  fs.writeFileSync(output, JSON.stringify({ commit, uploadBytes: compressed.length, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  console.log(result.stdout || result.stderr); assert.equal(result.status, 0, 'Application update failed: ' + output);
}
module.exports = { applyRemote };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
