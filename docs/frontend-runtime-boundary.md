# Reviewed frontend/runtime source boundary

`scripts/frontendRuntimeBoundary.cjs` is one prerequisite for a future UI-only
release. It is not a deployment command, an authorization token, or a general
JavaScript whole-program proof. It never runs application scripts, npm jobs,
models, migrations, shell commands, or network requests.

## Contract

The trusted caller first authenticates the original full release's detached
signature, bundle identity, and complete archive source inventory. It extracts
that original tree into a sealed directory. It constructs a candidate from that
tree, applying only separately authorized browser source edits. Generated source
data must remain the original baseline bytes; this module does not authorize
replacing them with today's mutable production data.

```js
const { compareFrontendRuntimeBoundary } = require('./frontendRuntimeBoundary.cjs');
const evidence = compareFrontendRuntimeBoundary({
  baseline: {
    root: absoluteSealedOriginalRoot,
    inventory: authenticatedOriginalInventory,
    authenticatedInventoryHash: authenticatedOriginalInventory.treeHash,
  },
  candidate: {
    root: absoluteSealedCandidateRoot,
    inventory: authenticatedCandidateInventory,
    authenticatedInventoryHash: authenticatedCandidateInventory.treeHash,
  },
});
```

`authenticatedInventoryHash` must come from the caller's actual authentication
step. Supplying a matching hash is not itself authentication. The implementation
validates the complete-inventory schema and rereads each reachable file against
its recorded bytes and SHA-256. It rejects symlinked roots/parents, symlink or
hardlinked source files, missing files, unexpected size/hash changes, and source
growth during a bounded fd-based read. The caller must prevent concurrent tree
mutation and retain the original archive/signature; a mutable production
checkout is not an acceptable baseline.

`inspectFrontendRuntimeBoundary(input)` returns exact sorted source hashes,
module edges, npm command edges, subprocess call commitments, worker and dynamic
import commitments, external imports, a policy hash, and an evidence hash.
`compareFrontendRuntimeBoundary` requires both inspections to pass and their
entire runtime closure, package files, entrypoint policy and dependency evidence
to match. A real page-only edit may change the complete inventory hash without
changing the runtime closure. Any runtime/shared/dependency drift rejects.

Both APIs return `externalRuntimeAttestationRequired: true`. Comparison always
returns `fastPathActivated: false`, including when `ok` is true. An `ok` result
means only that this reviewed local-source boundary passed.

## Explicit reviewed policy

The policy is built in, immutable, versioned, and hashed. Callers cannot replace
entrypoints, parser settings, dynamic exceptions, or the UI allowlist via options.
Changing policy requires code review and a new trusted policy deployment; do not
silently regenerate hashes after a failing check.

| Source entrypoint | Runtime role |
| --- | --- |
| `server/index.cjs` | `football-predict.service` |
| `scripts/runSyncWorker.cjs --loop` | `football-sync-worker.service` |
| `scripts/checkServerRuntime.cjs` | `football-monitor.service` |
| `scripts/cleanupServerArtifacts.cjs` | `football-cleanup.service` |
| `deploy/light-server/football-postgres-backup.sh` | Existing fixed external backup unit |
| `deploy/light-server/football-postgres-cos-upload.sh` | Existing fixed external upload unit |

The six complete unit templates and two operational shell bodies are pinned by
reviewed LF-normalized source hashes. Their actual raw bytes are also included
in each runtime closure. One exact `ExecStart` per unit must match the fixed Node
22.22.1 executable/application path (or the two fixed external executables).
Unexpected unit names, changed launcher options, environment directives, extra
exec hooks, or changed pinned operational scripts reject. This does not inspect
the installed units/drop-ins or externally stored environment files.

The parser is TypeScript 6.0.3, with its actual parser binary SHA-256 and Node
22.22.1 pinned in the policy. The lockfile must agree with that parser version.
Static imports, exports, `require`, `require.resolve`, literal dynamic imports,
and lexical import binding identities are read from its AST. Relative source
imports must resolve to inventory members. Unknown runtime packages, missing
lockfile integrity, unsupported loaders, `eval`/`Function`, require aliases,
unreviewed subprocess aliases/namespace escapes, and computed commands reject.
Local package scope files are included in the closure. Unsupported npm loader
configuration rejects.

All literal strings matching npm script keys are conservatively treated as
possible command edges, including reviewed worker plan/wrapper labels. Direct
literal `runCommand(..., ["run", name])` edges are also parsed. Relevant npm
`pre`/`post` lifecycle hooks are included. Supported command syntax is only
`node`, reviewed memory/GC flags, an inventory-local `.cjs` script, simple literal
arguments, and optional `&&`-joined Node commands. New loader flags, arbitrary
executables, shell substitution/pipes/redirection, unknown script names, and
unresolvable targets reject. This over-approximates module-level references;
it does not purport to prove every function executes.

