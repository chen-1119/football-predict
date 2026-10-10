# Current recommendation publication authority

Production PostgreSQL readers and the code release preparation check use the same `TRAINED_ONLY_POLICY` object from `server/recommendationAuthority.cjs`. Copying that object into JSON, or adding a retirement flag to a match, does not grant server authority. Callers without the trusted object retain the existing strict behavior.

## Evidence and current availability

The caller owns one repeatable-read, read-only transaction. Authority reads the persisted recommendation center and the actual reviewed and trained freeze/ACK records through that transaction's client. It verifies original artifact bytes, hashes, signed source evidence, deterministic replay, directions, exact SP, identities and clocks before comparing the stored public view.

The stored center is replayed at its own `updatedAt`. A newer committed publication is excluded from that older view only after its real freeze and ACK have passed validation. A new freeze without an ACK can remain pending only when it was created after the center and its original deterministic replay succeeds. An older freeze missing its ACK remains an error. A missing public lane is `unavailable` only when replay confirms no records belonged in that view.

At midnight a valid prior-day center remains readable as `stale`; it does not become today's publication. Current availability and open/closed counts use the actual read clock. Existing UI business-day and cutoff checks continue to suppress stale or expired recommendations. Integrity success does not claim model reliability or the existence of an eligible combination.

Repeated deterministic replay may reuse a bounded cache of four results and at most 32 MiB. Every hit still rereads and verifies the original records through the caller's own repeatable-read transaction; exact original evidence, ACK, registry and center inputs must match. Authority, current clock checks and the complete stored-view comparison run on every request. Concurrent reuse is bounded and never substitutes a cached database snapshot or an authority flag for evidence.

## Public projections and historical evidence

Only the current public projection clears retired legacy `predictions`. It retains original archives and marks their state as `valid`, `missing` or `none`. Any existing invalid archive still fails validation. Raw PostgreSQL rows, internal settlement readers and historical readers are unchanged.

An in-process private token survives ordinary server object spreads and prevents the public projector from restoring a retired legacy direction from an archive. The browser's public marker only suppresses legacy reference/model fallback paths; it cannot authorize a server gate. Reviewed and trained recommendations retain their own existing publication and cutoff rules.

Remote verification accepts retirement only when the protected current response carries a complete, recent authority receipt, every row agrees with that receipt and current predictions are empty. Existing archives and list/detail identity, direction and SP comparisons remain independently checked. Match-level flags alone retain strict verification.

## Verification and operations

The focused tests cover trusted and copied policies, real freeze/ACK replay, changed SP/directions/hashes, missing ACKs, as-of refresh gaps, midnight, preserved archives, read-only transaction boundaries, browser fallback suppression and remote receipts. New tests are required by `verifyReleaseVerifierContracts.cjs` and are included in both release archive lists.

The authority mechanism does not migrate data, create an archive, train a model, extend a release authorization, or perform a deployment. Any separately issued release authorization retains its own actual-clock validation. Full release verification and live acceptance remain separate operations.
