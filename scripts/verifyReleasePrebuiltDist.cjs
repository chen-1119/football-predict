"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MANIFEST_VERSION,
  inspectPrebuiltDist,
  verifyPrebuiltDist,
} = require("./releasePrebuiltDist.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-prebuilt-dist-"));
try {
  const dist = path.join(root, "dist");
  const manifestPath = path.join(root, "manifest.json");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<main>ok</main>\n");
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('ok');\n");
  const manifest = inspectPrebuiltDist(dist);
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.fileCount, 2);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(verifyPrebuiltDist({ distDir: dist, manifestPath }).ok, true);

  fs.appendFileSync(path.join(dist, "assets", "app.js"), "tamper\n");
  const tampered = verifyPrebuiltDist({ distDir: dist, manifestPath });
  assert.equal(tampered.ok, false);
  assert.notEqual(tampered.actualTreeHash, tampered.expectedTreeHash);

  try {
    fs.symlinkSync(path.join(dist, "index.html"), path.join(dist, "linked.html"));
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    fs.symlinkSync(path.join(dist, "assets"), path.join(dist, "linked-assets"), "junction");
  }
  assert.throws(() => inspectPrebuiltDist(dist), /symlink/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "release-prebuilt-dist",
    assertions: 7,
    guarantees: {
      deterministicTreeHash: true,
      tamperRejected: true,
      symlinkRejected: true,
    },
  }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
