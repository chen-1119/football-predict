# Trained league baseline adoption

## What this change implements

The existing V3 loader cannot load the league-history experiment format. This
change adds a separate, versioned `league-trained-baseline-v1` adapter, without
relabelling those parameters as a dynamic-goal V3 artifact.

The data path is:

1. `registerLeagueBaseline.cjs --prepare` verifies original CC0 files, hashes,
   collection clocks and the training report, then replays fitting. A candidate
   must pass the chronological statistical holdout. Its selected mixture must
   currently be pure Poisson, so every outcome comes from one score grid.
2. `--apply` replays exactly the prepared artifact and uses a PostgreSQL CAS
   against the expected active payload hash. Previous and new versions remain
   immutable. Registration returns a separate post-COMMIT readback receipt.
3. The normal recommendation publisher calls the independent league lane.
   It reads the two exact league registry keys, validates parameter/model hashes
   and availability clocks, then computes a new forecast from the loaded model.
4. Signed current-event identity, ordered teams, business day and competition
   identity must agree. Runtime league IDs are derived from the signed league
   name using the existing importer hash. They are not Sporttery numeric IDs.
5. HAD and HHAD prices are extracted by the existing signed-price implementation.
   Their value screens remain separate (`p × SP > 1.05` AND same-market edge
   `> 0.05`). No cross-market bare-probability winner replaces the HAD tendency.
6. The first record per event/model is immutable. It stores the actual forecast,
   original model, signed inputs, model version, parameter hash and input hash.
   A second transaction observes its committed bytes before publishing an ACK.
7. The recommendation-center projection replays the record against the trusted
   collector registry and requires that ACK. The compact team-baseline section
   displays the direction and exposes version/hash evidence under a disclosure.

These are **reference forecasts**, not calibrated formal picks. The existing
formal promotion gates and eight-week prospective CLV requirement are unchanged.
Legacy recommendations, combinations, frozen scores and settlement denominators
are not rewritten. An empty section does not prove live model adoption.

## Operator workflow

Run with Node 22. All arguments are absolute paths; outputs are create-only.

```text
node scripts/registerLeagueBaseline.cjs --prepare HISTORY REPORT br1 BINDINGS NEW_PREPARED_OUTPUT
node scripts/registerLeagueBaseline.cjs --apply HISTORY REPORT br1 BINDINGS NEW_RECEIPT PREPARED_OUTPUT absent
```

For replacement, use the exact current **payload SHA-256** instead of `absent`.
The model content hash and PostgreSQL payload hash are different identifiers.
An unknown COMMIT outcome must be read back before any retry. Never change the
expected hash to make a conflicting registration succeed.

Bindings are reviewed, exact identities, not fuzzy name matching:

```json
[
  {
    "teamId": "team_<existing-derived-id>",
    "teamName": "<exact signed source name>",
    "leagueId": "league_<existing-derived-id>",
    "modelTeam": "<exact trained literal name>",
    "reviewId": "<saved identity review>",
    "reviewedAt": "<actual review time>",
    "evidence": [{"url": "https://<identity-source>", "sha256": "<saved-source-hash>"}]
  }
]
```

Missing optional injury, lineup, fatigue, xG and weather inputs do not block this
history-only baseline. They remain explicitly unused, with no fabricated health
or adjustment values. Untrained teams, absent identity reviews, known neutral
venues, closed events, missing signed prices and future clocks block the event.

## Actual local evidence and remaining live work

- Original Brazil report replay produced parameters hash
  `de3921291ceccf23794f5c96555c3307aa82db6b02939f8fd915324c0bfc058f`:
  1,417 training rows and 29 team literals, selected Poisson weight 1.
- The first prepared artifact had zero mappings. On October 9 at 09:12 Beijing,
  a new private packet was prepared with eight manually reviewed Brazil club
  mappings, using the signed Sporttery identity, exact production team IDs,
  ordered event pairs and UTC kickoff times against opened provider event/team
  pages. Saved web evidence hashes identify factual extracts, not raw HTML or
  provider signatures. No scores or lineup information from those pages entered
  training or prediction. The new model hash is
  `ec51d51f47c2a0513179895e33fe5acbc67f2f25bc557b65cc5d66fd152f1755`;
  parameters are unchanged. It has not been registered in production.
- Finland remains blocked by insufficient holdout rows; it is not silently
  replaced with the Brazil model.
- New online read at Beijing 2026-10-09 01:31 found 12 October 9 target events
  among the bounded current rows, covering other leagues. No October 9 Brazil
  event was observed in that slice. October 8 Brazil inputs are already closed
  and cannot be used as new prospective adoption evidence.
- Protocol tests cover signed-source admission, registration/CAS, immutable
  history, post-COMMIT observation, model/parameter binding, clock rejection,
  probability replay and browser projection. They are not a real PostgreSQL
  deployment, live adoption receipt or evidence of improved hit rate.
- Production requires the new signed source release, reviewed team mappings,
  actual registration/readback, a naturally generated future record and public
  verification. r812 was already running separately when this work began; its
  deployment cannot serve as proof that these new files are installed.

The original training study is statistical time holdout on newly acquired
community results. Historical knowledge time, same-time official prices and
venue identity remain unverified. Do not describe it as a prospective gain or a
comparison against the live model/market.
