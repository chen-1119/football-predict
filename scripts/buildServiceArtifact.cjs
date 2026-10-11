'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { plan } = require('../services/release/componentPolicy.cjs');
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
function build({ component, root = path.resolve(__dirname, '..'), output }) {
  const policy = plan(component);
  if (!output || !path.isAbsolute(output)) throw new Error('Absolute output path required');
  if (fs.existsSync(output)) throw new Error('Output already exists');
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (cp.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Tracked source must be committed before packaging');
  const tracked = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  const staging = output + '.contents'; fs.mkdirSync(staging, { recursive: false });
  const inventory = [];
  function copy(from, name) {
    if (!name || name.startsWith('/') || name.split('/').some(part => part === '..') || /(?:^|\/)(?:\.env(?:\..*)?|server-data|\.codex-tmp)(?:\/|$)/.test(name)) throw new Error('Unsafe artifact entry');
    const stat = fs.lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Artifact entries must be ordinary files');
    const target = path.join(staging, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    const raw = fs.readFileSync(from); fs.writeFileSync(target, raw, { flag: 'wx' });
    inventory.push({ path: name, bytes: raw.length, sha256: sha(raw) });
  }
  function tree(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const from = path.join(directory, name), to = prefix ? prefix + '/' + name : name;
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error('Artifact tree contains a symlink');
      if (stat.isDirectory()) tree(from, to); else copy(from, to);
    }
  }
  if (component === 'web') {
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/.next/service-build-proof.json'), 'utf8'));
    if (proof.version !== 'separated-web-build-v1' || proof.head !== head || proof.exitCode !== 0 || proof.platform !== process.platform) throw new Error('Web requires fresh source-bound component build evidence');
    for (const row of proof.sourceInventory) if (sha(fs.readFileSync(path.join(root, row.path))) !== row.sha256) throw new Error('Web build source changed');
    for (const row of proof.outputInventory) if (sha(fs.readFileSync(path.join(root, 'apps/web/.next', row.path))) !== row.sha256) throw new Error('Web build output changed');
    const standalone = path.join(root, 'apps/web/.next/standalone');
    if (!fs.existsSync(path.join(standalone, 'apps/web/server.js'))) throw new Error('Build standalone web first');
    tree(standalone, '');
    tree(path.join(root, 'apps/web/.next/static'), 'apps/web/.next/static');
    copy(path.join(root, 'apps/web/.next/service-build-proof.json'), 'service-build-proof.json');
  } else {
    for (const name of tracked.filter(name => policy.roots.some(prefix => name === prefix || name.startsWith(prefix + '/')))) copy(path.join(root, name), name);
    for (const name of ['package.json', 'package-lock.json']) copy(path.join(root, name), name);
  }
  for (const unit of new Set(policy.units.map(name => name.replace(/@[^.]+\./, '@.')))) {
    const name = 'deploy/services-v1/' + unit; copy(path.join(root, name), name);
  }
  const environmentExample = 'deploy/services-v1/services-v1.env.example'; copy(path.join(root, environmentExample), environmentExample);
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  const schema = tracked.filter(name => /^server\/postgres\/migrations\/\d+.*\.sql$/.test(name)).map(name => ({ path: name, sha256: sha(fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')) }));
  const manifest = { version: 'independent-component-artifact-v1', component, head, createdAt: new Date().toISOString(),
    apiContract: 'separated-read-api-v1', entry: policy.entry, schemaSha256: sha(JSON.stringify(schema)),
    databaseCopies: 0, migrations: false, signed: false, activationEligible: false,
    artifactPlatform: component === 'web' ? process.platform : 'source', runtimeDependenciesInstalled: component === 'web',
    linuxRuntimeVerified: false,
    requiresSignedActivation: true, sourceFiles: inventory.length, sourceBytes: inventory.reduce((n, row) => n + row.bytes, 0), inventory };
  fs.writeFileSync(path.join(staging, 'component-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  cp.execFileSync('tar', ['-czf', output, '-C', staging, '.'], { windowsHide: true, stdio: 'pipe' });
  const receipt = { ...manifest, archive: output, archiveSha256: sha(fs.readFileSync(output)), archiveBytes: fs.statSync(output).size };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
if (require.main === module) {
  const value = build({ component: process.argv[2], output: process.argv[3] });
  const { inventory, ...summary } = value; void inventory; console.log(JSON.stringify(summary, null, 2));
}
module.exports = { build };
