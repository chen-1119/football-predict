# Source-authorized UI bundle construction

This path creates a signed **source package**, not a locally built UI or a
deployment. It changes only the exact reviewed FRONTEND_PATHS already present
in an authenticated original full-release archive. Other workspace edits,
including backend, worker, database, model, dependency and shared-code edits,
are not packaged and must not be described as deployed.

## Entry and inputs

Set RELEASE_KIND=frontend-only and use the existing createReleaseBundle.cjs
entry. Its first operation validates the kind and dispatches the fixed
createFrontendReleaseBundle.cjs child exactly once. Undefined/full retains the
full flow; empty/unknown/null kind is rejected. UI dispatch occurs before the
full live archive preflight, umbrella verifier chain, sequence reservation and
local build. The child status is preserved, and spawn failure is not success.

The independent child also accepts no command-line arguments and requires the
frontend-only environment. It requires Node v22.22.1.

Required source inputs:

- RELEASE_FRONTEND_BASELINE_BUNDLE: original full .tgz archive. Adjacent
  .manifest.json and .manifest.sig are mandatory.
- RELEASE_FRONTEND_STATE_PATH: exact bytes copied from the root-published
  accepted frontend state.
- RELEASE_FRONTEND_RUNTIME_PATH: root-published runtime binding JSON.

Existing RELEASE_SIGNING_PRIVATE_KEY / RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SITE,
RELEASE_CHANNEL, RELEASE_SEQUENCE_STATE_PATH, RELEASE_SEQUENCE,
RELEASE_MANIFEST_TTL_HOURS and RELEASE_BUNDLE_PATH configuration is retained.
No key is generated or installed. The externally configured RSA public key
must verify the original manifest and match the configured signing private key.
The original archived public key, if any, never bootstraps its own trust.

The callable interface is:

```js
const { createFrontendReleaseBundle } = require("./createFrontendReleaseBundle.cjs");
const result = await createFrontendReleaseBundle({
  workspaceRoot: "/absolute/reviewed/workspace",
  env: explicitEnvironment,
  now: new Date(),
});
```

Unknown options, success flags, arbitrary commands and build hooks are not
accepted. The optional clock is for controlled fixtures; actual CLI uses now.
The output artifact set remains exactly four files: .tgz, .tgz.sha256,
.tgz.manifest.json and .tgz.manifest.sig.

## What is verified and what is not

The original signature is checked over its exact bytes. A historical baseline
may be expired, but its manifest lifetime/identity/policy must still be valid.
The candidate gets a fresh lifetime and a newly reserved monotonic sequence.
Non-full baselines, legacy baselines without authenticated complete inventory,
nonempty release actions, action members, blockers and sensitive members are
rejected. r711 without signed inventory remains ineligible; reconstructing a
manifest or reproducing its dist cannot repair this trust boundary.

The supplied state must pass server/frontendReleaseIdentity.cjs parsing and be
accepted, with the same runtime SHA and sequence as the original full archive.
Its raw byte SHA, current index SHA and current dist-tree commitment are signed
into frontendAuthorization. For a full state, the index and dist commitments
must additionally match the original archive. A previous accepted frontend-only
state may have a newer index; it does not change the original full source
baseline. A candidate sequence must be newer than the current frontend sequence,
not merely the runtime sequence.

The runtime binding is exact:

```json
{
  "version": "frontend-runtime-binding-v1",
  "runtimeSha256": "<original full archive SHA>",
  "runtimeSequence": 1,
  "inventorySha256": "<complete inventory treeHash>",
  "runtime": {
    "nodeSha256": "<hash>",
    "nodeVersion": "v22.22.1",
    "dependencyLockSha256": "<original package-lock.json hash>",
    "buildDependencySha256": "<hash>",
    "installedRuntimeSha256": "<hash>"
  },
  "policies": {
    "authorizationSha256": "<hash>",
    "runtimeBoundarySha256": "<hash>",
    "sandboxSha256": "<hash>"
  }
}
```

Duplicate keys (including escaped nested aliases), extra fields, malformed
hashes and identity/lock/version mismatches are rejected. Inventory commitments
use inventory.treeHash, not a second hash of the complete object including its
treeHash field.

These local JSON inputs are **not server authorization**. The server must
independently compare the current root-owned state, accepted receipt, original
baseline, runtime/dependencies and policy identities, then run the isolated
build for this invocation and inspect its real dist before publishing. This
constructor does not confirm current production state or grant deployment.

