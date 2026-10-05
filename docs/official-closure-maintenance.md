# Official empty-schedule maintenance

This is an incident-specific repair for the authenticated runtime **r785** and
frontend **r787**. It is separate from a full application release. Existing full
release, UI release, source freshness, model qualification and historical repair
policies remain unchanged.

**Current state: reviewed candidate, production admission disabled.** Official
source research confirms that `channel=c` selects the cash channel, but does not
establish the numeric meaning of either `SaleStatus` field. The current `1/1`
predicate is an unverified business assumption. Synthetic passing fixtures only
test its implementation. Capsule creation and production prepare/activate remain
disabled in code until a separately reviewed official contract establishes the
correct predicate. There is no environment or CLI override; status/recovery
remain available.

## Exact scope

The three application files are reconstructed from the authenticated original
r785 source and the reviewed incident delta in commit `1d0daef3924f7`:

- `scripts/syncData.cjs`: attach the independently verifiable official closure
  evidence when the real current list is empty.
- `scripts/validateData.cjs`: verify that evidence against the independently
  installed collector trust registry; missing current files still fail.
- `scripts/officialClosedScheduleEvidence.cjs`: the new proof verifier.

The maintenance capsule must not contain the entire integration version of
`syncData.cjs`, a model change, a UI change, data rows, a replacement database or
new privileges. The CLI binds the exact original files, reviewed patch, and
resulting file hashes.

A separate, signed root entrypoint change only **adds a refusal** while
`/var/lib/football-release/closure-repairs/current` exists. It preserves the
existing full-release and PostgreSQL-repair checks. The guard remains installed
after code rollback so an interrupted repair cannot be hidden by a new release.

## Preconditions

1. The server's retained r785 archive and detached signature must authenticate
   the original runtime; installed files and the four existing proof dependencies
   must match that inventory. Frontend r787 must remain unchanged.
2. The current worker PID, invocation, completed failed cycle and journald
   evidence must identify the exact `matches-current.json must contain a
   non-empty array.` failure. The current file must really contain `[]`.
3. Both exact official endpoints must have valid signatures, one source cycle,
   successful empty responses and verified stop-sale semantics. Evidence must
   be no more than 20 minutes old. Neither an online sale flag of `0` nor two
   flags of `1` currently establishes the missing business contract.
4. PostgreSQL and the active immutable generation must agree. Frozen
   recommendations and public reference evidence are captured before any repair.
5. A valid maintenance window, no unresolved release/repair, unchanged trust
   registry, exact before hashes and a short-lived signed capsule are required.

The available `sudo` capability is checked on the target host. The client uses
the existing pinned SSH identity and fixed Node executable; it does not modify
sudoers or invent a new mode supported by the existing `football-release`
wrapper. The server verifies the capsule with its own installed release public
key **before loading capsule code**.

## Operator flow

Use the already configured release signing key, public key, SSH key and dedicated
known-hosts file through explicit `RELEASE_SIGNING_PRIVATE_KEY`,
`RELEASE_SIGNING_PUBLIC_KEY`, `RELEASE_DEPLOY_KEY` and
`RELEASE_DEPLOY_KNOWN_HOSTS`. Do not print or recreate keys.

The entrypoint is `node scripts/officialClosureRepairCli.cjs` with explicit
`--action=...`; it has no implicit activation action.

1. `inspect --output=<absolute-new-observation.json>` performs only remote
   observation. In actual CLI syntax this is `--action=inspect`.
2. `--action=sources --baseline=<authenticated-before-directory>
   --output=<new-directory-inside-checkout>` reconstructs and checks the exact
   three-file delta without signing or touching production.
3. `--action=create --observation=<observation.json>
   --baseline=<authenticated-before-directory> --output=<new-capsule-directory>`
   rejects an ineligible observation before signing. The unverified sales
   contract independently disables signing even for an otherwise eligible
   observation.
4. `--action=prepare --capsule=<capsule-directory>` stages verified root-owned
   artifacts and runs the candidate validator with no network and a read-only
   host. The real current clock is used. Server/public positive cases, the
   original validator failure, expired evidence, corrupt signature and missing
   current-file cases are required. Only the isolated candidate is writable.
5. `--action=activate --capsule=<capsule-directory>` dispatches a supervised
   systemd transaction under the existing publisher lock. Dispatch is not
   acceptance. Original service states and code are preserved; only the normal
   worker may publish new data.
6. `--action=status --capsule=<capsule-directory>` reads the durable receipt.
   Acceptance requires a new worker PID and completed official publication,
   PostgreSQL/generation agreement, retained frozen objects, valid newly
   published closure proof and service/API checks. Model promotion remains false.
7. `--action=recover --capsule=<capsule-directory>` restores exact original
   application code and service states under the same lock. Recovery never
   restores an older database, rewrites frozen decisions or discards new source
   observations. Expiry blocks prepare/activate but cannot prevent recovery.

If the input changes during preparation, capture and sign a new observation;
do not edit an existing signed capsule. If another code hash appears during
recovery, fail closed and preserve the transaction for inspection.

## Current evidence and release boundary

At **2026-10-03 01:52:24 Asia/Shanghai**, a genuinely fresh local collection had
two HTTP 200 empty responses and valid Ed25519 signatures. It still failed the
closure proof: the calculator reported `offLineSaleStatus=1` and
`onLineSaleStatus=0`. Therefore source freshness alone does not make this repair
eligible. This observation is historical evidence, not a live authorization.

At **2026-10-03 02:03:11 Asia/Shanghai**, read-only inspection of the actual
server found the full relay had refreshed to **01:58:02**. Both signatures were
valid; `closure-stop-sale-unproven` remained the only closure audit blocker.
Creating a capsule from that actual observation was rejected before signing,
and no capsule directory was created.

The official [commonV1.js](https://static.sporttery.cn/res_1_0/common/js/commonV1.js)
defines `c` as cash, `i` as internet, `v` as telephone and `a` as all channels.
The fetched calculator page and its scripts did not define the two sale-status
numeric values. Seven successful official page/script fetches with timestamps
and hashes are retained locally in
`outputs/maintenance-20261003/official-sale-status-semantics/findings.json`.
This narrows the investigation; it does not prove that the existing closure
predicate matches the upstream contract.

The existing full-release route additionally requires source and publication
conditions that this maintenance transaction does not relax. A successful
maintenance receipt would not itself mean the UI/model optimization batch was
deployed, that market data was fresh, or that collection had fully moved off the
laptop. Actual deployment and local collector status are recorded separately in
`outputs/maintenance-20261003/delivery.json`.
