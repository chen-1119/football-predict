# Code release preparation diagnostics

r836 stopped before opening the service transaction. Its terminal message lost
the final transient reason, while independent observations showed a later
fixture replacing the earlier missing result archive. The generic timeout was
insufficient to distinguish pointer contention, projection-lock contention, and
missing result archives.

Preparation now emits a bounded classification after each failed read session
has closed, and retains the last cause when the elapsed deadline expires.
Only an allowlisted reason, counts and monotonic elapsed/remaining time appear
in the log. Error messages, database credentials, payloads and team records are
not serialized into progress observations.

The 600-second horizon, 61-attempt bound, 10-second retry interval, complete
session restart, archive requirements and 900-second cutover lease are unchanged.
Diagnostics neither generate missing archives nor establish release readiness.
No old release may be retried as a new transaction. A new release still requires
fresh preparation, candidate/final parity and complete acceptance.
