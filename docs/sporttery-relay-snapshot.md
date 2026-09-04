# Sporttery Relay Snapshot

Use this when the production server cannot reach `webapi.sporttery.cn` directly
from its outbound region. A mainland collector fetches the official Sporttery
payloads and writes a signed-by-path JSON snapshot for the cloud worker to read.
This is a collector path, not proof of source redundancy. The cloud server owns
the sync worker, SQLite store, model catch-up, and protected `/api/v1/*` reads,
but when server direct/proxy egress is unavailable and only one collector is
trusted, that collector is still an upstream production single point. Public
source health exposes this as `officialSourceSinglePoint=true` with an explicit
`watch` redundancy status; it does not fail an otherwise serviceable deployment.

## Collector

Run on a machine that can reach Sporttery:

```bash
SPORTTERY_RELAY_SNAPSHOT_OUT=/tmp/sporttery-relay-snapshot.json \
npm run sync:sporttery-snapshot
```

Production prediction evidence requires a signed collector identity. Generate it
once in a secure directory outside the repository:

```powershell
node scripts/generateCollectorAttestationKey.cjs `
  --out-dir "$HOME\.football-predict\collector-attestation" `
  --key-id football-mainland-collector-YYYYMMDD `
  --independence-domain mainland-collector-runtime-1
```

`--independence-domain` identifies an independently operated collector runtime,
not a key. Key rotations on the same machine must keep the same domain, so two
keys on one collector still count as one source. Only separately operated
collectors with distinct registry-assigned domains can increase redundancy.

Put only these paths in `.codex-tmp/sporttery-relay.env`:

```env
SPORTTERY_COLLECTOR_PRIVATE_KEY_PATH=C:\Users\operator\.football-predict\collector-attestation\football-mainland-collector-YYYYMMDD.private.pem
SPORTTERY_COLLECTOR_KEY_ID=football-mainland-collector-YYYYMMDD
SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=C:\Users\operator\.football-predict\collector-attestation\collector-trust-registry.json
```

The private key remains collector-local. Copy only the generated public trust
registry into `deploy/light-server/collector-trust-registry.json`; both the API
service and sync worker load that public registry. Unsigned or unknown-key
snapshots remain usable only as diagnostic/fallback data and cannot enter the
promotion cohort.

Verify a real collector output against the deployed public trust registry:

```powershell
npm.cmd run verify:collector-runtime -- .codex-tmp\sporttery-relay-snapshot.json --strict
```

The runtime verifier rehashes each endpoint payload, validates the Ed25519
attestation, parses the actual HAD/HHAD rows, and requires at least one strict
market row from each pool. It prints key IDs and public fingerprints only; it
never reads or prints the private key.

Optional proxy on the collector:

```bash
SPORTTERY_OUTBOUND_PROXY=socks5h://user:password@mainland-proxy.example.com:1080 \
SPORTTERY_RELAY_SNAPSHOT_OUT=/tmp/sporttery-relay-snapshot.json \
npm run sync:sporttery-snapshot
```

Windows collector proxy preflight:

```powershell
# Writes .codex-tmp/sporttery-relay.env with 0600-style permissions where supported,
# masks credentials in output, then verifies the proxy against Sporttery.
npm run configure:sporttery-proxy -- --proxy=socks5h://user:password@mainland-proxy.example.com:1080 --verify

# Later checks can be run without rewriting the proxy.
npm run verify:sporttery-relay-proxy
```

`configure:sporttery-proxy` only prints a masked proxy URL. The verifier imports
`.codex-tmp/cloud-sync.env` and `.codex-tmp/sporttery-relay.env`, requires a
configured proxy, runs the Sporttery egress probe through that proxy, and writes
`logs/sporttery-egress-proxy-status.json`.

Authenticated proxy URLs are never passed in curl command-line arguments. The
collector sends the proxy setting through curl's private stdin config pipe, so
the username/password do not appear in process listings. Proxy values containing
newlines or NUL bytes fail closed before curl starts. Snapshots and logs retain
only the masked proxy URL.

## Upload

Recommended: collect, validate, and upload with one command. Run this on the
collector that has a mainland Sporttery egress:

```bash
SPORTTERY_RELAY_PUSH_BASE_URL=https://134.175.132.183 \
SPORTTERY_RELAY_ADMIN_TOKEN=$ADMIN_TOKEN \
npm run sync:sporttery-relay-push
```

Useful collector modes:

```bash
# Local fetch only; does not call the production server.
SPORTTERY_RELAY_DRY_RUN=1 npm run sync:sporttery-relay-push

