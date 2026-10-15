# Exact r876 preparation reader and PostgreSQL peer identity

The r880 controller stopped before candidate preparation on 2026-10-15 at
14:37:23 UTC. Its worker gate passed, but the root preparation process connected
to the installed Unix PostgreSQL socket as database user `football`. PostgreSQL
correctly refused the root operating system peer. No application cutover or
recommendation write occurred; r880 is retained and must not be reused.

The signed root preparation retains its private candidate source and all source,
release, original-record, OID, publication, identity, lock, and clock checks. Only
its SELECT-only database transport runs in a fixed `runuser -u football` child,
using the installed fixed Node and PostgreSQL reader paths. Credentials come
from the verified API environment and are passed only in the child environment.
There is no configurable executable, operating system account, or connection
override. The database authentication configuration is unchanged.

The child inherits the actually held exclusive kernel flock descriptor, verifies
its device/inode and effective UID/GID, and requires cleared effective and ambient
capabilities. The parent holds the same root lock across both authority replays.
The bounded pipe permits SELECTs, the exact READ ONLY transaction setup, and
ROLLBACK. It permits neither writes nor COMMIT. It is limited to one outstanding
request, 256 requests, 1 MiB total input, 16 MiB per response, 64 MiB total output,
and an absolute 60-second reader lifetime. Child failures fail the preparation.

The isolated Linux verification starts a disposable peer-authenticated PostgreSQL
16 cluster. It proves root rejection, the real privilege drop, a READ ONLY
snapshot, the inherited exclusive lock, rejection of SQL writes and wrong UIDs,
and deterministic cleanup. Its explicitly named substitutions use the existing
`nobody` fixture account, repository PostgreSQL module, and CI Node executable;
they are not production caller acceptance.

This change does not mark baseline health true, bypass worker failures, change
the first 13 recommendations or their ACK, or permit closed-event revisions.
All candidate health, schema, capacity, signature, final lease, and post-cutover
checks remain required. A fresh reviewed HEAD and unique signed release are
required; a successful isolated test is not production installation.
