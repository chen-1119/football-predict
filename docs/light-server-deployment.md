# Lightweight Server Deployment

This project can run as a light full-stack app:

- React/Vite builds to `dist`.
- `server/index.cjs` serves the website and `/api/*`.
- The split sync worker runs Sporttery/500/weather/pre-match sync, exports
  SQLite, stores snapshots/events, and updates model artifacts before kickoff.
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
- `PRODUCTION_DATA_MODE=server-primary`
- `SERVER_DATA_PRIMARY=1`
- `LOCAL_DATA_PUSH_REQUIRED=0`
- `CLOUD_SYNC_REQUIRED=0`
- `SPORTTERY_RELAY_REQUIRED=0`
- `ENABLE_SYNC_CRON=0`
- `SYNC_INTERVAL_SECONDS=300`
- `PAGE_POLL_SECONDS=20`
- `ADMIN_TOKEN=<long random token>`
- `ACCESS_CODE_ADMIN_TOKEN=<fixed code generator token>`; if omitted, the
  server falls back to `ADMIN_TOKEN`. `ALLOW_LOCAL_ADMIN` never authorizes code
  generation.
- `ACCESS_CODE_SECRET=<another long random secret>`
- `ACCESS_CODE_TTL_SECONDS=21600` for 6-hour recommendation access codes.
- `ENABLE_GPT_CRON=1` only after the GPT relay is ready.
- `GPT_RELAY_BASE_URL`, `GPT_RELAY_API_KEY`, `GPT_MODEL`. For the current
  OpenAI flagship, provision `GPT_MODEL=gpt-5.6` only after the relay/API
  account confirms access. This lane is explanation and risk review only; it
  must not overwrite the numeric forecast or recommendation gate.
- `ENABLE_API_FOOTBALL_SYNC=0` keeps the optional keyed supplement outside
  the production recommendation path. It is not required for coverage.
- `ENABLE_UEFA_OFFICIAL_RESULTS_SYNC=1` enables the no-key UEFA organizer
  result lane. It settles only UEFA Champions League rows whose event clock,
  home/away order, competition, and regular-time score pass the strict mapping
  contract; ambiguous rows remain pending.
- `ENABLE_FREE_FOOTBALL_SYNC=1` aggregates Sporttery, 500 public pages,
  Open-Meteo, public-web advisory evidence, and the local Elo/form/Poisson
  baseline. Missing supplements downgrade the analysis grade but never remove
  the model reference direction.
- `ENABLE_PREMATCH_SIGNALS_SYNC=1` runs the pre-match signal quality layer after
  supplemental sources and before the main match materialization.
- `REQUIRE_PREMATCH_SIGNALS=0` keeps missing pre-match sources as recommendation
  downgrade signals instead of making the whole service fail health checks.
- `ENABLE_OPEN_RESEARCH_SYNC=1` and `ENABLE_WEB_CONSENSUS_SYNC=1` run the
  free/open research discovery lane before pre-match materialization.
- `OPEN_RESEARCH_MAX_MATCHES=4`, `OPEN_RESEARCH_MAX_RESULTS=8`,
  `OPEN_RESEARCH_TIMEOUT_MS=7000`, and `OPEN_RESEARCH_CACHE_TTL_MINUTES=30`
  bound network and storage use. Optional `OPEN_RESEARCH_UNPAYWALL_EMAIL` enables
  legal DOI open-copy lookup. `OPEN_RESEARCH_CONTACT_URL` is set to the public
  release URL so Wikimedia can identify the client. See `docs/open-research-gateway.md`.

The Sporttery sync remains the primary source for fixtures, scores, and official
HAD/HHAD SP. API-FOOTBALL is used only as a supplemental signal layer for
fixture mapping, injuries, lineups, and reference bookmaker odds.
`sync:prematch` merges referee/card, lineup, injury, xG, weather, market, and
motivation availability into `pre-match-signals.json`, then `sync:data` applies
that score to cold-index and recommendation downgrade logic.

`PRODUCTION_DATA_MODE=server-primary` means the cloud server is responsible for
fetching, storing, exporting SQLite, running model catch-up, and serving the API.
It does not by itself prove that the official Sporttery source is independent
from a local collector. When verified server direct/proxy egress is unavailable
and fewer than two trusted collectors are evidenced at runtime,
`/api/v1/source-health` and `/api/v1/health` expose
`officialSourceSinglePoint=true` with redundancy status `watch`. This warning is
deliberately non-blocking, while stale or unusable source data continues to use
the existing health failure rules.

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

