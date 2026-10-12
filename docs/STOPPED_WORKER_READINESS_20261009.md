# Code release readiness with a stopped worker

## Incident

r818 reached the code swap but failed in `native_finish_readiness`: the code
lane skipped SIGSTOP readiness freezing while the shared heartbeat keeper still
required `WORKER_FROZEN_FOR_READINESS=1`. Normal recovery completed and restored
r816. The failed archive, sequence and recovery evidence remain retained.

## Repair

- The database lane retains its existing frozen-worker requirement.
- The code lane explicitly selects `stopped-code`; it never fabricates the
  frozen-worker flag. It requires the recognized worker unit to be loaded,
  inactive/dead, with both MainPID and ControlPID zero and an absent or proven
  unpopulated canonical cgroup. Unknown state, wrong cgroup, missing evidence,
  symlinks, surviving children and command failure all reject readiness.
- The stopped-worker proof runs before heartbeat refresh, keeper startup and
  every keeper health check. The keeper still needs its normal exact heartbeat
  evidence and clean shutdown before the normal worker starts.
- The short code lease, publication identity, source/signature verification,
  core/public checks, fixed recovery and separate business acceptance remain.

## Verification

`tests/staged-code-release.test.cjs` executes the actual native finish function,
keeper entrypoint, keeper health function, stopped-worker guard and native
failure trap in Bash. External systemd/PG/recovery effects are fixtures and the
cgroup root is redirected to an owned temporary directory. The tests do not
claim production recovery or PostgreSQL restoration proof.

Cases include normal stopped code and frozen database lanes, residual child,
nonzero MainPID/ControlPID, missing unit or cgroup evidence, active/failed unit,
conflicting cgroup fields, failed verifier, and a worker that restarts during
verification. Failures must invoke the fixed recovery command, omit commit and
omit the engineering acceptance receipt. Successful paths stop the keeper
before starting/resuming the worker. Existing release and cleanup tests remain.

Initial harness failures (heredoc extraction and accidental PWD fixture value)
are preserved in local logs. These were local test harness errors, not production
changes. Full release gates and the final signed factory must run on the final
commit. This repair does not promote model parameters or change predictions.
