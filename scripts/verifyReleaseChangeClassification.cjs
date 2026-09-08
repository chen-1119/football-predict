"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
const { INVENTORY_VERSION, LIMITS, FRONTEND_PATHS, captureReleaseSourceInventory,
  validateInventory, buildFrontendBinding, classifyReleaseChanges } = require("./releaseChangeClassification.cjs");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));

function verifyReleaseChangeClassification() {
  const checks = [];
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-classification-"));
  const write = (root, relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const distManifest = root => write(root, ".release-prebuilt/dist-manifest.json",
    `${JSON.stringify(inspectPrebuiltDist(path.join(root, "dist")), null, 2)}\n`);
  const make = name => {
    const root = path.join(fixtureRoot, name);
    fs.mkdirSync(root);
    for (const [file, text] of Object.entries({
      "package.json": '{"scripts":{"build":"tsc -b && vite build && node scripts/stripLargeStaticPayloads.cjs"}}',
      "package-lock.json": '{"lockfileVersion":3}', "vite.config.ts": 'export default {};',
      "scripts/stripLargeStaticPayloads.cjs": 'module.exports = {};',
      "server/index.cjs": 'module.exports = require("../src/services/policy.cjs");',
      "src/services/policy.cjs": 'module.exports = { formal: false };',
      "src/pages/PredictionsList.tsx": 'export default () => <p>reference</p>;',
      "src/components/Navbar.tsx": 'export default () => <nav>fixtures</nav>;',
      "src/styles/tokens.css": ':root { --foreground: #fff; }',
      "public/data/runtime-config.json": '{"formal":false}',
      "public/data/sync-meta.json": '{"generation":"fixture"}',
      "public/matches.json": '[]', ".release-model-assets/historical-training-index.json": '{"fixture":true}',
      "dist/index.html": '<script src="/assets/app-a.js"></script>',
      "dist/assets/app-a.js": 'console.log("fixture");',
    })) write(root, file, text);
    distManifest(root);
    return root;
  };
  const bindingOptions = { nodeSha256: hash("fixture-node22"), nodeVersion: "v22.22.1", buildEnvironmentHash: hash("fixture-environment") };
  const input = root => {
    const inventory = captureReleaseSourceInventory(root);
    const buildBinding = buildFrontendBinding(inventory, bindingOptions);
    return { root, inventory, buildBinding, authenticatedIdentity: {
      releaseSha256: hash(`fixture-release:${inventory.treeHash}`), inventorySha256: inventory.treeHash,
      buildBindingSha256: hash(buildBinding),
    } };
  };
  const base = make("baseline");
  let sequence = 0;
  const altered = edit => {
    const root = make(`candidate-${++sequence}`);
    edit(root);
    distManifest(root);
    return input(root);
  };
  const full = result => {
    assert.equal(result.classification, "full", JSON.stringify(result));
    assert.equal(result.executionMode, "full");
    assert.equal(result.fastPathActivated, false);
    assert.deepEqual(result.skippedStages, []);
    assert.ok(result.blockers.length > 0);
  };
  const check = (name, action) => { action(); checks.push({ name, ok: true }); };
  try {
    const baseline = input(base);
    check("complete filesystem inventory is canonical, stable and immutable", () => {
      assert.deepEqual(captureReleaseSourceInventory(base), baseline.inventory);
      assert.equal(baseline.inventory.version, INVENTORY_VERSION);
      assert.equal(validateInventory(baseline.inventory), baseline.inventory);
      assert.equal(Object.isFrozen(baseline.inventory.entries[0]), true);
      assert.ok(baseline.inventory.entries.some(row => row.path === "public/data/sync-meta.json"));
    });
    check("unchanged release does not authorize a no-op or skipped checks", () => {
      const result = classifyReleaseChanges({ baseline, candidate: baseline });
      assert.equal(result.classification, "unchanged");
      assert.equal(result.executionMode, "full");
      assert.deepEqual(result.skippedStages, []);
    });
    const ui = altered(root => {
      write(root, "src/pages/PredictionsList.tsx", 'export default () => <section>clear reference</section>;');
      write(root, "src/components/Navbar.tsx", 'export default () => <nav>daily</nav>;');
      write(root, "src/styles/tokens.css", ':root { --foreground: #ddd; }');
      write(root, "dist/index.html", '<script src="/assets/app-b.js"></script>');
      fs.unlinkSync(path.join(root, "dist/assets/app-a.js"));
      write(root, "dist/assets/app-b.js", 'console.log("new fixture UI");');
    });
    check("real page/component/style plus content-hashed dist changes yield a bound frontend-only plan", () => {
      const result = classifyReleaseChanges({ baseline, candidate: ui });
      assert.equal(result.classification, "frontend-only", JSON.stringify(result));
      assert.deepEqual(result.blockers, []);
      assert.ok(result.changes.some(row => row.path === "dist/assets/app-a.js" && row.action === "removed"));
      assert.ok(result.changes.some(row => row.path === "dist/assets/app-b.js" && row.action === "added"));
      assert.equal(result.executionMode, "full");
      assert.equal(result.fastPathActivated, false);
      assert.ok(result.activationRequirements.includes("audited-runtime-entrypoint-and-ui-dependency-boundary"));
      assert.deepEqual(result, classifyReleaseChanges({ baseline, candidate: ui }));
    });
    check("missing baseline and legacy count-only metadata default full", () => {
      full(classifyReleaseChanges({ candidate: ui }));
      full(classifyReleaseChanges({ baseline: { ...baseline, authenticatedIdentity: { releaseSha256: hash("legacy"), entries: 900 } }, candidate: ui }));
    });
    check("malformed or absent candidate defaults full", () => {
      full(classifyReleaseChanges({ baseline }));
      full(classifyReleaseChanges({ baseline, candidate: { ...ui, authenticatedIdentity: { ...ui.authenticatedIdentity, inventorySha256: "bad" } } }));
    });
    check("self-asserted complete flag or additional exclusions cannot grant trust", () => {
      const forged = copy(ui); forged.inventory.complete = true;
      full(classifyReleaseChanges({ baseline, candidate: forged }));
      forged.authenticatedIdentity.excludes = ["public/data"];
      full(classifyReleaseChanges({ baseline, candidate: forged }));
    });
    for (const [name, relative] of [
      ["runtime", "server/index.cjs"], ["model shared service", "src/services/policy.cjs"],
      ["dependency lock", "package-lock.json"], ["build configuration", "vite.config.ts"],
      ["runtime configuration", "public/data/runtime-config.json"], ["generated sync data", "public/data/sync-meta.json"],
      ["generated matches", "public/matches.json"], ["historical model asset", ".release-model-assets/historical-training-index.json"],
      ["unreviewed new page", "src/pages/Unreviewed.tsx"], ["unreviewed new style", "src/styles/unreviewed.css"],
      ["unreviewed public image", "public/new-ui.png"], ["nested outputs", "src/outputs/inference.ts"],
      ["unknown root file", "new-policy.cjs"], ["shared app context", "src/context/AppContext.tsx"],
      ["database migration", "server/new-migration.sql"], ["deployment config", "deploy/new-policy.json"],
    ]) check(`${name} change cannot take frontend-only route`, () => {
      const candidate = altered(root => {
        write(root, "src/pages/PredictionsList.tsx", '<p>new UI</p>');
        write(root, relative, "changed fixture bytes");
      });
      full(classifyReleaseChanges({ baseline, candidate }));
    });
    check("artifact-only changes cannot impersonate a source UI release", () => {
      full(classifyReleaseChanges({ baseline, candidate: altered(root => write(root, "dist/assets/app-a.js", "unexplained build")) }));
    });
    check("missing signed build binding cannot validate derived artifacts", () => {
      full(classifyReleaseChanges({ baseline, candidate: { ...ui, authenticatedIdentity: { ...ui.authenticatedIdentity, buildBindingSha256: null } } }));
      full(classifyReleaseChanges({ baseline, candidate: { ...ui, buildBinding: undefined } }));
    });
    check("signed build binding cannot be replayed for different source or outputs", () => {
      const replay = { ...ui, buildBinding: baseline.buildBinding,
        authenticatedIdentity: { ...ui.authenticatedIdentity, buildBindingSha256: baseline.authenticatedIdentity.buildBindingSha256 } };
      full(classifyReleaseChanges({ baseline, candidate: replay }));
    });
    check("build runtime and environment changes require full even with valid signed binding", () => {
      const candidate = copy(ui);
      candidate.buildBinding.nodeSha256 = hash("different node");
      candidate.authenticatedIdentity.buildBindingSha256 = hash(candidate.buildBinding);
      full(classifyReleaseChanges({ baseline, candidate }));
    });
    check("failure and tampered build evidence never grant a route", () => {
      const candidate = copy(ui); candidate.buildBinding.exitCode = 1;
      candidate.authenticatedIdentity.buildBindingSha256 = hash(candidate.buildBinding);
      full(classifyReleaseChanges({ baseline, candidate }));
      candidate.buildBinding.exitCode = 0;
      full(classifyReleaseChanges({ baseline, candidate }));
    });
    check("prebuilt manifest must actually describe the complete dist tree", () => {
      const root = make(`candidate-${++sequence}`);
      write(root, "src/pages/PredictionsList.tsx", '<p>new UI</p>');
      write(root, "dist/assets/app-a.js", "not in the stale dist manifest");
      const candidate = input(root);
      const result = classifyReleaseChanges({ baseline, candidate });
      full(result);
      assert.ok(result.blockers.some(reason => reason.includes("derived-dist-manifest-mismatch")));
    });
    check("omitted entry cannot be hidden behind a newly recomputed inventory hash", () => {
      const candidate = copy(ui);
      candidate.inventory.entries = candidate.inventory.entries.filter(row => row.path !== "server/index.cjs");
      const body = { version: INVENTORY_VERSION, entries: candidate.inventory.entries,
        entryCount: candidate.inventory.entries.length, fileCount: candidate.inventory.entries.filter(row => row.kind === "file").length,
        totalBytes: candidate.inventory.entries.reduce((sum, row) => sum + (row.bytes || 0), 0) };
      candidate.inventory = { ...body, treeHash: hash(body) };
      candidate.authenticatedIdentity.inventorySha256 = candidate.inventory.treeHash;
      full(classifyReleaseChanges({ baseline, candidate }));
    });
    check("duplicate, unsorted, incomplete parent and unsafe path inventories reject", () => {
      for (const mutate of [
        inv => inv.entries.push(inv.entries[0]),
        inv => inv.entries.reverse(),
        inv => { inv.entries = inv.entries.filter(row => row.path !== "src"); },
        inv => { inv.entries[0].path = "../outside"; },
        inv => { inv.entries[0].path = "C:/outside"; },
        inv => { inv.entries[0].path = "src\\alias"; },
        inv => { inv.entries[0].kind = "symlink"; },
      ]) {
        const candidate = copy(ui); mutate(candidate.inventory);
        full(classifyReleaseChanges({ baseline, candidate }));
      }
    });
    check("filesystem mutation after capture invalidates inventory, not just build proof", () => {
      const candidate = altered(() => {});
      write(candidate.root, "server/index.cjs", "changed after capture");
      full(classifyReleaseChanges({ baseline, candidate }));
    });
    check("actual directory junction or symlink is rejected without following it", () => {
      const root = make(`candidate-${++sequence}`);
      const link = path.join(root, "linked-tree");
      fs.symlinkSync(base, link, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => captureReleaseSourceInventory(root), /symlink-entry/);
      assert.throws(() => captureReleaseSourceInventory(link), /non-plain-root-or-ancestor/);
      fs.unlinkSync(link);
    });
    check("actual hardlink and aliased directory are not plain release inputs", () => {
      const root = make(`candidate-${++sequence}`);
      fs.linkSync(path.join(root, "src/pages/PredictionsList.tsx"), path.join(root, "hardlink.tsx"));
      assert.throws(() => captureReleaseSourceInventory(root), /non-plain-file/);
    });
    check("file changing during read is detected with real filesystem mutation", () => {
      const root = make(`candidate-${++sequence}`);
      const target = path.join(root, "src/pages/PredictionsList.tsx");
      const original = fs.readSync;
      let mutated = false;
      fs.readSync = function observedRead(fd, buffer, ...args) {
        const count = original.call(fs, fd, buffer, ...args);
        if (!mutated && buffer.subarray(0, count).includes(Buffer.from("<p>reference</p>"))) {
          mutated = true; fs.appendFileSync(target, "\nchanged during observation");
        }
        return count;
      };
      try { assert.throws(() => captureReleaseSourceInventory(root), /entry-changed-during-read/); assert.equal(mutated, true); }
      finally { fs.readSync = original; }
    });
    check("oversized real sparse file is rejected before reading bytes", () => {
      const root = make(`candidate-${++sequence}`);
      const target = path.join(root, "oversized.bin");
      const fd = fs.openSync(target, "wx");
      try { fs.ftruncateSync(fd, LIMITS.fileBytes + 1); } finally { fs.closeSync(fd); }
      assert.throws(() => captureReleaseSourceInventory(root), /byte-limit/);
    });
    check("plan hash covers explanation, exact release identities and complete change rows", () => {
      const result = classifyReleaseChanges({ baseline, candidate: ui });
      const { planHash, ...body } = result;
      assert.equal(planHash, hash(body));
      assert.equal(result.identities.baseline.releaseSha256, baseline.authenticatedIdentity.releaseSha256);
      assert.throws(() => { result.changes[0].after.sha256 = hash("tamper"); }, TypeError);
      assert.ok(FRONTEND_PATHS.includes("src/pages/PredictionsList.tsx"));
      assert.ok(!FRONTEND_PATHS.includes("src/context/AppContext.tsx"));
      assert.ok(FRONTEND_PATHS.every(name => !name.includes("*")));
    });
    return { ok: true, verifier: "release-change-classification-v1", checks, fixtures: "real bounded filesystem trees",
      productionWrites: 0, networkCalls: 0, skipsActivated: 0 };
  } finally {
    const resolved = fs.realpathSync(fixtureRoot);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^football-release-classification-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

module.exports = { verifyReleaseChangeClassification };
if (require.main === module) console.log(JSON.stringify(verifyReleaseChangeClassification(), null, 2));
