# Candidate rehearsal: preserve the real ledger before validation

## Observed failure (2026-09-07)

r701 / SHA `0a292f7957ff7c0019e32d7cfecd878a4514a406040c738508941cd3c8840479`
started at 14:03:00Z and failed at 14:06:20Z, before cutover. The candidate
revision baseline reported ENOENT for its own
`server-data/model-artifacts/candidate-prospective-registry.json`.
The cache barrier copied public data and AI arena state, but did not seed
the private model artifacts required by the newly added rehearsal.

This was not a queue timeout. The failed sequence must not be retried.
Both live markers stayed on r699. The fixed release entrypoint subsequently
reported `recoveryPending=0 appPresent=1` during this repair turn.

## Change

- Inside the existing stopped-worker/cache barrier, copy the nine explicit
  model artifact paths to the disposable candidate store. The candidate registry
  is mandatory; other absent artifacts stay absent.
- Validate canonical unlinked parent directories; reject existing target paths,
  non-regular files, symlinks, multiple hard links and unexpected copy failures.
- Compare source and destination bytes. Do not initialize a new empty ledger,
  copy arbitrary store contents, use a live-store symlink or write to live data.
- Retain both the pre-backtest candidate baseline and the separate final
  frozen-live baseline/continuity check. No formal promotion gate changes.
- Repair the Linux transaction-test harness to supply release identity and
  expect the two rehearsal steps already added by r701.

## Verification

`verifyCandidateArtifactSeed.cjs` executes the real Bash functions against
isolated Linux files. Eight cases cover valid copying and write isolation,
missing registry, symlink, hard link, linked parent, unsafe optional artifact,
existing target and wrong destination. Seven source-order checks bind seeding
to the existing barrier and require it before expensive construction.
The Linux behavior checks are also called by the release transaction gate.

Windows ACL behavior is not treated as Linux permission evidence. The initial
Windows execution failed on mkdir permissions; the actual Linux tests were run
through stdin using an unprivileged account, with only a temporary test directory.
No production paths were mutated by those tests.

Local release-transaction, deployment-config and exact revision-transition
checks passed. These are not proof that a new signed release has deployed.
The next release must rerun the complete real model-backtest rehearsal.

At 14:30:02Z, the read-only live window check rejected the 7,197-second runway
against the required 7,620 seconds. Its next prospective window begins strictly
after 19:30Z (03:30 Beijing on September 8). This is advisory, not a reserved
window or deployment schedule; check fresh fixtures and budgets again.
