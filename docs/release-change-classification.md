# Release change classification

This is a **classification and evidence API, not an activated fast deployment**.
Every returned plan has `executionMode: "full"`, `fastPathActivated: false`, and
`skippedStages: []`. A `frontend-only` classification does not authorize skipping
tests, model work, database publication, service recovery or live acceptance.

## Inputs and trust boundary

`scripts/releaseChangeClassification.cjs` compares two **complete, sealed,
extracted release trees**. It does not inspect `git diff`, trust timestamps, omit
untracked files, accept caller exclusions, or ignore generated JSON. All regular
files and directories, including empty directories, are inventoried. A raw
worktree with `node_modules`, live data symlinks or output files is not a substitute
for the exact extracted archive tree.

For each side the caller supplies:

```js
{
  root: "/absolute/immutable/extracted-release",
  inventory, // captureReleaseSourceInventory(root)
  buildBinding, // optional; missing means no frontend-only classification
  authenticatedIdentity: {
    releaseSha256,    // actual archive SHA, matched to verified detached signature
    inventorySha256,  // inventory.treeHash, authenticated by that release signature
    buildBindingSha256, // SHA256(JSON.stringify(buildBinding)), authenticated too
  },
}
```

`classifyReleaseChanges({ baseline, candidate })` never interprets an untrusted
`authenticated: true` or `complete: true` flag. The exact authenticated identity
fields must be passed separately from the inventory being checked. It validates
the inventory schema/hash, rescans actual files, and compares the complete result.
The API does **not** verify a signature itself: only a trusted caller that already
verified the archive, signature, current live release marker, and extraction
membership may construct `authenticatedIdentity`. Supplying arbitrary matching
hashes to this API is not a trust bootstrap.

Existing production releases sign archive SHA/bytes and an archive entry count,
plus a separate prebuilt dist commitment. The new creator integration described
in [release-archive-source-inventory.md](release-archive-source-inventory.md) signs
the complete actual archive inventory, but **source-to-build binding remains
unavailable**. A count alone cannot prove which entries are present. Legacy
baselines and missing build evidence return `full`; never fabricate missing
historical proof from the currently mutable application directory.

## Browser boundary and actual repository audit

The versioned policy lists exact current `src/pages/*.tsx`, `src/components/*`
browser modules, the existing stylesheets, `src/App.tsx`, and `src/main.tsx`.
It is an explicit list, not `src/**`, `public/**`, arbitrary `.tsx`, or arbitrary
`.css`. A newly introduced page is unknown until the policy is reviewed and
updated in a full release.

The current `src/main.tsx` mounts React and imports the browser styles and App.
`vite.config.ts` builds the browser bundle and copies/filters public artifacts.
Inspection of `server`, `src/services`, `src/data` and the production worker's
imports found shared policy/data modules, not imports of pages or components.
References to pages/components under `scripts` are predominantly tests and
release-contract readers. Importantly, some tests **execute** those UI modules:
`verifyLegacyReferenceConflict.cjs`, `verifyMatchDetailLifecycle.cjs` and review
test loaders. UI-only is therefore not “all tests unaffected.” Frontend semantic,
recommendation-boundary, accessibility, and browser tests must still run.

This inspection is not a sound whole-program proof of all dynamic module loads,
subprocess entrypoints or future code. Plans explicitly retain
`audited-runtime-entrypoint-and-ui-dependency-boundary` as an activation
requirement. A future fast executor must enforce a reviewed runtime closure and
invalidate its attestation when any loader/entrypoint/manifest/lockfile changes.
Do not promote this structural classification alone into an execution policy.

The following always require the full route:

- `server/`, `scripts/`, `deploy/`, shared `src/services/`, `src/context/`,
  `src/data/`, model and database files.
- Dependencies, lockfiles, build configuration, runtime settings, permissions,
  directory/type changes outside derived artifacts, or unreviewed paths.
- All changed `public/data/*`, `public/matches.json`, `public/odds-history.json`
  and `.release-model-assets/*`, even when a UI file also changes.
- Arbitrary new assets or unknown paths anywhere. Root and nested `outputs`
  paths are not omitted by this scanner.

