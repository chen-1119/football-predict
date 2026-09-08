# Release workflow: reject known worker failures before expensive preparation

2026-09-08. This change is separate from the already signed/running r707.

## Observed problem

r705 previously reached candidate preparation before the existing live-prebuild
gate discovered that the old worker could not publish an official generation.
An active service and HTTP 200 did not establish worker publication health. This
caused a late failure, not a failed frontend build. Replaying the same terminal
release or rebuilding an unchanged bundle cannot fix that condition.

## Implemented

`releaseWorkerPreflight.cjs` reads the fixed systemd service, the real `/proc`
process and its status file. It binds the status PID and timestamp to the same
service incarnation before/after the read. Missing/unsafe files, unknown status,
process races and the latest official-cycle failure reject preparation. Raw
errors, runtime environment values and credentials are not returned.

The deployment client runs the serialized, identically tested probe over pinned
SSH before uploading artifacts. The signed server shell repeats the fresh probe
before changing host configuration or constructing the candidate, covering queue
and offline-entry callers. A failed supplement after a successfully published
official phase is a distinct warning, not automatically an official-source
failure. A new active attempt clears the previous failure classification.

`prepare-may-continue` is **not** publication success: `readyToCutover` is always
false. The original fresh official publication, transition lease, full candidate
verification, generation/SQLite/PG identity, new-worker cycle, public/protected
contracts, recovery and rollback gates remain mandatory. This probe writes no
production state, starts no process and caches no live pass.

## Verification

- 20 behavioral/wiring cases, including the exact serialized SSH code executing
  against a read-only capability-limited filesystem/process fixture.
- Release transaction 65/65; recovery-helper rotation 10; deployment configuration
  122; release verifier contracts 172; six affected JavaScript files pass ESLint.
- Read-only live execution at 2026-09-08T03:18:10Z identified PID 2768192 and
  `slow-enrichment`, status age 0.135 seconds, no blockers and no production writes.
  This is a time-specific probe, not r707 acceptance or a full worker-cycle proof.
- Evidence: `outputs/worker-preflight-regression-1788837526253.json` and
  `outputs/worker-preflight-live-1788837490303.json` in the UI worktree.

## Remaining workflow work

The r706/r707 output wrappers already prevent repeat static stages for the same
source/bundle identity. They are not yet a general checked-in release controller.
Move toward four explicit phases: immutable local preparation, fresh live
preflight, one signed remote transaction, and version-bound post-release
acceptance. Persist per-stage identity/evidence/duration and invalidate only the
dependencies that changed. Refresh live facts just before dispatch; never reuse
them as static receipts. Resume observation of a running identity, never restart
because its SSH observer timed out. A terminal failed identity remains terminal.

Remaining work includes early candidate-registry/archive-continuity checks,
portable stage receipts and an actionable phase/failure report. Do not claim the
whole release workflow redesign or a fixed deployment-duration reduction from
this one early-rejection improvement.
