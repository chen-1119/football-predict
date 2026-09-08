# Fixed frontend release transaction

`scripts/frontendReleaseTransaction.cjs` is a fixed-root filesystem transaction,
not a signed-source authorizer. Install it and `releasePrebuiltDist.cjs` from
reviewed trusted source before requiring either as root. The production module
has no CLI, environment-selected path, test hook or signing key. It never
starts/stops services, invokes a provider, modifies source/model/database files,
or deletes public assets. The existing fixed wrapper/authorizer must authenticate
the signature, complete source/runtime boundary, sandbox result and read-only
acceptance checks. A caller-supplied fixture result is never authorization.

## Fixed paths and global lock

- Dist: `/opt/football-predict/dist`.
- Same-filesystem staging: `/opt/.football-frontend-transactions/<24hex>/`.
- Global recovery: `/var/lib/football-release/recovery/current`.
- Root state: `/var/lib/football-release/frontend-state.json`, root 0600.
- Public state: `/opt/football-predict/.frontend-release-state.json`, root 0644.
- Public receipt: `/opt/football-predict/.frontend-release-acceptance.json`, root
  0644, at most 10 KiB. This is an exact copy of the corresponding private receipt.
- Existing global lock: `/run/lock/football-release.lock`, inherited fd 9.

Production requires Linux, root, exact Node `/opt/node-v22.22.1/bin/node` version
22.22.1, no Node exec arguments or loader environment overrides. All path
ancestors must be canonical root-controlled non-writable directories; staging
and recovery roots must be private. Static files must be root-owned and not
group/world writable. State/proof files are single-link regular files; symlinks,
oversized files and unstable descriptors/path metadata fail closed.

`assertFrontendReleaseLock()` is a fixed read-only precondition assertion, not
authorization. It checks all fixed directories and that staging shares dist's
device. It requires fd 9 to have the fixed lock's dev/inode, a matching exclusive
`FLOCK ADVISORY WRITE` record in `/proc/self/fdinfo/9`, and the corresponding
`/proc/locks` entry. Merely seeing somebody else hold that inode is insufficient.
The recorded holder need not be the Node PID: the wrapper's `flock 9` opens the
lock description before invoking Node. When using Node spawn rather than shell
exec, explicitly inherit fd 9 in stdio. Do not reacquire a different lock.

The guarantee assumes every authorized dist writer holds this same lock.
POSIX rename is not a kernel hash-conditional operation; an uncooperative root
writer can race a userspace check. Unknown identity changes are refused rather
than overwritten. The fixture-only adapter creates its own private temp root
and uses an in-process fixture lock; it does not assert the production lock.

## API

All production APIs accept only the documented exact keys, with no path or
failure-injection argument. They keep the inherited lock held by the caller.

```js
assertFrontendReleaseLock();
const pending = beginFrontendRelease({
  expectedStateSha256, // SHA of exact canonical root state bytes
  expectedDistManifest, // exact complete current cumulative dist manifest
  candidateIndex: { bytes: Buffer, sha256 },
  newAssets: [{ path: 'assets/name-Abcdef12.js', bytes: Buffer, sha256 }],
  runtimeSha256, runtimeSequence,
  frontendSha256, frontendSequence,
  authorizationSha256, // root authorizer's durable authorization record bytes
});
acceptFrontendRelease({
  transactionId: pending.transactionId,
  acceptanceReceiptBytes: Buffer,
  acceptanceSha256,
});
recoverFrontendRelease();
initializeFullFrontendState({
  runtimeSha256, runtimeSequence,
  acceptanceReceiptBytes: Buffer,
  acceptanceSha256,
});
```

`begin` verifies both full markers, the prior accepted state and public proof,
the consumed global sequence, the entire current dist and the exact index.
The new sequence must exceed the prior frontend sequence. Buffers are copied
and independently hashed. Index is bounded to 1 MiB, each new asset to 32 MiB;
candidate input and final cumulative tree to 128 MiB/4096 files. Only direct
hashed filenames inside assets are accepted. Existing names may only reuse
identical bytes. Unchanged index is not treated as a deployment.

The full initializer additionally requires recovery to be idle, both full
markers to match, the consumed sequence to match, and the existing root status
for that SHA to say complete/ok=1/exitCode=0. Its finishedAt accepts the actual
wrapper's canonical second-resolution UTC format as well as Node's canonical
millisecond format, not loose dates or timezone aliases. The outer wrapper can
write its already-accepted full status and call this initializer while retaining
the lock. Initialization failure leaves UI eligibility unavailable; it does not
retroactively convert the accepted full release into a database rollback.

## Exact state and acceptance contracts

State has exactly these fields, serialized in this order with JSON.stringify
plus one newline; no indentation. Hash the actual bytes, including the newline:

```text
version='frontend-release-state-v1'
kind='full'|'frontend-only'
phase='pending'|'accepted'
runtimeSha256, runtimeSequence
frontendSha256, frontendSequence
indexSha256, distTreeHash
acceptanceSha256=null for pending, 64hex for accepted
```

UI receipt has exactly:

```text
version='frontend-readonly-acceptance-v1'
transactionId (24hex)
runtimeSha256, runtimeSequence, frontendSha256, frontendSequence
indexSha256, distTreeHash, authorizationSha256
checkedAt (canonical millisecond ISO UTC)
checks={index:true,assets:true,health:true,protected:true,services:true}
```

