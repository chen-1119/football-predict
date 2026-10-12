# Check result archives before pausing the worker

r835 failed during candidate health at 2026-10-10 11:39 UTC because a newly
started event required a frozen archive absent from the current PG row. It
rolled back normally. The signed source and daily envelope parser fix remain
in this branch; r835 is not reused.

Code-only preparation now reads current PG rows in its existing protected,
read-only repeatable-read session, before writing lease input or stopping the
worker. It applies the existing server result-phase and archive validation
predicates. Only an absent required archive is retryable; malformed existing
archives, SQL errors and identity failures fail immediately.

Each retry closes the session and pool before delay, so the normal worker can
commit its next projection. The existing 600-second preparation horizon,
61-attempt bound and 10-second interval are unchanged. Reads are limited to
512 rows and 32 MiB; the query has an 8-second statement timeout. This does not
construct or persist an archive, change frozen predictions, or bypass final
candidate/API parity, window or 900-second cutover checks.

This prevents entering cutover with an already-known archive gap. It does not
prove a future recommendation is valid or eliminate every possible later data
race. The final health check is still required.