For production, keep the split worker enabled and `ENABLE_SYNC_CRON=0` so the
API process only serves reads/admin commands and does not run heavyweight sync
work in request-serving memory.

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

Keep `SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES=15` on the light server. Every
worker cycle still publishes the official data generation and SQLite/PostgreSQL
projection, while external enrichments, model backtests, and any required second
publication are throttled as one slow phase. A signed release-priority request
always bypasses this throttle and runs the complete readiness pipeline. Hot
cycles and completed slow cycles wait a full cadence after completion instead
of immediately starting another child-process tree after an overrun.

Set `CURRENT_UNSETTLED_RETENTION_HOURS=48` to keep genuinely recent live or
result-pending fixtures visible while removing older unresolved source rows
from the C-end current list. Expired rows are not relabelled as `FINISHED` and
are not inserted into match history; their original status and payload remain
in the private `SERVER_STORE_DIR/matches-unresolved-archive.json` store so a
later official result can still reconcile the same fixture.

Keep `ENABLE_MODEL_BACKTEST_ON_SYNC=1` with
`MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES=30`. The worker checks SQLite row
coverage after each export and only runs `model:backtest` when model evaluation
is missing, stale, or below the coverage trigger. Coverage below
`MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO` bypasses the minimum interval so
the public recommendation reliability gate can recover immediately.
`ENABLE_MODEL_STRATEGY_ON_SYNC` can stay `0`; the worker still runs
`optimize:strategy` immediately after a backtest, while avoiding an extra
strategy rewrite on every ordinary sync.

Check the current worker cadence without running a sync:

```bash
npm run sync:worker:status
cat server-data/sync-worker-status.json
```

Check logs:

```bash
journalctl -u football-predict -f
```

Server cleanup is explicit and conservative. It removes only known deployment
scratch files, old hotfix/failed release directories, excess release archive
tarballs, excess `dist.*` rollback directories, old SQLite backup files, and
rotated logs according to retention settings; it preserves
`/opt/football-predict`, `/opt/football-predict.previous`,
`/var/lib/football-predict/football.db`, JSONL history, and snapshots.

```bash
npm run server:cleanup
SERVER_CLEANUP_APPLY=1 npm run server:cleanup
```

Useful cleanup knobs when a deploy session leaves many same-day rollback
artifacts:

```bash
SERVER_CLEANUP_APP_BACKUP_KEEP=2 \
SERVER_CLEANUP_RELEASE_ARCHIVE_KEEP=8 \
SERVER_CLEANUP_DIST_BACKUP_KEEP=1 \
SERVER_CLEANUP_CURRENT_SNAPSHOT_UNCOMPRESSED_KEEP=24 \
SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS=12 \
SERVER_CLEANUP_SQLITE_BACKUP_KEEP=3 \
SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS=1 \
npm run server:cleanup
```

Optional daily cleanup timer:

```bash
sudo cp deploy/light-server/football-cleanup.service /etc/systemd/system/football-cleanup.service
sudo cp deploy/light-server/football-cleanup.timer /etc/systemd/system/football-cleanup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now football-cleanup.timer
systemctl list-timers football-cleanup.timer --no-pager
```

The timer runs the same explicit cleanup script as root, so it can remove
root-owned `/opt` rollback artifacts while still obeying the script's safe
target allow-list and production data preserves.

Optional runtime monitor timer:

```bash
sudo cp deploy/light-server/football-monitor.service /etc/systemd/system/football-monitor.service
sudo cp deploy/light-server/football-monitor.timer /etc/systemd/system/football-monitor.timer
sudo systemctl daemon-reload
sudo systemctl enable --now football-monitor.timer
systemctl list-timers football-monitor.timer --no-pager
```

The monitor runs every 5 minutes as the `football` user. It checks
`/api/v1/health`, `/api/v1/source-health`, `/api/v1/model/evaluation`, the app,
sync worker, nginx, cleanup/monitor timers, disk pressure, and a cleanup
dry-run. The status snapshot is written to
`/var/lib/football-predict/health-monitor-status.json`.

```bash
sudo -u football env RUNTIME_MONITOR_BASE_URL=http://127.0.0.1:8788 npm run server:monitor
cat /var/lib/football-predict/health-monitor-status.json
```

