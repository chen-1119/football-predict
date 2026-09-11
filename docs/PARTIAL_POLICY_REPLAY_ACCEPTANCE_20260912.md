# Per-market replay remains separate from formal recommendation promotion

r729 completed its new official worker publication but final readiness rejected
a valid shadow state: HHAD had 126 exact replay rows and HAD had 96, below the
unchanged 100-row per-market threshold. The validator incorrectly assumed that
both markets must be unvalidated whenever overall replay eligibility is false.
The server automatically rolled back; r729 is not an accepted bootstrap.

The validator now derives the exact validated market set, requires both reports
to agree, requires overall replay eligibility to equal policy identity AND both
market flags, and requires the precise missing-market/identity blockers. Every
incomplete case must remain shadow-only with promotion disabled. No predictor,
sample threshold, historical evidence, strategy or recommendation is changed.

47 direct checks execute the actual validator predicate before signing: every
market subset and policy identity, contradictory summaries, missing blockers,
and false promotion. Normal signed deployment and complete live acceptance
remain mandatory.
