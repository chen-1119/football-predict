# Code preparation and cutover

## Scope

This change follows the request to separate build/upload from the actual code
switch. It includes the daily bulletin branch at 3c28793f. It does not activate
a trained model, alter predictions, migrate business records, or delete backups.

## Stages

1. `RELEASE_KIND=full node scripts/createReleaseBundle.cjs`: a valid native policy
   permits local preparation outside a match window. Worker, capacity, original
   archive, mandatory regression, build, signing and sequence checks remain.
2. `node scripts/deployReleaseBundle.cjs --upload-only`: authenticate the package,
   validate remote release configuration, upload and compare all four incoming
   file hashes. No controller, server sequence consumption or switch occurs.
3. `node scripts/deployReleaseBundle.cjs --activate-only`: reauthenticate the
   local package and all incoming bytes and invoke the normal locked root
   controller. No second upload is needed. Default invocation still uploads then
   activates. Neither option bypasses the signed root executor or recovery.

Native preparation grants no future cutover permission. Unknown/legacy bundles
retain their previous preparation gate. Native database migrations still take
their complete original server-side preparation, lease and natural-cycle path.

## Code-only classification and window

The root executor compares actual live and signed candidate schema/storage
contracts, then checks the installed PG catalog. Classification cannot be chosen
with an environment flag. Allocation must agree with its preceding classification.
Source or catalog drift fails. Code-only releases reuse the production database.

Signed frontend build and sandboxed dependency installation finish before the
code lease. Immediately before pausing publishers, a fresh 900-second lease is
created (300 verification + 570 preparation/handover + 30 atomic margin).
It binds the existing transition data rather than resetting the clock after
candidate verification. Before stopping the public API and again before swap,
the lease is checked with 300 seconds remaining and a monotonic elapsed-time
limit. Failure restores through the existing fixed recovery. After service
startup, a fresh 30-second boundary check and elapsed check apply. The 900 seconds
is a protection budget, not a promised duration or measured outage.

Seed and final PG publication must have the exact same generationId,
manifestHash, sourceCycleId and committedAt. Existing root lock, read-only
candidate, installed-schema verification, final stopped-writer checks, preserved
database OID, rollback journals and source/dist validation remain.

## Completion states

Code preparation opens its recovery snapshot and pauses maintenance only after
the fresh code lease succeeds. An unsigned build or closed lease before that
point preserves the running services. The database lane still creates recovery
before its preparation. This corrects the observed r817 pre-cutover rejection,
which opened recovery too early and unnecessarily restarted the existing service.
The 900-second cutover budget, final identity checks and post-pause recovery
remain unchanged.
The create-only lease lives in the already allocated native transaction directory;
it does not depend on a recovery directory that has not been created yet.

Code-only engineering completion retains serving PG integrity, archive lineage,
candidate continuity, public readiness, worker startup and exact runtime marker
checks. It does not await a whole collection/enrichment run inside the release
transaction. The database path still awaits both original worker phases.

`.release-code-acceptance.json` is a create-only, fsynced engineering receipt with
`businessAccepted:false`, the package hash and the new worker start time.
`node scripts/codeReleaseAcceptance.cjs observe <sha>` requires matching runtime
and complete markers and separately checks a subsequent natural complete cycle.
Even a natural-cycle success reports `recommendationAdoptionAccepted:false`:
new quotes, daily bulletin rows and model/version adoption need their own proof.
Existing independent full-runtime acceptance still requires new worker evidence.

## Verification limits

The regression suite exercises real Bash code/database branches with mocked
external service effects, real transition-lease clock/data rejection and real
worker evidence predicates. It is not a production rollback demonstration.
Deployment duration, new source bytes and natural-cycle acceptance must be
measured after the normal signed deployment. Full-repository legacy lint failures
are not relabelled as passing.
