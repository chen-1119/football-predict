# Frontend controller orchestration verification

scripts/verifyFrontendReleaseController.cjs executes the **unchanged complete
controller source** in a test-only VM. No controller path override, test hook,
loader flag, production CLI or privileged entry point was added for testing.
The fixture is Linux-only and creates its own private temporary root.

## What is real, and what is simulated

Real checks in the same main(["apply", ...]) call chain:

- A freshly generated test-only RSA-3072 key signs actual manifest bytes.
  The production manifest/signature and frontend authorization validators run.
- Small actual gzip/tar archives pass the real bounded archive inventory parser,
  signed source evidence validator and before/after complete source comparison.
  Retained baseline signature and actual archive evidence are also checked.
- On-disk root-state, public-state and runtime-binding JSON feed the controller's
  actual raw-byte and exact identity checks. Dependency record/complete files
  bind actual snapshotBuildInputs().dependencyHash.
- The controller calls its normal dependency-copy, retention, staging, record
  persistence, read-only acceptance and recovery orchestration functions.
  Source growth while retaining an archive is detected by the real fd checks.
- The production sandbox **receipt reader** executes unchanged against actual
  evidence.json/complete.json bytes in the VM filesystem. Malformed lifecycle,
  source, dependency, baseline, environment, command and artifact commitments
  are rejected by that reader and the controller.
- Transaction adapter inputs must match written authorization/complete hashes,
  original state, candidate bytes and actual cumulative dist tree. Accepted
  receipt bytes are checked by the real shared frontend identity/receipt schema.

Explicit test adapters, not demonstrated production authority:

- Fixed absolute paths map into the fixture root; owner/root process metadata
  and the inherited-lock assertion are simulated. This is **not** a new flock,
  root-owned installation or production path-permission proof.
- Tar extraction is a bounded synthetic adapter over the already-inventoried
  fixture archive. No tar subprocess runs.
- Runtime closure capture and runtime boundary execution use adapter results.
  Their current schema/input bindings and refusal propagation are exercised;
  this suite does not replace their separate real runtime proofs.
- The one sandbox invocation creates synthetic compiler output and a synthetic
  root evidence record. It never executes tsc/Vite, package scripts or systemd.
  Receipt cgroup observation is simulated inside the VM.
- HTTP, health, protected routes, dynamic runtime config and service observations
  are deterministic in-memory transport/command adapters. No provider or live
  production request is made.
- Transaction mutations are fixture-only adapters. They validate exact records
  and update fixture state; they do not repeat the separately tested atomic
  replacement, inherited flock, SIGKILL or cold transaction recovery algorithms.

The report states these limitations and records actual compiler executions,
network requests and production writes as zero. A pass is orchestration proof,
not build provenance, deployment acceptance or permission to import materials.

## Covered release and failure behavior

The positive path is signature → actual archive inventory → signed state/runtime
binding → retained baseline/source comparison → runtime boundary → exactly one
sandbox call → actual receipt/hash checks → authorization records → transaction
begin → bounded public reads and health/protected/service checks → strict accept.
Original runtime markers and runtime/database sentinels stay unchanged.

Negative cases stop at the correct boundary: invalid/expired signature, missing
lock, full-kind route, state/public-binding/source-inventory drift, archive and
retained-fd drift, extracted membership/content, dependency complete hash,
runtime refusal/drift, build failure, build receipt/output/current-state/policy
drift, exposed APIs, unhealthy services and dynamic config contract failures.
Failures never call the full release route and never retry the sandbox build.

Four concurrent public readers are verified. On the first artifact failure,
the controller drains current readers before returning and does not enqueue
additional assets. The exact dynamic data/runtime-config.json route accepts
valid runtime-generated JSON that differs from the committed fallback; bad API,
authentication, TTL, polling and static-history semantics reject. Other assets
and index still require the exact committed bytes.

Recovery cases prove the orchestration decision only: a begin failure after
pending publication still reaches recovery; no accept intent allows rollback
without HTTP or service prerequisites; an accept intent requires fresh outer
health/services/public artifacts before the strict transaction recovery call.
Offline intent rollforward remains pending. No candidate build is retried.

## Frozen focused proof

outputs/frontend-controller-linux-1788866875341.json:

- **41 / 41** current controller cases passed on Node 22.22.1 in **6817 ms**.
- Controller SHA-256:
  f551368eb6be569d2598252e35d4a63ae96295652f520c3e4c5e4635df3d61c9.
- Verifier SHA-256:
  884b48fabb32334dd05729f03ea821d60e828f55285335db9f18b299f69296c3.
- The outer Linux runner used a real isolated DynamicUser service with
  PrivateTmp/PrivateNetwork, read-only copied sources, and inaccessible
  production configuration/state. It ran only this VM verifier.
- The real outer unit/cgroup was quiescent; exact fixture cleanup succeeded;
  all copied source hashes still matched the local files afterwards.
- Targeted Node syntax and ESLint recommended checks passed.

The local-only helper outputs/verify-frontend-controller-linux.cjs specializes
the existing reviewed static-response isolated runner's exact source allowlist
and result contract. It copies the complete listed input closure, does not use
APP source/data, and does not rerun the real compiler or transaction suites.
