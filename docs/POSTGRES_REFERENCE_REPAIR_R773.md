# r773 PostgreSQL reference repair

This incident-specific channel is an explicit mode of `scripts/deployReleaseBundle.cjs`.
It does not relax the normal release, Worker or immutable-generation reader gates.
Inspection and preparation do not update production data. Activation pauses writers,
backs up the complete application/store/configuration and database, then performs an
isolated projection before changing four signed runtime files.

The accepted incident is either a current `POSTGRES_REFERENCE_ADMISSION_LIMIT`
failure, or its proven derivative: PostgreSQL is strictly older than both current
and previous immutable generations, so `syncData` fails its publication-identity
pairing check before reaching the next projection. The derivative requires the
exact latest failure message and an earlier admission failure in the same Worker
invocation, after the signed active generation was committed. Unknown failures,
another invocation, incomplete clocks, or a snapshot below the original 320 Mi
character admission limit remain blocked. The legacy error text mentions SQLite;
the bound identity in this channel is explicitly PostgreSQL-only.

The capsule binds r773, current/previous generation pointers, the PostgreSQL
database OID and cluster, source and target file hashes, all frozen object hashes,
the exact forward projection and the fixed publisher entrypoint guard. Four
runtime files remain the entire application allowlist. The separate entrypoint
change only refuses ordinary releases while a durable repair marker exists.

Activation order:

1. Hold the existing publisher lock; recheck the signed identities and fresh
   release window. Install the signed reject-only entrypoint guard, record the
   durable repair marker, and stop/drain every managed writer.
2. Make and verify full backups. Restore a distinct database and copy the exact
   active generation. Run the new source/writer there; compare original frozen
   hashes, every reference shard, archive index and the complete PostgreSQL archive
   SHA-256. This proof cannot target the production database OID.
3. Atomically install only the four signed application files. With writers still
   stopped, invoke the same source/writer and verification function once against
   the signed production OID. The archive descriptor must equal the isolated
   archive SHA before its transaction can commit. Record
   `productionProjectionWrites=true`; this is a forward projection, not a new
   recommendation or a data rollback.
4. Start the API and a new Worker PID. Require a complete new successful official
   cycle, ordered observation clocks, fresh service/PG health, unchanged frozen
   evidence and archive continuity. Only then record repair acceptance. The full
   release marker still names r773; repair acceptance is not a new full release.

Both isolated and production projection receipts record the actual PostgreSQL
backend PID, sampled peak RSS and minimum available host memory, separately from
Node RSS. Sampling does not change PostgreSQL settings or terminate its backends.

On failure the supervisor retains the publisher lock while draining its process
group and the exact isolated proof unit. Recovery restores code and verifies the
original services. It preserves any committed forward projection and all newer
data; it never restores an old database or generation. The reject-only entrypoint
guard is retained. A SIGKILL leaves the durable marker blocking ordinary releases
until the same signed repair controller verifies recovery.

Use existing pinned SSH and signing-key environment variables. The actions are
`inspect` (default), `create`, `prepare`, `activate`, `status`, `recover`, all
invoked with `--signed-reference-repair --repair-action=...`. `create` consumes
the fresh inspection JSON via `--repair-observation=...`; later actions consume
the resulting directory via `--repair-capsule=...`. No generic skip/override
arguments are accepted. A failed activation cannot be replayed.

Local tests validate policy, target separation, pre-commit archive mismatch,
clock precision, and code-only recovery. They are not a substitute for the actual
isolated projection and live Worker acceptance receipts.
