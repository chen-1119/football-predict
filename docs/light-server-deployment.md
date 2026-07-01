# Lightweight Server Deployment

This project can run as a light full-stack app:

- React/Vite builds to `dist`.
- `server/index.cjs` serves the website and `/api/*`.
- The server runs scheduled Sporttery sync, stores snapshots/events, and optionally calls an OpenAI-compatible GPT relay before kickoff.
- The browser polls `/api/v1/matches/current` through runtime config, so the page does not stay stale.

## 1. Server Requirements

- Ubuntu 22.04/24.04 or similar Linux server.
- Node.js 20+.
- Nginx if using a domain or public reverse proxy.
- A repo checkout at `/opt/football-predict`.

## 2. Install

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin football || true
sudo mkdir -p /opt/football-predict /var/lib/football-predict
sudo chown -R football:football /opt/football-predict /var/lib/football-predict

cd /opt/football-predict
git clone https://github.com/chen-1119/football-predict.git .
npm ci
npm run build
```

## 3. Configure Environment

```bash
cp deploy/light-server/env.example deploy/light-server/env
nano deploy/light-server/env
```

Important fields:

- `HOST=127.0.0.1`
- `PORT=8788`
- `ENABLE_SYNC_CRON=1`
- `SYNC_INTERVAL_SECONDS=300`
- `PAGE_POLL_SECONDS=20`
- `ADMIN_TOKEN=<long random token>`
- `ACCESS_CODE_ADMIN_TOKEN=<fixed code generator token>`; if omitted, the
  server falls back to `ADMIN_TOKEN`. `ALLOW_LOCAL_ADMIN` never authorizes code
  generation.
- `ACCESS_CODE_SECRET=<another long random secret>`
- `ACCESS_CODE_TTL_SECONDS=21600` for 6-hour recommendation access codes.
- `ENABLE_GPT_CRON=1` only after the GPT relay is ready.
- `GPT_RELAY_BASE_URL`, `GPT_RELAY_API_KEY`, `GPT_MODEL`.
- `ENABLE_API_FOOTBALL_SYNC=1` only after `API_FOOTBALL_KEY` is configured.
- `API_FOOTBALL_MAX_CALLS_PER_SYNC`, `API_FOOTBALL_INJURY_REFRESH_MINUTES`,
  `API_FOOTBALL_ODDS_REFRESH_MINUTES`, and `API_FOOTBALL_LINEUP_REFRESH_MINUTES`
  keep the supplemental API usage bounded.
- `ENABLE_PREMATCH_SIGNALS_SYNC=1` runs the pre-match signal quality layer after
  supplemental sources and before the main match materialization.
- `REQUIRE_PREMATCH_SIGNALS=0` keeps missing pre-match sources as recommendation
  downgrade signals instead of making the whole service fail health checks.

The Sporttery sync remains the primary source for fixtures, scores, and official
HAD/HHAD SP. API-FOOTBALL is used only as a supplemental signal layer for
fixture mapping, injuries, lineups, and reference bookmaker odds.
`sync:prematch` merges referee/card, lineup, injury, xG, weather, market, and
motivation availability into `pre-match-signals.json`, then `sync:data` applies
that score to cold-index and recommendation downgrade logic.

The GPT relay must expose an OpenAI-compatible chat completions endpoint, for example:

```text
POST {GPT_RELAY_BASE_URL}/v1/chat/completions
Authorization: Bearer {GPT_RELAY_API_KEY}
```

## 4. Run With systemd

```bash
sudo cp deploy/light-server/football-predict.service /etc/systemd/system/football-predict.service
sudo systemctl daemon-reload
sudo systemctl enable --now football-predict
sudo systemctl status football-predict --no-pager
```

Optional split sync worker:

```bash
sudo cp deploy/light-server/football-sync-worker.service /etc/systemd/system/football-sync-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now football-sync-worker
```

When the split worker is enabled, set `ENABLE_SYNC_CRON=0` for the web/API
service to avoid duplicate sync runs. Keep `SYNC_WORKER_LOOP=1` in the worker
unit and use `HOT_SYNC_INTERVAL_SECONDS` for near-kickoff refreshes. The worker
uses `SYNC_INTERVAL_SECONDS` for the normal low-cost cadence and switches to
`HOT_SYNC_INTERVAL_SECONDS` when a match is live or inside
`HOT_SYNC_WINDOW_MINUTES`; the same cadence is passed into `syncData` as
`SYNC_WORKFLOW_MINUTES`. Keep `ENABLE_SQLITE_EXPORT=1` when
`DATASTORE_READ_SOURCE=sqlite`; the worker also forces this export whenever the
configured read source is SQLite so the API does not drift to a stale database
after a sync run. The web/API manual sync path and the split worker share a
filesystem sync lock under `SERVER_STORE_DIR/locks/sync.lock`, so concurrent
sync attempts skip instead of writing `public/data`, JSONL snapshots, and
SQLite at the same time. Tune stale-lock recovery with
`SYNC_LOCK_STALE_MINUTES`; keep `API_SYNC_LOCK_WAIT_MS=0` and
`SYNC_WORKER_LOCK_WAIT_MS=0` on small VPS deployments so request handlers do not
block behind a long worker cycle.

Check the current worker cadence without running a sync:

```bash
npm run sync:worker:status
cat server-data/sync-worker-status.json
```

Check logs:

```bash
journalctl -u football-predict -f
```

## 5. Nginx Reverse Proxy

```bash
sudo cp deploy/light-server/nginx.conf /etc/nginx/sites-available/football-predict
sudo nano /etc/nginx/sites-available/football-predict
sudo ln -s /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict
sudo nginx -t
sudo systemctl reload nginx
```

Replace `your-domain.com` with the actual domain.

The bundled config keeps `/assets/` immutable for one year, while `/`,
`/index.html`, `/data/runtime-config.json`, and `/data/*.json` are explicitly
`no-store`. API routes keep the Node server's short private cache and ETag
headers; admin routes and public API routes use separate `limit_req` zones, and
the SSE route disables proxy buffering.

Validate the checked-in deployment rules before copying them to the host:

```bash
npm run verify:deployment-config
```

Plan coverage check:

```bash
npm run verify:plan-coverage
```

This statically and locally verifies that the production plan is represented in
code: protected v1/API boundaries, SQLite + legacy JSONL warehouse, split sync
worker, cache/ETag/large-payload rules, rolling backtest and promotion gates,
LLM/cutoff boundaries, and C-end observability. `verify:production` runs this
check as part of its readiness gate.

## 6. Health Checks

```bash
curl http://127.0.0.1:8788/api/health
curl http://127.0.0.1:8788/api/v1/health
curl http://127.0.0.1:8788/api/v1/source-health
curl http://127.0.0.1:8788/data/runtime-config.json
```

Automated readiness check:

```bash
ADMIN_TOKEN="$ADMIN_TOKEN" VERIFY_REQUIRE_SQLITE=1 npm run verify:production
```

For a remote host, pass `VERIFY_BASE_URL=https://your-domain.com`. The check
validates v1 health, SQLite freshness, model evaluation, access-code auth,
protected current/history/detail/odds endpoints, and that admin query tokens are
rejected.

Source fallback drill:

```bash
npm run verify:source-fallback
```

This backs up the current published JSON/SQLite files, simulates an empty
Sporttery fetch, verifies that current/history stay non-empty, `sync-meta`
sets `api.stale=true`, and confirms `/api/v1/matches/current` still serves from
SQLite while marked stale. The script restores the original files before it
exits.

Prediction audit check:

```bash
npm run verify:prediction-audit
```

This verifies that prediction snapshots and currently visible recommendations
carry `modelVersion`, `calibrationVersion`, `cutoffTime`, and a hashed
`featureSnapshot`, and that locked recommendations keep a snapshot signature.
`verify:production` runs this check as part of its readiness gate.

Model promotion gate check:

```bash
npm run model:backtest
npm run optimize:strategy
npm run verify:model-promotion
```

This verifies that `model-strategy.json` was generated after the latest
backtest, mirrors to `server-data`, carries the expected promotion thresholds,
and keeps shadow candidates out of current recommendations until they pass the
Sporttery market-baseline gate. `verify:production` runs this check as part of
its readiness gate.

LLM review boundary check:

```bash
npm run verify:llm-boundary
```

This verifies that stored LLM rows are second-pass risk reviews only, were
generated before the Sporttery cutoff, cannot override probabilities or
recommendation direction, and still match the current algorithm prediction
signature. `/api/admin/model/run` also skips matches whose cutoff has already
passed, so post-cutoff work is limited to settlement.

Sync lock check:

```bash
npm run verify:sync-lock
```

This verifies that only one sync cycle can hold the cross-process lock at a
time, release allows the next cycle to proceed, and stale locks can be recovered
without manual file deletion. `verify:production` runs this check as part of
its readiness gate.

API contract check:

```bash
ADMIN_TOKEN="$ADMIN_TOKEN" CONTRACT_START_SERVER=1 npm run verify:api-contracts
```

For a remote host, pass `CONTRACT_BASE_URL=https://your-domain.com`. This
checks the public v1 schema, access-code protection for recommendation reads,
ETag `304`, `since` freshness, history cursor pagination, history/odds limit
clamps, match detail `404`, static large-payload `410`, and admin method
errors. `verify:production` runs this check against its already-started server.

Frontend observability check:

```bash
npm run verify:frontend-observability
```

For a remote host, pass `FRONTEND_OBSERVABILITY_BASE_URL=https://your-domain.com`.
This checks that the React app is wired to `/api/v1`, that the DOM carries
stable `data-testid`/`data-*` markers for data freshness, source health, and
model governance, that large static payloads are stripped from `dist`, and that
the public model/source-health APIs expose the fields the C-end UI renders.
`verify:production` runs this check against its already-started server.

API performance smoke check:

```bash
ADMIN_TOKEN="$ADMIN_TOKEN" PERF_START_SERVER=1 PERF_REQUESTS=120 PERF_CONCURRENCY=12 npm run verify:perf
```

For a remote host, pass `PERF_BASE_URL=https://your-domain.com`. The smoke test
generates an access token, then measures `/api/v1/matches/current`,
`/api/v1/matches/history`, and `/api/v1/matches/:id`. The default acceptance
target is p95 <= 800ms, error rate <= 1%, and current-list response bytes <=
180KB; tune with `PERF_MAX_P95_MS`, `PERF_MAX_ERROR_RATE`, and
`PERF_MAX_CURRENT_AVG_BYTES` only when the hardware class or daily match volume
changes.

The v1 read APIs return private short-TTL `Cache-Control` plus `ETag`. The
frontend sends `If-None-Match` for v1 data reads and reuses its in-memory JSON
when the server returns `304`, so repeat polling does not keep downloading the
same current-list or detail payload.

Local protected preview:

```bash
npm run datastore:sqlite
npm run preview:server
```

The preview helper starts the Node API on `http://127.0.0.1:8788` with SQLite
reads enabled, background sync disabled, and local admin tokens. It also creates
and verifies a recommendation access code, then prints the URL, health summary,
log paths, code id, expiry, and session token. Treat `health.ok=false` with
`status.serviceOk=true` as a source freshness warning, not a failed preview;
the health payload still shows whether SQLite is non-stale and whether protected
reads are coming from `sqlite`.

Manual sync:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Manual GPT prediction:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/model/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"limit":8}'
```

Recommendation access code:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/access-codes" \
  -H "Authorization: Bearer $ACCESS_CODE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"wechat-user"}'
```

Send the returned `code` to the user on WeChat. The user enters it at
`https://your-domain.com/auth`; the admin page is `https://your-domain.com/codes`.
The plain code is returned only once and expires 6 hours after generation by
default.

## 7. Data Storage

Runtime data is stored in two places:

- Source snapshots generated by sync: `public/data/*.json` and `public/matches.json`.
  Protected C-end recommendation payloads are not shipped as static files in
  `dist`; the browser reads them through the access-controlled API.
- Server-only event/snapshot store: `SERVER_STORE_DIR`, default `/var/lib/football-predict`.
- Server-side JSONL data store: `SERVER_STORE_DIR/db/*.jsonl`, used for sync runs, match state changes, odds snapshots, and prediction runs. This keeps a replayable history for later model calibration without exposing internal automation text on the public page.
- Server-side materialized indexes: `SERVER_STORE_DIR/db/current-matches.json`, `history-list.json`, `latest-match-index.json`, and `latest-matches/*.json`. The web API reads these first so list/detail pages do not need to load the 40MB+ history package.
- SQLite WAL warehouse: `DATASTORE_SQLITE_PATH`, default `/var/lib/football-predict/football.db`. Run `npm.cmd run datastore:sqlite` locally or `npm run datastore:sqlite` on Linux after a manual sync to export `source_snapshots`, `match_snapshots`, `odds_snapshots`, and `prediction_snapshots`.
  The exporter also imports the tail of the legacy JSONL event store from
  `SERVER_STORE_DIR/db/*.jsonl`. Match events are stored as `jsonl-*` datasets so
  they do not pollute `current`/`history` list reads; source sync runs, odds
  events, and prediction runs are kept for replay, backtests, and audit. Tune
  the import windows with `SQLITE_IMPORT_JSONL_MATCH_LIMIT`,
  `SQLITE_IMPORT_JSONL_ODDS_LIMIT`, `SQLITE_IMPORT_JSONL_PREDICTION_LIMIT`, and
  `SQLITE_IMPORT_JSONL_SYNC_LIMIT`.

Production should run with `DATASTORE_READ_SOURCE=sqlite` and
`ENABLE_SQLITE_EXPORT=1`. `/api/v1/health` must show
`storage.sqlite.available=true`, non-stale `syncMetaUpdatedAt`, and non-zero
current/history/odds counts before exposing traffic. It should also expose
`storage.sqlite.legacyJsonl.version=legacy-jsonl-import-v1` after the export.
If SQLite is missing, stale, or empty, the API automatically falls back to the
existing materialized store/file path and exposes the fallback reason in
`currentRead.source`; treat that as a release warning, not the normal state.

Model promotion is also gated. Run `npm run model:backtest` and then
`npm run optimize:strategy`; `model-strategy.json` will keep
`activation.onlineEffect=shadow` until the Sporttery market-baseline comparison
has enough rows and non-negative Brier/log-loss improvement. Keep
`ENABLE_MODEL_STRATEGY_ON_SYNC=0` until this gate is understood in production;
turn it on only when the sync worker should refresh the shadow gate after each
backtest.

Large static payloads are intentionally disabled in production. Use the API instead:

- `/matches.json` and `/data/matches-current.json` -> `/api/v1/matches/current?view=list`
- `/data/matches-history.json` -> `/api/v1/matches/history?limit=50`
- `/odds-history.json` and `/data/odds-history.json` -> `/api/v1/odds/history?matchId=...&limit=200`
- `/data/external-signals.json` and `/data/five-hundred-details.json` -> `/api/v1/source-health` for public health, or admin-only source pages when debugging.
- `/data/prediction-snapshots.json`, `/data/model-calibration.json`, and `/data/model-strategy.json` -> `/api/v1/model/evaluation`

Useful API endpoints:

- `/api/v1/matches/current?view=list`
- `/api/v1/matches/history?limit=50`
- `/api/v1/matches/sporttery_2040145`
- `/api/v1/odds/history?matchId=sporttery_2040145&limit=200`
- `/api/v1/source-health`
- `/api/v1/model/evaluation`
- `/api/v1/model/evaluation?detail=admin` with `Authorization: Bearer $ADMIN_TOKEN`
- `/api/v1/health`
- `/api/data/external-signals?limit=120`
- `/api/data/five-hundred-details?limit=80`
- `/api/predictions/gpt`
- `/api/db/events`
- `/api/db/status`
- `/api/db/sync-runs`
- `/api/db/match-snapshots?matchId=sporttery_2040145`
- `/api/db/odds-snapshots?matchId=sporttery_2040145`
- `/api/db/prediction-runs?matchId=sporttery_2040145`
- `/api/matches/sporttery_2040145/timeline`
- `/api/analytics/summary`
- `/api/health`

`/api/v1/model/evaluation` is intentionally public and redacted. It should show
model version, public performance aggregates, calibration, promotion-gate state,
and the best shadow candidate id only. Full shadow-candidate lists, candidate
weights, and strategy rule details belong to
`/api/v1/model/evaluation?detail=admin`, which must reject missing bearer auth
and query-string tokens.

## 8. Update Deployment

```bash
cd /opt/football-predict
git pull
npm ci
npm run build
ADMIN_TOKEN="$ADMIN_TOKEN" VERIFY_REQUIRE_SQLITE=1 npm run verify:production
sudo systemctl restart football-predict
curl http://127.0.0.1:8788/api/health
```

## 9. Mainland Egress For Sporttery

China Sporttery may reject non-mainland or high-risk egress IPs with `HTTP 567`.
If the server is outside mainland China, keep the public website on the current
server and add one of these egress options for the sync process:

- A small mainland CVM that runs the sync and pushes JSON to this server.
- A mainland HTTP/SOCKS5 proxy dedicated to Sporttery requests.
- A VPN/tunnel whose egress IP is in mainland China.

When using a proxy, set it in `deploy/light-server/env`:

```bash
SKIP_SPORTTERY_FETCH=0
SPORTTERY_OUTBOUND_PROXY=http://user:password@mainland-proxy.example.com:8080
# or:
# SPORTTERY_OUTBOUND_PROXY=socks5h://user:password@mainland-proxy.example.com:1080
```

Then restart and test:

```bash
sudo systemctl restart football-predict
cd /opt/football-predict
npm run sync:prematch
npm run sync:data
npm run validate:data
npm run validate:sources
curl http://127.0.0.1:8788/api/health
```

Do not use public/free proxies for production. Use a fixed authenticated proxy
or a private mainland sync node so the request fingerprint and IP stay stable.