# Upload validation only; the server validates the snapshot but does not write it.
SPORTTERY_RELAY_PUSH_BASE_URL=https://134.175.132.183 \
SPORTTERY_RELAY_ADMIN_TOKEN=$ADMIN_TOKEN \
SPORTTERY_RELAY_VALIDATE_ONLY=1 \
npm run sync:sporttery-relay-push

# Use an already-created snapshot file. Snapshot upload does not run server sync by default.
SPORTTERY_RELAY_SKIP_COLLECT=1 \
SPORTTERY_RELAY_SNAPSHOT_PATH=/tmp/sporttery-relay-snapshot.json \
SPORTTERY_RELAY_PUSH_BASE_URL=https://134.175.132.183 \
SPORTTERY_RELAY_ADMIN_TOKEN=$ADMIN_TOKEN \
npm run sync:sporttery-relay-push

# Manual emergency only: ask the API process to trigger an immediate sync after upload.
# Prefer the split sync worker for normal production traffic.
SPORTTERY_RELAY_RUN_SYNC=1 npm run sync:sporttery-relay-push
```

The script never logs the token. It prints the local snapshot status, upload
validation rows, whether remote sync was triggered, and a compact
`/api/v1/health` + `/api/v1/source-health` summary after upload.

Production keeps two independent remote files. The protected full endpoint
writes `sporttery-relay-snapshot.json` and accepts only a complete single-cycle
snapshot with both `result` and `all` archive coverage. The protected fast-lane
endpoint writes `sporttery-relay-fast-lane.json` and accepts only bounded
`current` and/or `calculator`, plus optional result page 1 evidence with trusted
endpoint clocks. At least one official current-market endpoint is required;
this keeps a signed `current` payload serviceable when WAF blocks the redundant
calculator endpoint. A fast upload never rewrites or truncates the full archive.

To publish a previously verified single-cycle collector file into only the fast
lane, without touching the full archive:

```powershell
npm.cmd run sync:sporttery-fast-lane-push -- .codex-tmp\sporttery-relay-snapshot.json --current-only
```

`sync:sporttery-relay-push` retains the complete hourly full snapshot and the
separate local fast-lane snapshot. When a full collection is cooling down or is
not due, a successful signed current/calculator collection is uploaded directly
to `/api/admin/sporttery-relay-fast-lane?runSync=0`; it is never flattened into
the retained full snapshot. The resident fast-result/current watcher can publish
the same independent remote fast file at a shorter result-driven cadence. Keep
`SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=0`; that legacy override is not a
substitute for the dual-file lane and must not be used to overwrite the full
endpoint with a compact payload.

## Optional Windows Collector Task

Only use this on a dedicated collector or temporary fallback machine. It is not
a production dependency on your local PC. On a Windows collector, keep secrets
in `.codex-tmp/cloud-sync.env` or
`.codex-tmp/sporttery-relay.env`:

```env
SPORTTERY_RELAY_PUSH_BASE_URL=https://134.175.132.183
SPORTTERY_RELAY_ADMIN_TOKEN=replace-with-admin-token
# Optional. Use this when the collector's direct Sporttery egress is blocked.
# Credentials are masked in generated snapshots and logs.
SPORTTERY_OUTBOUND_PROXY=socks5h://user:password@mainland-proxy.example.com:1080
```

Prefer the helper when rotating or clearing the proxy:

```powershell
npm run configure:sporttery-proxy -- --proxy=socks5h://user:password@mainland-proxy.example.com:1080 --verify
npm run configure:sporttery-proxy -- --clear
```

Install a hidden task that runs only the lightweight relay push:

```powershell
npm run sync:sporttery-relay-install-task
```

Defaults:

- Task name: `FootballPredictSportteryRelay`
- Interval: 1 minute for the current/live lane; the collector keeps full-history refreshes on its separate slower cadence.
- Log: `logs/sporttery-relay.log`
- Lock: `logs/sporttery-relay.lock`
- Timeout: 4 minutes
- Missed-start recovery: enabled (`StartWhenAvailable=true`).
- Power policy: starting on battery is allowed and switching to battery does not
  stop an active run.
- Failure recovery: 3 retries, 1 minute apart.
- Task execution limit: 10 minutes, independent from the wrapper's 4-minute
  child-process watchdog.
- Overlap policy: `TASK_INSTANCES_IGNORE_NEW` plus the wrapper's exclusive file
  lock prevents a slow run from being queued or overlapped by the next trigger.
- Wake policy: disabled by default so a one-minute task does not repeatedly wake
  the computer. Set `FOOTBALL_RELAY_WAKE_TO_RUN=1` before installing only when
  this behavior is explicitly desired.
- Logon policy: interactive token by default. S4U is never selected implicitly;
  set `FOOTBALL_RELAY_USE_S4U=1` before installing only after verifying local-key
  access and unattended execution for that Windows account.
- Upload mode: snapshot upload only; the server worker consumes it on the next
  cycle. Set `SPORTTERY_RELAY_RUN_SYNC=1` only when you need the collector to
  trigger an immediate server sync after upload.
- SSH uploads atomically replace the relay file and verify the worker is active;
  they do not restart the worker, so an in-flight sync and its lock are not interrupted.
- Cloud sync API uploads follow the same rule: `FOOTBALL_CLOUD_RELAY_RUN_SYNC`
  defaults to off, so the API process does not run heavyweight sync work.

The recovery defaults can be overridden before installation with
`FOOTBALL_RELAY_RETRY_COUNT`, `FOOTBALL_RELAY_RETRY_INTERVAL_MINUTES`, and
`FOOTBALL_RELAY_EXECUTION_LIMIT_MINUTES`. Re-run
`npm run sync:sporttery-relay-install-task` after changing task policy.

### Optional fast official-result lane

The one-minute task above remains the reliable full/current fallback. When
settled scores need a smaller publication window, install the separate resident
fast lane after its isolated verifier passes:

```powershell
npm run verify:sporttery-result-fast
npm run sync:sporttery-result-fast-install-task
```

The fast-result task defaults to passwordless `TASK_LOGON_S4U`, so it continues
after the interactive desktop session logs off without storing the Windows
password. `FOOTBALL_FAST_RESULT_TASK_IDENTITY=SYSTEM` selects the service account
policy when the installer is elevated and the configured Node/workspace paths
are machine-readable. Interactive-token mode is rejected unless the operator
explicitly sets both `FOOTBALL_FAST_RESULT_TASK_IDENTITY=INTERACTIVE` and
`FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE=1`; it is for temporary diagnostics only.
The identity policy can be checked without changing Task Scheduler:

```powershell
$env:FOOTBALL_FAST_RESULT_VALIDATE_ONLY="1"
powershell -NoProfile -File scripts/installSportteryFastResultLaneTask.ps1
```

The resident watcher uses a 15-second result-page probe by default. A steady
probe makes one official request for result page 1 and computes a semantic
fingerprint from official match IDs, statuses, and scores. A result change
publishes immediately. Even when the result is unchanged, a 60-second
`SPORTTERY_FAST_CURRENT_HEARTBEAT_SECONDS` deadline collects fresh current and
calculator responses and publishes a new three-endpoint fast snapshot. Uploads
go to `/api/admin/sporttery-relay-fast-lane?runSync=0`; the worker notices the
independent fast-file change and consumes it without the collector starting a
second heavyweight sync process.

Safety properties:

- four result-page requests per minute at the 15-second default, plus two
  current/calculator requests per 60-second heartbeat; a result change can
  publish sooner but never disables the heartbeat freshness bound;
- a process/lease singleton prevents overlapping resident watchers, while the
  Task Scheduler supervisor uses `TASK_INSTANCES_IGNORE_NEW`; the lock validates
  PID, process start time, command signature, and workspace root so PID reuse is
  never reported as a healthy already-running instance;
- state and upload snapshots use same-directory temporary files plus atomic
  rename;
- generic failures use exponential backoff from 30 seconds to 5 minutes;
  `official-waf` failures continue to a 30-minute cap
  (`SPORTTERY_FAST_RESULT_WAF_BACKOFF_MAX_SECONDS`) so repeated WAF blocks do
  not extend the ban, while ordinary timeout and network recovery remain fast;
- invalid `NaN`, `Infinity`, negative, or extreme cadence/timeout values are
  replaced with conservative finite defaults and clamped bounds;
- upload success requires HTTP 2xx plus JSON `ok=true` and successful stored snapshot validation;
  empty or non-JSON 2xx responses never advance the result
  fingerprint;
- bearer uploads require HTTPS except for isolated loopback verification, and
  logs never contain the token;
- the full archive SHA256 is unaffected by fast uploads, and the existing
  one-minute `FootballPredictSportteryRelay` task remains an independent full
  collector fallback.

With a healthy collector and the server fast-result watcher deployed, a result
that is already visible on Sporttery normally reaches the relay within one
15-second probe window plus collection/upload time. The operational target is
20–30 seconds from official visibility to the changed relay snapshot, not a
guarantee. This design does not promise source-to-page updates under 10 seconds:
Sporttery publication timing, network/WAF behavior, server consumption, and the
browser event connection remain external latency and availability risks. If the
resident fast lane is not installed, the honest healthy bound remains the
one-minute scheduler window plus that run's collection/upload duration.

If a live collection is blocked but the existing trusted relay snapshot is still
inside the C-end fallback window, the task uploads that existing snapshot and
exits successfully with `status: "watch"`. `SPORTTERY_RELAY_MAX_AGE_MINUTES`
still marks the primary Sporttery lane stale after the short source window, but
`SPORTTERY_RELAY_STALE_FALLBACK_MAX_AGE_MINUTES` lets the collector keep the
known-good snapshot usable until the public health fallback window expires. The
verifier still reports `relay-collector-waf-blocked` /
`relay-collector-direct-egress`, so this is safe for short degradation windows
without hiding the need for a better egress.

The push task also keeps a trusted last-good copy beside the working snapshot.
By default a fresh collection must have at least 100 rows and 2 usable endpoints
(`SPORTTERY_RELAY_MIN_TRUSTED_ROWS`, `SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS`) to
replace that trusted copy. If WAF returns only a tiny partial snapshot, the task
uses a trusted last-good snapshot while it remains within the stale fallback
window and marks the collector state with `lastTrustedFallbackAt`. If no trusted
fallback exists inside that window, the current-only snapshot can still keep the
live list moving only when `SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=1` is set.
By default partial current-only snapshots are not uploaded as business snapshots;
the task uploads collector state with `partial-live-upload-disabled`, and the
server keeps the last trusted fallback authoritative.

The collector tracks `current/calculator` and paged `full/history` as separate
lanes. A healthy full snapshot is refreshed at most once per
`SPORTTERY_RELAY_FULL_INTERVAL_MINUTES` (default 60); intervening scheduled runs
request only the lightweight current lane. This avoids repeatedly hitting the
paged endpoints while keeping the C-end list fresh. Current-only runs never
change the full failure counter or its retry deadline.

After repeated weak/WAF full results, the v2 circuit enters adaptive backoff.
During cooldown it preserves a fixed `nextFullProbeAt`, continues the lightweight
current lane when enabled, and performs exactly one half-open full probe when the
deadline is reached. One collector cycle can advance the circuit only once, even
though state is written before and after upload. Defaults are:
`SPORTTERY_RELAY_BACKOFF_FAILURES=3`,
`SPORTTERY_RELAY_BACKOFF_BASE_MINUTES=15`, and
`SPORTTERY_RELAY_BACKOFF_MAX_MINUTES=60`. By default
`SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT=1` keeps the lightweight
current/calculator lane available during non-WAF full-lane backoff, so the
collector can evaluate current freshness while the full trusted snapshot is
still marked degraded. When the last full failure is an official WAF/403/567
response, `SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT=1` keeps an independent,
bounded current/calculator recovery probe. Its first retry waits
`SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES` (default 10), then consecutive
failures back off exponentially to 20, 40, and at most
`SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES` (default 60). A successful
current-lane collection resets the failure count and the delay. The one-minute
task therefore does not hit the provider on every scheduler tick or keep
extending a provider-side WAF window, while the independent full lane still
performs its hourly half-open probe. It will not overwrite the server relay snapshot unless
`SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=1` is set.
Set `SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT=0` only when even the lightweight
current endpoint is causing collector trouble. Internally this uses
`SPORTTERY_RELAY_METHODS=none`, which means no paged concern/live/result/all
methods are requested beyond the built-in current/calculator endpoints. Set
`SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT=0` only when an operator needs to
stop even the bounded current-lane probe. Set
`SPORTTERY_RELAY_BACKOFF_DISABLED=1` only for a manual recovery test.

A full trusted snapshot must include at least one usable paged endpoint;
current-only data cannot become last-good merely by exceeding the row threshold.
Composite snapshots preserve per-endpoint timestamps and never replace the real
full last-good file. State and last-good files are published with atomic rename,
and source health reports current and history freshness independently.

Override examples:

```powershell
$env:FOOTBALL_RELAY_INTERVAL_MINUTES="1"
$env:FOOTBALL_RELAY_START_NOW="0"
npm run sync:sporttery-relay-install-task
```

Preferred: push through the protected admin API. This keeps the collector out of
the server shell and lets the server validate the snapshot before writing it.
The token must be sent as `Authorization: Bearer ...`; query tokens are rejected.
Public bearer uploads require HTTPS. Plain HTTP is allowed only for loopback
diagnostics and must never carry a production token across a network.

```bash
curl -X POST "https://134.175.132.183/api/admin/sporttery-relay-snapshot?runSync=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq '{snapshot: .}' /tmp/sporttery-relay-snapshot.json)
```

For a dry validation that does not write the file:

```bash
curl -X POST "https://134.175.132.183/api/admin/sporttery-relay-snapshot?validateOnly=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq '{snapshot: .}' /tmp/sporttery-relay-snapshot.json)
```

`scripts/pushCloudSync.cjs` will use this HTTPS path first when
`FOOTBALL_CLOUD_ADMIN_TOKEN` is configured:

```bash
FOOTBALL_CLOUD_API_BASE=https://134.175.132.183 \
FOOTBALL_CLOUD_ADMIN_TOKEN=$ADMIN_TOKEN \
npm run sync:cloud-push
```

Fallback: copy the snapshot to the production data store over SSH.

Copy the snapshot to the production data store:

```bash
scp -P 22 /tmp/sporttery-relay-snapshot.json ubuntu@134.175.132.183:/tmp/
ssh -p 22 ubuntu@134.175.132.183 \
  "sudo install -o football -g football -m 0664 /tmp/sporttery-relay-snapshot.json /var/lib/football-predict/sporttery-relay-snapshot.json"
