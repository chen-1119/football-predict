'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { artifact } = require('../scripts/signServiceArtifact.cjs');
test('a dependency-complete Linux manifest fits a fixed metadata bound while oversized and changed inputs still fail', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'football-component-manifest-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert(path.basename(root).startsWith('football-component-manifest-')); fs.rmSync(root, { recursive: true }); });
  const archive = path.join(root, 'component.tgz'), raw = Buffer.from('test fixture archive'); fs.writeFileSync(archive, raw);
  const manifest = { archiveBytes: raw.length, archiveSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    inventory: Array.from({ length: 12083 }, (_, i) => ({ path: 'node_modules/fixture-runtime-dependency-with-long-package-name/distribution/chunk-' + i + '.cjs', bytes: 1, sha256: 'a'.repeat(64) })) };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2)); assert(bytes.length > 2 * 1024 * 1024 && bytes.length < 4 * 1024 * 1024);
  fs.writeFileSync(archive + '.manifest.json', bytes);
  assert.equal(artifact(archive).manifest.inventory.length, 12083);
  fs.writeFileSync(archive, 'changed'); assert.throws(() => artifact(archive), /COMPONENT_ARCHIVE_MISMATCH/);
  fs.writeFileSync(archive + '.manifest.json', Buffer.alloc(4 * 1024 * 1024 + 1, 32)); assert.throws(() => artifact(archive), /ARTIFACT_FILE_BOUND/);
});