Expected production behavior: hard failures such as inactive services, stale
protected data, missing SQLite primary reads, or disk usage above the fail
threshold return `status: "failed"` and a non-zero exit code. Recoverable
signals such as Sporttery direct egress being WAF-blocked while the relay keeps
primary data fresh are reported as `status: "watch"`.

## 5. Nginx Reverse Proxy

```bash
sudo install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo install -m 0644 deploy/light-server/nginx-http-common.conf /etc/nginx/conf.d/football-predict-common.conf
sudo install -m 0644 deploy/light-server/nginx-server-common.conf /etc/nginx/snippets/football-predict-server.conf
sudo install -m 0644 deploy/light-server/nginx-security-headers.conf /etc/nginx/snippets/football-predict-security-headers.conf
sudo install -m 0644 deploy/light-server/nginx.conf /etc/nginx/sites-available/football-predict
sudo ln -sfn /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict
sudo nginx -t
sudo systemctl reload nginx
```

The HTTP bootstrap owns the ACME webroot at
`/var/www/letsencrypt/.well-known/acme-challenge`. It stays usable before a
domain or certificate exists. For the trusted short-lived IP certificate,
staging/production cutover, renewal drill, and rollback procedure, follow
[`https-tls-operations.md`](https-tls-operations.md). Normal releases never
accept CA terms or request a certificate.

The bundled config serves immutable `/assets/` and public media such as
`/contact-qr-code.jpg` directly from `/opt/football-predict/dist`, while `/`,
`/index.html`, `/data/runtime-config.json`, `/data/*.json`, and all API routes
still go through Node. This keeps static assets available during short Node
restart windows and reduces API process load. API routes keep the Node server's
short private cache and ETag headers; admin routes and public API routes use
separate `limit_req` zones, and limited requests return HTTP 429 instead of
looking like service outages. The SSE route disables proxy buffering. The
default request body cap stays at 2 MB, with only
`/api/admin/sporttery-relay-snapshot` raised to 32 MB so large relay snapshots
can pass through Nginx while other admin routes stay tight.

Validate the checked-in deployment rules before copying them to the host:

```bash
npm run verify:deployment-config
```

Plan coverage check:

```bash
npm run verify:server-primary
npm run verify:plan-coverage
```

This statically and locally verifies that the production plan is represented in
code: protected v1/API boundaries, SQLite + legacy JSONL warehouse, split sync
worker, cache/ETag/large-payload rules, Cloudflare/Pages downgrade rules,
rolling backtest and promotion gates, LLM/cutoff boundaries, and C-end
observability. `verify:server-primary` specifically verifies that cloud-server
sync worker + SQLite + model catch-up are the production data path and that
local push automation is opt-in. `verify:production` runs these checks as part
of its readiness gate.

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

`/api/v1/health` treats source-health as the freshness authority for C-end
recommendations. A Sporttery relay snapshot can remain serviceable for its
configured source window even when `sync-meta.updatedAt` is older than the
short generic health age; once source-health marks the primary source stale, the
health response drops out of `dataFresh` and relies on fallback coverage.

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

Cloudflare scheduling Worker policy check:

```bash
npm run verify:cloudflare-worker-policy
```

This simulates the Worker locally and verifies that `/api/matches/*`,
`/api/odds/*`, and internal model JSON resources return `410` with a replacement
Node `/api/v1/*` path. `verify:production` runs this check as part of its
readiness gate.

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
changes. The verifier uses HTTP keep-alive and requests gzip by default to match
browser/CDN connection reuse and compressed JSON transfer; set
`PERF_KEEP_ALIVE=0` or `PERF_ACCEPT_GZIP=0` only when intentionally measuring
fresh TCP connection churn or uncompressed payload transfer. Remote runs also
pause briefly between endpoint groups by default (`PERF_ENDPOINT_COOLDOWN_MS`,
default 2500) so one public-IP smoke test does not deplete the shared Nginx
rate-limit bucket before the next API route is measured.

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
- SQLite WAL warehouse: `DATASTORE_SQLITE_PATH`, default `/var/lib/football-predict/football.db`. Run `npm.cmd run datastore:sqlite` locally. On the light server, load `deploy/light-server/env` or pass `SERVER_STORE_DIR=/var/lib/football-predict DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db`; otherwise the exporter can write to the app-local `server-data/football.db`, which is not the production read path.
  The exporter also imports the tail of the legacy JSONL event store from
  `SERVER_STORE_DIR/db/*.jsonl`. Match events are stored as `jsonl-*` datasets so
  they do not pollute `current`/`history` list reads; source sync runs, odds
  events, and prediction runs are kept for replay, backtests, and audit. Tune
  the import windows with `SQLITE_IMPORT_JSONL_MATCH_LIMIT`,
  `SQLITE_IMPORT_JSONL_ODDS_LIMIT`, `SQLITE_IMPORT_JSONL_PREDICTION_LIMIT`, and
  `SQLITE_IMPORT_JSONL_SYNC_LIMIT`.