```

## Server Config

`deploy/light-server/env`:

```bash
SPORTTERY_RELAY_MODE=prefer
SPORTTERY_RELAY_SNAPSHOT=/var/lib/football-predict/sporttery-relay-snapshot.json
SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=/opt/football-predict/deploy/light-server/collector-trust-registry.json
SPORTTERY_RELAY_MAX_AGE_MINUTES=20
SPORTTERY_RELAY_STALE_FALLBACK_MAX_AGE_MINUTES=60
SPORTTERY_RELAY_BACKOFF_FAILURES=3
SPORTTERY_RELAY_BACKOFF_BASE_MINUTES=15
SPORTTERY_RELAY_BACKOFF_MAX_MINUTES=60
SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT=1
SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT=1
SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES=10
SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES=60
SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=0
# Optional strict mode. Keep this off unless paged Sporttery endpoints are stable.
SPORTTERY_RELAY_REQUIRE_PAGED=0
```

`prefer` uses a fresh relay snapshot before trying direct Sporttery fetches.
`fallback` tries direct fetches first and only uses the snapshot if direct fetches
return no rows. `off` disables snapshots.

The live/current endpoint is enough to refresh current C-end match freshness.
If Sporttery paged endpoints return HTML or are blocked, the server accepts a
fresh current-only snapshot and records a warning instead of rejecting the
upload. Set `SPORTTERY_RELAY_REQUIRE_PAGED=1` only when a release explicitly
needs paged relay data to be mandatory.

## Verify

```bash
SPORTTERY_RELAY_SNAPSHOT=/var/lib/football-predict/sporttery-relay-snapshot.json \
npm run verify:sporttery-relay

