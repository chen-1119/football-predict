"use strict";

// This contract authenticates source for one isolated build. It never says that
// the candidate's old dist bytes are the result of that build, nor activates the
// older classifier's dual-build-binding contract.
const crypto = require("node:crypto");
const { validateInventory, FRONTEND_PATHS } = require("./releaseChangeClassification.cjs");
const VERSION = "source-authorized-frontend-v1";
const NODE_VERSION = "v22.22.1";
const HASH = /^[a-f0-9]{64}$/;
const allowed = new Set(FRONTEND_PATHS);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = object => hash(JSON.stringify(object));
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
  && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
const positive = value => Number.isSafeInteger(value) && value > 0;
const BASELINE_FIELDS = ["runtimeSha256", "runtimeSequence", "inventorySha256", "frontendStateSha256", "indexSha256", "distTreeHash"];
const RUNTIME_FIELDS = ["nodeSha256", "nodeVersion", "dependencyLockSha256", "buildDependencySha256", "installedRuntimeSha256"];
const POLICY_FIELDS = ["authorizationSha256", "runtimeBoundarySha256", "sandboxSha256"];

function validateFrontendAuthorization(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("frontend-manifest-object-required");
  const kind = Object.hasOwn(manifest, "releaseKind") ? manifest.releaseKind : "full";
  if (kind === "full") {
    if (Object.hasOwn(manifest, "frontendAuthorization")) throw new Error("full-release-must-not-have-frontend-authorization");
    return { releaseKind: "full" };
  }
  if (kind !== "frontend-only") throw new Error("unsupported-release-kind");
  const a = manifest.frontendAuthorization;
  if (!exact(a, ["version", "baseline", "candidateInventorySha256", "runtime", "policies", "changedPaths"])
    || a.version !== VERSION || !exact(a.baseline, BASELINE_FIELDS) || !exact(a.runtime, RUNTIME_FIELDS)
    || !exact(a.policies, POLICY_FIELDS) || !HASH.test(a.candidateInventorySha256 || "")) throw new Error("malformed-frontend-authorization");
  for (const key of BASELINE_FIELDS.filter(k => k !== "runtimeSequence")) if (!HASH.test(a.baseline[key] || "")) throw new Error("invalid-frontend-baseline-binding");
  if (!positive(a.baseline.runtimeSequence) || !positive(manifest.releaseSequence)
    || manifest.releaseSequence <= a.baseline.runtimeSequence) throw new Error("invalid-frontend-runtime-sequence");
  for (const key of RUNTIME_FIELDS.filter(k => k !== "nodeVersion")) if (!HASH.test(a.runtime[key] || "")) throw new Error("invalid-frontend-runtime-binding");
  if (a.runtime.nodeVersion !== NODE_VERSION) throw new Error("unsupported-frontend-node-version");
  for (const key of POLICY_FIELDS) if (!HASH.test(a.policies[key] || "")) throw new Error("invalid-frontend-policy-binding");
  if (!Array.isArray(a.changedPaths) || a.changedPaths.length < 1 || a.changedPaths.length > FRONTEND_PATHS.length
    || a.changedPaths.some((name, i) => typeof name !== "string" || !allowed.has(name) || i > 0 && name <= a.changedPaths[i - 1])) {
    throw new Error("frontend-changes-must-be-exact-reviewed-ordered-paths");
  }
  if (!manifest.archiveSourceEvidence || manifest.archiveSourceEvidence.inventorySha256 !== a.candidateInventorySha256
    || !Array.isArray(manifest.releaseActions) || manifest.releaseActions.length !== 0) throw new Error("frontend-source-or-action-binding-mismatch");
  return { releaseKind: kind, authorizationSha256: digest(a) };
}

function compareAuthorizedFrontendSources({ manifest, baselineInventory, candidateInventory }) {
  validateFrontendAuthorization(manifest);
  if (manifest.releaseKind !== "frontend-only") throw new Error("frontend-source-authorization-required");
  validateInventory(baselineInventory); validateInventory(candidateInventory);
  const a = manifest.frontendAuthorization;
  if (baselineInventory.treeHash !== a.baseline.inventorySha256 || candidateInventory.treeHash !== a.candidateInventorySha256) {
    throw new Error("frontend-complete-inventory-commitment-mismatch");
  }
  if (baselineInventory.entries.length !== candidateInventory.entries.length) throw new Error("frontend-file-membership-change");
  const changed = [];
  for (let i = 0; i < baselineInventory.entries.length; i++) {
    const before = baselineInventory.entries[i], after = candidateInventory.entries[i];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    // New/deleted paths, type changes, file modes, generated data, old dist,
    // dependencies, shared code and unknown entries are never UI overrides.
    if (before.path !== after.path || before.kind !== "file" || after.kind !== "file"
      || before.mode !== after.mode || !allowed.has(before.path)) throw new Error("change-outside-frontend-source-authorization");
    changed.push(before.path);
  }
  if (!changed.length || JSON.stringify(changed) !== JSON.stringify(a.changedPaths)) throw new Error("declared-frontend-source-changes-mismatch");
  return { version: VERSION, changedPaths: changed, baselineInventorySha256: a.baseline.inventorySha256,
    candidateInventorySha256: a.candidateInventorySha256, sourceAuthorizationSha256: digest(a),
    baselineArtifactEvidence: "authenticated-accepted-full-release-artifact-not-build-provenance",
    candidateArtifactEvidence: "requires-this-invocation-isolated-build", deploymentAuthorized: false };
}

module.exports = { VERSION, NODE_VERSION, BASELINE_FIELDS, RUNTIME_FIELDS, POLICY_FIELDS,
  validateFrontendAuthorization, compareAuthorizedFrontendSources };
