# Pre-match evidence sources

This document records which evidence may affect recommendation confidence and
which sources are only suitable for display or manual review.

## Automated now

### Venue and weather context

- TheSportsDB v1 free team and venue endpoints are used only to discover a
  reusable home-team venue reference. Lookup starts from the reviewed English
  team aliases already used by the historical-data connector; a provider row
  is rejected unless its normalized team name matches and its sport is soccer.
- Venue coordinates are parsed from the provider venue map. If a venue has no
  coordinate, its explicit location text may be geocoded by Open-Meteo. The
  resulting mapping is persisted by local team ID so later fixtures do not
  repeat the lookup.
- Discovery is deliberately bounded per worker cycle and unresolved teams are
  recorded with a reason for later review. Crowd-sourced venue mappings remain
  `verified=false` and reference-only until reviewed; they may improve weather
  coverage but cannot by themselves promote a formal recommendation.
- Open-Meteo supplies the hourly forecast after a location is resolved. Weather
  is a small environmental modifier, never a replacement for lineup, injury,
  referee, form, or market evidence.

### Historical team and referee discipline

- Source: Football-Data.co.uk season CSV files already archived under
  `server-data/training/raw/football-data/main-league-season`.
- Release path: the build generates the deterministic compact asset
  `scripts/data/football-data-discipline.json`. It is signed with the release
  bundle, so production does not depend on mutable training files that are
  intentionally excluded from deployments.
- Fields: referee, home/away yellow cards, and home/away red cards.
- Scope: the downloaded main-league files only; unsupported competitions stay
  explicitly missing.
- As-of rule: source rows contain a date but no reliable publication timestamp,
  so only rows strictly before the forecast date are eligible. Same-day rows are
  excluded even if a match appears to have finished.
- Confidence use: a minimum of five historical matches per team is required.
  This is an estimated risk feature and cannot by itself promote a fixture into
  the formal recommendation tier.

## Available after credentials or official publication

### Confirmed lineups and injuries

- API-Football provides fixture, lineup, injury, event, and statistic endpoints,
  but the previously configured account is suspended and production therefore
  keeps this connector disabled.
- A restored API-Football key may be enabled only after the `/status` account
  check succeeds. Confirmed and projected lineups must remain distinct; only a
  confirmed lineup published before the recommendation cutoff can raise formal
  confidence.
- UEFA and LALIGA official match-centre pages can be used as competition-specific
  confirmation sources. Every observation must store source URL, fetched time,
  published time when available, and the match identity used for reconciliation.
- TheSportsDB exposes a free lineup lookup, but coverage is crowd-sourced and
  frequently null. It can be collected as a secondary observation only; it must
  not be labelled confirmed without an official match-sheet cross-check.

### Referee assignment

- K League's official API is the preferred Korean-league source, but it requires
  an issued authentication key. Official competition match sheets are the final
  authority when published.
- UEFA information kits and league appointment pages are acceptable official
  sources when they expose a machine-readable match/referee identity.
- A referee name without historical card or penalty observations is displayed as
  an assignment only and does not count as a connected referee-risk feature.

## Promotion rules

1. Missing evidence remains missing; do not synthesize a lineup, referee profile,
   card history, or injury list.
2. Every feature must be available before the immutable recommendation cutoff.
3. Team/entity resolution must be verified before an external row is attached.
4. New coverage first enters shadow/reference use. Formal confidence may be
   raised only after prospective calibration and hit-rate gates pass on a common
   cohort.
5. Settled, started, cutoff, or otherwise locked recommendations are never
   rewritten by a later data refresh.
