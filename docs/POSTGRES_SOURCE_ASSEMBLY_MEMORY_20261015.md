# Bounded PostgreSQL source assembly repair candidate

The normal r869 package passed local mandatory verification and the full build,
and upload verified its remote bytes. Activation stopped before cutover after
the existing 600-second preparation wait could not obtain a current committed
publication. The r868 application/completion markers remained unchanged and
there was no pending recovery. The failed r869 package is retained, not retried.

Read-only kernel evidence at 2026-10-15 01:34 UTC identified a global OOM, not a
worker cgroup limit breach. PostgreSQL backend 1305799 had 1,567,101 RSS pages;
the OOM victim was projection Node child 1305392. The worker was automatically
restarted by systemd. A subsequent automatic restart was also observed. The
PostgreSQL log tied that backend to the `public-reference-decisions:current`
source row. Its existing insertion path combined `string_agg`, a json cast and
an old/new `payload::text` comparison in one statement. The failed transaction
did not authorize changing generation metadata or advancing its raw pointer.

The candidate keeps the original JSON text, SHA-256/stat/UTF8 verification,
768 MiB file admission, 256 KiB chunks, 4 MiB batches, global projection barrier,
SERIALIZABLE transaction, exact table hash/inventory and pruning. No persistent
schema, recommendation, model, source representation or memory limit changes.

For file-backed source rows only:

1. Lock and compare the existing exact UTF8 text SHA-256 and scalar fields in a
   separate statement. A no-op still consumes and verifies the entire original
   input file, while preserving the physical database row and logical row count.
2. Assemble verified parts into a temporary text value.
3. Validate that text into a temporary json value in another statement.
4. Upsert the verified json after the earlier executor contexts have ended.
   The existing locked comparison makes a second ledger-sized old/new ROW
   comparison unnecessary. Ordinary inline rows retain their original SQL.

All temporary tables belong to the caller transaction. Errors propagate to its
rollback; the writer never catches an unknown result and retries a mutation.
The existing server statement ceiling and any stricter operator setting remain.

The new real PostgreSQL integration uses synthetic originals exceeding 512 MiB,
a 256 MiB Node heap and a verified 2304 MiB/no-extra-swap PostgreSQL container.
It requires byte-exact insert and replacement, a physical no-op, rollback after
staged validation and zero container OOM kills. It must actually pass CI before
the candidate is claimed verified. Local Docker is unavailable; unit fixtures
are not a substitute for this Linux/database result.

This candidate is not installed. A new reviewed HEAD, normal signed package and
current healthy route or a separately reviewed exact incident scope are required.
The old failed packages and old worker grants cannot be reused. The broker is
still uninstalled, dot network permission unapproved and workstation-offline
acceptance unperformed. Local automations remain active.
