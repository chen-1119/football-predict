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

- `GET /api/health`
- `GET /api/matches/current`
- `GET /api/matches/history`
- `GET /api/odds/history`
- `GET /api/predictions/gpt`
- `POST /api/admin/sync?token=ADMIN_TOKEN`
- `POST /api/admin/predict?token=ADMIN_TOKEN`

The browser reads `/data/runtime-config.json` at startup. When served by `server/index.cjs`, this runtime config points the app to `/api` and enables regular polling.

## Lightweight Server Deployment

See [docs/light-server-deployment.md](docs/light-server-deployment.md).