## Archive and source boundary

The original compressed archive is fully streamed through the strict archive
parser and checked against its signed compressed SHA, size and complete
inventory. Its only temporary representation is one private 0600 inert TAR
byte spool. There is no extracted application/source directory and no source,
package-manager, shell, TypeScript, Vite or strip execution.

The spool payload index handles already-validated USTAR, PAX and GNU long-name
metadata; every resulting payload must match its authenticated row. The writer
uses canonical USTAR headers and bounded gzip streaming. It keeps all
non-UI file bytes, member names, file/directory kinds and original mode bits,
including executable backend files, model assets and old dist. Paths that
cannot fit USTAR name/prefix byte limits are explicitly rejected, not truncated.
Timestamps, UID/GID and compression encoding are normalized; compressed bytes
and archive SHA therefore change.

Only existing allowed UI file contents can change. Added/deleted allowed paths,
non-plain files, hardlinks, symlink/junction ancestors and POSIX source mode
changes are rejected. Windows does not represent POSIX file modes faithfully:
its filesystem's simulated mode is not copied; archive row.mode remains the
authority and is preserved exactly. Other nonallowlisted workspace files are
not read into the package.

Per-UI-file reading is limited to 16 MiB and the total UI snapshot to 64 MiB.
Original archive limits remain 512 MiB compressed, 1 GiB ordinary payload,
20,000 members and 128 MiB per archive file, with separate bounded TAR metadata.
File metadata is checked before allocation; reads are nofollow and compare
descriptor/path identities before and after. Inputs are rechecked before
reservation and signature publication. Private TAR and output copies are
hashed/checked again; a fresh strict capture of the actual candidate must equal
the expected inventory and pass compareAuthorizedFrontendSources.

Signed original model/historical metadata is retained only when its entry hash
(and historical byte count) matches the authenticated inventory. The old
prebuilt dist inventory is recomputed from authenticated dist rows and must
match both its embedded manifest and signed metadata. This checks preservation,
not a repeat model validation or new frontend compilation. The retained old
dist is explicitly a baseline artifact, never claimed as the new source's
build output. No fabricated frontendBuildBinding is supplied.

## Publication, failure and recovery

All validation and candidate construction precede sequence reservation.
Automatic reservation advances above both the accepted frontend sequence and
the existing local high-water mark; concurrent conflicts fail without retry.
Explicit sequences must exceed both relevant boundaries. A late write failure
may consume its reserved sequence; that number is never reused or rolled back.

All four output names use exclusive creation; an existing file, sidecar,
symlink or concurrent creator is never overwritten. Archive bytes, checksum and
manifest are persisted before the detached signature bytes. Ordinary failures
remove only outputs created by this attempt after inode checks. A changed
cleanup target is retained with an error instead of being deleted.

The private stage contains only original.tar and candidate.tgz and is removed
on ordinary success/failure with exact membership, path and inode checks.
A killed process can leave a private inert spool or incomplete output. No
automatic broad cleanup/retry is performed; inspect the exact failed attempt.
The four-file set is not a filesystem-wide atomic transaction: consumers must
require a valid final detached signature and matching archive, not presence.

## Verification

Run only the affected suite:

```text
node scripts/verifyFrontendSourceBundle.cjs
```

The suite creates its own RSA key, tiny real archives, workspace and sequence
state under a new temporary directory. It tests actual signature/capture and
complete non-UI preservation; PAX/GNU inputs; state/runtime and inventory-hash
cross-contracts; action, mutation, path/mode, sparse-size and output collisions;
concurrent attempts; source drift; partial publication rollback; and early
dispatch without executing the full flow. Linux additionally verifies actual
POSIX-mode and symlink-parent rejection.

Tests do not read real signing keys, consume a real sequence, build the
application, install dependencies, access providers, alter production or deploy.

The retained report outputs/frontend-source-bundle-linux-1788865517220.json
records 24 passing checks on actual Linux/Node v22.22.1 as UID 1000. The suite
took 1.144 seconds (tiny fixtures, not real release packaging throughput); the
whole pinned SSH invocation took 1.731 seconds. The exact private /tmp fixture,
its RSA keys, fixture sequence states, spools and candidate archives were
removed. Source hashes were unchanged locally and remotely. Windows portable
checks passed 23 groups; that run makes no POSIX isolation claim.
