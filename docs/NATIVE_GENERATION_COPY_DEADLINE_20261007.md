# Native generation copy deadline

## Scope

The normal native seed copies the immutable filesystem generation bound to its
held PostgreSQL read-only snapshot. A live generation writer can naturally hold
the pointer lock longer than the old 120-second copy wait. This change allows a
bounded natural wait inside the existing 240-second copy-child limit. It does
not steal an active lock, stop a worker, change PostgreSQL publication, skip
verification, retry a failed candidate, or increase the release-window horizon.

The failed r804 transaction and its recovery evidence remain historical. Its
archive SHA and allocated native directory cannot be reused by this change.

## One deadline

`copyGenerationAsService` creates the deadline immediately before constructing
and spawning its child. The deadline contains the fixed 240,000 ms budget,
canonical start/end timestamps and the parent monotonic start. The child
requires that complete exact contract; a missing, expired, future, extended or
malformed deadline does not start a new 240-second interval.

Same-host monotonic elapsed time includes dispatch. The child grants a lock
wait of `min(180000, remainingMs - 60000)`. At most 60,000 ms remaining before
acquisition is refused before creating a target. After acquisition, at most
60,000 ms remaining is also refused before complete source validation begins.
Wall-clock disagreement is a refusal, not an extension. The parent
`spawnSync(timeout: 240000)` remains the final cap.

The existing 3,600-second candidate-preparation reserve and complete normal
window checks, including the observed 9,429-second before-build allowance, are
unchanged. These horizon reserves are not an additional seed timeout.

## Verification and failure

Every original identity, canonical path, exact manifest/file hash, file
stability, byte count, fsync, pointer and complete candidate validation remains.
The copy holds its own pointer lock while validating the database-bound
generation and obtaining a 15-minute generation read lease. That lock is then
released; the read lease protects the whole copy against garbage collection.
Deadlines are checked around validation, lease acquisition, manifest/pointer
work, every large read/hash/write block and fsync. Time shortage never selects
a weaker validator.

The lock acquisition code still only reclaims an exactly identified dead
same-host owner through the existing token/inode quarantine contract. Lock age
or an observer's default `active=false` is not permission to replace a live
owner.

Normal deadline failures release the copy's own lock and read lease, including
failure immediately after obtaining the lease. Existing or partially copied
targets remain intact and create-only: another call cannot overwrite them.
An external hard timeout or signal can interrupt JavaScript `finally`; the
existing dead-owner reclamation, expiring lease and normal release recovery
remain necessary. This change does not guarantee immediate absence of every
artifact after a forcibly interrupted process.

## Timing and verification boundary

Successful proofs report actual parent/child/request/acquisition/completion
clocks and monotonic dispatch, lock-wait, copy and total elapsed milliseconds.
The copy interval includes complete source validation, lease establishment,
byte/hash copying, candidate validation and fsync. These fields do not measure
the first football recommendation publication or odds movement.

The verifier retains all original copy/identity/tamper/lease assertions. Added
checks use real isolated immutable files, an actual 11-second naturally released
local writer, a real live owner that cannot be stolen, and explicit synthetic
clock/fault injection for deadline boundaries and failure cleanup. A parent also
issues the deadline and passes it to an actual `process.execPath` child: that
child copies an independent small generation with full hash/fsync checks,
reports positive dispatch elapsed time and preserves the parent timestamp. A
second child receives an aged parent deadline with at most 60 seconds remaining
and refuses without creating a target or changing the source, lock or leases.
The original failed, existing and partial candidate cases remain create-only.

Those checks do not prove that a full production generation can finish within
60 seconds, that the new wait will always succeed, or that model accuracy or
production release reliability has improved. Actual full-generation copy
duration and a new normal signed release remain separate evidence.
