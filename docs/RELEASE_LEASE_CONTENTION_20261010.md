# Code release lease contention

r830 failed before service pause: its initial lease-input reader timed out on
the generation pointer lock. A later observation found no remaining lock;
the natural worker recorded publication and retention at the same period.
The historical lock owner was not captured, so this does not establish its
unique owner or justify removing a lock.

The pre-stop lease capture now retries at most three complete read sessions,
with one and two second backoff, only for POINTER_LOCK_TIMEOUT or the exact
PostgreSQL receipt-barrier busy error. Each attempt closes the previous read
session and rereads runtime markers and PostgreSQL identity. Integrity,
cleanup, I/O, and uncertain proof-write errors still fail immediately.
The existing 900-second cutover clock starts before these attempts; it is
neither extended nor reset. Seed and final identity guards are unchanged.

The mandatory code-data tests cover transient success, permanent contention,
non-retryable errors, cleanup-before-retry and wiring. These controlled tests
are not production contention recovery evidence. Deployment and publication
of reviewed recommendations require separate actual receipts.
