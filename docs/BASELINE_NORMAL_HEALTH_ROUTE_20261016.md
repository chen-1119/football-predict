# Normal health after the exact r876 incident is absent

The unique r881 attempt stopped before candidate allocation or application
cutover. Its signed preparation reader connected through the fixed privilege
drop, but the expected old reviewed-view error was absent. The original r876
application, database identity, API and worker remained installed and running.

A separate read-only observation at 2026-10-15 16:06:52 UTC verified the installed
authority reader against PostgreSQL OID 28598409. The current recommendation
center had naturally advanced to the October 16 business day with zero reviewed
and trained records, and its integrity validation succeeded. An observation
using the earlier day clock was correctly rejected as `CENTER_CLOCK`. The
October 15 original records and acknowledgements remain archived; no new
recommendation was published by this observation.

The incident preparation scope still requires the exact original error and all
original release, source, database, record, acknowledgement, clock and lock
bindings. It must not invent that error when the current authority is healthy.
On the initial check only, a verified current healthy authority now returns
the distinct `BASELINE_REPAIR_NOT_APPLICABLE` status 3. The actual shell clears
the incident proof and requires the original consecutive normal service health
gate. Status 3 is not a health success or cutover permission. Other errors fail;
the paused incident-proof path cannot switch to this route.

The existing repair proof keeps its false baseline-health flags. Worker
preparation, source/schema/capacity checks, candidate health, signed fresh
clocks, root lock, exact publication and final cutover lease are unchanged.
The r881 failed package and evidence must not be retried or modified.

The focused suite includes the actual extracted Bash branch with fixed fixture
adapters: status 3 plus healthy service can continue normally, status 3 plus
failed health cannot continue, known repair status 0 preserves its proof, and
all other exit statuses reject. These fixture results are not installation,
production health or cloud publication acceptance.

The first complete CI run passed the new route cases, then exposed an existing
crash-fixture race: the recorder was sometimes killed after its second journal
file appeared but before its append lock was released. That test now waits for
the intended boundary outside the append critical section before killing the
recorder. Its unresolved-command assertion and the separate interrupted-append
lock test remain strict; the production journal implementation is unchanged.
