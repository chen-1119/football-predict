# Frontend resource policy maintenance and failed retry

The accepted application remains runtime r793 / frontend r794. The r795 and r797 sandbox builds failed and do not authorize a new frontend. The observed r797 cgroup exceeded its 768 MiB `memory.high` boundary (98,843 high events and about 53% memory pressure); `memory.max`/OOM events remained zero. This supports investigating direct reclaim throttling, without proving it was the only cause. The kernel describes `memory.high` as the throttle/direct reclaim boundary and `memory.max` as the hard limit: https://www.kernel.org/doc/html/v6.8/admin-guide/cgroup-v2.html.

The reviewed resource change is only `MemoryHigh=896M`. The hard 1 GiB limit, zero swap, 300-second controller budget, task limits, immutable inputs, DynamicUser/rootfs/network isolation, descendant cleanup and byte/signature acceptance remain required. Real isolated Linux fixtures read the actual cgroup limits and exercise hostile writes/network/descendants; they do not establish production Vite performance.

## Fixed maintenance

Installation uses the official independently reviewed root bootstrap. An existing accepted runtime requires every signing/configuration argument and consumed sequence to match before any mutation. The root-private bootstrap ledger retains the original module/protected-file pins and reviewed source pins before copying modules. An interrupted installation can resume only that source and protected baseline; it cannot rebase the old policy proof onto a partially installed module set.

The operator uses three lock stages: observe/stage under the normal exclusive release lock, release it so the official bootstrap obtains its own lock, then acquire a fresh exclusive lock and compare the original protected state and completed bootstrap ledger before policy refresh. Drift blocks the operation. It does not pass a held lock to a bootstrap that reopens the descriptor.

The installed fixed controller command is:

```
/opt/node-v22.22.1/bin/node /usr/local/libexec/football-release-frontend/frontendReleaseController.cjs refresh-policies <old-root-binding-sha256> <accepted-state-sha256>
```

It requires root, clean fixed Node, inherited exclusive fd 9, no active release/recovery/build and no unresolved attempt. Actual installed policy hashes, retained signed runtime, complete offline material, fresh installed capture, accepted state/receipt/dist/markers, service and public-byte checks are revalidated. Only the root/public binding `policies` fields change. State, receipt, runtime fields, source/dist, signing configuration, services, database and consumed sequence are preserved. A durable shared recovery journal records known old/new inode identities and exact bytes. The normal `recover` route resumes only that verified pair; substituted files or changed evidence block recovery.

## A failed archive may be retried with a fresh signed sequence

The wrapper validates signed identity before changing any log/status. Each attempt is retained under `frontend-attempts/<archiveSHA>.<sequence>`, and each build authorization under `frontend-authorizations/<archiveSHA>.<sequence>`. Original archives/signatures, prior failure status/log and legacy authorization hashes are immutable. A retry requires a new fresh signed sequence, the current accepted binding/state, a new sandbox build and a new authorization. Success, running/unresolved state, signature drift, missing previous status, changed projections or recovery intent block preparation. The original attempt is never cleared or overwritten.

Terminal status is sealed only after the wrapper closes its append stream. Interrupted attempts use the normal fixed recovery route with quiescence checks and retained signed evidence; accepted and rolled-back outcomes require their corresponding actual bound state/receipt/journal. A cold interrupted failure records an observation code and does not invent a successful build or release.

## Verification boundaries

`verifyFrontendPolicyRefresh.cjs` exercises actual policy text and filesystem CAS/journal recovery with explicit privileged/runtime/network adapters. `verifyFrontendPolicyBootstrap.cjs` executes the unchanged embedded audit against private Linux files and the actual Bash configuration preservation guard. `verifyFrontendReleaseAttempt.cjs` includes real filesystem/signature tests and Linux SIGKILL/restart and real transaction rollback tests. `verifyFrontendBuildSandbox.cjs --linux-fixture` exercises actual private systemd/rootfs/cgroups. Production maintenance additionally requires current independent operator review, fixed committed source pins, fresh production before/after observations and a normal signed deployment. Local tests, fixture success and health alone are not deployment acceptance.
