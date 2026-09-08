# Unified release workspace freshness

2026-09-08. This change is independent of the in-flight, immutable r709 release.

## Reproduced inconsistencies

- Status ignored root QA reports but treated `src/outputs/` as source.
- Online deployment ignored every directory named `outputs`, including source.
- Offline kit creation did not ignore root QA reports, forcing needless rebuilds
  after validation reports were written.
- Status ignored changes to `public/data/runtime-config.json`, while deployment
  correctly invalidated the candidate for those changes.
- On the actual Windows BSD tar, both `--exclude=outputs` and
  `--exclude=./outputs` omitted nested production source directories. Prefixing
  the pattern with `./` did not anchor it to the workspace root.

## Implemented policy

`releaseWorkspaceFreshness.cjs` is now used by status, online deployment and
offline kit creation. Root `outputs/` receipts do not invalidate source
freshness. Nested `src/outputs/`, `server/outputs/`, similar names and runtime
configuration still invalidate it. The previous 1-second mtime tolerance and
other excluded directories are unchanged. Non-finite cutoffs are rejected.

Online status/deploy still exclude mutable generation JSON from this local
source check: the existing fresh remote archive, worker and publication gates
remain mandatory. Offline kits retain their stricter generated-data freshness
check because they cannot obtain live-generation proof.

Packaging now lists explicit `./`-prefixed root entries, omitting root outputs,
instead of a basename exclusion that can drop nested code. All other existing
tar exclusions and sensitive-entry rejection remain. The shared implementation
and its verifier are required by both signed archive-entry gates. Behavioral
tests run in the existing before-signing contract preflight.

This mtime check is not a content cache, signature, release checkpoint or proof
of deployment. It does not authorize bypassing a stale source check, reusing a
failed sequence, or skipping fresh database, recommendation or cutover gates.

## Verification

- Windows Node 22.22.1: 12 filesystem/real tar behaviors; 11 status transport
  cases; 203 before-signing contract cases (includes the 12 behaviors); 122
  deployment configuration cases; 65 transaction-safety cases. Counts overlap
  where contract suites invoke their component verifiers; they are not additive.
- Linux Node 22.22.1, unprivileged uid 1000: the same 12 filesystem/real GNU tar
  behaviors passed. Source was supplied in memory; temporary fixtures were
  created and removed under the system temporary directory only. No production
  files were changed, no data providers contacted, and no release was dispatched.
- Changed JavaScript ESLint and `git diff --check` passed.
- An initial Linux harness used separate VM realms and failed on array prototype
  equality. The harness was fixed to share a realm; assertions were not relaxed.
- The local summary harness initially expected JSON from the transaction
  verifier, which actually emitted 65 PASS lines and an anchored 65/65 summary
  with exit 0. Its original output was reconciled without repeating any suite.

Local reports (not distributed in the release):
`outputs/flow-validation-reconciled-1788844083956.json` and
`outputs/freshness-linux-1788844016331.json`.

## Remaining release optimization work

This fixes contradictory freshness decisions and one packaging exclusion bug;
it does not claim a measured reduction of the full production release duration.
Remaining work includes dependency-bound static verification receipts, explicit
stage results and elapsed times, release paths scoped by actual changes, and
separation of research computation from deployment where input contracts allow.
Any reuse must invalidate for changed code/dependencies/configuration and must
never substitute old runtime data, frozen-record or cutover safety evidence.
