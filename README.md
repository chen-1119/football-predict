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
- `POST /api/admin/sync` with `Authorization: Bearer ADMIN_TOKEN`
- `POST /api/admin/model/run` with `Authorization: Bearer ADMIN_TOKEN`
- `POST /api/admin/access-codes` with `Authorization: Bearer ACCESS_CODE_ADMIN_TOKEN`

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
npm run verify:llm-boundary
npm run verify:sync-lock
npm run verify:api-contracts
npm run verify:frontend-observability
npm run verify:deployment-config
npm run verify:plan-coverage
npm run verify:source-fallback
npm run verify:perf
ADMIN_TOKEN="$ADMIN_TOKEN" VERIFY_REQUIRE_SQLITE=1 npm run verify:production
```

## Lightweight Server Deployment

See [docs/light-server-deployment.md](docs/light-server-deployment.md).
