# Result input timeline dependency commitment

The previous v1 timeline hash omitted `hasSettledScore`, `matchIdentity`,
and the transitive helpers/constants of `buildResultProvenance`. A changed
score admission rule could therefore change the training result stream while
leaving the prospective candidate revision unchanged. The verifier reproduces
that counterexample; it does not establish historical recommendation tampering.

## v2 implementation

- Commit all eight timeline function implementations, including score admission
  and identity tie-breaking.
- Commit the provenance function's 22-function dependency closure and the
  reachable status constant, including the strict clock parser and official
  source validation helpers. Preserve exact native function source with LF
  normalization so Windows/Linux checkout line endings agree.
- Resolve actual lexical source dependencies before signing. New helpers,
  unresolved imports, changed import targets/aliases and mismatched named
  function bodies are rejected until their dependency inventory is reviewed.
- The parser itself must remain closed; adding an uncommitted parser helper
  also fails the pre-sign gate. Constants must be JSON data, not functions
  silently erased by serialization.
- Do not hash the entire lifecycle file: unrelated UI/merge orchestration
  changes must not retire a trial. The source-only mutation tests cover this.
- Retain the existing fixed Node runtime and normal release verification. This
  is a reviewed closure for these three CommonJS modules, not a general-purpose
  sandbox, arbitrary JavaScript dependency analyzer or a cache trust mechanism.

The result admission functions, probability formulas, direction decisions,
scores, archived predictions and odds are unchanged by the fix. Only the
commitment changes from `result-input-timeline-commitment-v1` to v2.

## Revision boundary and rollout

This fix MUST start a new prospective candidate revision. Previous frozen
headers and events remain byte-for-byte intact; a retirement event is appended
and the new revision starts empty with fresh windows. Old samples cannot count
towards the new revision. Neither a repaired identity nor passing synthetic
tests makes a candidate eligible for formal recommendations.

An exact `candidate-revision-transition.json` must bind the actual prior live
ledger/implementation to the current implementation before this source can be
signed. The current r711 package is immutable and does not contain this change.
Do not edit/replay that package or invent its eventual active ledger identity.
After its terminal state, capture the actual registry, preserve all old events
and counts, and verify the next declaration through the real continuity code.

Commands: `npm.cmd run verify:result-timeline-closure`,
`npm.cmd run verify:asof-result-timeline`, the affected lifecycle/ledger suites,
and the existing pre-sign verifier contracts after the exact transition is set.
Local synthetic checks do not replace signed deployment, live registry, new
worker, archive continuity, database/API or browser acceptance.

### Exact transition drafts

`buildRevisionTransitionContract(registry)` derives the old identity and the
new implementation from a validated active ledger. It preserves the precise
hypothesis, gate and nomination policy; unchanged implementations cannot create
a reset. The returned draft is detached from the source so editing nested
weights cannot mutate an old ledger through object references.

New v1 declarations include normalized `sourceDefinition` and
`sourceImplementation`. Both must reconcile to the existing `from` hashes;
partial, changed or noncanonical descriptions fail validation. Already signed
legacy declarations without these two fields retain their old exact binding.
Runtime binding to the actual source ledger, signed release identity and full
old-event continuity remains mandatory. This is not a switch to arbitrary or
automatically promoted candidates.

`verify:candidate-transition-draft` covers original and previously revised
sources, actual isolated refreeze, preserved headers/event prefixes/counts,
empty new shadow state, no-op rejection and tampered source descriptions.
The next production declaration is still deferred until r711 is terminal and
its recovery state is clear. A local preview is not a signed or live change.
