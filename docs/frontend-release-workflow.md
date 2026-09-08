# Signed frontend-only release workflow

Status (2026-09-08): PR 12 merged the connected implementation. The normal r712 bundle passed signing/preflight/build and archive safety; independent fixed-controller/dependency bootstrap succeeded in 44.471 seconds without changing services or configuration. Its single full deployment was rejected by the early transition window before candidate construction or APP swap. Sequence 712 is consumed and must not be replayed. Production remains accepted r711. First full activation and real UI-only end-to-end timing remain pending; neither bundle creation nor bootstrap is a completed deployment.

## Two different identities

An ordinary full release changes the runtime and frontend together. A frontend-only release changes the index and adds content-hashed assets; the installed server, worker, dependencies, environment, service configuration, data and recommendation history remain unchanged. The runtime bundle markers therefore remain the original full release SHA. The frontend has its own signed request SHA, sequence and root-controlled acceptance receipt.

The public health response exposes the fresh frontend state outside the health cache. `pending` is not success. A frontend-only success requires the expected frontend SHA and sequence, the original runtime markers, the current index commitment and the exact accepted receipt. Queue/status/deploy observers use this identity rather than treating the unchanged runtime SHA as a failed deployment or starting another business verification cycle.

## First activation

1. Independently bootstrap the reviewed fixed root controller and its module closure under `/usr/local/libexec/football-release-frontend`, using the existing release lock. Import the separately reviewed offline dependency material into the lockfile-keyed private store and install the pinned parser. This is not executable code obtained from a UI candidate.
2. Make one normal full release containing the new health reader and a signed complete archive source inventory. Retain the original archive, manifest and signature. Only after the existing full release acceptance may the root controller initialize the frontend state and capture the installed runtime binding.
3. Read the exact public state bytes and runtime binding. A legacy bundle without the signed inventory, including r711, cannot be retroactively treated as an eligible UI baseline. If optional initialization fails, the already accepted full release remains accepted; report the precise readiness failure without redeploying it for proof.

## Each UI release

`npm run release:frontend-bundle` constructs four artifacts using the original signed full baseline and the current state/binding. It allows only existing reviewed UI source files to change. It preserves every other archive byte and mode, including the old dist. The signature authorizes source changes, not a claimed new compiled artifact. There is no local TypeScript/Vite build or local business verification in this path.

The existing signed release wrapper verifies the request and consumes the shared sequence once under the inherited kernel lock. A UI request is dispatched only to the independently installed controller, never the uploaded full-release shell. Unknown kinds and failed UI requests do not fall back to a full deployment.

The controller rechecks the retained original signature, complete source inventory, current state, installed runtime, fixed policies and offline dependency commitment. It runs one constrained Linux TypeScript/Vite/static-strip build. Root evidence records the actual inputs, output tree, fixed commands and cleared descendants. This fresh output is not reused from an earlier build or accepted from a caller-provided success flag.

The index transaction adds new immutable assets and retains the old ones, then atomically changes the index. Read-only acceptance checks the public index and asset bytes, the explicitly dynamic runtime-config contract, fresh pending identity, protected routes and existing active services. It does not restart services or run model/database repair. Only then are the accepted receipt and state published.

Original UI request artifacts and root build/authorization evidence are retained privately under `/var/lib/football-release/frontend-authorizations/<request-sha>`. Failed attempts are not silently reused. Unknown live descendants, ambiguous index changes and recovery records are preserved for inspection rather than force-cleaned.

## Recovery and proof boundaries

Full deployment transport recovery now checks that remote status is complete for the exact requested bundle and both runtime markers match before invoking public business verification. Failed, unknown, incomplete, or different-release status stays failed with an explicit skip reason; it does not waste a second business verification against the old live release. A matching completed full release still needs the existing public gate. The UI receipt-based path is unchanged.

Cold recovery without an accept intent can restore the prior index even while HTTP is unavailable. With a persisted accept intent, fresh read-only service/public checks precede the transaction's strict receipt/index recovery. This does not fabricate a new recommendation or rerun the model suite. Root transaction tests include actual Linux atomic rename, inherited kernel lock checks and process-kill recovery; they do not claim physical power-loss testing.

The real isolated r711 build took 61.340 seconds for the build controller and 67.432 seconds including remote preparation/cleanup. These are build measurements, **not a UI deployment duration**. Production acceleration must be measured from dispatch to exact accepted frontend identity after activation, compared with r711's 59 minutes 19 seconds full-release baseline.

Portable source/schema/consumer/entrypoint tests and Linux-only dependency/transaction/sandbox tests have separate proof scopes. Linux tests are not reported as passing on Windows. Re-run affected checks for source deltas; do not repeatedly deploy an accepted release merely to reproduce the same evidence.

