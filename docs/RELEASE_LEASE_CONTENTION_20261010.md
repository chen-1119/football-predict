# Code release lease contention

r830 failed before service pause: its initial lease-input reader timed out on
the generation pointer lock. A later observation found no remaining lock;
the natural worker recorded publication and retention at the same period.
The historical lock owner was not captured, so this does not establish its
unique owner or justify removing a lock.

The first three-attempt implementation in r831 correctly failed before service
pause while the PostgreSQL projection was still busy. A short backoff did not
cover the observed multi-minute normal projection duration.

The pre-stop lease capture now retries complete read sessions within a
600-second monotonic retry horizon, at most 61 attempts with ten-second
backoff, only for POINTER_LOCK_TIMEOUT or the exact
PostgreSQL receipt-barrier busy error. Each attempt closes the previous read
session and rereads runtime markers and PostgreSQL identity. Integrity,
cleanup, I/O, and uncertain proof-write errors still fail immediately.
Live services continue during this preparation wait. An in-flight read retains
its existing transport deadlines. After a successful fresh capture, the
unchanged 900-second cutover clock starts and the actual transition lease is
created against the current time. No window is reserved by the earlier check;
an insufficient horizon still fails before service pause. Seed and final
identity guards are unchanged. Neither a lock nor a worker is forcibly cleared.

The mandatory code-data tests cover transient success, permanent contention,
non-retryable errors, cleanup-before-retry and wiring. These controlled tests
are not production contention recovery evidence. Deployment and publication
of reviewed recommendations require separate actual receipts.
