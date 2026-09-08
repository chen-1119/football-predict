"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { VERSION, validateFrontendAuthorization, compareAuthorizedFrontendSources } = require("./frontendReleaseAuthorization.cjs");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const H = "a".repeat(64), J = "b".repeat(64), clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
const check = (name, fn) => { try { fn(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: e.message }); } };
function inventory(entries) {
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const body = { version: "complete-release-tree-v1", entries, entryCount: entries.length,
    fileCount: entries.filter(row => row.kind === "file").length, totalBytes: entries.reduce((n, row) => n + (row.bytes || 0), 0) };
  return { ...body, treeHash: digest(body) };
}
const baseline = inventory([{ path: "src", kind: "directory", mode: 0o755 },
  { path: "src/App.css", kind: "file", mode: 0o644, bytes: 1, sha256: H },
  { path: "package.json", kind: "file", mode: 0o644, bytes: 1, sha256: H }]);
const nextRows = clone(baseline.entries); nextRows.find(row => row.path === "src/App.css").sha256 = J;
const candidate = inventory(nextRows);
const manifest = { releaseKind: "frontend-only", releaseSequence: 12, releaseActions: [],
  archiveSourceEvidence: { inventorySha256: candidate.treeHash }, frontendAuthorization: {
    version: VERSION, baseline: { runtimeSha256: H, runtimeSequence: 11, inventorySha256: baseline.treeHash,
      frontendStateSha256: H, indexSha256: H, distTreeHash: H }, candidateInventorySha256: candidate.treeHash,
    runtime: { nodeSha256: H, nodeVersion: "v22.22.1", dependencyLockSha256: H, buildDependencySha256: H, installedRuntimeSha256: H },
    policies: { authorizationSha256: H, runtimeBoundarySha256: H, sandboxSha256: H }, changedPaths: ["src/App.css"] } };
const compare = (m = manifest, before = baseline, after = candidate) => compareAuthorizedFrontendSources({ manifest: m, baselineInventory: before, candidateInventory: after });
check("legacy-full-remains-full", () => assert.deepEqual(validateFrontendAuthorization({}), { releaseKind: "full" }));
check("explicit-full", () => assert.deepEqual(validateFrontendAuthorization({ releaseKind: "full" }), { releaseKind: "full" }));
check("unknown-kind-not-fallback", () => assert.throws(() => validateFrontendAuthorization({ releaseKind: "ui" }), /unsupported/));
check("full-cannot-smuggle-ui-authorization", () => assert.throws(() => validateFrontendAuthorization({ frontendAuthorization: {} }), /must-not/));
check("valid-source-authorization-is-not-deployment-proof", () => { const r = compare(); assert.equal(r.deploymentAuthorized, false); assert.deepEqual(r.changedPaths, ["src/App.css"]); });
for (const [name, mutate] of [
  ["partial-contract", m => delete m.frontendAuthorization.runtime],
  ["extra-contract-field", m => { m.frontendAuthorization.ok = true; }],
  ["wrong-version", m => { m.frontendAuthorization.version = "build-complete"; }],
  ["rollback-sequence", m => { m.releaseSequence = 11; }],
  ["unsafe-node-version", m => { m.frontendAuthorization.runtime.nodeVersion = "v24.0.0"; }],
  ["missing-installed-dependencies", m => { m.frontendAuthorization.runtime.buildDependencySha256 = null; }],
  ["unbound-policy", m => { m.frontendAuthorization.policies.sandboxSha256 = "ok"; }],
  ["source-inventory-drift", m => { m.archiveSourceEvidence.inventorySha256 = J; }],
  ["tls-action-forbidden", m => { m.releaseActions = ["enable-ip-tls"]; }],
  ["unreviewed-path", m => { m.frontendAuthorization.changedPaths = ["src/services/api.ts"]; }],
  ["duplicate-path", m => { m.frontendAuthorization.changedPaths.push("src/App.css"); }],
  ["no-source-change", m => { m.frontendAuthorization.changedPaths = []; }],
  ["baseline-inventory-substitution", m => { m.frontendAuthorization.baseline.inventorySha256 = J; }],
]) check(name, () => { const m = clone(manifest); mutate(m); assert.throws(() => compare(m)); });
for (const [name, mutate] of [
  ["generated-non-ui-byte-change", rows => { rows.find(r => r.path === "package.json").sha256 = J; }],
  ["mode-change", rows => { rows.find(r => r.path === "src/App.css").mode = 0o755; }],
  ["new-path", rows => { rows.push({ path: "src/new.css", kind: "file", bytes: 1, sha256: H, mode: 0o644 }); }],
]) check(name, () => {
  const rows = clone(candidate.entries); mutate(rows); const changed = inventory(rows), m = clone(manifest);
  m.frontendAuthorization.candidateInventorySha256 = changed.treeHash; m.archiveSourceEvidence.inventorySha256 = changed.treeHash;
  assert.throws(() => compare(m, baseline, changed));
});
check("unchanged-input-is-not-ui-release", () => { const m = clone(manifest); m.frontendAuthorization.candidateInventorySha256 = baseline.treeHash;
  m.archiveSourceEvidence.inventorySha256 = baseline.treeHash; assert.throws(() => compare(m, baseline, baseline), /declared/); });
check("canonical-archive-inventory-hash-is-not-digest-including-treeHash", () => {
  assert.notEqual(candidate.treeHash, digest(candidate)); const m = clone(manifest);
  m.frontendAuthorization.candidateInventorySha256 = digest(candidate); m.archiveSourceEvidence.inventorySha256 = digest(candidate);
  assert.throws(() => compare(m), /commitment/);
});
const report = { ok: checks.every(c => c.ok), checks, productionWrites: 0, deploymentAuthorized: false };
console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
