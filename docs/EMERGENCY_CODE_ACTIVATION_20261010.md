# Time-limited emergency code activation

The operator explicitly requested immediate activation without the football
schedule window on 2026-10-10. The previous uploaded r837 was not activated;
its local wait was stopped before any server controller or native transaction.

This release carries `deploy/light-server/code-release-activation-authorization.json`
inside the signed archive. Its sole mode is `code-only-ignore-schedule`, with a
two-hour UTC validity interval. The local deployer reads the actual archive
member only after signature and whole-archive SHA verification. Environment
variables cannot add the exception to a previously signed package.

The server must classify the actual installed/candidate database contract as
code-only. A migration or unclassified database change rejects the emergency
authorization. The exception only removes the future match/sales transition
horizon restriction. It retains the 900-second wall-clock and monotonic-clock
lease limit, data and generation identity, source signatures, the unique root
release lock, capacity, result archive integrity, candidate checks and normal
rollback. Expired, future-dated, malformed or different authorization is rejected.

This is a one-off authorization. Remove the JSON in a later ordinary release;
its presence must not silently grant a permanent schedule exception.

The inherited UI change fixes whole-day reviewed-envelope parsing while keeping
per-record identity, price, handicap, score and hash validation. The 27 existing
reviewed records stay unchanged. Deployment success is separate from observing
their actual desktop/mobile display and from trained-model validation.
