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

- Runtime: Node.js 20.15
- Region: `cn-north-4` (华北-北京四)
- Handler: `index.handler`
- Memory: 256 MB
- Timeout: 60 seconds
- Public network access: enabled
- Timer trigger: `@every 5m`

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
