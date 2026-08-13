# AI Football Predict

足球赛事数据看板与赛前预测项目。前端使用 React + TypeScript + Vite，生产部署可以使用内置轻量 Node 服务提供静态页面、实时数据 API、定时采集、GPT 中转预测和历史快照落库。

## Local Development

```bash
npm install
npm run dev
```

## Data Sync

```bash
npm run sync:data
npm run validate:data
```

## ChatGPT Pro Manual Audit Pack

Generate a privacy-minimized, cutoff-safe data pack for manual upload to a
ChatGPT Pro conversation or Project:

```bash
npm run verify:chatgpt-pack
npm run analysis:chatgpt-pack -- --out .codex-tmp/chatgpt-pro-analysis-pack
```

The pack separates pre-match features from post-match settlements and includes
CSV files, a manifest with hashes and time boundaries, a data dictionary, and a
fixed audit prompt. It never reads ChatGPT login state, chats, cookies, `.env`
files, or API keys. ChatGPT Pro is a manual analysis surface; automated website
use requires a separately billed API project. See
[docs/chatgpt-pro-data-analysis.md](docs/chatgpt-pro-data-analysis.md).

## Full-Stack Server

```bash
npm run build
npm run server
```

Useful endpoints:

- `GET /api/v1/health`
- `GET /api/v1/source-health`
- `GET /api/v1/model/evaluation`
- `GET /api/v1/model/evaluation?detail=admin` with `Authorization: Bearer ADMIN_TOKEN`
- `GET /api/v1/matches/current?view=list`
- `GET /api/v1/matches/history?limit=50`
- `GET /api/v1/odds/history?limit=200`
- `GET /api/v1/research/status` with a valid access session
- `POST /api/v1/research/search` with a valid access session

The research endpoint uses public/free metadata sources and legal open-access
discovery. It does not proxy browser subscriptions or bypass paywalls. See
[docs/open-research-gateway.md](docs/open-research-gateway.md).
- `POST /api/admin/sync` with `Authorization: Bearer ADMIN_TOKEN`
- `POST /api/admin/model/run` with `Authorization: Bearer ADMIN_TOKEN`
- `POST /api/admin/access-codes` with `Authorization: Bearer ACCESS_CODE_ADMIN_TOKEN`; an optional `ttlSeconds` may shorten (never extend) the configured access-code lifetime for temporary QA sessions.

The browser reads `/data/runtime-config.json` at startup. When served by
`server/index.cjs`, this runtime config points the app to `/api/v1`, enables
regular polling, and keeps admin APIs bearer-token only. Query-string admin
tokens are intentionally rejected.

Local protected preview:

```bash
npm run datastore:sqlite
npm run preview:server
```

`preview:server` starts `server/index.cjs` on `http://127.0.0.1:8788` with
`DATASTORE_READ_SOURCE=sqlite`, sync/GPT cron disabled, and local admin tokens.
It prints the preview URL, health summary, log paths, and a one-time access code
for the protected C-end pages.

The public model-evaluation endpoint exposes only C-end governance fields:
version, sample counts, public metrics, promotion gate, and the best shadow
candidate id. Full shadow-candidate lists, candidate weights, and strategy rule
details are available only through `?detail=admin` with a bearer admin token.

`datastore:sqlite` exports the current public JSON snapshots and also imports
the tail of the legacy JSONL event store under `server-data/db/*.jsonl`. Current
and history list reads still use the clean `current`/`history` datasets, while
legacy event rows are kept as replayable `jsonl-*` snapshots for audit,
backtests, odds history, and migration safety.

Production checks:

```bash
npm run validate:data
npm run datastore:sqlite
npm run verify:prediction-audit
npm run verify:model-promotion
npm run verify:handicap-settlement
npm run verify:llm-boundary
npm run verify:sync-lock
npm run verify:api-contracts
npm run verify:frontend-observability
npm run verify:cloudflare-worker-policy
npm run verify:deployment-config
npm run verify:plan-coverage
npm run verify:source-fallback
npm run verify:perf
ADMIN_TOKEN="$ADMIN_TOKEN" VERIFY_REQUIRE_SQLITE=1 npm run verify:production
```

Before and after a public cutover, run a no-SSH public check against the live
origin. It verifies the site shell, public health, anonymous access denial,
disabled protected static JSON, and whether the live service has moved to
SQLite reads:

```bash
REMOTE_BASE_URL="https://your-domain.com" REMOTE_REQUIRE_SQLITE=1 npm run verify:remote-public
```

Production updates use signed bundles only. Create and verify the bundle on the
release workstation, then invoke the fixed root-owned server entrypoint through
the deployment client. First obtain the ED25519 host public key and SHA-256
fingerprint from the cloud serial/VNC console, and write one exact
`[host]:port ssh-ed25519 ...` entry to the dedicated known-hosts file; release
SSH never uses trust-on-first-use:

```bash
npm run release:bundle
npm run verify:release-bundle
RELEASE_DEPLOY_HOST="your-host" \
RELEASE_DEPLOY_PORT=18789 \
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
npm run release:status
RELEASE_DEPLOY_HOST="your-host" \
RELEASE_DEPLOY_PORT=18789 \
RELEASE_DEPLOY_KNOWN_HOSTS=".codex-tmp/football-release.known_hosts" \
RELEASE_DEPLOY_HOST_KEY_SHA256="SHA256:replace-with-console-fingerprint" \
PUBLIC_BASE_URL="https://your-domain.com" \
npm run release:deploy-bundle
```

If that command reports a pending release transaction, use
`npm run release:recover` with the same `RELEASE_DEPLOY_*` and
`PUBLIC_BASE_URL` settings. Do not remove `recovery/current` manually.

Migration history: `deploy/light-server/release.sh` previously performed an
unsigned Git clone/build release, and `deploy/light-server/deploy.ps1` performed
an unsigned bootstrap over SSH. Both files now fail closed before any repository,
credential, token, or network action. They are retained only as explicit
deprecation tombstones and have no override switch.

Data-only cloud pushes keep full JSON snapshots server-side for the Node API,
but do not republish protected recommendation/history payloads through `dist`.
The browser should read current matches, history, odds, and model governance via
`/api/v1/*`.

GitHub Pages builds require the `DATA_API_BASE` repository variable to be an
absolute HTTPS URL for that protected Node API. The build intentionally fails
when this is missing so Pages cannot become an accidental static data endpoint.

## Lightweight Server Deployment

See [docs/light-server-deployment.md](docs/light-server-deployment.md).
