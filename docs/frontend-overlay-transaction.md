# Frontend overlay file-transaction fixture

`scripts/frontendOverlayTransaction.cjs` deliberately exposes **only** `createFrontendOverlayFixtureAdapter()`. It creates its own new private Linux temporary directory; callers cannot select an application or production dist path. There is no CLI, signature validator, credential handler, production authorization entry point, service/worker operation or data publication action.

The filesystem algorithm is separate from this fixture adapter in an unexported `applyLocked` function. A future fixed root authorizer can reuse the algorithm only after separately supplying authenticated release/build evidence, a protected destination/baseline, and the real shared release lock held by every permitted writer. The current factory's exclusive lock file is a fixture coordination mechanism, not that production integration.

Every adapter/result declares `fixtureOnly: true`, `deploymentAuthorized: false`, `requiresOuterTrustedAuthorization: true` and `requiresSharedReleaseLock: true`.

## Input contract

The fixture's `apply` method accepts:

```js
{
  expectedDistManifest,       // Exact complete current prebuilt-dist manifest
  expectedIndexSha256,        // Must match that manifest and the actual index
  candidateIndex: { bytes, sha256 },
  newAssets: [{ path, bytes, sha256 }]
}
```

Content is copied into bounded buffers and its SHA-256 is checked. Index content is limited to 1 MiB; individual new assets to 32 MiB; the supplied overlay to 128 MiB. New asset names must be a direct `assets/<name>-<hash8+>.<extension>` path; duplicate, dot-prefixed, nested, traversal and non-asset paths are rejected. Existing same-name identical content is reused without inode replacement. Different content under an existing immutable name rejects the transaction.

The current complete dist must exactly equal the supplied manifest before any transaction mutation. Before the index switch, the complete expected file set is checked again: only declared new assets may have appeared and the old index must still be present. Unrelated dist files must retain their exact names, lengths and hashes. The plan is a bound input precondition, **not proof that its caller has production authorization**.

## Ordering and failure behavior

The transaction keeps its journal, original-index backup, next index and staged assets outside dist. Files and their containing directories are fsynced; phase records are append-only JSON lines followed by fsync. A successful flow is:

1. Preserve the original index, prepare the complete candidate, and durably record the bound plan.
2. Install new immutable assets using atomic create-only hard links from fully written private stages; remove the temporary alias outside dist and fsync both directories. Existing public assets are never overwritten.
3. Record switch intent, validate all other files, and compare the current index's content hash **and inode/metadata identity** with the originally observed index.
4. Perform one Linux rename of the prepared index over `dist/index.html`, fsync dist, revalidate the complete result and record completion.

No old or newly installed public asset is deleted on success or failure. A pre-index failure leaves the original index unless an external writer changed it. A post-index failure restores the backup only when the current index still matches this transaction's candidate hash and observed inode identity. An external replacement, including identical content under a different inode, refuses rollback. Rollback also preserves the original index's readable mode.

This comparison is performed under the required writer lock. POSIX rename is not a kernel “replace only if SHA still matches” operation: a rogue writer acting after the final comparison is outside the cooperative-lock guarantee. Production integration must not omit the shared lock or permit alternate index writers.

The tests cover normal failures and conditional compensation, not power-loss/restart recovery. A killed process may leave an intent journal, fixture lock or private staging alias (including a temporary second hardlink to a newly installed asset). There is intentionally no automatic stale-lock cleanup, process-restart recovery or asset garbage collection. Those require a separately authorized recovery controller to bind journal/backup/lock identity and current release before acting. Uncertain journal or rollback state is reported for manual recovery, never converted into success.

## Actual bounded proof

The narrow verifier `scripts/verifyFrontendOverlayTransaction.cjs` requires Linux rather than reporting a substitute Windows success. It executes the actual algorithm in private trees and records real fsync/rename calls through a test-local filesystem wrapper. Only the fixture adapter accepts failure hooks; no production API exposes them.

On 2026-09-08, all 15 checks passed in a transient DynamicUser service with private temporary storage/network namespace and read-only copied source. The unit took 646 ms. The real HTTP child used the existing `server/staticFileResponse.cjs`: 16 requests held open old-index FileHandles across the atomic switch while 16 later requests received the new index. Every response had the correct full body and Content-Length; both retained-old and newly installed assets remained readable.

`outputs/frontend-overlay-transaction-linux-1788861937355.json` records the proof, exact four-file source hashes, unchanged local sources, successful child/unit completion, absent final cgroup and removal of the isolated source fixture. Targeted ESLint recommended rules and Node syntax checks passed. Provider requests and production writes were zero. This proves the fixture transaction and HTTP identity behavior, not a deployed UI release, clean dependency install, signed authorization chain or production shared-lock integration.
