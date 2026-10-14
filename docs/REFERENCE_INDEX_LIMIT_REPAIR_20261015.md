# Reference decision index incident preparation

The production r863 worker completed a failed official cycle at
2026-10-14T17:41:06.393Z. The reconciliation child reported
`REFERENCE_DECISION_INDEX_LIMIT`. A read-only scan measured 7,964 attested
original decisions: 34,963,149 serialized characters, 35,495,897 UTF-8 bytes,
and 17,620,517 bytes when every complete record is losslessly compressed and
charged 256 bytes of index metadata. This is the serialized index admission
failure, not a PostgreSQL canonical identity incident.

## Candidate scope

`worker-code-repair-v7` is a new preparation contract. It does not reuse a v1–v6
incident grant or promote the worker's failed health report. Its exact reason
is `reference-decision-index-limit`; its exact binding policy is
`fresh-reference-index-limit-and-exact-corpus-before-lease-v1`.

The signed input must bind the completed baseline release, changed-file
before/after hashes, unchanged reader source hashes, all existing data contract
and migration hashes, database OID and committed publication, worker PID and
start time, signed failed cycle, child PID, actual journal microsecond and the
full five-line original reconciliation error frame. Only the same failure in
that cycle, or a later non-overlapping cycle on the same worker incarnation,
qualifies. Missing, duplicate, mixed or truncated journal records reject it.

The read-only collector hashes and validates the entire snapshot JSON using the
existing bounded streaming reader. It reattests every original decision,
rejects duplicate hashes and measures every complete serialized record. The
ordered, length-framed corpus digest and all count/capacity measurements must
match the signed input. The 32 MiB index limit and 100,000-record limit remain.
The old serialized character total must exceed 32 MiB, while the lossless
compressed index plus metadata must fit that same bound. An individual oversized
record, a count-limit failure or a still-oversized compressed index does not
qualify. The probe rechecks reader and repair source bytes after the scan.

Natural changes outside the reference array may change the whole snapshot JSON
SHA. The fresh full SHA and size are retained in the sealed capture. All complete
reference records, their order and capacity measurements must remain identical.
A changed reference corpus requires a new reviewed signed input.

## Cutover boundary

The actual PostgreSQL commit must remain identical to the signed input. Raw
generations may only move naturally forward and must pass the existing complete
immutable-generation byte verification. The existing root-owned create-only
capture, allocation-state MAC, real pointer lock and code-only publication
pairing bind these facts before the lease. A healthy worker follows the original
ordinary publication route and does not load the old incident.

This contract authorizes preparation only. The normal signed package, root
release lock, schema/catalog, capacity, source closure, archive coverage,
two-clock 900-second transition lease and final serving verification remain
required. It adds no metadata write, raw-pointer write, forced synchronization,
second writer, archive pruning or data migration. A new natural complete cycle
and public TLS verification are still required after any real installation.

## Verification and installation status

Tests execute the serialized read-only probe with explicit local service/journal
fixtures, exercise the actual root capture implementation in a private fixture,
and stream a real local JSON corpus above the old index size bound. They also
retain all v1–v6 rejection and normal release checks. These tests are not a
production installation, caller acceptance or cloud takeover receipt.

No operative v7 authorization is included here. Generate it only from fresh
production read-only evidence after the candidate source has completed review
and CI, then create a new normal signed package and sequence. Old failed or
superseded packages 864, 865 and 866 must not be reused. Production remains r863
until a new installation is actually verified.
