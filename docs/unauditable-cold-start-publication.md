# Withhold unauditable cold-start directions

## Policy

When official Sporttery odds are absent **and** the existing audited-input
threshold is not met, newly computed predictions remain `WATCH`, with tier
`input-insufficient-watch`, zero quoted odds, and no public final probability
or projected score. The internal diagnostic model remains available for audit.
This is not a formal recommendation and is not a new accuracy observation.

Previously `suppressUnauditableDirectionalTips` constructed this neutral result,
then restored the unsupported original directions as cold-start references.
Six synthetic unmapped fixtures passed through the real builder reproduced
six home directions and a blocked batch. The corrected builder withholds all
six directions; the existing bias audit therefore has no public directional
rows to reject for this fixture.

This does not relax any batch-bias thresholds, manufacture balanced picks,
override existing immutable publications, or prohibit model-only references
whose audited inputs are sufficient. Other genuinely biased batches still
fail closed. It is not a general source-only publication fallback.

## Evidence and limits

- Regression `verifyRecommendationBatchBias.cjs` exercises the real builder
  and audit, including rejection of actual cold, repeated, or conflicting
  published directions.
- Direction, confidence and eligibility tests distinguish insufficient inputs
  from sufficient model-only inputs.
- On 2026-09-08, 17 regression groups passed, including archived cutoff,
  frozen authority, public-reference integrity, execution clocks and fast
  result publication. Local report:
  `outputs/cold-start-regression-1788830296178.json`.
- Eligibility used a sealed historical model-evaluation fixture; this is not
  a fresh backtest or evidence of improved hit rate.

Production r705 aborted before swapping because the old worker's official
sync failed the `dominant-direction-with-cold-start-majority` gate. The rejected
live draft was not persisted. The synthetic reproduction proves a concrete
implementation defect, but cannot identify every member of that live cohort.
The aborted release retained r699, with 601 archived and 15 public-reference
objects unchanged against its immediate pre-release baseline.

A new signed release must still satisfy the fresh old-worker publication gate,
database parity, immutable-record continuity and post-swap checks. This patch
alone does not prove that the old runtime can pass that pre-swap gate; do not
replay r705 or bypass the gate to install it.
