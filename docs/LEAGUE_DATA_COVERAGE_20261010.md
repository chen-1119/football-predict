# League data acquisition, 2026-10-10

This change adds a local, reproducible research-history collector. It does not change the running publisher, model registry, timers, or production database.

## Actual acquisition

- Fresh downloads of the pinned OpenFootball JSON and Europe repositories; CC0 license bytes retained with each capture. JSON and text from the same upstream are not independent corroborating sources.
- JSON: 58 files, 17,451 explicit full-time rows; 3,500 ambiguous, unplayed, future or nonordinary rows excluded.
- Text: 10 files, 2,567 ordinary-score rows for Sweden, Norway and Netherlands second division; 393 excluded. Capture time does not prove historical availability.
- Most major-league JSON ends on 2026-09-20. Japan ends on 2025-05-03; Sweden/Norway text ends on 2025-05-04. These are training research inputs, not current last-five evidence.
- Korea official POST APIs responded successfully for standings and August–October schedules. Raw responses and request/receive times are retained privately. A single official source does not satisfy the user's two-independent-source requirement for current team facts.

## Reproducible commands

Use an absolute clean repository path at the pinned commit, a new absolute output directory, and the real acquisition timestamp:

```text
node scripts/collectExpandedLeagueHistory.cjs ABS_JSON_REPOSITORY ABS_NEW_OUTPUT ISO_ACQUISITION_TIME
node scripts/collectExpandedLeagueHistory.cjs --text ABS_EUROPE_REPOSITORY ABS_NEW_OUTPUT ISO_ACQUISITION_TIME
node --test tests/expanded-league-history.test.cjs
```

The collector reads canonical Git blob bytes so Windows checkout newline conversion cannot alter the archived source. Existing output is never overwritten. Source raw hashes, exclusions, licensing and missing coverage are retained. Fixed source commits make this an auditable acquisition, not a silently updating live crawler.

## Automatic acquisition: installed versus still required

The inherited worker already has official Sporttery collection and an 11:00 Beijing opening wake. Its optional `sync:k-league-standings` step uses the shared slow-artifact lock and is enabled unless explicitly disabled. The presence of that job does not prove a particular run succeeded or that the trained-model lane consumed its output.

This new multi-league history collector is not attached to a production schedule. Completing automatic refresh requires an approved source manifest update, append-only raw captures, event/team identity verification, acquisition timestamps, per-league freshness and failure metrics, and an accepted adapter into the model/evidence store. Training and registration remain separate from collection.

## Missing-data behavior to complete

1. With valid league parameters and enough verified history, missing injuries, xG or confirmed lineups may use the applicable validated baseline; label missing fields. Do not invent numerical impacts or claim full evidence.
2. Without valid league parameters, sufficiently corroborated team facts can support a separately labelled reviewed reference. That requires a real review record and a successful production commit/ACK; the currently installed reviewed lane supports only its existing report format, not automatic all-format fallback.
3. Unverified event identity, sale status, official market/line or current SP blocks that actionable selection. Preserve an explanation and retry acquisition; never reuse an expired quote as current.
4. A changed quote or lineup is an input update, not automatic proof that direction must change. Automatic re-evaluation/version publication is a separate unfinished integration. Never overwrite a closed prediction.

No claim of new online recommendations, learned weight improvements, all-league coverage, or formal admission is made by this data acquisition.
