# Current recommendation publication authority

Production PostgreSQL readers and the code release preparation check use the same `TRAINED_ONLY_POLICY` object from `server/recommendationAuthority.cjs`. Copying that object into JSON, or adding a retirement flag to a match, does not grant server authority. Callers without the trusted object retain the existing strict behavior.

## Evidence and current availability

The caller owns one repeatable-read, read-only transaction. Authority reads the persisted recommendation center and the actual reviewed and trained freeze/ACK records through that transaction's client. It verifies original artifact bytes, hashes, signed source evidence, deterministic replay, directions, exact SP, identities and clocks before comparing the stored public view.

The stored center is replayed at its own `updatedAt`. A newer committed publication is excluded from that older view only after its real freeze and ACK have passed validation. A new freeze without an ACK can remain pending only when it was created after the center and its original deterministic replay succeeds. An older freeze missing its ACK remains an error. A missing public lane is `unavailable` only when replay confirms no records belonged in that view.

At midnight a valid prior-day center remains readable as `stale`; it does not become today's publication. Current availability and open/closed counts use the actual read clock. Existing UI business-day and cutoff checks continue to suppress stale or expired recommendations. Integrity success does not claim model reliability or the existence of an eligible combination.

Repeated deterministic replay may reuse a bounded cache of four results and at most 32 MiB. Every hit still rereads and verifies the original records through the caller's own repeatable-read transaction; exact original evidence, ACK, registry and center inputs must match. Authority, current clock checks and the complete stored-view comparison run on every request. Concurrent reuse is bounded and never substitutes a cached database snapshot or an authority flag for evidence.

## Public projections and historical evidence

Only the current public projection clears retired legacy `predictions`. It retains original archives and marks their state as `valid`, `missing` or `none`. Any existing invalid archive still fails validation. Raw PostgreSQL rows, internal settlement readers and historical readers are unchanged.

When the current center has no reviewed records, its existing authenticated endpoint can also return `reviewedAnalysisHistory` for the single most recent stored day before the center's business date. This is read through the same read-only transaction, replaying original freezes, signed sources and committed ACKs at the actual clock. It does not modify today's center, authority or coverage counts. The separate history field preserves the original day and singles and carries empty combo arrays: reviewed freeze records never independently stored those derived combinations, so the reader cannot claim newly reconstructed combinations were original historical publications.

An in-process private token survives ordinary server object spreads and prevents the public projector from restoring a retired legacy direction from an archive. The browser's public marker only suppresses legacy reference/model fallback paths; it cannot authorize a server gate. Reviewed and trained recommendations retain their own existing publication and cutoff rules.

Remote verification accepts retirement only when the protected current response carries a complete, recent authority receipt, every row agrees with that receipt and current predictions are empty. Existing archives and list/detail identity, direction and SP comparisons remain independently checked. Match-level flags alone retain strict verification.

## Health coverage and public readiness

The health reader binds the complete current snapshot to the authority produced by the same repeatable-read transaction. Its private summary and exact row-token membership must agree after normal server projections. Copied summaries, JSON rows, omitted or duplicated rows, and rows from a separate transaction cannot authorize retired coverage. A genuinely empty snapshot is distinguished from a removed subset; missing authority under the trusted production policy fails closed.

Raw BEST/WATCH and HHAD missing counts remain visible. `retiredDispositionMatches` counts absent legacy dispositions; `retiredHhadOnlyDirectionMatches` counts absent legacy HHAD-only directions. The two `effectiveMissing*` counters subtract only these verified retired requirements. `legacyCoverageOk` and `dualMarketAtomicCoverageOk` preserve their raw meanings and may remain false while engineering readiness is true.

Engineering readiness still requires training lineage on every scheduled row, valid actual HAD/HHAD atomic bindings on every eligible dual-market row, no effective missing requirements, and list/detail projection parity. Public readiness checks the complete authority summary, freshness, bounded integer counts and exact raw/retired/effective relationships. No authority retains strict legacy requirements. This does not create recommendations: reviewed/trained record and open counts remain unchanged, including zero open records and stale business days.

## Verification and operations

The focused tests cover trusted and copied policies, real freeze/ACK replay, changed SP/directions/hashes, missing ACKs, as-of refresh gaps, midnight, preserved archives, read-only transaction boundaries, browser fallback suppression and remote receipts. Coverage tests run the actual server coverage function, actual dual-market validator and actual remote coverage check together, including the retired HHAD-only case and rejection after rehashing altered event, clock, direction, SP, line or provenance claims. These tests are required by `verifyReleaseVerifierContracts.cjs` and are included in both release archive lists.

Code release preparation also requires the actual current generation pointer to match the PostgreSQL snapshot on all four publication identity fields. An intact newer current generation whose intact previous generation exactly matches PostgreSQL is a bounded preparation wait while normal publishers remain running. Corrupt or inconsistent generations fail immediately. The seed checks again before copying, and the final current-pointer check remains mandatory; neither check refreshes the original 900-second cutover lease.

The authority mechanism does not migrate data, create an archive, train a model, extend a release authorization, or perform a deployment. Any separately issued release authorization retains its own actual-clock validation. Full release verification and live acceptance remain separate operations.