Private row-level model evidence, including the HHAD companion audit, is kept
in SQLite's `private_model_artifacts` table. It is never mirrored to
`public/data`, `dist`, or a public/admin API. The public model evaluation keeps
only aggregate, redacted scorecard fields. This placement also makes the audit
part of the release transaction's existing SQLite base/WAL/SHM snapshot rather
than introducing another root-helper recovery-file contract.

Production should run with `DATASTORE_READ_SOURCE=sqlite` and
`ENABLE_SQLITE_EXPORT=1`. `/api/v1/health` must show
`storage.sqlite.available=true`, source-health-backed `status.dataFresh=true`,
and non-zero current/history/odds counts before exposing traffic. It should also expose
`storage.sqlite.legacyJsonl.version=legacy-jsonl-import-v1` after the export.
If SQLite is missing, stale, or empty, the API automatically falls back to the
existing materialized store/file path and exposes the fallback reason in
`currentRead.source`; treat that as a release warning, not the normal state.

Model promotion is also gated. The split sync worker normally runs
`npm run model:backtest` when SQLite coverage falls behind and then runs
`npm run optimize:strategy`; you can run both commands manually for an
immediate audit. `model-strategy.json` will keep
`activation.onlineEffect=shadow` until the Sporttery market-baseline comparison
has enough rows and non-negative Brier/log-loss improvement. Keep
`ENABLE_MODEL_STRATEGY_ON_SYNC=0` until this gate is understood in production;
the worker already refreshes the shadow gate after each backtest.

Large static payloads are intentionally disabled in production. Use the API instead:

- `/matches.json` and `/data/matches-current.json` -> `/api/v1/matches/current?view=list`
- `/data/matches-history.json` -> `/api/v1/matches/history?limit=50`
- `/odds-history.json` and `/data/odds-history.json` -> `/api/v1/odds/history?matchId=...&limit=200`
- `/data/external-signals.json` and `/data/five-hundred-details.json` -> `/api/v1/source-health` for public health, or admin-only source pages when debugging.
- `/data/prediction-snapshots.json`, `/data/model-calibration.json`, and `/data/model-strategy.json` -> `/api/v1/model/evaluation`

Data-only cloud pushes must follow the same rule. `scripts/pushCloudSync.cjs`
may copy full `public/data` snapshots to the server so Node can rebuild SQLite
and serve protected APIs, but it must keep `dist` lightweight: only
`runtime-config.json`, `sync-meta.json`, `team-index.json`, and
`model-evaluation.json` are allowed under `dist/data`. Root `dist/matches.json`,
root `dist/odds-history.json`, and full history/odds/model detail JSON files are
removed locally and remotely before traffic is served.

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

After a release, run the read-only result-to-review acceptance gate with an
active recommendation session token. The access token and optional admin token
are read only from environment variables and are never printed:

```bash
REMOTE_REFRESH_BASE_URL="https://<production-origin>" \
REMOTE_REFRESH_ACCESS_TOKEN="$RECOMMENDATION_SESSION_TOKEN" \
REMOTE_REFRESH_ADMIN_TOKEN="$ADMIN_TOKEN" \
npm run verify:remote-refresh:strict
```

The gate requires public health to prove SQLite primary reads, checks the
`kickoff-retention-v1` 48-hour unresolved policy, result/history freshness, and
the three newest trusted official finished rows against their detail/review
payloads. Each selected row must already have a review, and the history/detail
review identity, generated version/time, locked settlement counters/statuses,
and locked review rows must agree. The strict post-release command requires the
admin token and checks the admin-only fixed-field worker publication and
relay-wake summary. `REMOTE_REFRESH_REQUIRE_ADMIN=1` is the environment form of
the same strict switch; `npm run verify:remote-refresh` remains available for a
deliberately data-plane-only audit. Set
`REMOTE_REFRESH_REQUIRE_OBSERVED_RELAY_WAKE=1` after a known relay upload to
require evidence that the current worker cycle was actually woken by the relay,
not just that the two-second wake watcher is configured. A missing protected
session token fails the gate and marks protected probes as skipped. A missing
admin token also fails the strict post-release command. The verifier never
creates an access code or mutates production state.

