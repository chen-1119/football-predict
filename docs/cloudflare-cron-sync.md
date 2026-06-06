# Cloudflare Workers Cron Sync

This project uses Cloudflare Workers Cron as the reliable scheduler and keeps the
existing GitHub Actions workflow as the data scraper, committer, and deployer.

Flow:

1. Cloudflare Worker runs every 5 minutes.
2. Worker checks recent GitHub workflow runs to avoid duplicate dispatches.
3. Worker calls GitHub `workflow_dispatch` for `.github/workflows/sync.yml`.
4. GitHub Actions runs `scripts/syncData.cjs`, validates data, commits changed
   JSON files, and deploys GitHub Pages.
5. The web page polls static JSON every 30 seconds.

## Required Secrets

### Cloudflare Worker secrets

Set these with Wrangler or through the GitHub deployment workflow.

- `GITHUB_TOKEN`: GitHub token used by the Worker to dispatch the sync workflow.
- `MANUAL_TRIGGER_TOKEN`: optional token for calling `/trigger` manually.

The GitHub token should have access to this repository and enough Actions
permission to read workflow runs and create workflow dispatch events.

### GitHub repository secrets for deployment

Add these in GitHub repository settings before running
`Deploy Cloudflare Sync Worker`.

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SYNC_WORKER_GITHUB_TOKEN`
- `SYNC_WORKER_MANUAL_TOKEN` optional

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
npm run cf:sync:deploy
```

On Windows PowerShell, use `npx.cmd` if `npx.ps1` is blocked by the execution
policy:

```powershell
npx.cmd wrangler login
npx.cmd wrangler secret put GITHUB_TOKEN --config cloudflare/sync-trigger/wrangler.jsonc
```

## Manual Trigger Test

```bash
curl "https://football-predict-sync-trigger.<your-subdomain>.workers.dev/health"
curl -H "Authorization: Bearer <MANUAL_TRIGGER_TOKEN>" \
  "https://football-predict-sync-trigger.<your-subdomain>.workers.dev/trigger"
```

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
sync script now preserves the existing full data store instead of overwriting it
with partial data.
