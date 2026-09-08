# Stable recommendation policy contracts in release verification

2026-09-08. r707 exited **before cutover**, at 03:27:15Z. Its full candidate
readiness report passed 176/177 checks. The only failure was production plan
coverage, specifically the multi-factor shadow-safe gate (104 total plan checks,
99 mandatory). The fixed failed release identity must not be replayed.

The gate searched for an obsolete human-readable test name: the earlier
cold-start reference behavior had been replaced by withholding unauditable
directions, but the string-based coverage assertion still expected the old
description. The actual recommendation eligibility verifier passed on the
candidate. This was not evidence that the model qualified for promotion.

The behavioral check now reports `model-only-input-sufficiency-v2` independently
of its display description. Coverage requires this stable declaration; readiness
also requires its actual boolean result, the verifier's overall pass and process
exit zero. A missing/false contract is rejected even if the declaration appears
in source. The no-input WATCH policy, formal exclusion, zero-SP handling and
chronological shadow rules are unchanged.

17 additional contract regressions execute the actual coverage/readiness
expressions and actual model-only behavioral assertion. They reproduce the
original stale-name failure, allow description-only changes, reject a missing
contract, false result, failed child, fabricated cold-start direction, executable
recommendation, positive odds and settled result. The full verifier-contract
suite now has 189 checks.

The actual eligibility verifier passes 17 checks and reports the new contract as
true using the already sealed r707 local evaluation bootstrap. An initial run
without a local evaluation artifact correctly failed five artifact checks; that
failure is retained. The later scoped run does not claim a freshly rebuilt
production evaluation, full production-plan pass or successful deployment.

Evidence: UI worktree `outputs/worker-preflight-regression-1788838527043.json`;
r707 `outputs/failure-evidence-1788838717551.json`. Four affected JavaScript files
pass ESLint. The r707 archive/package/source remain unchanged.

## Post-abort integrity

593 existing frozen archives remained byte-content-identical. The earlier eight
missing archives still require restoration by a successful new release; the
target stays 601, not 593. A strict comparison of current reference pointers
flagged four changes; it was not silently treated as passed. A separate read-only
generation-bound ledger audit verified all 32 original full objects retained,
plus four valid pre-cutoff parent-linked revisions. Direction, market and
handicap line remained the same; one quoted SP changed from 1.95 to 2.02.

The ledger read verified the complete 449,713,724-byte source digest while
materializing only 212,213 selected characters. Current-pointer equality and
historical-object immutability are different claims. Future acceptance must
verify both immutable originals and explicit legal revision chains; this audit
is not a waiver for missing, changed or post-cutoff original records.

Evidence: r707 `outputs/abort-integrity-1788838371742.json` (strict pointer check
failed, preserved as such) and `outputs/public-reference-revision-audit-1788838653854.json`
(32 originals, 36 ledger rows). Neither proves the original Newcastle screenshot
incident was reconstructed or the full Q1–Q5 objective completed.
