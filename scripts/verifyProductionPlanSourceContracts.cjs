"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
const { classifyPredicate, inspectProductionPlanSourceContracts: inspect } = require("./productionPlanSourceContracts.cjs");
const root = path.resolve(__dirname, "..");
function verifyProductionPlanSourceContracts() {
  const checks = [], check = (name, action) => { action(); checks.push({ name, ok: true }); };
  const baseline = inspect(root), gateName = "bundle release path supports uncommitted candidate packages";
  const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n?/g, "\n");
  const plan = read("scripts/verifyProductionPlanCoverage.cjs");
  check("all 73 required current source predicates pass without runtime data", () => {
    assert.equal(baseline.ok, true); assert.ok(baseline.sourceOnlyChecks >= 73);
    assert.deepEqual(baseline.uncoveredRequired, []); assert.equal(baseline.productionWrites, 0); assert.equal(baseline.providerRequests, 0);
  });
  check("old literal outputs requirement reproduces r710's exact failing gate", () => {
    const legacy = inspect(root, { planSource: plan.replace('"...listReleaseRootEntries(rootDir)"', '"\\\"outputs\\\""') });
    assert.equal(legacy.ok, false); const failed = legacy.checks.filter(c => !c.ok);
    assert.equal(failed.length, 1); assert.equal(failed[0].name, gateName); assert.deepEqual(failed[0].missing, [['"outputs"']]);
  });
  for (const [name, file, from, to] of [
    ["missing real root selector", "scripts/createReleaseBundle.cjs", "...listReleaseRootEntries(rootDir)", '"./"'],
    ["root QA exclusions removed", "scripts/releaseWorkspaceFreshness.cjs", 'name !== "outputs"', 'true'],
    ["manifest signing removed", "scripts/createReleaseBundle.cjs", "signManifestBytes", "REMOVED_SIGNING"],
    ["rollback contract removed", "deploy/light-server/release-from-bundle.sh", "restore_app_tree_after_rollback", "REMOVED_ROLLBACK"],
  ]) check(`${name} still fails the actual plan contract`, () => {
    const source = read(file); assert.ok(source.includes(from));
    const report = inspect(root, { sources: { [file]: source.replaceAll(from, to) } });
    assert.equal(report.ok, false); assert.equal(report.checks.find(c => c.name === gateName).ok, false);
  });
  check("a previously required source gate cannot silently disappear into mixed classification", () => {
    const report = inspect(root, { planSource: plan.replace(`"${gateName}", hasAll`, `"${gateName}", runtimeOnly && hasAll`) });
    assert.equal(report.ok, false); assert.ok(report.uncoveredRequired.includes(gateName));
  });
  function classified(expression) {
    const ast = ts.createSourceFile("fixture.cjs", expression + ";", ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0);
    return classifyPredicate(ast.statements[0].expression, new Set(["source"]));
  }
  check("pure source predicates and lexically scoped callback parameters are eligible", () => {
    const c = classified('["x"].every(needle => source.includes(needle))');
    assert.equal(c.eligible, true); assert.deepEqual(c.sourceInputs, ["source"]);
  });
  for (const expression of ['false && liveOnly', '["x"].some(liveOnly => liveOnly) || liveOnly',
    'Date.now() > 0', 'Math.random() > 0', 'process.env.KEY', 'fetch("https://example.invalid")',
    'fs.readFileSync("private")', 'require("node:fs")', 'source["constructor"]',
    'source[dynamicKey]', '(source = "changed")', '(() => { return true; })()', 'new Function("return true")()'])
    check(`runtime or dynamic expression is excluded before execution: ${expression}`, () => assert.equal(classified(expression).eligible, false));
  check("runtime and mixed checks remain outside the early source proof", () => {
    assert.ok(baseline.mixedOrUnsupportedChecks >= 20);
    assert.ok(baseline.excluded.some(c => c.reasons.some(r => r.startsWith("unknown-input:"))));
  });
  return { ok: true, verifier: "production-plan-source-contracts-regression-v1", checks,
    actualSourceChecks: baseline.sourceOnlyChecks, excludedRuntimeOrUnsupported: baseline.mixedOrUnsupportedChecks,
    productionWrites: 0, providerRequests: 0 };
}
module.exports = { verifyProductionPlanSourceContracts };
if (require.main === module) console.log(JSON.stringify(verifyProductionPlanSourceContracts(), null, 2));
