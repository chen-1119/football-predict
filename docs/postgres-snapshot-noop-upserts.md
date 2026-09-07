# PostgreSQL snapshot no-op update avoidance

2026-09-07. Applies to match/source/odds/prediction snapshots and private model artifacts. This follow-up is not part of the running r695 signed bundle.

## Motivation and preserved boundaries

r695's guarded release still performs full PostgreSQL backfill after swapping the application. That full inventory scan, transaction, source hashes, active-ID pruning, publication identity, semantic projection, frozen recommendation rules and primary-read checks are retained. The release is not changed to skip migration or use an incomplete incremental window.

`postgresSnapshotUpsert.cjs` centralizes the same five existing update assignments and adds a null-safe comparison of the current row with the values that would actually be assigned. Exact `json::text` is compared, not `jsonb`: a changed key order remains a required update for order-sensitive reference hashes. First-seen is still the minimum; last-seen and seen-count remain maxima. Older observations that do not change any resulting value no longer trigger a redundant UPDATE.

PostgreSQL still locks conflicting rows and reads/compares payloads; this is not zero I/O or zero WAL. Full scans and application-to-database payload transmission also remain. The existing `rowCounts` reports processed source inputs, not physical updates, so its meaning and complete denominators are not changed.

The SQL behavior is documented in [PostgreSQL 16 INSERT](https://www.postgresql.org/docs/16/sql-insert.html): `ON CONFLICT DO UPDATE WHERE` tests its condition after finding/locking the conflict; rows not updated do not contribute to the affected-row count. No affected-row equality guard on the separate fail-closed semantic ledger paths was removed.

## Verification

- 7 SQL-construction checks: five allowlisted tables, exact payload text, null-safe row comparison and rejection of unknown/injected table names.
- 49 checks with real PostgreSQL 16.15: insertion, repeated no-op, unchanged tuple and JSON bytes, reordered JSON, actual content changes, null/timestamp transitions, dominated and advanced observation metadata, status-only and artifact version/hash-only changes. These synthetic changes are rolled back.
- 2 integrated real-database checks: rerun actual full backfill (not fingerprint skip) and verify all five snapshot tables preserve unchanged tuple versions and payload bytes across transactions.
- Full native evidence suite passed 323 assertions (previous 265 plus these 58), including real schema migrations, full/incremental projection, SQLite/PG readers and both primary-mode HTTP paths. Disposable local database identity was verified; database stopped and temporary test data removed. Production data was not changed.
- Existing PostgreSQL migration-plan verifier passed. No production latency result is claimed until an independent signed release and measured full-sized runtime check are complete.

Reproduce:

```powershell
node scripts/verifyPostgresSnapshotUpsert.cjs
npm.cmd run verify:evidence-native-postgres -- C:/path/to/pgsql/bin
```

Output: `outputs/q1-native-postgres-evidence-result.json`. The native harness only accepts an isolated local QA database and does not install a Windows service.