The exact browser allowlist is imported from
`releaseChangeClassification.cjs` (App/main, reviewed pages/components/styles).
Any runtime edge into those paths, `src/pages/`, `src/components/`, or CSS rejects.
`src/context`, shared services, server modules, scripts, dependency files and
configuration are not granted UI eligibility. A separate complete-tree change
classifier must still reject unknown/non-UI changes outside this closure.

### Narrow dynamic exceptions

1. `scripts/syncServerDirectSportteryEvidence.cjs` may execute exactly
   `import(collectorUrl)` from the pinned enclosing function deriving the URL
   for `cloudflare/sync-trigger/src/sportteryCollector.js`. That actual target
   joins the inspected source closure. Changed target derivation/function bytes
   or any other nonliteral module import rejects.
2. `server/index.cjs` may construct the pinned publication resolver Worker,
   passing `path.join(__dirname, "publicationResolverWorker.cjs")` from the
   reviewed function. Its actual worker source joins the closure. Only the
   observed `Worker` binding and that worker's `parentPort`/`workerData` binding
   are permitted; changed constructors, aliases or target functions reject.
3. Existing subprocess adapters are pinned by exact enclosing-function hashes.
   The existing `runCommand` callers are separately pinned: retaining a generic
   spawn adapter does not authorize adding an unreviewed dynamic caller.
   The existing `spawnImpl = spawn` test-injection parameter in
   `server/relayFastResultWatcher.cjs` has its own exact binding/function proof;
   `scripts/publishOfficialResultsFast.cjs` is explicitly included. No new
   subprocess adapter or alias is automatically allowed.

Function-policy hashes normalize CRLF to LF; source-inventory and closure hashes
never normalize source bytes. Thus a cross-platform line-ending change remains
a real baseline/candidate change.

## Remaining proof before activating UI-only releases

- Run this module/parser from trusted, pinned code, not a candidate-controlled
  `node_modules`, policy file, import path, or CLI. TypeScript is currently a
  production dependency; the signed-release source contract requires it in
  `dependencies`, requires the lockfile package not to be dev-only, and rejects
  a duplicate `devDependencies.typescript`. Production pruning therefore does
  not intentionally remove it, but that does not authenticate a particular
  installed parser. Prefer trusted build-side evidence plus a separately
  installed trusted verifier; copying only this one CJS file is insufficient.
- Authenticate complete inventories and verify an actual sealed build's
  source/artifact/toolchain binding. Neither this API nor a caller assertion of
  build success creates provenance. Legacy full releases missing the original
  authenticated inventory remain full-route only.
- Attest the actual installed service units/drop-ins, environment, Node/npm
  executables, lockfile-installed dependencies, PATH, and external binaries.
  Reviewed existing adapters use CURL/browser overrides, optional collector
  script parameters, and release-heartbeat capture-script parameters. This
  local-source inspection deliberately does not invent proof of those external
  values or arbitrary file/data-driven code execution. Preserve/verify their
  existing approved runtime contract; no UI release may introduce overrides.
- Keep generated public/data and other non-UI members unchanged in the build
  source, and do not overwrite live data/model/service state during UI deploy.
- The root-owned deployment helper must hold the shared release/recovery lock,
  preserve runtime identity separately from UI identity, bind original baseline
  and target hashes, append verified hashed assets, and atomically swap only
  the verified index with journaled rollback. Retain old lazy-loaded assets.
- UI build/smoke/access checks remain required. Passing this source boundary
  does not establish recommendation readiness or permit skipping live safety.

## Focused verification and cache behavior

Run with the reviewed Node runtime:

```text
node scripts/verifyFrontendRuntimeBoundary.cjs
```

The verifier copies actual workspace source into guarded temporary baseline and
candidate trees, inventories them, and exercises page-only, shared source,
service, dynamic-loader, npm/dependency, worker, alias, filesystem and mutation
cases. It performs no deployment, model/database work, network access, or
production writes. Counts are derived from the actual graph, not hardcoded as
success criteria. A fixture is complete for its own copied tree, not a claim to
be an authenticated production release.

Pure AST results are process-local cached by exact source hash, local package
scope, complete package commitment and policy. Every invocation still checks
actual file type/identity/bytes/hash; authentication and filesystem success are
never cached. Results and policy objects are deeply frozen so a caller cannot
poison subsequent comparisons. The cache is bounded and is not a release
checkpoint or persistent proof.