`/api/v1/model/evaluation` is intentionally public and redacted. It should show
model version, public performance aggregates, calibration, promotion-gate state,
and the best shadow candidate id only. Full shadow-candidate lists, candidate
weights, and strategy rule details belong to
`/api/v1/model/evaluation?detail=admin`, which must reject missing bearer auth
and query-string tokens.

## 8. Signed Bundle Deployment

Production updates use the signed bundle path exclusively. The fixed root-owned
entrypoint verifies the immutable bundle name, SHA-256 sidecar, RSA signature,
manifest identity, expiry and anti-replay sequence before it consumes the
candidate. It then runs the isolated candidate health, SQLite, production
readiness, public-origin and rollback checks. The caller cannot select an
alternate release script or production path.

Migration history: `deploy/light-server/release.sh` formerly performed an
unsigned Git clone/build update, while `deploy/light-server/deploy.ps1` formerly
generated credentials and bootstrapped a host over SSH. Both legacy files are
now unconditional fail-closed tombstones: they exit before clone, build, key,
token, SSH or server mutation, and there is no override. Do not use them as
emergency fallbacks.

During the signed release, the existing site remains active while the candidate
is built and validated. The release pauses `football-sync-worker`, preserves
the current live data cache, refreshes the SQLite warehouse at the guarded
cutover, validates Nginx before reload, and preserves an enabled host-local TLS
site. A failed candidate or post-swap readiness gate retains or restores the
previous application release. The fixed cold-recovery helper and signed bundle
share a strict two-file external model manifest (`model-strategy.json` and
`model-artifacts/evaluation.json`); private HHAD audit rows roll back with
SQLite and must not be reintroduced as `hhad-companion-audit.json`.

Use the public no-SSH verifier before and after the release. Before release it
records whether the current site is reachable and which gaps remain. After
release, require SQLite to prove the public origin has actually moved from file
JSON reads to the WAL warehouse:

```bash
REMOTE_BASE_URL="https://your-domain.com" REMOTE_AUDIT_ONLY=1 npm run verify:remote-public
REMOTE_BASE_URL="https://your-domain.com" REMOTE_REQUIRE_SQLITE=1 npm run verify:remote-public
```

Create and verify the signed candidate locally, inspect remote readiness, then
deploy it through the fixed entrypoint:

Before any release SSH command, pin the server host key out of band. From the
cloud serial/VNC console, record both of these outputs and compare the
fingerprint through a separate trusted view of the instance:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

On the operator workstation create a dedicated file containing exactly one
entry, using the public-key blob returned by the console (never a private key):

```text
[your-host]:18789 ssh-ed25519 replace-with-console-public-key-blob
```

Do not populate this file with `ssh-keyscan` or trust-on-first-use. The release
commands require the exact non-default-port token, one ED25519 entry, and an
explicit `SHA256:` fingerprint. They use `StrictHostKeyChecking=yes`, ignore
global SSH configuration/known-hosts files, disable host-key learning, and fail
before SSH or SCP if any pin input is missing or mismatched.

```bash
npm run release:bundle
npm run verify:release-bundle
RELEASE_DEPLOY_HOST="your-host" \
RELEASE_DEPLOY_PORT=22 \
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
npm run release:status
RELEASE_DEPLOY_HOST="your-host" \
RELEASE_DEPLOY_USER="ubuntu" \
RELEASE_DEPLOY_PORT=22 \
RELEASE_DEPLOY_KEY=".codex-tmp/football.pem" \
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
npm run release:deploy-bundle
```

If preflight reports `recoveryPending=1`, do not upload another bundle and do
not delete `recovery/current`. Run the fixed cold-recovery path with the same SSH
settings; it does not require or read a local release bundle:

```bash
RELEASE_DEPLOY_HOST="your-host" \
RELEASE_DEPLOY_USER="ubuntu" \
RELEASE_DEPLOY_PORT=22 \
RELEASE_DEPLOY_KEY=".codex-tmp/football.pem" \
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
npm run release:recover
```

