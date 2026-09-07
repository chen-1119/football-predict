# Official-club result ingress integrity

## Scope and diagnosis — 2026-09-07

The archived pre-match recovery verifier failed with `scoreHome undefined` versus `0` in both the unchanged r702 source and the current branch. Its local generated `public/data/official-club-results.json` was absent, so the production loader correctly returned an empty store. This was not evidence that an actual official result was missing from production.

A separate real ingress defect was reproduced before fixing the implementation: `Number(record.scoreHome)` admitted a null score as zero even after the record hash was recomputed. Numeric strings and booleans had the same coercion risk. Bare `Date.parse` also normalized malformed calendar timestamps.

## Changes

- Admit only raw nonnegative safe-integer scores; retain legitimate numeric 0:0.
- Reuse the shared strict zoned-ISO/calendar validator for event and observation clocks.
- Require the source declaration's match identity and kickoff to agree with the target event when building evidence.
- Reject invalid parsed scores or observation clocks before constructing a record.
- Allow previous records to donate the initial observation and revision only after they pass the existing evidence validator plus the new score/clock checks. An invalid null-score predecessor no longer supplies its clock to a real zero score.
- Keep the valid numeric evidence-hash contract unchanged. No historical direction, score, denominator, or promotion rule is rewritten.
- Make the recovery verifier consume explicitly synthetic offline HTML-parser fixtures. The production loader has no synthetic fallback. Test output labels synthetic input and does not assert that a provider was contacted.
- Include the new ingress checks in public-reference verification and require their source files in future release bundles.

## Verification

- Official-club verifier: 41 strict admission cases passed, including recomputed hashes, both score fields, malformed clocks, wrong source identity, invalid predecessor, repeat and correction behavior.
- Archived recovery verifier: passed the existing five signed-recovery cases and two synthetic result-review scenarios; no generated local result cache is required.
- Public-reference integrity: 46 checks passed.
- Release verifier contracts: 34 checks passed; candidate revision transition: 27 passed.
- Frozen archive authority: 10 checks passed.
- Match lifecycle reconciliation: 29 checks passed; publication ledger: 28 passed; archived cutoff verifier passed.
- Targeted ESLint and `git diff --check` passed.

These are local behavioral and packaging-contract tests, not a new signed bundle, live provider verification, production settlement, or model-quality evidence. No provider request or production data write was made for this change. Other timestamp/revision semantics and fetch transport behavior are outside this patch.

## Release boundary

At 2026-09-07T15:42:39Z the existing r702 server queue was alive, waiting for its scheduled single attempt at September 8 03:31 Beijing, and had not attempted a release. Its signed source remains `6f86e44c61c98ce3763c0b1a0a56f9cc671724ab`; this patch is not in that bundle. Both live markers remained the r699 bundle SHA `e4bb349180b3dfce4df305fc8fdb2820868709208ae660b13fb018a825a343ef`.

No requeue, duplicate deployment, signed-worktree edit, gate waiver, or historical result correction was performed. The original Newcastle public-direction adjudication and the full Q1–Q5 optimization remain open.
