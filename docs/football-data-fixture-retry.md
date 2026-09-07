# Supplementary fixture failure scheduling

2026-09-07. This change is developed separately from the signed, running r698
transaction. It does not restore the upstream service or change model admission.

## Observed defect

The fixture collector correctly preserves its last successful `status.json` on
network/HTTP failure. The worker previously used only that successful `checkedAt`
to decide whether its six-hour refresh was due. Once overdue, a failing request
was therefore eligible again on every slow cycle. The actual r697 completed cycle
reported `sync:football-data-fixtures` exit 1; the separate historical-results
downloader's failed 2627/E0 requests must not be confused with this fixtures URL.

## Changes

- An independent `training/raw/football-data/fixtures/attempt.json` records only
  operational attempts, consecutive failures and the next eligible attempt.
- Failed requests back off for 30, 60, 120, 240 and then at most 360 minutes.
  This is the worker's own policy, not an implementation of HTTP Retry-After.
  Successful fixture polling retains its existing minimum interval.
- A persisted running attempt protects restarts for up to 30 minutes. Worker
  interruption is propagated; it is not silently changed into a source success.
- During failed/incomplete cooldown the step remains nonfatal but `ok:false`,
  including the next attempt time. Existing worker warnings remain degraded.
- Signed release reuse is not a new network observation and cannot clear an
  unresolved source failure. A genuinely newer successful snapshot can supersede
  it. Invalid/future operational clocks cannot suppress requests indefinitely.
- Failure to persist attempt state stops that request and emits an operational
  warning; missing/invalid command results remain failures.
- The successful source status, immutable raw CSV, metadata, source observation
  clocks, provenance and recommendation eligibility are untouched. No original
  recommendation, historical outcome or signed training asset is rewritten.

## Verification

18 new zero-network checks use actual atomic file writes in a system temporary
directory, restart-style rereads, failure/recovery/reuse/clock cases, real fixture
collector validation with a synthetic 503, unchanged successful snapshot bytes,
and execution of the actual worker orchestration for disabled, fresh, due and
cooldown branches. The source fixture collector's existing 13 checks and worker
cadence regression pass. Production readiness now requires this 18-case suite.

These checks do not establish live adoption or upstream recovery. Release
completion and a real worker failure/cooldown observation are separate evidence.
