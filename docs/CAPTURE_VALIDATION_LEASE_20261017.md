# Capture validation and read lease

The r889 natural capture at 2026-10-16 19:52 UTC took 46,935.886 ms to retain
64 observations. The following natural deadline attempt exceeded 36,968 ms.
The observations audit covered 1,990,928,018 bytes; independent read-only proc
sampling observed approximately 4.86 GB of cumulative reads in one deadline
child, including several passes over prediction-snapshots.json. The observer
did not dispatch a capture or change the worker.

The native read session previously resolved the committed generation, hashing
every payload, then acquired a reader lease by resolving and hashing it again.
The new combined operation holds the real pointer lock, executes the complete
existing committed-publication validator once, and creates the lease before
releasing that lock. PostgreSQL still supplies the exact publication identity
from the same REPEATABLE READ READ ONLY transaction. All payload hashes,
manifest and source-cycle identity, safe paths, directory checks, reader lease
and receipt barriers remain required. There is no validation cache or accepted
caller-supplied context. Other reader-lease callers retain their previous path.

For a snapshot warehouse larger than the existing prefix limit, the capture
now goes directly to the existing complete streaming reader. It still hashes
the stable file and validates every byte, UTF-8 sequence and JSON production,
including skipped history. It preserves every selected observation and the
existing file, memory, nesting and scalar bounds. Small-file and legacy lanes
are unchanged. The removed prefix probe had no admission value for the actual
warehouse: observations did not occur in its first 8 MiB.

Private capture diagnostics now separate native validation/lease time from
observation hashing and complete selected parsing. They report actual bytes
and durations; no deadline, timeout, heap, source quota or model gate changes.
Local tests count real payload reads and verify that the one retained pass
occurs under the actual lock. They also reject later corruption, wrong
publication identity and foreign handles, and verify lock release on failure.

The earlier ignored parser prototypes are excluded: compact fixtures improved
only about 1.4 times, and native container parsing was slower. These numbers do
not establish a production improvement. Full review, complete CI, a new normal
signed release, its own natural full cycle and independent live capture timing
are still needed. Existing recommendations, SP, scores, ACKs and settlement
denominators remain immutable; this is not a model promotion or accuracy claim.
