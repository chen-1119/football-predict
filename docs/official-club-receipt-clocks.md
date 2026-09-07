# Official-club response receipt clocks

## Reproduction and change — 2026-09-07

The real `syncOfficialClubResults` function previously captured one observation clock before its sequential requests. An isolated transport test made the first full body arrive 15 seconds later and the second at 40 seconds: both records incorrectly used batch start. The test failed before the implementation fix.

The fetch path now records receipt after the full body is available. Each source uses that receipt as its observation; batch `checkedAt` is sampled at completion. Request-to-receipt ordering is validated. Caller-supplied offline responses must explicitly contain a strict `receivedAt`; the former batch `options.nowMs` cannot manufacture a receipt. No tracked caller relied on that option.

Newer valid result evidence cannot be replaced by an older observation, even if the older response declares a changed score. Invalid `firstObservedAt` values are not carried forward: same-score updates retain that value only if it is a valid instant between kickoff and the previous observation, otherwise retain the validated previous observation. Valid repeats retain their first observation and revision. A failed source preserves its exact old evidence while another source can still update.

This does not reconstruct historical network receipt times. Older timestamps are not retroactively certified as precise receipts. The numeric result hash, source allowlist, formal promotion prohibition, frozen recommendations and statistical denominators are unchanged. Transport redirect and streaming-size behavior are outside this patch.

## Evidence

- New verifier: **21 behavioral checks**, executing the real fetch/body/parser/build/store pipeline with mocked transport and clock in an owned temporary directory; six mocked fetch calls, zero network calls and zero production data writes.
- Cases cover sequential completion times, batch completion, valid 0:0, repeat stability, missing/invalid receipt, backwards evidence, malformed first observation, reversed/invalid request interval, old score correction and partial upstream failure.
- Existing strict-score verifier: **41 cases**; archived recovery verifier passes; public-reference integrity **46**; lifecycle reconciliation **29**; archived cutoff passes.
- Future readiness runs the receipt verifier and requires all 21 cases with zero network/production writes. Future signed bundles must include it. Release verifier contracts **41** pass, including actual readiness gate acceptance/rejection in isolation. Targeted ESLint and diff checks pass.

Full local plan coverage is **not green**: 104 total checks, 99 required, 10 required failures. Two report that the independent worktree has no SQLite database. The remaining eight report absent model evaluation/digest and missing or inconsistent strategy, calibration, risk, HHAD and model-signal artifacts. The official-club plan check passes. These are not waived, and local contract checks do not constitute full production readiness or model-quality proof.

## Deployment boundary

At 2026-09-07T15:50:58.529Z the exact r702 queue PID 3577920 was alive, `waiting-not-before`, `attempted=false`, release status absent. Its planned single attempt remains September 8 at 03:31 Beijing, subject to live safety gates. Both live bundle markers remained r699 (`e4bb349180b3dfce4df305fc8fdb2820868709208ae660b13fb018a825a343ef`).

This source change is not in signed r702 (`6f86e44c61c98ce3763c0b1a0a56f9cc671724ab`). That worktree and queue were not changed or duplicated. Full Q1–Q5, actual current-source adoption, the historical public-direction dispute, independent prospective model evidence and deployment acceptance remain open.
