# Huawei FunctionGraph Sporttery collector

This package runs the existing cryptographically-attested Sporttery collector as
a Huawei Cloud FunctionGraph event function. Each timer cycle publishes market
evidence to the protected collector-evidence endpoint and independently publishes
the signed official result page plus its current/calculator companion to the
protected fast-result endpoint. Result-page payout SP stays isolated from pre-match
odds and cannot enter the market collector quorum. The ZIP never contains
production secrets.

Fast-lane storage is not treated as publication. The function succeeds only when
the server confirms both `stored: true` and `watcherEligible: true` from the same
signature-aware validator used by the result watcher.

## Function settings

- Runtime: Node.js 22.18
- Region: `cn-north-4` (华北-北京四)
- Handler: `index.handler`
- Memory: 256 MB
- Timeout: 60 seconds
- Public network access: enabled
- Timer trigger: `@every 5m`
- Keep exactly one enabled timer and remove duplicate timers after checking their purpose.
- Maximum instances: 1; reserved instances: 0 (on-demand only).
- Asynchronous retries: 0; maximum event age: 60 seconds. A failed collection waits
  for the next scheduled cycle instead of multiplying billable attempts.
- Do not enable additional paid services such as reserved capacity or LTS as part
  of this collector deployment.

`function-config.json` describes the desired console configuration; uploading the
ZIP does **not** apply those settings. Read back memory, timeout, all triggers,
asynchronous retry settings, and reserved-instance policies after deployment.
The handler also checks actual runtime memory and timeout metadata before network
work and refuses allocations exceeding 256 MB / 60 seconds. Upstream request
timeouts are clamped to 20 seconds; the shared collector bounds uploads at 15 seconds.

## Cost envelope and September 2026 correction

At 256 MB, one invocation every five minutes, and a 60-second execution limit,
31 days contain 8,928 scheduled invocations and at most 133,920 GB-seconds of
execution. Allowing another 100 operator test invocations gives 135,420 GB-seconds,
below the 150,000 planning limit and the 400,000 GB-second monthly free quota.
This estimates **zero execution/request charges in a fresh month** only when the
verified configuration is maintained and no other functions consume the shared
quota. It is not an account-wide monetary hard stop. Other cloud services and
extra triggers/API invocations are outside this estimate.

The September 16 bill showed 437,025.59 GB-seconds already used and CNY 4.10 owed.
The observed marginal price was CNY 0.00011108 per GB-second. The old free-month
estimate was not validated against the live allocation, retry configuration, and
actual duration, so it must not be presented as guaranteed free operation.
At the September 13 observed daily usage (48,790.9989 GB-seconds), 30 active days
would cost about CNY 118.16 after the free quota. This is a scenario, not the
current bill or proof of which previous setting caused the excess.

Because September's quota is already exhausted, resuming for the remaining 15
full days at the new worst-case execution limit would add up to approximately
CNY 7.20, plus CNY 4.10 already billed. The next calendar month resets the quota.
Budget notifications can lag and do not implement a hard stop. Configure a
low-cost alert separately when the account is available; do not call an alert a cap.

Sources: [free quota](https://support.huaweicloud.com/price-functiongraph/functiongraph_00_0012.html),
[budget behavior](https://support.huaweicloud.com/usermanual-cost/costcenter_0000023_1.html).

Run `node scripts/huaweiFunctionGraphCostPolicy.cjs` to validate the deployment
plan. The ZIP builder rejects plans with faster schedules, larger allocations,
automatic retries, or reserved capacity. This local check does not prove the
cloud settings have taken effect.

## Environment settings

Copy the non-secret values from `function-config.json`. Configure these values as
encrypted/secret environment settings in FunctionGraph:

- `SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8_BASE64`
- `SPORTTERY_COLLECTOR_KEY_FINGERPRINT`
- `FOOTBALL_PRODUCTION_ADMIN_TOKEN`

`SPORTTERY_COLLECTOR_REQUEST_TIMEOUT_MS` bounds both response headers and the
complete response body. Keep it below the FunctionGraph timeout budget; the
packaged default is 20 seconds.

The private key must be an independent Huawei FunctionGraph Ed25519 key. The
matching public key belongs in `deploy/light-server/collector-trust-registry.json`.
Do not reuse the Cloudflare, server-direct, or mainland collector private key.

## Build and verification

```powershell
npm.cmd run verify:huawei-functiongraph-collector
npm.cmd run build:huawei-functiongraph-collector
```

The builder copies the shared collector implementation into a deployable ZIP
under `.codex-tmp`. It rejects secret values in the source files and ZIP entry
names. Deployment is not proof of redundancy: the production evidence store
must contain a fresh valid row from this function's independent trust domain.