Recovery succeeds only after the transaction converges, localhost health is
green, and public readiness confirms SQLite plus the sync worker. See
`docs/signed-release-entrypoints.md` for phase and fail-stop semantics.

To watch for an intermittent SSH recovery window without manually re-running
status checks, use:

```bash
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
RELEASE_WATCH_ATTEMPTS=1 \
npm run release:watch
```

By default this only reports readiness and never deploys. To let it deploy after
`release:status` reports `canAttemptDeploy: true`, make the action explicit:

```bash
PUBLIC_BASE_URL="https://your-domain.com" \
RELEASE_WATCH_AUTO_DEPLOY=1 \
RELEASE_WATCH_ATTEMPTS=60 \
RELEASE_WATCH_INTERVAL_SECONDS=60 \
npm run release:watch
```

The watch command only reports completion when the remote release marker equals
the local candidate bundle SHA and the public-origin checks are complete. A
healthy older live release is not treated as completion: the watcher keeps
waiting for SSH/preflight recovery and, with auto deploy enabled, deploys when
`canAttemptDeploy: true`. The command still uses `release:deploy-bundle`, so it
inherits the same remote preflight, candidate SQLite check, public-origin
verification, and rollback path.

When SSH from the operator machine cannot complete, generate an offline kit
after `npm run release:bundle`:

```bash
PUBLIC_BASE_URL="https://your-domain.com" npm run release:offline-kit
```

The kit is written under `.codex-tmp/football-offline-release-kit-*` and also
archived as `.tgz`. It contains the latest bundle, SHA sidecar, manifest,
`release-from-bundle.sh`, the keyless
`restore-ubuntu-operator-key.sh` recovery program, and
`README-server-console.md` with the exact console commands. Upload the kit files
through the cloud provider console, VNC, or other out-of-band file transfer,
then run the README's command on the server. This is still a guarded candidate
release, not a manual overwrite. The kit does not contain an operator key;
never add a private key or `football-operator.pub` to the kit or signed bundle.
Before either helper runs as root, the generated README verifies the signed
manifest against the bundle and compares both helpers byte-for-byte with their
copies inside that authenticated bundle.

When TCP port `18789` returns an OpenSSH banner but authentication ends in
`Permission denied (publickey)`, do not alter `sshd_config`, enable passwords,
or open another firewall port. From the reviewed operator workstation, export
only the public half of the existing deployment identity to a one-line file,
verify its SHA-256 fingerprint locally, and upload that public file separately
to the fixed server-console path `/tmp/football-operator.pub`. In the unpacked
offline-kit directory run:

```bash
chmod 700 restore-ubuntu-operator-key.sh
sudo FOOTBALL_OPERATOR_KEY_FINGERPRINT='SHA256:replace-with-reviewed-fingerprint' \
  bash ./restore-ubuntu-operator-key.sh
```

The recovery program accepts exactly one `ssh-rsa` public-key line, optionally
pins it to `FOOTBALL_OPERATOR_KEY_FINGERPRINT`, preserves every existing
authorized key, de-duplicates by the public-key blob, and atomically installs
`~ubuntu/.ssh/authorized_keys`. It enforces `ubuntu:ubuntu` ownership with
directory mode `0700` and file mode `0600`, rejects symlink/hard-link targets,
and runs `sshd -t` before and after the repair. It does not modify sshd configuration,
firewall rules, or password authentication. Test external SSH,
then delete `/tmp/football-operator.pub` from the server.

If `npm run release:status` says `ssh is not reachable` while the website still
answers `/api/v1/health`, do not retry the public swap. The existing service is
still serving from the old app directory; the release helper has not uploaded or
restarted anything. Recover SSH first from the cloud provider console or VNC:

```bash
curl -fsS http://127.0.0.1:8788/api/v1/health | head -c 500
sudo ss -ltnp | grep ':22' || true
sudo systemctl status ssh --no-pager || sudo systemctl status sshd --no-pager
sudo journalctl -u ssh -u sshd -n 120 --no-pager
sudo ufw status verbose || true
sudo systemctl restart ssh || sudo systemctl restart sshd
```

Only restart the SSH service when it is inactive or no SSH banner is returned.
If the banner is already present and authentication is specifically denied as
`publickey`, restarting cannot restore an ignored or missing `authorized_keys`;
use the fingerprint-pinned key repair above.