SPORTTERY_RELAY_REQUIRE_PAGED=1 \
SPORTTERY_RELAY_SNAPSHOT=/var/lib/football-predict/sporttery-relay-snapshot.json \
npm run verify:sporttery-relay

npm run sync:data
npm run datastore:sqlite
```

After the next worker cycle, `/api/v1/source-health` should show
`sporttery.metrics.transport` as `relay` or `relay-fallback`, with a fresh
`relaySnapshot.capturedAt`.

For collector-side operations, use:

```bash
npm run verify:cloud-sync-freshness
```

Important fields:

- `summary.localRelayTransport`: `proxy` proves `SPORTTERY_OUTBOUND_PROXY` was
  used for the successful snapshot; `direct` means the collector is still using
  its normal network.
- `summary.relayLastFailureWafBlocked`: true means the latest failed collection
  hit Sporttery WAF/403.
- `summary.sportteryRelayNeedsProxy`: true means the collector is still using
  direct egress and Sporttery is returning Tencent captcha/WAF/403 pages. Add a
  working `SPORTTERY_OUTBOUND_PROXY` to `.codex-tmp/sporttery-relay.env` or move
  the collector to a Sporttery-reachable network before expecting primary mode
  to recover.
- `summary.sportteryRelayRecommendedAction`: copyable next action for restoring
  Sporttery primary freshness after a relay egress failure.
- `npm run verify:sporttery-relay-proxy`: one-command proof that the configured
  relay proxy really returns Sporttery JSON before the scheduled task relies on
  it.
- `watch` containing `relay-collector-direct-egress` means the collector needs a
  working proxy or a different network location before the current snapshot
  ages out.
