# Incident-bound reference hash repair

The first repaired full bundle r845 was constructed and signed normally in the
existing offline preparation mode. Its normal upload request then rejected the
known failed-worker state before uploading or starting a controller. No production
change or sequence consumption occurred on the server.

This candidate adds a separate preparation route for the specific reference-array
string-limit incident. A short-lived authorization is included in the signed full
source. It binds the exact completed runtime, both original and repaired file
hashes, and the unchanged storage/schema source contract. An active, clock-bound
worker must retain exactly the known official-cycle failure; a bounded journal
read must show `Invalid string length` inside that failed cycle. Unrelated failures,
old logs, stale status, process replacement, missing sources, schema changes and
pending recovery reject the route.

The report keeps `workerHealthy=false` and the original blockers. Permission to
prepare a repair is separate from worker recovery. The ordinary signed native
code release still checks the root lock, capacity, real PostgreSQL catalog,
source generation, candidate readiness, short cutover lease, consistency and
rollback. No production source is hot copied; no sync or worker restart is forced
outside the normal release transaction. After completion the full acceptance
still requires a naturally successful new complete cycle, original recommendations
and ACKs, protected frozen history, and public source/dist checks.

This incident route does not promote a model, register parameters, modify past
directions/prices/scores, or repair the previous failure status by relabeling it.
