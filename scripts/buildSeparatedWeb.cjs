'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inventory(directory, prefix = '') {
  const rows = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), entry = prefix ? prefix + '/' + name : name, stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Build output contains a symlink');
    if (stat.isDirectory()) rows.push(...inventory(file, entry));
    else if (stat.isFile()) rows.push({ path: entry, bytes: stat.size, sha256: sha(fs.readFileSync(file)) });
    else throw new Error('Build output must be ordinary files');
  }
  return rows;
}
function build({ root = path.resolve(__dirname, '..') } = {}) {
  const git = args => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit source before building component evidence');
  const lock = path.join(root, '.codex-tmp/separated-web-build.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true });
  const fd = fs.openSync(lock, 'wx');
  try {
    const sources = git(['ls-files']).split('\n').filter(name => /^(?:apps\/web\/|src\/(?:services|components)\/|package(?:-lock)?\.json$)/.test(name)).map(name => ({ path: name, sha256: sha(fs.readFileSync(path.join(root, name))) }));
    const next = path.join(root, 'apps/web/node_modules/next/dist/bin/next');
    const child = cp.spawnSync(process.execPath, [next, 'build', '--webpack'], { cwd: path.join(root, 'apps/web'), env: process.env, stdio: 'inherit', windowsHide: true, timeout: 600000 });
    if (child.status !== 0 || child.error) throw new Error('Next build failed');
    if (git(['rev-parse', 'HEAD']) !== head || git(['status', '--porcelain', '--untracked-files=no']) || sources.some(row => sha(fs.readFileSync(path.join(root, row.path))) !== row.sha256)) throw new Error('Build source changed');
    const outputs = [...inventory(path.join(root, 'apps/web/.next/standalone'), 'standalone'), ...inventory(path.join(root, 'apps/web/.next/static'), 'static')];
    const proof = { version: 'separated-web-build-v1', head, completedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, command: 'next build --webpack', exitCode: 0, sourceInventory: sources, outputInventory: outputs };
    fs.writeFileSync(path.join(root, 'apps/web/.next/service-build-proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ head, platform: proof.platform, sourceFiles: sources.length, outputFiles: outputs.length, exitCode: 0 })); return proof;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (require.main === module) build();
module.exports = { build, inventory };
