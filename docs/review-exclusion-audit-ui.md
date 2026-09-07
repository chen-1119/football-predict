# Review exclusion audit UI

Verified 2026-09-07, against integrated base `abf8b47dbac80fc61e01e070cb1980a39f2703f9`.

The review evidence overview now exposes the server ledger's exclusion counters in a keyboard-accessible, initially collapsed panel. Formal and reference ledgers remain separate; research shadow does not inherit their counters.

## Contract

- Require a validated complete all-time ledger before showing counters as verified.
- Show before-start, invalid-date, invalid-identity, duplicate-record, conflicting-event and track-specific missing-frozen-settlement counters.
- Accept only own-property, nonnegative safe integer values. Missing and malformed values show `—`, never fabricated zero.
- Unknown counter names keep the audit incomplete and display a schema-check notice.
- These are full-input counters, including pre-start rows, not counts filtered by the selected period or market. Record and event units are explicit and never summed.
- No change to historical directions, settlement membership, rates, recommendation eligibility or model weights.

## Verification

- `npm.cmd run verify:review-dashboard`: 18 grouped checks passed, including malformed, missing, inherited and unknown-schema cases and actual TSX rendering.
- `npm.cmd run verify:review-performance`: 29 existing aggregation/presentation checks passed.
- `npm.cmd run verify:analysis-reference-selection`: 54 direction-selection scenarios passed.
- Full-App browser suite: 39 scenarios passed at 390, 768 and 1440 pixels; no runtime errors or unexpected requests. Keyboard opening, unchanged filtered rates, invalid counters and prior frozen-direction scenarios all exercised.
- Build and targeted ESLint passed; existing unrelated media warning and PredictionsList lint issue are not claimed fixed.
- Reviewed the 390px and 1440px rendered screenshots. Tests use isolated synthetic HTTP data, not production performance evidence.

This follow-up is not in the already signed r695 bundle. It must be integrated and independently released after that transaction reaches a terminal state. No deployment was restarted for this UI addition.
