# Lightweight Server Deployment

This project can run as a light full-stack app:

- React/Vite builds to `dist`.
- `server/index.cjs` serves the website and `/api/*`.
- The server runs scheduled Sporttery sync, stores snapshots/events, and optionally calls an OpenAI-compatible GPT relay before kickoff.
- The browser polls `/api/matches/current` through runtime config, so the page does not stay stale.

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

The Sporttery sync remains the primary source for fixtures, scores, and official
HAD/HHAD SP. API-FOOTBALL is used only as a supplemental signal layer for
fixture mapping, injuries, lineups, and reference bookmaker odds.

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

## 6. Health Checks

```bash
curl http://127.0.0.1:8788/api/health
curl http://127.0.0.1:8788/data/runtime-config.json
```

Manual sync:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/sync?token=$ADMIN_TOKEN"
```

Manual GPT prediction:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/predict?token=$ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"limit":8}'
```

Recommendation access code:

```bash
curl -X POST "http://127.0.0.1:8788/api/admin/access-codes?token=$ACCESS_CODE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"wechat-user"}'
```

Send the returned `code` to the user on WeChat. The user enters it at
`https://your-domain.com/auth`; the admin page is `https://your-domain.com/codes`.
The plain code is returned only once and expires 6 hours after generation by
default.

## 7. Data Storage

Runtime data is stored in two places:

- Public data used by the website: `public/data/*.json` and `public/matches.json`.
- Server-only event/snapshot store: `SERVER_STORE_DIR`, default `/var/lib/football-predict`.
- Server-side JSONL data store: `SERVER_STORE_DIR/db/*.jsonl`, used for sync runs, match state changes, odds snapshots, and prediction runs. This keeps a replayable history for later model calibration without exposing internal automation text on the public page.

Useful API endpoints:

- `/api/matches/current`
- `/api/matches/history`
- `/api/odds/history`
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

## 8. Update Deployment

```bash
cd /opt/football-predict
git pull
npm ci
npm run build
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
npm run sync:data
npm run validate:data
curl http://127.0.0.1:8788/api/health
```

Do not use public/free proxies for production. Use a fixed authenticated proxy
or a private mainland sync node so the request fingerprint and IP stay stable.
