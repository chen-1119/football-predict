# Generation cold-start memory repair, 2026-10-15

The sequence 867 normal deployment failed before replacing source code. Restarting
the existing r863 API parsed the entire immutable prediction-snapshots object
(1,006,653,402 bytes) while validating its committed PostgreSQL publication.
The original 1,536 MiB Node heap repeatedly exhausted memory. The guarded rollback
also initially failed its API readiness check. All original failure evidence and
the failed package remain retained; sequence 867 must not be reused.

A separate, narrowly bound signed recovery bootstrap added a temporary 3,072 MiB
API command-line heap override. Its fixed root-owned drop-in is
`80-r867-api-heap-bootstrap.conf`. The original fixed release recovery subsequently
reported `rolled-back`, PostgreSQL-only storage, no projection rebuild, preserved
live model data, and no remaining recovery pointer. This restores the old API;
it does not install the publisher or prove a healthy full worker cycle. The
bootstrap override must be retired through a reviewed signed action after the
bounded cold-start implementation passes an actual normal installation and cold
start. Other service configuration must remain intact.

The candidate implementation streams complete root `rows` arrays in immutable
generation validation, one item at a time. It verifies the full JSON grammar,
UTF-8, exact signed byte count and SHA-256, stable plain-file identity, and exact
row count. Missing or non-array rows, duplicate root rows fields, malformed or
trailing JSON, payload tampering and declared count conflicts are rejected.
Original per-item/depth/file bounds remain in the existing strict stream reader.
No data is written, removed or truncated. Semantic-hash callers keep their full
original value path, while current/history identity and calibration checks remain.

The regression suite resolves an actual committed generation larger than 128 MiB
in a child with a 64 MiB heap, validates every row and tail, and checks the original
semantic hash on a representative smaller generation. The tests are required by
the normal pre-sign release gate and Linux CI. These are isolated fixtures, not
production installation evidence.

At UTC 2026-10-14 21:18:05–21:18:45, a separate read-only diagnostic streamed the
actual retained immutable file (1,006,653,402 bytes, SHA-256
`c97055629e6a5a007337b5f9cf9fb6591474b71abc0b1ca636044c177f092fc5`)
in a 128 MiB Node heap. It validated the entire document and counted exactly
5,000 root rows, with measured peak RSS 97,956 KiB. The release markers, raw
pointer and manifest bytes were checked before and after. This proves bounded
reading of that original file; it is neither an installed API cold-start test
nor a new PostgreSQL identity transaction or data freshness acceptance.

The r863 worker's separate `REFERENCE_DECISION_INDEX_LIMIT` remains an independent
production failure until the previously reviewed lossless index candidate is
installed and a genuinely new complete natural cycle passes. Its old v7 grant is
bound to worker 713693 and cannot authorize the restarted worker incarnation.
Any later code repair needs fresh exact release/source, worker/journal, committed
PG, corpus, capacity and final lease evidence under the existing root lock.

The dot IP network permission is still unapproved. The official support request
has already been escalated. Dot tasks stay paused and local automations remain
active until independent cloud authentication, read/report/archive/publish/second
ACK and deployment exclusion are proved. A real workstation-offline interval
has not yet been verified.
