"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const build = require("./frontendBuildEvidence.cjs"), { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
function verify() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-frontend-build-evidence-"));
  fs.chmodSync(temp, 0o700); const checks = []; let count = 0;
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  function fixture({ tsc = "", vite = "", strip = "" } = {}) {
    const root = path.join(temp, "build-" + ++count); fs.mkdirSync(root, { mode: 0o700 });
    const write = (name, body) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); };
    write("package.json", JSON.stringify({ scripts: { build: build.BUILD_SCRIPT } })); write("package-lock.json", "{}");
    write("src/App.tsx", "original source"); write("server/untouched.cjs", "module.exports=1");
    write("node_modules/typescript/bin/tsc", tsc || "require('node:fs').mkdirSync('node_modules/.tmp',{recursive:true});require('node:fs').writeFileSync('node_modules/.tmp/tsconfig.app.tsbuildinfo','synthetic fixture cache');");
    write("node_modules/vite/bin/vite.js", vite || "const fs=require('node:fs');fs.mkdirSync('dist/assets',{recursive:true});fs.writeFileSync('dist/index.html','<script src=\"/assets/index-bbbbbbbb.js\"></script>');fs.writeFileSync('dist/assets/index-bbbbbbbb.js','new fixture asset');");
    write("scripts/stripLargeStaticPayloads.cjs", strip || "// synthetic no-op strip fixture, not a real Vite build proof\n");
    const baselineDir = path.join(temp, "baseline-" + count); fs.mkdirSync(path.join(baselineDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(baselineDir, "index.html"), '<script src="/assets/index-aaaaaaaa.js"></script>');
    fs.writeFileSync(path.join(baselineDir, "assets/index-aaaaaaaa.js"), "old fixture asset");
    return { root, write, baseline: inspectPrebuiltDist(baselineDir) };
  }
  const execute = f => build.executeFrontendBuild({ rootDir: f.root, baselineDist: f.baseline, baselineReleaseSha256: "a".repeat(64) });
  try {
    check("actual three child processes finish before an evidence record is returned", () => {
      const f = fixture(), result = execute(f); assert.equal(result.version, build.VERSION);
      assert.equal(result.runs.length, 3); assert.ok(result.runs.every(r => r.status === 0 && !r.error && !r.signal));
      assert.equal(result.deploymentAuthorized, false); assert.equal(result.productionWrites, null);
      assert.equal(result.signingEligible, false); assert.equal(result.descendantsQuiescent, null);
      assert.equal(result.externalInputIsolation, false); assert.equal(result.executionAssurance, "unsandboxed-direct-children-only");
      assert.equal(result.baseline.releaseSha256, "a".repeat(64)); assert.equal(result.baseline.distTreeHash, f.baseline.treeHash);
      assert.equal(result.overlay.newAssets.length, 1); assert.deepEqual(result.overlay.deletes, []);
      assert.equal(result.cacheOutputs.length, 1); assert.equal(result.builderPolicies.length, 2);
    });
    check("unreviewed package command or lifecycle hook is rejected before execution", () => {
      const f = fixture(); f.write("package.json", JSON.stringify({ scripts: { build: "node arbitrary.cjs" } })); assert.throws(() => execute(f), /unreviewed-build-command/);
      f.write("package.json", JSON.stringify({ scripts: { build: build.BUILD_SCRIPT, prebuild: "node arbitrary.cjs" } })); assert.throws(() => execute(f), /unreviewed-build-command/);
    });
    check("a failed child preserves bounded diagnostics and never yields evidence", () => {
      const f = fixture({ tsc: "console.error('expected fixture compiler failure');process.exitCode=23;" });
      assert.throws(() => execute(f), e => e.message.includes("command-failed") && e.evidence.runs[0].status === 23 && e.evidence.stderr.includes("expected fixture"));
    });
    check("source mutation during an otherwise successful build is rejected", () => {
      const f = fixture({ tsc: "require('fs').writeFileSync('server/untouched.cjs','changed runtime');" }); assert.throws(() => execute(f), /input-drift/);
    });
    check("dependency mutation during build is rejected", () => {
      const f = fixture({ strip: "require('fs').appendFileSync('node_modules/typescript/bin/tsc','\\n// changed dependency');" }); assert.throws(() => execute(f), /input-drift/);
    });
    check("pre-existing compiler state cannot silently influence a fresh build proof", () => {
      const f = fixture(); f.write("node_modules/.tmp/tsconfig.app.tsbuildinfo", "untrusted old cache"); assert.throws(() => execute(f), /preexisting-build-cache/);
    });
    check("pre-existing dist cannot be an excluded hidden build input", () => {
      const f = fixture(); f.write("dist/previous-output.json", "hidden input"); assert.throws(() => execute(f), /fresh-empty-build-output-required/);
    });
    check("baseline duplicates, malformed digests and unbound tree hashes are rejected", () => {
      const f = fixture(), duplicate = structuredClone(f.baseline); duplicate.files.push(duplicate.files[0]); duplicate.fileCount++;
      assert.throws(() => build.validateDistManifest(duplicate), /duplicate-or-unordered/);
      const changed = structuredClone(f.baseline); changed.files[0].sha256 = "c".repeat(64);
      assert.throws(() => build.validateDistManifest(changed), /tree-hash-mismatch/);
      changed.files[0].sha256 = "not-sha256"; assert.throws(() => build.validateDistManifest(changed), /invalid-overlay-dist-row/);
      assert.throws(() => build.executeFrontendBuild({ rootDir: f.root, baselineDist: f.baseline }), /baseline-release-sha256-required/);
    });
    check("unreviewed dependency cache output is not silently excluded", () => {
      const f = fixture({ strip: "require('fs').writeFileSync('node_modules/.tmp/injected.js','bad');" }); assert.throws(() => execute(f), /unexpected-or-preexisting-build-cache/);
    });
    check("new runtime or generated data files cannot be hidden by output exclusions", () => {
      const f = fixture(), before = build.snapshotBuildInputs(f.root); f.write("public/data/current.json", "{}");
      assert.notEqual(build.snapshotBuildInputs(f.root).sourceHash, before.sourceHash);
    });
    check("non-asset dist changes reject the overlay route", () => {
      const f = fixture({ strip: "require('fs').writeFileSync('dist/robots.txt','changed outside UI asset route');" }); assert.throws(() => execute(f), /non-overlay-artifact-change/);
    });
    check("same immutable asset filename cannot change its content", () => {
      const f = fixture({ strip: "require('fs').writeFileSync('dist/assets/index-aaaaaaaa.js','collision');" }); assert.throws(() => execute(f), /immutable-asset-name-collision/);
    });
    check("old content-hashed assets absent from new output are retained, never deleted", () => {
      const f = fixture(); const r = execute(f);
      assert.equal(r.overlay.retainPreviousAssets, true); assert.deepEqual(r.overlay.deletes, []);
    });
    check("execution environment removes inherited injectors and limits base path", () => {
      const f = fixture(), env = build.buildEnvironment(f.root); assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.NODE_PATH, undefined); assert.equal(env.VITE_BASE_PATH, "/"); assert.equal(env.ADMIN_TOKEN, undefined);
    });
    check("npm root and nested package bin aliases are narrowly accepted", () => {
      for (const [relative, target] of [
        ["node_modules/.bin/tsc", "node_modules/typescript/bin/tsc"],
        ["node_modules/@typescript-eslint/typescript-estree/node_modules/.bin/semver", "node_modules/@typescript-eslint/typescript-estree/node_modules/semver/bin/semver.js"],
        ["node_modules/one/node_modules/@scope/two/node_modules/.bin/tool", "node_modules/three/bin/tool.js"],
      ]) assert.doesNotThrow(() => build.validateBuildBinAlias(relative, target));
    });
    check("nested aliases cannot authorize arbitrary links, hidden cache targets or escaped source", () => {
      for (const [relative, target] of [
        ["src/.bin/tool", "node_modules/one/tool.js"],
        ["node_modules/one/.bin/tool", "node_modules/one/tool.js"],
        ["node_modules/.cache/node_modules/.bin/tool", "node_modules/one/tool.js"],
        ["node_modules/.bin/tool/nested", "node_modules/one/tool.js"],
        ["node_modules/.bin/tool", "src/main.tsx"],
        ["node_modules/.bin/tool", "node_modules/one/node_modules/.tmp/injected.js"],
        ["node_modules/.bin/tool", "node_modules/one/../outside.js"],
        ["node_modules/.bin/tool", "../node_modules/one/tool.js"],
      ]) assert.throws(() => build.validateBuildBinAlias(relative, target));
    });
    check("timeouts and nonprivate roots cannot be caller-selected without bounds", () => {
      const f = fixture(); assert.throws(() => build.executeFrontendBuild({ rootDir: f.root, baselineDist: f.baseline, timeoutMs: 0 }), /invalid-build-timeout/);
      if (process.platform !== "win32") { fs.chmodSync(f.root, 0o755); assert.throws(() => execute(f), /private-build-root/); }
    });
    return { ok: true, verifier: build.VERSION, checks, productionWrites: 0, providerRequests: 0,
      realChildProcesses: true, actualViteBuild: false,
      scope: "controlled synthetic compiler fixtures for lifecycle/input/output contracts; real dependency install and Vite build proof required separately" };
  } finally {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(temp), /^football-frontend-build-evidence-/); fs.rmSync(temp, { recursive: true });
  }
}
module.exports = { verify };
if (require.main === module) { try { console.log(JSON.stringify(verify(), null, 2)); } catch (e) { console.error(e.stack); process.exitCode = 1; } }
