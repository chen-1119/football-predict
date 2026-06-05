# Football Probability Forecast Roadmap

This project should evolve from pick labels into a time-aware probability forecasting system.

## Current Stage

- Official Sporttery HAD / HHAD SP sync.
- Official SP history snapshots.
- Pre-match prediction lock after kickoff.
- Market-implied 1X2 probabilities after overround removal.
- Poisson score-distribution baseline derived from current SP.
- Probability outputs for 1X2, score distribution, over/under 2.5, BTTS, and handicap.

## Next Stages

1. Market baseline
   - Keep simple normalized implied probability.
   - Add Shin or power-method de-margining.
   - Compare all models against market baseline.

2. Team strength layer
   - Build Elo ratings by league and team.
   - Add home advantage and recent-form decay.
   - Store pre-match Elo snapshots only.

3. Goal model layer
   - Add Dixon-Coles / Poisson attack-defense model.
   - Fit league-level home advantage and low-score correction.
   - Output lambdas and full score matrix.

4. Backtest layer
   - Use rolling time splits only.
   - Metrics: log loss, Brier score, calibration error, and closing line value.
   - Never random-split football matches.

5. Calibration layer
   - Reliability diagrams by league, odds band, and home/away.
   - Platt or isotonic calibration when sample sizes are sufficient.
   - Store model version and calibration version with every prediction.

6. Data expansion
   - xG / xGA and non-penalty xG.
   - Injuries, suspensions, lineups, rest days, travel, weather, referee.
   - Each field must be timestamped and available before kickoff.

## Data Integrity Rules

- Do not use post-match xG, shots, possession, or final table data for pre-match predictions.
- Do not rewrite historical predictions after kickoff.
- Result settlement may update hit/miss status only.
- Missing data must be shown as insufficient, not inferred as fact.
