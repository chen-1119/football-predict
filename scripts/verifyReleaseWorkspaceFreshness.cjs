"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { collectFilesNewerThan, listReleaseRootEntries } = require("./releaseWorkspaceFreshness.cjs");

function verifyReleaseWorkspaceFreshness() {
  const checks = [];
  const check = (name, action) => { action(); checks.push({ name, ok: true }); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-freshness-policy-"));
  const cutoff = Date.parse("2020-01-01T00:00:00Z");
  const write = (relative, age = 2000) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "synthetic fixture\n");
    fs.utimesSync(target, new Date(cutoff + age), new Date(cutoff + age));
  };
  const paths = options => collectFilesNewerThan(root, cutoff, options).map(row => row.path);
  try {
    check("new root receipts do not invalidate verified source", () => {
      write("outputs/result.json"); write("outputs/screenshots/mobile.png");
      assert.deepEqual(paths(), []);
      assert.deepEqual(paths({ includeGeneratedData: true }), []);
    });
    check("nested outputs are source, not QA receipts", () => {
      write("src/outputs/decision.ts"); write("server/outputs/policy.cjs");
      assert.deepEqual(paths(), ["server/outputs/policy.cjs", "src/outputs/decision.ts"]);
    });
    check("similar directory names are not silently ignored", () => {
      write("outputs-next/policy.cjs"); assert.ok(paths().includes("outputs-next/policy.cjs"));
    });
    check("runtime configuration always invalidates source freshness", () => {
      write("public/data/runtime-config.json");
      assert.ok(paths().includes("public/data/runtime-config.json"));
    });
    check("online mutable generation has a separate live validation gate", () => {
      write("public/data/sync-meta.json"); write("public/matches.json");
      assert.equal(paths().includes("public/data/sync-meta.json"), false);
      assert.equal(paths().includes("public/matches.json"), false);
    });
    check("offline path retains its stricter generated-data invalidation", () => {
      assert.ok(paths({ includeGeneratedData: true }).includes("public/data/sync-meta.json"));
      assert.ok(paths({ includeGeneratedData: true }).includes("public/matches.json"));
    });
    check("old files and timestamp tolerance remain unchanged", () => {
      write("src/unchanged.ts", 0); write("src/boundary.ts", 1000); write("src/changed.ts", 1001);
      assert.equal(paths().includes("src/unchanged.ts"), false);
      assert.equal(paths().includes("src/boundary.ts"), false);
      assert.ok(paths().includes("src/changed.ts"));
    });
    check("invalid timestamp cannot silently certify an empty change list", () => {
      for (const invalid of [NaN, Infinity, undefined, "0"]) assert.throws(() => collectFilesNewerThan(root, invalid));
    });
    for (const filename of ["checkReleaseStatus.cjs", "deployReleaseBundle.cjs", "createOfflineReleaseKit.cjs"]) {
      check(`${filename} uses the real shared scanner with correct data scope`, () => {
        const source = fs.readFileSync(path.join(__dirname, filename), "utf8");
        assert.ok(source.includes('const { collectFilesNewerThan } = require("./releaseWorkspaceFreshness.cjs");'));
        assert.equal(source.includes("const ignoredFreshnessDirs"), false);
        const call = source.match(/const newerWorkspaceFiles = (collectFilesNewerThan\([^\n]+\))/);
        assert.ok(call, "actual entrypoint call must be located");
        const rows = vm.runInNewContext(call[1], { collectFilesNewerThan, rootDir: root,
          bundleStat: { mtimeMs: cutoff }, bundlePath: "fixture-bundle",
          fs: { statSync: name => { assert.equal(name, "fixture-bundle"); return { mtimeMs: cutoff }; } } });
        const names = Array.from(rows, row => row.path);
        assert.ok(names.includes("src/outputs/decision.ts"));
        assert.ok(names.includes("public/data/runtime-config.json"));
        assert.equal(names.includes("outputs/result.json"), false);
        assert.equal(names.includes("public/data/sync-meta.json"), filename === "createOfflineReleaseKit.cjs");
      });
    }
    check("actual tar excludes root outputs but retains nested production code", () => {
      const creator = fs.readFileSync(path.join(__dirname, "createReleaseBundle.cjs"), "utf8");
      const array = creator.match(/const excludes = (\[[\s\S]+?\n\]);/);
      assert.ok(array);
      const excludes = vm.runInNewContext(array[1], { runtimeMutableSourceEntries: [], sensitiveTarExcludes: [] });
      assert.ok(creator.includes('...listReleaseRootEntries(rootDir)'));
      const archive = path.join(root, ".codex-tmp", "fixture.tar");
      fs.mkdirSync(path.dirname(archive));
      const made = spawnSync("tar", ["-cf", archive, ...excludes.map(item => `--exclude=${item}`),
        "-C", root, ...listReleaseRootEntries(root)], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(made.status, 0, made.stderr);
      const listed = spawnSync("tar", ["-tf", archive], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(listed.status, 0, listed.stderr);
      const entries = listed.stdout.split(/\r?\n/).map(item => item.replace(/^\.\//, ""));
      assert.ok(entries.includes("src/outputs/decision.ts"), JSON.stringify(entries));
      assert.ok(entries.includes("server/outputs/policy.cjs"));
      assert.equal(entries.includes("outputs/result.json"), false);
    });
    return { ok: true, verifier: "release-workspace-freshness-v1", checks, productionWrites: 0, networkCalls: 0 };
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^football-freshness-policy-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyReleaseWorkspaceFreshness };
if (require.main === module) console.log(JSON.stringify(verifyReleaseWorkspaceFreshness(), null, 2));
