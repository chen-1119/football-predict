# Committed PostgreSQL generation sync recovery

The r844 worker repeatedly fails with `SQLite publication identity matches
neither the serving generation nor its immutable previous generation`. That
message is a historical helper name; the installed database is PostgreSQL.
The committed PostgreSQL generation is older than both raw pointers.

The committed-generation reader verifies the exact retained generation named
by the database metadata, including every immutable file hash. It does not
rewrite pointers, advance database metadata, copy PostgreSQL or manufacture
a successful worker cycle. Normal retention protects that accepted generation
under the existing projection barrier and read lease.

## Incident-bound code delivery

The v2 worker repair authorization binds the completed runtime SHA, unchanged
schema/storage hashes, seven changed reader/reference source hashes, database
OID, exact committed generation, and exact raw current/previous generations.
Preparation also requires the same active worker PID and a recent failed cycle
containing the exact identity-mismatch journal message. The original failure
remains visible; this only admits preparation of the signed code repair.

Ordinary code deployments still require raw-current/PostgreSQL affinity. Only
the signed v2 incident route can seed and finalize against the exact committed
database generation while validating both unchanged raw generations under the
pointer lock. PostgreSQL identity must remain equal to the seed through final
reconciliation. All normal schema/catalog, root lock, immutable hashes,
capacity, readonly candidate, archive, signed lease, 900-second dual-clock
budget and recovery gates remain mandatory.

An explicit data-sync-repair purpose is accepted by the existing bounded
code-only immediate-activation authorization. It cannot authorize a database
release or extend its two-hour authorization / 900-second activation clocks.

## Acceptance scope

The read-only replay verified 13 retained files totaling 1,326,753,264 bytes,
the real PostgreSQL OID and current reviewed recommendation ACK authority.
This replay is not an installed repair or successful synchronization.

After normal deployment, wait for a real natural successful full cycle and a
newer committed PostgreSQL source batch. Preserve all original recommendations,
prices, scores, ACKs and settlements; do not force the worker, fake freshness,
or register model parameters to make acceptance pass. Today's r848 coverage
and user-approved highest-available pair are retained in the candidate UI.
