# Selected-event pairing verification

Run the development verification with Node 22:

```sh
node scripts/verifyRecommendationPairedEventScoring.cjs
node --test tests/model-backtest-dev-entrypoint.test.cjs
```

The verifier imports the actual `recommendationSelectionComparison` exported by
`scripts/runModelBacktest.cjs`. It checks the existing same-event model/market
scoring, production-policy replay, gates, time ordering and input isolation.
The signed synthetic fixture verifies constructor/replay/settlement wiring; its
scores are test data and do not establish real recommendation performance.

The old command `node scripts/runModelBacktest.cjs --verify-selected-event-pairing`
now exits with code 2 and directs the caller to the verifier above. It must not
fall through into a real backtest. The other existing `--verify-*` commands keep
their CLI behavior.

The production backtest no longer imports the development verifier or its test
signing fixture. Importing its exported comparison does not run the backtest or
CLI self-tests. No scoring formula, weight, threshold, event-selection rule,
input isolation guard, or production activation rule is changed by this split.
