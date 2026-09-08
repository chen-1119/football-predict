# Production plan source contracts before signing

## Real r710 failure and retained state

r710 (`a957068c6e22f448bfec36eaf3d5f077746c05174fecb17c369beaeb47cd7eab`)
ran once from 2026-09-08 06:10:37Z to 06:38:04Z and aborted **before swap**.
Candidate readiness was 176/177. The sole failure was production plan coverage,
specifically `bundle release path supports uncommitted candidate packages`.
The old predicate required the literal `"outputs"` inside createReleaseBundle.
Root entry selection had moved to releaseWorkspaceFreshness, so the literal
was absent even though actual Windows/Linux tar regression had passed.

After the abort, exact old app/live-complete markers remained, recoveryPending
was false and services active. Read-only full-object comparison retained all
592 before-release frozen archives and 40 public ledger originals. The known
nine absent originals versus 601 remain absent; no restoration is claimed.
The failed signed package is held and must not be replayed or re-signed.

## Fix and broader prevention

The actual plan predicate now requires the creator's real shared root selector
and the shared helper's root-only outputs exclusion. Signing, rollback, frozen
artifacts, manifest and upload guards were not removed. Existing real tar tests
still require root QA artifacts excluded and nested production outputs included.

`productionPlanSourceContracts.cjs` parses the **actual** production-plan source.
It identifies literal-named checks whose predicates depend only on declared
readText source inputs, package script strings, literals and allowlisted pure
operations. It does not run the whole live coverage script, load its SQLite
store, fetch a URL, launch providers or execute source-file content.

Current scope: 73 source-bound predicates; 20 literal-named mixed/unsupported
predicates remain outside this proof. Dynamically named checks also remain with
the original live verifier. Runtime clocks, environment, network/filesystem
calls, mutation, metaprogramming, unbound identifiers and unsupported syntax are
excluded **before** evaluation, including dead branches and callback name leaks.
Only the eligible boolean expression runs in a time-bounded VM with runtime code
generation disabled. This is a conservative evaluator, not a general sandbox
for arbitrary untrusted code.

The committed inventory requires all 73 current source rules to remain covered.
If a known rule is deleted, renamed or becomes unsupported/mixed, early release
validation fails instead of silently reducing coverage. Intentional scope
changes require an explicit reviewed inventory change. New eligible predicates
are included automatically. The original full production-plan and live readiness
checks still run in their original places.

This early check and its 22 regressions are called by the existing pre-signing
contract gate, before release-sequence reservation and frontend build. They are
not a cached live-readiness result. All new code and the inventory are required
signed bundle entries. The r710 bug is now caught early alongside the other
source-only rules, rather than adding only a one-off literal assertion.

## Verification

- The unmodified r710 predicate fails with exactly the missing `"outputs"`
  requirement; the corrected current 73 predicates pass.
- Removing the actual root selector, root exclusion, signing or rollback still
  fails the real predicate. Introducing an unknown runtime input cannot silently
  remove a required rule from the early scope.
- Runtime calls, clocks, environment, assignments, dynamic property access and
  lexical callback leakage are rejected by classifier regressions.
- Prior Windows/Linux real tar behavior is retained, not replaced by source
  substring checks. Remaining runtime/data checks are not declared complete by
  this module.

No source in the immutable r710 worktree, live recommendation, probability or
historical record is edited by this change. New signing and actual deployment
acceptance are still required after source merge.
