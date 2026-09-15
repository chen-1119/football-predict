# Market collector optimization

This change adds a low-cost market ingestion lane that reuses the existing 500.com parser but no longer requires the full JSON publication pipeline for every market observation.

## Why

The legacy `scripts/sync500Data.cjs` is still useful for the public external-signal snapshot, but each execution downloads the whole JCZQ page, parses all rows, merges a large JSON object and rewrites `public/data/external-signals.json`. That is appropriate for a publication snapshot, not for high-frequency market history.

The new collector separates ingestion from publication:

1. Download the public JCZQ page once per polling cycle.
2. Reuse the existing parser to extract HAD/HHAD rows for all matches.
3. Hash the normalized market state without receipt time.
4. Append a new PostgreSQL observation only when the market state changes.
5. When unchanged, update only `last_seen_at` and `seen_count`.
6. Dynamically slow down when no match is close and speed up as kickoff approaches.
7. Add random jitter so every request does not occur at a perfectly fixed boundary.
8. Record collector runs, response body hashes, row counts, failures and the chosen next interval.

This design does not attempt to bypass access controls, CAPTCHAs or provider anti-bot protections. HTTP 403/429 responses are treated as a blocked source and trigger a longer backoff.

## PostgreSQL schema

Migration `007_market_collector_runtime.sql` adds:

- `football.market_collector_runs`: one audit row per collection attempt.
- `football.market_observations`: append-only changed market states.
- `football.market_latest`: pointer to the latest state for each source/match/pool/bookmaker.

It intentionally does not replace `football.odds_snapshots`. The latter remains the serving/projection layer used by the current API. The new tables are the raw acquisition layer and can later feed the projection in a controlled publication step.

## Scheduling policy

Default polling interval is selected from the nearest upcoming match:

| Time to nearest kickoff | Poll interval |
| --- | ---: |
| <= 15 min | 60 sec |
| <= 60 min | 120 sec |
| <= 120 min | 300 sec |
| <= 6 h | 600 sec |
| <= 24 h | 900 sec |
| > 24 h | 1800 sec |
| no future match | 900 sec |

Each sleep receives 0.85-1.15 jitter and never goes below `MARKET_COLLECTOR_MIN_SECONDS`.

Environment overrides:

```bash
MARKET_COLLECTOR_MIN_SECONDS=60
MARKET_COLLECTOR_MAX_SECONDS=1800
FIVE_HUNDRED_JCZQ_URL=https://trade.500.com/jczq/
```

The production database connection continues to use the repository's existing `FOOTBALL_POSTGRES_URL` / `DATABASE_URL` configuration.

## Rollout

Apply the migration through the existing privileged migration lane before starting the collector:

```bash
npm run postgres:migrate-schema
```

Run the pure behavior verification:

```bash
node scripts/verifyMarketCollector.cjs
```

Perform one live collection attempt:

```bash
node scripts/runMarketCollector.cjs
```

Run continuously:

```bash
node scripts/runMarketCollector.cjs --loop
```

For the light-server deployment, install `deploy/light-server/football-market-collector.service` and enable it with systemd after the migration has been applied.

## Useful SQL

Latest markets:

```sql
SELECT
  latest.source,
  latest.source_match_id,
  latest.pool,
  latest.bookmaker,
  observation.first_seen_at,
  observation.last_seen_at,
  observation.seen_count,
  observation.payload
FROM football.market_latest latest
JOIN football.market_observations observation
  ON observation.observation_id = latest.observation_id
ORDER BY observation.kickoff_time, latest.source_match_id, latest.pool;
```

Market trajectory for one match:

```sql
SELECT
  pool,
  first_seen_at,
  last_seen_at,
  seen_count,
  payload->>'odds1' AS home_odds,
  payload->>'oddsX' AS draw_odds,
  payload->>'odds2' AS away_odds
FROM football.market_observations
WHERE source = '500.com:jczq'
  AND source_match_id = $1
ORDER BY first_seen_at, pool;
```

Collector health:

```sql
SELECT
  started_at,
  status,
  rows_seen,
  rows_changed,
  rows_unchanged,
  next_poll_seconds,
  error_code,
  error_message
FROM football.market_collector_runs
ORDER BY started_at DESC
LIMIT 50;
```

## Next integration step

2026-09-15 deployment adds `collectors/market/signalBridge.cjs`: the existing PostgreSQL-mode `sync:500` now reads the shared acquisition store and preserves each quote's observed time. Only the standalone collector requests the source page. The bridge retains existing event reconciliation and frozen recommendation boundaries; it does not relabel reference quotes as official SP.

The next safe step is to add a small projector from `football.market_observations` into the existing `football.odds_snapshots` serving contract and then expose collector freshness in `/api/v1/source-health`. That should be done after the ingestion lane has run in shadow mode long enough to confirm provider stability and match-ID parity with the current publication flow.
