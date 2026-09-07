# r698 candidate verification failure and repair

## Actual release state

r698 SHA `1f0a94f7b3b1779d0a73e2d2c3f729b313343b553d4ddc50d497d1745531bf8d`
was accepted at 2026-09-07T10:39:11Z and terminated failed/exit1 at 11:02:19Z,
before swap (23m08s). The original local session completed exit1. Both live
release markers remained r697; no repeated r698 transaction was launched.

The parsed complete candidate-readiness report identifies exactly two failed
checks, not a general source outage:

1. `verifyReferencePairedBaseline.cjs` failed with MODULE_NOT_FOUND at its
   TypeScript require. Production had pruned devDependencies. Local development
   tests did not exercise that dependency shape.
2. `verifyProductionPlanCoverage.cjs` still required the old 21-check receipt
   reconciliation contract while readiness had correctly advanced to 23.

## Repair

TypeScript is now an explicit production verification dependency. The lockfile
retains the existing 6.0.3 version, archive and integrity; only its dependency
classification changes. The real TS selectors and TSX components remain tested,
not replaced by precomputed passing results or omitted.

The plan-coverage gate now requires exactly 23 successful reconciliation checks
and both additional pair-preservation/no-write-on-invalid-source contract flags.
The original invariants remain required.

`verifyReleaseVerifierContracts.cjs` executes that actual plan gate in isolation
and checks production dependency declarations and lock metadata. Negative cases
reject the stale count, either missing new contract flag and missing signed
reconciler. Bundle creation invokes it before sequence reservation/signing; the
helper is required in both bundle construction and safety inventory. No runtime
or model admission gate is bypassed.

## Production-dependency reproduction

An independent Windows system-temp workspace received copied repository code and
the package/lock files, then actually ran `npm ci --omit=dev --ignore-scripts
--offline --no-audit --no-fund`. No shared node_modules or parent-module fallback
was used. TypeScript resolved inside that production install, version 6.0.3;
dev-only ESLint was absent. Node was local v25.8.1, not production v22.22.1.

- Dependency installation: 7,456 ms.
- Actual release-contract gate: 7 checks passed.
- Actual full-history paired/server/browser/TSX verifier: 37 passed.
- Actual review-dashboard selector/TSX verifier: 23 passed.
- Temporary installation was removed after verification; production untouched.

Report: `outputs/pruned-review-runtime-1788779453806.json`. The next actual signed
candidate still must repeat its Node22 runtime verification; this local report is
not a successful deployment. After r698 failure, the fixed recovery check showed
recoveryPending=0/appPresent=1, all four service/timer units active, and public /
protected readiness passed all 28 checks at 11:12:09.259Z.
