# Native publication repair, 2026-09-12

The r734 candidate failed before database activation: the PostgreSQL projection
step inherited an 896 MiB heap, then the full-size rehearsal exposed a missing
TEMP privilege on the isolated build writer. Production remains the accepted
r730 runtime until a new signed release completes its online checks.

The projection command now explicitly enables phase collection and a 1536 MiB
heap, including Worker calls. The candidate step uses the existing 2200 MiB
service bound. Match archives resolve snapshot evidence lazily; the independent
reference ledger uses the manifest-verified selected-object reader's value.
The candidate writer receives TEMP only on its own database; permanent schema
creation and production writes remain denied.

Before native database activation, recovery now rebuilds the current serving
generation's compatibility projection before restarting services. It never
rewinds an activated native database. Both health checks allow a bounded
180-second cold start, with native storage checks retained.

Validation retained under this worktree's outputs directory:

- `real-native-projection-complete-result.json`: actual retained r734 candidate,
  2313 match rows, 251 source rows, 1907 odds updates, 647 frozen recommendations,
  zero frozen corrections; peak RSS 1660696 KiB; no production data writes.
- `native-data-plane-temp-20260912.json`: real isolated Linux PostgreSQL dump,
  restore, complete mirror, temporary-table write and role isolation/cleanup.
- `evidence-native-memory-temp-20260912.json`: real PostgreSQL evidence roundtrip,
  exact frozen payloads and tuple versions, native HTTP readers.
- `worker-native-memory-temp-20260912.json`: actual Worker CLI on disposable
  PostgreSQL, 41 processes, zero SQLite attempts, readiness passed.
- `native-recovery-memory-temp-20260912.json`: 20 recovery cases.
- `native-memory-pipeline-20260912.json`: actual shell allocation and dispatch.
- `verifyRecoveryColdStart.cjs`: actual health methods accept a 75-second start
  and reject unavailable or invalid native storage at the bounded deadline.
- `signed-precutover-affinity-recovery-result.json`: signed, identity-bound
  r734 recovery completed with live model data preserved and journal resolved.

These checks authorize proceeding through the normal signed release gates;
they are not evidence of a completed production PostgreSQL-only cutover.
