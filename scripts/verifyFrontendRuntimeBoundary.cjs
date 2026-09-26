"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureReleaseSourceInventory } = require("./releaseChangeClassification.cjs");
const { ENTRYPOINTS, parseNpmCommand, inspectFrontendRuntimeBoundary, compareFrontendRuntimeBoundary } = require("./frontendRuntimeBoundary.cjs");

function verifyFrontendRuntimeBoundary() {
  const startedAt = Date.now();
  const checks = [];
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-runtime-boundary-"));
  const originalRoot = path.resolve(__dirname, "..");
  const baselineRoot = path.join(fixtureRoot, "baseline"), candidateRoot = path.join(fixtureRoot, "candidate");
  fs.mkdirSync(baselineRoot);
  const copySource = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`fixture source symlink: ${from}`);
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (["node_modules", ".git", ".codex-tmp", "outputs"].includes(name)) continue;
        copySource(path.join(from, name), path.join(to, name));
      }
    } else if (stat.isFile() && /\.(cjs|js|mjs|ts|tsx|json|css|service|sh)$/.test(from) && stat.size <= 8 * 1024 * 1024) fs.copyFileSync(from, to);
  };
  const input = root => {
    const inventory = captureReleaseSourceInventory(root);
    return { root, inventory, authenticatedInventoryHash: inventory.treeHash };
  };
  const check = (name, run) => { run(); checks.push({ name, ok: true }); };
  try {
    for (const directory of ["server", "scripts", "src", "collectors", "deploy/light-server", "cloudflare/sync-trigger/src"]) {
      copySource(path.join(originalRoot, directory), path.join(baselineRoot, directory));
    }
    for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(originalRoot, file), path.join(baselineRoot, file));
    fs.cpSync(baselineRoot, candidateRoot, { recursive: true });
    const baseline = input(baselineRoot);
    const observed = inspectFrontendRuntimeBoundary(baseline);
    check("actual current service/worker/monitor/cleanup source graph passes reviewed boundary", () => {
      assert.equal(observed.ok, true, JSON.stringify(observed.blockers));
      assert.ok(observed.files.length > 100);
      assert.ok(observed.npmEdges.length > 30);
      assert.equal(observed.dynamicImports.length, 1);
      assert.equal(observed.dynamicImports[0].target, "cloudflare/sync-trigger/src/sportteryCollector.js");
      assert.ok(observed.files.some(row => row.path === "cloudflare/sync-trigger/src/sportteryCollector.js"));
      assert.equal(observed.workers.length, 1);
      assert.ok(observed.files.some(row => row.path === "server/publicationResolverWorker.cjs"));
      assert.ok(observed.files.some(row => row.path === "scripts/publishOfficialResultsFast.cjs"));
      for (const file of ["scripts/syncDailyPrematchApi.cjs", "scripts/syncApiFootballData.cjs", "scripts/dailyFeaturedComboLedger.cjs", "scripts/runMarketCollector.cjs", "scripts/runRecommendationSettlement.cjs"])
        assert.ok(observed.files.some(row => row.path === file), `missing runtime closure: ${file}`);
      assert.ok(observed.commands.some(row => row.file === "scripts/syncDailyPrematchApi.cjs" && row.api === "spawnSync"));
      assert.equal(observed.imports.some(row => /^src\/(pages|components)\//.test(row.target)), false);
      assert.equal(observed.externalRuntimeAttestationRequired, true);
    });
    const changed = (relative, transform, action) => {
      const target = path.join(candidateRoot, relative);
      const prior = fs.existsSync(target) ? fs.readFileSync(target) : null;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, transform(prior?.toString("utf8") || ""));
      try { action(input(candidateRoot)); }
      finally { if (prior) fs.writeFileSync(target, prior); else fs.unlinkSync(target); }
    };
    const rejected = candidate => {
      const result = compareFrontendRuntimeBoundary({ baseline, candidate });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(result.blockers.length > 0);
      assert.equal(result.fastPathActivated, false);
    };
    const unreviewed = candidate => {
      const inspection = inspectFrontendRuntimeBoundary(candidate);
      assert.equal(inspection.ok, false, "mutated input must itself reject, not merely differ from baseline");
      rejected(candidate);
    };
    check("warm parse cache rechecks local import resolution when a higher-priority file appears", () => {
      changed("server/boundary-cache-fixture.js", () => "module.exports = {};\n", () => {
        changed("server/index.cjs", text => `${text}\nrequire('./boundary-cache-fixture');\n`, candidate => {
          assert.equal(inspectFrontendRuntimeBoundary(candidate).ok, true);
          changed("server/boundary-cache-fixture.cjs", () => "require('../src/pages/PredictionsList.tsx');\n", replacement => {
            const warm = inspectFrontendRuntimeBoundary(replacement);
            assert.equal(warm.ok, false, "warm cached resolution must not hide newly reachable UI code");
            assert.ok(warm.blockers.some(reason => reason.includes("runtime-ui-boundary-overlap")));
          });
          changed("server/boundary-cache-fixture.cjs", () => "module.exports = { changedTarget: true };\n", replacement => {
            const warm = inspectFrontendRuntimeBoundary(replacement);
            assert.equal(warm.ok, true);
            assert.ok(warm.imports.some(row => row.specifier === "./boundary-cache-fixture" && row.target.endsWith(".cjs")));
            const modulePath = require.resolve("./frontendRuntimeBoundary.cjs"), originalModule = require.cache[modulePath];
            delete require.cache[modulePath];
            try {
              const cold = require(modulePath).inspectFrontendRuntimeBoundary(replacement);
              assert.deepEqual(warm, cold, "cache history must not change resolved edges or acceptance evidence");
            } finally { require.cache[modulePath] = originalModule; }
          });
          const fallback = inspectFrontendRuntimeBoundary(input(candidateRoot));
          assert.equal(fallback.ok, true);
          assert.ok(fallback.imports.some(row => row.specifier === "./boundary-cache-fixture" && row.target.endsWith(".js")));
        });
      });
    });
    check("real page-only mutation preserves exact runtime closure without activating deployment", () => {
      changed("src/pages/PredictionsList.tsx", text => `${text}\n// UI-only fixture change\n`, candidate => {
        const result = compareFrontendRuntimeBoundary({ baseline, candidate });
        assert.equal(result.ok, true, JSON.stringify(result.blockers));
        assert.equal(result.fastPathActivated, false);
        assert.equal(result.externalRuntimeAttestationRequired, true);
        assert.notEqual(baseline.inventory.treeHash, candidate.inventory.treeHash);
      });
    });
    check("shared policy source mutation invalidates unchanged closure even if parseable", () => {
      changed("src/services/matchLifecycle.cjs", text => `${text}\n// changed shared runtime source\n`, rejected);
    });
    check("service launcher drift and new unit entrypoints reject", () => {
      changed("deploy/light-server/football-predict.service", text => text.replace("server/index.cjs", "src/pages/PredictionsList.tsx"), unreviewed);
      changed("deploy/light-server/unknown.service", () => "[Service]\nExecStart=/bin/true\n", unreviewed);
      changed("deploy/light-server/football-predict.service", text => text.replace("[Service]", "[Service]\nExecStartPre=/bin/sh -c unknown"), unreviewed);
      changed("deploy/light-server/football-sync-worker.service", text => text.replace("MemoryHigh=5G", "MemoryHigh=7G"), unreviewed);
      changed("deploy/light-server/football-sync-worker.service", text => text.replace("MemoryMax=6G", "MemoryMax=7G"), unreviewed);
      changed("deploy/light-server/football-postgres-backup.sh", text => `${text}\n# unreviewed operational source\n`, unreviewed);
      changed("deploy/light-server/football-daily-prematch.service", text => text.replace("scripts/syncDailyPrematchApi.cjs", "scripts/unknown.cjs"), unreviewed);
      changed("scripts/syncDailyPrematchApi.cjs", text => text.replace("'scripts/syncApiFootballData.cjs'", "'scripts/unknown.cjs'"), unreviewed);
    });
    check("actual direct require of a UI module is detected as overlap", () => {
      changed("server/index.cjs", text => `${text}\nrequire('../src/pages/PredictionsList.tsx');\n`, candidate => {
        assert.ok(inspectFrontendRuntimeBoundary(candidate).blockers.some(reason => reason.includes("runtime-ui-boundary-overlap")));
        rejected(candidate);
      });
    });
    check("literal dynamic import and static export edges cannot hide UI overlap", () => {
      changed("server/index.cjs", text => `${text}\nimport('../src/components/Navbar.tsx');\n`, rejected);
      changed("server/index.cjs", text => `${text}\nexport * from '../src/components/Navbar.tsx';\n`, rejected);
    });
    check("unreviewed dynamic import, require alias and VM loader reject", () => {
      changed("server/index.cjs", text => `${text}\nimport(process.env.UNKNOWN_MODULE);\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst loadAnything = require; loadAnything('../src/pages/PredictionsList.tsx');\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nrequire('node:vm');\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst evaluator = eval; evaluator('code');\n`, unreviewed);
    });
    check("versioned Sporttery import proof rejects target or enclosing-function edits", () => {
      changed("scripts/syncServerDirectSportteryEvidence.cjs", text => text.replace('"sportteryCollector.js"', '"otherCollector.js"'), unreviewed);
      changed("scripts/syncServerDirectSportteryEvidence.cjs", text => text.replace("await import(collectorUrl)", "await import(process.env.COLLECTOR_OVERRIDE || collectorUrl)"), unreviewed);
    });
    check("actual publication worker target, binding and constructor changes reject", () => {
      changed("server/index.cjs", text => text.replace('"publicationResolverWorker.cjs"', '"unknownWorker.cjs"'), unreviewed);
      changed("server/index.cjs", text => `${text}\nnew Worker(process.env.WORKER, { eval: true });\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst ArbitraryWorker = Worker;\n`, unreviewed);
      changed("server/publicationResolverWorker.cjs", text => text.replace("parentPort, workerData", "parentPort, workerData, Worker"), unreviewed);
    });
    check("new dynamic process command fails even when aliased from child_process", () => {
      changed("server/index.cjs", text => `${text}\nconst { spawn: launchUnknown } = require('node:child_process');\nlaunchUnknown(process.env.COMMAND, []);\n`, candidate => {
        assert.ok(inspectFrontendRuntimeBoundary(candidate).blockers.some(reason => reason.includes("unreviewed-process-command")));
        rejected(candidate);
      });
    });
    check("namespace, computed and inline process loaders reject unknown call sites", () => {
      changed("server/index.cjs", text => `${text}\nconst cp = require('node:child_process'); cp.spawn(process.env.CMD, []);\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst cp = require('node:child_process'); cp[process.env.API]('command');\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nrequire('node:child_process').exec('anything');\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst launch = spawn; launch(process.env.CMD, []);\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nconst launch = require('node:child_process').spawn; launch('anything');\n`, unreviewed);
    });
    check("unrelated shadowed identifiers and object exec methods are not subprocess edges", () => {
      changed("server/index.cjs", text => `${text}\nfunction harmless(spawn) { return spawn; }\nconst unrelated = { exec() {} }; unrelated.exec();\n`, candidate => {
        const inspection = inspectFrontendRuntimeBoundary(candidate);
        assert.equal(inspection.ok, true, JSON.stringify(inspection.blockers));
        rejected(candidate); // Still a runtime source change, never a UI release.
      });
    });
    check("reviewed command adapter mutation invalidates its source commitment", () => {
      changed("scripts/runSyncWorker.cjs", text => text.replace("const child = spawn(command, args, {", "const child = spawn(process.env.OVERRIDE || command, args, {"), rejected);
    });
    check("unchanged generic process adapter cannot authorize a new dynamic wrapper caller", () => {
      changed("server/index.cjs", text => `${text}\nrunCommand(process.env.UNKNOWN_EXECUTABLE, process.env.UNKNOWN_ARGUMENTS);\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nrunCommand('node', ['src/pages/PredictionsList.tsx']);\n`, unreviewed);
    });
    check("node loader injection and shell command mutation in npm graph reject", () => {
      changed("package.json", text => {
        const pkg = JSON.parse(text); pkg.scripts["model:backtest"] = "node --import ./loader.js scripts/runModelBacktest.cjs"; return JSON.stringify(pkg);
      }, rejected);
      changed("package.json", text => {
        const pkg = JSON.parse(text); pkg.scripts["sync:data"] = "node scripts/syncData.cjs; echo dangerous"; return JSON.stringify(pkg);
      }, rejected);
    });
    check("npm lifecycle hooks and local package loader scope are actual dependency edges", () => {
      changed("package.json", text => {
        const pkg = JSON.parse(text); pkg.scripts["premodel:backtest"] = "node scripts/cleanupServerArtifacts.cjs"; return JSON.stringify(pkg);
      }, candidate => {
        const inspection = inspectFrontendRuntimeBoundary(candidate);
        assert.equal(inspection.ok, true, JSON.stringify(inspection.blockers));
        assert.ok(inspection.npmEdges.some(row => row.name === "premodel:backtest" && row.invokedName === "model:backtest"));
        rejected(candidate);
      });
      changed("cloudflare/sync-trigger/package.json", () => JSON.stringify({ type: "commonjs" }), candidate => {
        assert.ok(inspectFrontendRuntimeBoundary(candidate).files.some(row => row.path === "cloudflare/sync-trigger/package.json"));
        rejected(candidate);
      });
      changed(".npmrc", () => "script-shell=/unreviewed/loader\n", unreviewed);
    });
    check("unchanged command graph cannot conceal dependency manifest or lock drift", () => {
      changed("package.json", text => { const pkg = JSON.parse(text); pkg.name = "different-package"; return JSON.stringify(pkg); }, rejected);
      changed("package-lock.json", text => { const lock = JSON.parse(text); lock.packages["node_modules/typescript"].version = "6.0.999"; return JSON.stringify(lock); }, rejected);
    });
    check("unresolved source import and undeclared package reject", () => {
      changed("server/index.cjs", text => `${text}\nrequire('./unobserved-file.cjs');\n`, rejected);
      changed("server/index.cjs", text => `${text}\nrequire('unreviewed-package');\n`, rejected);
    });
    check("authenticated inventory mismatch and source changed after capture reject", () => {
      rejected({ ...baseline, authenticatedInventoryHash: "0".repeat(64) });
      const captured = input(candidateRoot);
      changed("server/index.cjs", text => `${text}\n// changed after capture\n`, () => rejected(captured));
    });
    check("filesystem-backed hardlink and root junction reject against a previously captured inventory", () => {
      const captured = input(candidateRoot), target = path.join(candidateRoot, "server/index.cjs"), link = path.join(fixtureRoot, "linked-runtime.cjs");
      fs.linkSync(target, link);
      try { unreviewed(captured); } finally { fs.unlinkSync(link); }
      const rootLink = path.join(fixtureRoot, "linked-root");
      fs.symlinkSync(candidateRoot, rootLink, process.platform === "win32" ? "junction" : "dir");
      try { unreviewed({ ...captured, root: rootLink }); } finally {
        if (process.platform === "win32") fs.rmdirSync(rootLink);
        else fs.unlinkSync(rootLink);
      }
    });
    check("runtime parse errors and unsupported import bindings reject", () => {
      changed("server/index.cjs", text => `${text}\nconst = invalid;\n`, unreviewed);
      changed("server/index.cjs", text => `${text}\nimport cp from 'node:child_process'; cp.spawn('anything');\n`, unreviewed);
    });
    check("caller cannot replace fixed entrypoints, parser or UI policy through options", () => {
      rejected({ ...baseline, entrypoints: [] });
      rejected({ ...baseline, parser: { version: "accept-any" } });
      assert.throws(() => { ENTRYPOINTS["football-predict.service"].script = "unknown.cjs"; }, TypeError);
    });
    check("pure parse cache preserves reproducible evidence and cannot be poisoned through outputs", () => {
      assert.equal(inspectFrontendRuntimeBoundary(baseline).evidenceHash, observed.evidenceHash);
      assert.throws(() => { observed.files[0].sha256 = "0".repeat(64); }, TypeError);
      assert.throws(() => { observed.imports.push({ target: "unknown" }); }, TypeError);
      assert.equal(inspectFrontendRuntimeBoundary(baseline).evidenceHash, observed.evidenceHash);
    });
    check("command parser supports actual multi-node jobs but rejects unknown forms", () => {
      assert.deepEqual(parseNpmCommand("node --expose-gc scripts/commitCurrentDataGeneration.cjs && node scripts/syncPostgresProjection.cjs --if-enabled").map(row => row.script),
        ["scripts/commitCurrentDataGeneration.cjs", "scripts/syncPostgresProjection.cjs"]);
      for (const command of ["npm run arbitrary", "node -e code", "node --require ./hook.cjs scripts/syncData.cjs", "node scripts/syncData.cjs | other", "node scripts/syncData.cjs $(other)", "node ../outside.cjs", "node scripts/syncData.cjs & other"]) {
        assert.throws(() => parseNpmCommand(command));
      }
    });
    return { ok: true, verifier: "frontend-runtime-boundary-v1", checks,
      observedCurrentRuntime: { fileCount: observed.files.length, moduleEdges: observed.imports.length,
        npmEdges: observed.npmEdges.length, commandSites: observed.commands.length, dynamicImports: observed.dynamicImports.length, workers: observed.workers.length,
        evidenceHash: observed.evidenceHash }, durationMs: Date.now() - startedAt, productionWrites: 0, networkCalls: 0, fastPathActivated: false };
  } finally {
    const resolved = fs.realpathSync(fixtureRoot);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^football-runtime-boundary-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyFrontendRuntimeBoundary };
if (require.main === module) console.log(JSON.stringify(verifyFrontendRuntimeBoundary(), null, 2));
