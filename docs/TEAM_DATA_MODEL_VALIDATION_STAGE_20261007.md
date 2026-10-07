# Current-event team research and model validation stage

## Implemented boundary

`officialClubResearchEvidence.cjs` is a pure, bounded research staging adapter.
It consumes the existing online-reader response and original remote bytes,
explicit manually reviewed event/ordered-team mappings, original HTTP page
bytes, acquisition clocks, and short literal fact spans. It performs no fetch,
PG write, feature admission, model registration or prediction publication.

The staging receipt keeps source URL, raw-byte hash, real acquisition time,
publication evidence when available, manual mapping hash and literal span
offset/hash. The existing online reader is replayed before staging; a new
source-page hash is never treated as provider authentication.

All records remain `formalEligible=false`, `sourceVerification=unverified`,
`numericFeatures=null`, and `actualTraining=false`. A missing stable player ID
or unconfirmed current-event absence remains unknown. Unknown/restricted reuse
permissions do not authorize automated training or source admission.

## Current online evidence and limits

New read-only production inputs for the October 7 business day passed the
existing reader with six event identities. New bounded team-history reading
returned three team rows representing only two distinct result events across
twelve teams. Nine teams had no corresponding rows. This is not a complete
fixture history, a valid recent-rest calculation, or a training dataset.

Current public club-page acquisition produced literal schedule and availability
research. It does not prove complete squads, player contributions, xG,
actual previous-match end times, or confirmed starting lineups. Private raw
pages and business exports remain outside Git and release archives.

The adapter explicitly cannot promote a future fixture's default 0-0, a default
90-minute display, a planned end time, or conflicting machine/local timestamps
to a settled result or a measured fatigue feature. Short medical news is not
automatically a confirmed match absence.

## Next model-validation requirements

1. Resolve explicit source/event/team/player identities and reuse admission;
   keep restricted/unknown sources in research staging.
2. Acquire complete recent schedules with actual 90-minute results and end
   observations. Unknown rest days/minutes remain null.
3. Build and register an independently reproducible zero-market baseline with
   honest training/availability watermarks. Current mixed probabilities are
   not a replacement for that artifact.
4. Freeze prospective observations, the baseline, same-time HAD prices and
   model/feature versions before the cutoff. Later result revisions attach
   without changing the frozen prediction hash.
5. Start with explicitly selected home/away rest-day features only when complete
   evidence exists. Split by independent match days, then compare baseline,
   factor model and same-time market on held-out Brier/Log Loss/calibration and
   coverage. No tiny-cohort accuracy claim or parameter activation.

The existing learner's small research fit minimum is not formal promotion.
Formal model/sample/window gates stay unchanged; two/three-leg recommendations
remain subject to their existing quality gates.

## October 7 follow-up research

A new pinned production read at 12:05 Beijing verified the six current event
identities. The actual shadow runner found six market references, zero admitted
zero-market baselines, zero trained parameter artifacts and zero known team
feature families. It produced no frozen learning records or formal directions.
Its blockers include missing source contracts, goal rates, trained parameters
and Asian-handicap timelines. This is a new online-input validation, not a fit
or an accuracy result.

A separate bounded public acquisition pinned OpenFootball's South America
repository and its CC0 license. The 2026 Brazil file contains 380 scheduled
rows, of which 277 have past score labels. Across the ten current Brazil teams,
27–28 such labels per team represent 277 team appearances but only 216 distinct
target-related events. The latest score label is September 20, so complete
recent coverage is not established. One explicit postponed row is isolated.
The five current Brazil fixtures have no score and cannot be settled early.

Follow-up acquisition of the official Football.TXT specification proves that
ordinary scores map to its FT field: 261 of these labels include HT and 16 do
not; none contains an AET/PEN result requiring separate FT extraction. This is
format semantics, not independent official 90-minute-result verification.
Canonical ordered-team admission, actual end times and historical availability
clocks remain missing. The new receipt time cannot supply those fields.
In the pinned European repository
tree, Finland 2026 was not found; older seasons were not substituted. Private
raw files, line spans, hashes, source commits and coverage receipts remain
outside Git. No records were written to the production dataset or model registry.