An unchanged generated file is inventoried and compared, not ignored. A changed
generation is not classified as harmless because of its filename. A future
release that separates source from generation can reuse the unchanged immutable
generation only with explicit generation/adoption/compatibility evidence; that
separate transaction has not been implemented here.

## Derived frontend artifacts are separate evidence

Normal page edits change content-hashed JS/CSS filenames, `dist/index.html`, and
the `.release-prebuilt/dist-manifest.json`. Those changes can participate in a
`frontend-only` plan instead of invariably forcing full, but **only when both
releases carry an authenticated build binding**.

`buildFrontendBinding(inventory, { nodeSha256, nodeVersion, buildEnvironmentHash })`
constructs the canonical bytes for a trusted builder to authenticate. It binds:

- Every non-artifact inventory row as `sourceTreeHash`; this includes shared
  source, unknown files and generated source inputs, not just changed UI paths.
- Every `dist` row and the exact dist manifest as `artifactTreeHash`.
- Exact package/lockfile/Vite/static-stripping input rows as `dependencyHash`.
- Node binary/version, a non-secret environment commitment, exact build command
  `npm run build`, and successful exit code.

The caller must calculate its environment commitment from the complete reviewed
build input environment (including `VITE_*`, build plugins and external tool
identities). Never print secrets; do not substitute a constant “production” flag.
The builder must execute the actual command successfully, prove source inputs
unchanged before/after the build, then sign the binding. This pure constructor
does not run the build or turn a caller-supplied success claim into evidence.

Classification additionally runs the existing real `verifyPrebuiltDist` check
against both trees. A stale dist manifest, replayed binding, changed runtime or
build environment, missing inputs, or unexplained artifact-only change returns
full. Unknown entries under `.release-prebuilt/` are not automatically artifacts.

## Required integration sequence

1. After actual frontend build, preserve pre/post input identity and capture the
   exact staging tree that will be archived. Include the inventory and binding in
   the **detached signed metadata**, not in the inventoried tree (avoid circular
   hashes). Do not scan a different pre-exclusion workspace.
2. Verify archive signature/SHA and exact member inventory before extraction.
   Reject tar aliases/duplicates/links and extraction traversal before invoking
   this filesystem scanner: a filesystem cannot reveal tar entries overwritten
   earlier during unsafe extraction.
3. Preserve the authenticated original release tree/inventory for baseline
   comparison. The baseline identity must equal the actual live marker at plan
   calculation and at cutover; any changed marker invalidates the plan.
4. Produce and save the deterministic plan with both release identities,
   inventory hashes, policy hash, complete changed rows, reasons and `planHash`.
   Missing evidence returns full, without failing an otherwise valid full release.
5. First deploy this classification in observation mode and record route reasons.
   Only after runtime closure, retained gates and a distinct UI cutover/rollback
   implementation have tests should execution use the `frontend-only` route.
   The new route should leave model/data/service state untouched where compatible,
   retain current live data consistency checks, and run real mobile/desktop and
   protected/public endpoint acceptance. This document does not activate it.

## Bounds and limitations

Capture rejects symlinks (including root/ancestors), hard-linked files, special
files, unsafe/non-canonical paths, case aliases, malformed/duplicate/unsorted
inventory rows and missing parent directories. Limits are 20,000 entries,
128 MiB per file, 1 GiB total and depth 32. Files are streamed in 64 KiB chunks;
identity is checked before/after read, directory changes detected, and a second
complete scan must match. Size growth cannot induce an unbounded file read.

These checks do not provide filesystem isolation against a hostile concurrent
writer. The trusted caller must seal the trees and ownership before capture and
retain that seal through cutover; checksums do not replace that boundary.
Permissions are included, so differing platform extraction modes conservatively
require full. No deployment, external command, network operation, artifact write
or test skip is performed by the classification API.

Run the bounded real-filesystem verifier:

```text
node scripts/verifyReleaseChangeClassification.cjs
```

It covers a normal page/component/style + hashed-dist change, unchanged and
missing/legacy baselines, unreviewed/runtime/model/config/data changes, exact build
replay and tampering, actual stale manifests, omitted entries, malicious inventory
shapes, actual junction/symlink/hardlink rejection, a file mutated during read,
and an oversized sparse file. It does not prove an activated production fast
path or any wall-clock deployment saving.