The pre-sign platform matrix runs `verifyFrontendInstalledRuntime.cjs --systemd-contracts-only` on Windows: exactly three executable systemd VM contracts with mocked transport, explicitly `linuxFilesystemProof: false`, `fullInstalledRuntimeProofRequired: true` and `signingEligible: false`. Linux still runs the default complete installed-runtime fixture (at least 12 checks) plus the three systemd contracts. The default command never silently degrades: a Windows symlink-permission failure remains nonzero. These Windows contracts do not satisfy the separately retained, source-bound Linux fixture evidence required before activation, nor replace the controller's fresh installed-runtime capture. No dependency/importer/transaction/controller Linux gate is waived by this platform selection.

The connected batch adds 23 portable source-bundle groups (24 on Linux), 23 source-authorization checks, 19 identity checks, and 14 executable Bash entrypoint groups. Its original 6 consumer groups are retained; the recovery delta adds a seventh group with 13 cases/37 assertions, and the pre-upload routing group now includes 9 window cases/20 assertions. The Linux-only controller VM has 41 orchestration checks, distinct from the transaction's 41 real Linux checks and one state-schema delta. The dependency importer has 24 Linux checks. The installed runtime has 12 Linux fixture checks plus 3 final systemd-contract checks; only the latter were repeated for the oneshot transient-state fix. These overlap in scope and are not summed into a fabricated coverage total.

The existing deployment-config suite passed 122 checks. The old signed-entrypoint suite passed 68 of 69; its one linear anti-replay assertion needed to distinguish the new UI branch from the full continuation. The revised assertion passed independently, including 8 negative mutations, without repeating the old 68 checks. Actual production `systemctl`/typed D-Bus observations confirmed empty credential arrays and the fixed worker memory dropin paths without printing credential or environment values; a complete real installed-runtime capture is still required on first activation.

The extensionless release/relay scripts and sudoers file now have explicit LF attributes. Their only byte-format changes were CRLF-to-LF with normalized contents unchanged; previously normalized-fixture proof is not misrepresented as a proof of the old raw CRLF files executing on Linux.

## Avoid work in a closed full-release window

Online full bundle creation now calls `runReleaseWindowPreflight.cjs` before the archive scan, pre-sign suite, sequence reservation, or build. Full deployment calls it again after signed kind/content validation and before the archive scan, local production-clone verification and uploads. These are separate fresh preparation observations, not repeated model verification or a reusable window reservation. Offline creation explicitly reports no live window check; dry-run performs no live probe; authenticated frontend-only requests do not use the full data-cutover budget. Online failures never silently fall back to offline or UI mode.

The single pinned-SSH read sends reviewed local code that uses only Node built-ins remotely. It reads the fixed current pointer, manifest and current fixture bytes, then rechecks pointer/runtime markers and file/directory identities. Local existing generation and transition functions validate the complete current payload. No archive corpus, database, environment or provider is read; no lease, queue or sequence is created.

The current server default budget is 7,620 seconds plus 900 seconds of preparation and an explicit small observation/clock reserve. The pre-sign contract binds the actual shell defaults and budget expressions. Projection stays at the remote observation instant so a fast client clock cannot silently discard its next boundary. Observations older than 60 seconds or over 5 seconds in the future fail. Generation age is reported separately: semantic no-op legitimately retains an older pointer, so an older `committedAt` is not treated as failed collection. This does not attest provider freshness. All signed early, candidate lease and final cutover gates remain mandatory.

The r712 failure's observed next opportunity was strictly after 2026-09-08 14:02 UTC (22:02 Beijing), not a scheduled or preauthorized release. It must be freshly checked using the preparation budget. The old r712 archive/sequence cannot be replayed or relabeled to bypass its immutable retained baseline.

The first real pinned observation using the new helper at 12:35:43–12:35:49 UTC took 6.090 seconds and correctly reported a closed window, next transition 14:00 UTC and next opportunity strictly after 14:02 UTC. It checked generation `g-7d2afd8a81fcd0b5d99dd191dbbaf40738d74e93ff1e598c3555076d89664aff` and accepted r711 markers; build, sequence reservation and deployment counts were all zero. This is measured preparation-rejection time, not a completed release duration. The new verifier has 25 groups: the first run passed 24; correcting one frozen-object test fixture was followed by only that remaining group's three negative cases, not a repeated full suite. The ordinary pre-sign entry will still run its required checks when a new normal bundle is actually created.

## Remaining product work

This workflow does not claim improved prediction accuracy or completion of the global UI redesign. The original optimization goal remains active. Daily 2-leg and 3-leg recommendation modules remain pending: only eligible immutable formal prematch legs, combined SP at least 2.5 and 5 respectively, and an explicit unavailable state when no qualifying combination exists. No fabricated recommendations, probabilities, settled history or guaranteed outcomes.