Also confirm the provider firewall/security group allows the configured SSH
port, default `22` for this project, from the
operator IP. A TCP connection that opens but never returns an SSH banner usually
means the port is forwarded, filtered, overloaded, or being closed before
OpenSSH can complete its greeting. After `npm run release:status` reports
`canAttemptDeploy: true`, run `npm run release:deploy-bundle`; the script will
still preflight a candidate service and roll back if the public origin does not
switch to SQLite.

Manual Git pulls, in-place builds, and direct service replacement are not a
supported release path, including during an incident. Recover console or SSH
access, create a signed bundle from a reviewed workstation checkout, and use
the normal signed deployment or offline-kit workflow so signature, anti-replay,
candidate and rollback gates remain intact.

## 9. Mainland Egress For Sporttery

China Sporttery may reject non-mainland or high-risk egress IPs with `HTTP 567`.
For the overseas light server, keep the public website/API/model workers on the
current host and make Sporttery collection relay-first. The production default is
`SKIP_SPORTTERY_DIRECT_FETCH=1`: the server still uses Sporttery as the primary
data source, but it reads verified relay snapshots instead of repeatedly probing
Sporttery from an overseas IP. Local PC push is not part of the production
critical path. Add one of these egress options for the server or a dedicated
collector:

- A small mainland CVM that runs the sync and pushes JSON to this server.
- A mainland HTTP/SOCKS5 proxy dedicated to Sporttery requests.
- Or a fresh Sporttery relay snapshot produced by a mainland collector; see
  `docs/sporttery-relay-snapshot.md`.
- A VPN/tunnel whose egress IP is in mainland China.

Default overseas server policy:

```bash
SKIP_SPORTTERY_FETCH=0
SKIP_SPORTTERY_DIRECT_FETCH=1
SPORTTERY_DIRECT_FETCH=0
SPORTTERY_RELAY_MODE=prefer
SPORTTERY_RELAY_SNAPSHOT=/var/lib/football-predict/sporttery-relay-snapshot.json
```

When using a proxy on the collector or when deliberately re-enabling server
direct fetch, set it in `deploy/light-server/env`:

```bash
SKIP_SPORTTERY_FETCH=0
SKIP_SPORTTERY_DIRECT_FETCH=0
SPORTTERY_DIRECT_FETCH=1
SPORTTERY_OUTBOUND_PROXY=socks5h://user:password@mainland-proxy.example.com:1080
# or an authenticated HTTPS CONNECT proxy:
# SPORTTERY_OUTBOUND_PROXY=https://user:password@mainland-proxy.example.com:8443
```

Then restart and test:

```bash
sudo systemctl restart football-predict
cd /opt/football-predict
SPORTTERY_EGRESS_AUDIT_ONLY=1 \
SPORTTERY_EGRESS_STATUS_OUT=/var/lib/football-predict/sporttery-egress-status.json \
npm run verify:sporttery-egress
npm run sync:prematch
npm run sync:data
npm run validate:data
npm run validate:sources
curl http://127.0.0.1:8788/api/health
```

`verify:sporttery-egress` is a no-write network probe. It reports whether the
Sporttery endpoints returned JSON or WAF/HTML/403, masks proxy credentials, and
exits non-zero unless `SPORTTERY_EGRESS_AUDIT_ONLY=1` is set. Use the strict
mode before trusting a new `SPORTTERY_OUTBOUND_PROXY`; use audit mode in
routine health reviews so fallback-degraded service can stay online while the
main source is being repaired. Set `SPORTTERY_EGRESS_STATUS_OUT` to persist the
latest probe; `/api/v1/source-health` then exposes a public summary while
`/api/v1/source-health?detail=admin` shows the full diagnostic and file path.
When `SKIP_SPORTTERY_DIRECT_FETCH=1`, the sync service writes a
`direct-disabled` egress status instead of probing the official endpoints; this
is the expected overseas-server mode and should not be treated as an outage.

By default `SOURCE_STRICT_PRIMARY_HEALTH=0`, so a short Sporttery outage does
not make the C-end API unavailable when the current cache and 500.com fallback
remain inside the configured reliable window. The public health response still
reports `servingMode: "fallback-degraded"` and exposes stale/source warnings.
Set `SOURCE_STRICT_PRIMARY_HEALTH=1` only when operations must fail closed as
soon as the primary Sporttery lane is stale.

Do not use public/free proxies for production. Use a fixed authenticated proxy
or a private mainland sync node so the request fingerprint and IP stay stable.