Full receipt has exactly:

```text
version='frontend-full-baseline-acceptance-v1'
runtimeSha256, runtimeSequence, indexSha256, distTreeHash
checkedAt (canonical millisecond ISO UTC)
checks={runtimeMarkers:true,health:true,sourceBaseline:true}
```

Normal accept/initialize requires a receipt timestamp from the last five
minutes (at most five seconds future skew). Receipt JSON formatting may vary;
its exact bytes are bounded, hashed and copied without reserialization. Cold
recovery verifies the previously persisted receipt against the exact pending
transaction, without pretending an old receipt is a new health observation.
The outer recovery controller remains responsible for any additional fresh
read-only service check required by deployment policy.

The root recovery record stores complete assets/manifest identities. Public
rollback receipt is intentionally compact and has exactly:

```text
version='frontend-rollback-acceptance-v1'
transactionId, authorizationSha256
previousState (the complete previous accepted state)
indexSha256, distTreeHash
retainedAssetsSha256, retainedAssetCount
newFrontendAccepted=false
```

Its retained-assets hash binds canonical JSON-plus-newline for the actual
installed newly declared rows. Rollback preserves the prior kind/runtime/
frontend SHA and sequence, but updates cumulative distTreeHash and receipt hash
because installed new assets are deliberately retained. This must not be counted
as acceptance of a new UI release. The state consumer should compare the target
frontend SHA/sequence, not merely whether acceptanceSha256 changed.

Public receipt is atomically published before accepted root/public state. During
the transition a receipt/state mismatch is unavailable evidence, not success.
Pending states have no accepted receipt even when the old public receipt remains.
Recovery reconciles known old/pending/accepted state and receipt combinations.

## Durable phases and cold recovery

```text
root-private prepared record + staged index/backup/asset identities fsynced
  -> current published
  -> pending state
  -> create-only assets (link/fsync/unlink temporary alias)
  -> index-switch-intent
  -> one same-filesystem index rename + directory fsync
  -> pending-acceptance
       | no accept-intent              | persisted exact accept-intent
       v                              v
  CAS rollback old index        verify candidate/index/assets/receipt
  publish rollback proof        publish acceptance proof
  restore prior UI identity     publish accepted state
       \                              /
        -> archive current under .frontend-resolved-<id>
```

The record commits original, staged candidate and backup dev/inode/hash/size/
mode before the index rename, closing the rename-to-journal crash gap. Recovery
derives index identity from persisted descriptors, not the remembered phase or
a process success message. No intent means rollback; a valid intent means
roll-forward. A same-content replacement with another inode is an external
change and is refused. An interrupted rollback can recognize the already-moved
backup. Both intents together, unknown files/phases, invalid receipts, missing
identities and undeclared dist changes leave current pending for manual review.

Root metadata updates use fsynced files and atomic rename. Known interrupted
state/phase temporary files can be reconciled; unrecognized bytes are retained
and rejected. Partial/corrupt immutable intent records fail closed for manual
review rather than guessing that a torn write authorized acceptance. A process
SIGKILL fixture is not a physical power-loss/filesystem durability guarantee.

After a crash between asset link and temporary unlink, recovery removes only
the exact staged alias after proving both paths have the saved inode/hash and
exact link count 2. Public assets are never deleted. The same-filesystem stage
and resolved root audit records are retained, not recursively cleaned by this
module. A failure before current is published can leave only a private unused
stage, with no app changes. The outer authorizer must enforce available-space
preconditions and a separately reviewed retention policy; this module does not
garbage-collect deployment history.

Full initialization publishes its complete receipt and accept intent together
with current, before changing state; cold recovery can finish its two projections
without touching index or entering full service/database recovery.

## Focused verification

`verifyFrontendReleaseTransaction.cjs` runs only private Linux fixtures, with
real file rename/link, directory fsync, state and receipt reads. It covers all
published interruption phases, strict receipt/identity contracts, immutable-name
conflicts, sparse oversized files, unknown members and changed index inodes.
Separate child processes really SIGKILL after index rename and acceptance intent,
then a fresh child recovers using only disk records. Another real shell/flock
fixture proves inherited-fd lock observations, and rejects the case where the
same inode is locked through fd 8 but fd 9 is a separate unlocked description.

Fault hooks and a VM-only private-core adapter exist solely in this verifier;
they are not production options. Tests check descriptor closure, public proof
hashes/modes, unchanged full markers/runtime/data sentinels and retained assets.
These are transaction proofs, not deployment, provider or model-readiness proof.

2026-09-08 isolated Linux Node 22.22.1 run: 41 checks passed in 5373 ms,
`outputs/frontend-release-transaction-linux-1788864634143.json`. The runner used
DynamicUser, PrivateTmp, PrivateNetwork and a read-only source fixture; production
configuration/store paths were inaccessible. It checked authoritative final
systemd/cgroup quiescence, exact isolated-fixture cleanup and unchanged input
source hashes. No provider requests or production writes occurred. Targeted
ESLint recommended rules reported zero warnings/errors for both new CJS files;
Node syntax checks and git diff whitespace checks also passed.
