# Free football source pipeline

The new `collectors/football-sources` pipeline is independent of the Leisu browser and does not replace or rewrite official Sporttery SP, results, decisions, or frozen combinations. It serves reference facts through the existing authenticated prematch-evidence route. Injury/lineup collection and priority requests continue to use the existing API-Football budgeted job; this worker makes **zero additional API-Football calls**.

## Sources and scope

- football-data.org v4: matches and standings for the supported free competitions. `FOOTBALL_DATA_ORG_TOKEN` is required. This is NOT Football-Data.co.uk. No paid upgrade or private scraping endpoint is used; absent/rejected tokens do not trigger retries with another account.
- OpenLigaDB: bl1/bl2/bl3 fixtures and regulation-time historical league scores. Results are reference only, never accepted as official Sporttery settlement. No API key is required. ODbL attribution is retained; deployment must review the corresponding database reuse/redistribution obligations.
- MET Norway: Locationforecast compact, only for explicitly verified, event-bound stadium coordinates. No IP/user geolocation, guessed home stadium, or geocoding is performed. CC BY 4.0 attribution is retained. User-Agent identifies this project. Cache validators and Expires are respected.
- Existing API-Football/Leisu injury-lineup readers stay intact. Neither Leisu success nor a new paid API account is required by the new basic-facts worker.

Exact full-name alias candidates from `scripts/freeFootballTeamAliases.cjs` are reused. An API fixture must also match the configured competition, exact kickoff and ordered home/away names uniquely. Operator additions in the bindings file are provider-scoped. Unmatched fixtures remain explicitly unmatched; youth/reserve/women suffixes are not removed.

The basic pipeline supplies fixture cross-check, recent 90-minute form (up to 10 samples), table positions and venue weather. It does NOT claim new universal coverage of injuries, confirmed lineups, live xG, or odds history.

## Runtime integration

`plan -> bounded fetch -> parser -> PostgreSQL raw receipts/cache -> exact event binding -> match_views -> existing prematch-evidence reader -> SupplementaryFootballFacts`

No external request runs in the detail GET path. Cache receipts preserve observedAt; 304 only changes checkedAt and expiration. A failed source retains the last successful cache. Each provider has its own persisted rate budget and cooldown. One provider's failure does not block the other provider loops. The official match table is read, never written. Input identity is checked again when committing a view. All new facts remain `predictionEligible:false` until separately evaluated for model adoption.

## Install (explicit release step; no startup DDL)

1. Install the source and run `node collectors/football-sources/run.cjs --migrate` using the authorized schema owner. This only creates the additive `football_sources` schema, not the application's migration ledger.
2. Grant the actual deployed reader role SELECT on cache/match_views; grant the collector role SELECT/INSERT/UPDATE for its tables and sequence usage. Do not grant access to browser sessions or application account credentials. The existing football.match_snapshots table only needs SELECT.
3. Set `FOOTBALL_DATA_SOURCES_ENABLED=1` for the website process. Configure `FOOTBALL_DATA_ORG_TOKEN` in the server-only environment for the collector; never in a VITE_* variable or committed JSON.
4. Optionally set `FOOTBALL_SOURCE_BINDINGS_FILE` to the operator's JSON based on bindings.example.json. A venue entry is `{matchId,eventVersion,verified:true,lat,lon,label}`; eventVersion must resolve to the exact match kickoff. No venue examples are auto-applied to real matches.
5. Install `football-free-sources.service` and `.timer`. The timer is five minutes; per-source TTLs normally avoid requests each tick. Existing injury/lineup jobs remain independent. No Leisu job is enabled or unblocked by this release.
6. Execute one successful collector cycle and validate the authenticated detail route. UI and server changes must be deployed together.

Each source has a conservative per-request interval and daily budget (FD.org 240; OpenLigaDB and MET 300). These are local caps, not claims about contractual provider limits. The loop also caps eight requests per provider per cycle. 401/403 pauses the source; 429 honors Retry-After. There is no captcha bypass, proxy rotation, background login or purchase.

## Validation

- `node --test tests/football-sources.test.cjs`
- `FOOTBALL_SOURCES_TEST_DATABASE_URL=postgresql://...@127.0.0.1/test node tests/football-sources-postgres.cjs`: creates/drops a unique test schema only; no production connection fallback.
- `node tests/football-sources-smoke.cjs qa/free-source-smoke.json`: one public request to OpenLigaDB and one to MET. FDO/authenticated API-Football are explicitly not tested without tokens. A smoke report is evidence of that environment only, not production-server reachability.
- `npm run build` plus existing recommendation/prematch regressions.

References: https://docs.football-data.org/general/v4/match.html ; https://docs.football-data.org/general/v4/policies.html ; https://github.com/OpenLigaDB/OpenLigaDB-Samples ; https://api.met.no/weatherapi/locationforecast/2.0/documentation ; https://api.met.no/doc/TermsOfService
