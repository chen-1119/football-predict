# Cloudflare Workers Cron Sync

This project uses Cloudflare Workers Cron as the reliable scheduler and keeps the
existing GitHub Actions workflow as the data scraper, committer, and deployer.
The Worker is not the protected C-end recommendation API.

Flow:

1. Cloudflare Worker runs every minute for the guarded GitHub scheduler.
2. Worker checks recent GitHub workflow runs to avoid duplicate dispatches.
3. Worker calls GitHub `workflow_dispatch` for `.github/workflows/sync.yml`.
4. GitHub Actions runs `scripts/syncData.cjs`, validates data, commits changed
   JSON files, and deploys GitHub Pages.
5. GitHub Pages publishes only the lightweight React shell and allowed runtime
   metadata. Protected C-end match, odds, history, and model data must be served
   by the Node `/api/v1/*` service.

The Worker may expose `/api/sync-meta` for freshness checks and `/api/health`
for operations. Requests for match lists, history, odds, prediction snapshots,
or model detail return `410` with a replacement Node API path.

## Required Secrets

### Cloudflare Worker secrets

Set these with Wrangler or through the GitHub deployment workflow.

- `GITHUB_TOKEN`: GitHub token used by the Worker to dispatch the sync workflow.
- `MANUAL_TRIGGER_TOKEN`: bearer token for `/trigger` and the authenticated
  `/api/sporttery-evidence` pull endpoint.
- `SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8`: Ed25519 PKCS#8 private key whose
  public key and fingerprint are frozen in the production collector trust
  registry and `wrangler.jsonc`.

The GitHub token should have access to this repository and enough Actions
permission to read workflow runs and create workflow dispatch events.

### GitHub repository secrets for deployment

Add these in GitHub repository settings before running
`Deploy Cloudflare Sync Worker`.

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SYNC_WORKER_GITHUB_TOKEN`
- `SYNC_WORKER_MANUAL_TOKEN` and
  `SYNC_WORKER_SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8` must be configured as a
  pair to enable the independent collector. A partial pair fails deployment;
  an absent pair leaves scheduling active but truthfully reports the collector
  as disabled.

## Deploy From GitHub

Open GitHub Actions and run:

```text
Deploy Cloudflare Sync Worker
```

That workflow uploads Worker secrets and deploys:

```text
cloudflare/sync-trigger/wrangler.jsonc
```

## Deploy Locally

```bash
npx wrangler login
npm run cf:sync:deploy
npx wrangler secret put GITHUB_TOKEN --config cloudflare/sync-trigger/wrangler.jsonc
npx wrangler secret put MANUAL_TRIGGER_TOKEN --config cloudflare/sync-trigger/wrangler.jsonc
npx wrangler secret put SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8 --config cloudflare/sync-trigger/wrangler.jsonc
npm run cf:sync:deploy
```

On Windows PowerShell, use `npx.cmd` if `npx.ps1` is blocked by the execution
policy:

```powershell
npx.cmd wrangler login
npx.cmd wrangler secret put GITHUB_TOKEN --config cloudflare/sync-trigger/wrangler.jsonc
npx.cmd wrangler secret put MANUAL_TRIGGER_TOKEN --config cloudflare/sync-trigger/wrangler.jsonc
npx.cmd wrangler secret put SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8 --config cloudflare/sync-trigger/wrangler.jsonc
```

The production source-health API must still prove a fresh Ed25519 signature
from this key and a distinct independence domain before the UI or model audit
may report `trustedCollectorCount=2`. Merely deploying the Worker or storing
the secrets is not redundancy proof.

## Manual Trigger Test

```bash
curl "https://football-predict-sync-trigger.<your-subdomain>.workers.dev/health"
curl -H "Authorization: Bearer <MANUAL_TRIGGER_TOKEN>" \
  "https://football-predict-sync-trigger.<your-subdomain>.workers.dev/trigger"
curl -X POST -H "Authorization: Bearer <MANUAL_TRIGGER_TOKEN>" \
  "https://football-predict-sync-trigger.<your-subdomain>.workers.dev/api/sporttery-evidence"
```

Keep the manual token in the `Authorization` header. Do not pass it as a query
string, because URLs are more likely to be captured in browser, proxy, and edge
logs.

The production server sets `SPORTTERY_CLOUDFLARE_EVIDENCE_URL` and
`SPORTTERY_CLOUDFLARE_PULL_TOKEN`. Each sync cycle pulls the signed evidence
over Workers HTTPS and posts it only to the loopback Node admin endpoint. The
production admin token is never sent to Cloudflare and is never exposed over
public HTTP.

Expected response:

```json
{
  "ok": true,
  "dispatched": true
}
```

If a GitHub workflow is already running or was started recently, the Worker will
return `dispatched: false` and include the existing run URL.

## Important Note

Cloudflare Cron starts the sync. GitHub Actions still performs the scrape and
publish step. If GitHub Actions cannot reach China Sporttery during one run, the
sync script preserves the existing full data store instead of overwriting it
with partial data. GitHub Pages deployment requires the `DATA_API_BASE`
repository variable to be an absolute HTTPS URL for the protected Node API;
otherwise the Pages build fails instead of publishing a shell that cannot reach
the production API.

If the official site blocks Cloudflare egress, leave that pull lane disabled in
production and use the signed new-server collector instead. Configure
`SPORTTERY_SERVER_DIRECT_COLLECTOR_PRIVATE_KEY_PATH`,
`SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_ID`, and
`SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_FINGERPRINT`; the sync worker fetches the
same two official HAD/HHAD endpoints directly, signs the observations under a
separate trust-registry identity, and uploads only to the loopback admin route.
Cloudflare deployment success by itself is not evidence that this collector is
usable: the runtime pull must return signed endpoints and the public source
health must report two current independence domains.
