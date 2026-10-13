# Normal code-only serving verification

## Observed failure

r860 rolled back after the post-swap worker observer compared the raw generation
with the older committed PostgreSQL generation. The signed repair preparation,
seed and final reconciliation already bound that exact pair. The post-swap
reader ignored that contract. Production remains r853 until a new signed release
has actually completed.

## Change

Only normal code-only cutovers use `verifyNativeCodeServing.cjs`. Database
cutovers keep the original core and archive verifiers. Candidate gates remain
unchanged. The new gate requires the real root-owned normal transaction in
`swap-complete`, matching installed SHA, unchanged schema, finalized seed and
original captured identity, stopped worker, and the original transition clock.
Cold recovery capsules are rejected.

The serving health, original worker observation, retained immutable generation
and all 601 archive rows are bound to one protected read-only repeatable-read
session. A signed repair route validates the exact original authorization,
candidate source hashes and v6 capture MAC when applicable. Raw pointers are
compared under a short lock before and after archive checks. Heavy hashing,
HTTP and SQL do not hold that global lock. Ordinary releases still require
raw/PG equality and worker readiness. No additional worker blocker is accepted.

No PostgreSQL metadata, raw pointer, recommendation, frozen price or settlement
is rewritten. An accepted engineering gate retains original worker blockers and
does not claim natural-cycle acceptance, freshness or recommendation adoption.
The existing later full-runtime observer must still prove a complete new
natural cycle, and the public TLS and user-facing checks remain required.

## Cloud handoff follows production acceptance

Next stages are server-hosted historical report/ACK access, a scoped evidence
and draft intake with idempotent status lookup, cloud verification, then a
single scheduler cutover. Official collectors stay on the server. Dot tasks
remain paused while local schedules remain the active owner. No claim is made
that cloud publishing or offline operation is already installed.
