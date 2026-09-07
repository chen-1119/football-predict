# Fixed prospective hypothesis across implementation revisions

## Reproduced defect

On 2026-09-07, an offline run of the actual `runModelBacktest.cjs` used the
workspace public JSON and read-only copies of the live candidate and benchmark
ledgers. The original candidate remained in the 64-entry inventory with its
exact definition, but the small JSON-fallback comparison ranked
`market-temperature-1_5` first. The updater retired the existing activated
`market-current-model-residual-minus-20-temperature-0_9` ledger and created a
different hypothesis during an implementation revision. The signed transition
correctly rejected it. A no-match transition unit fixture did not reveal this.

The failing run completed its backtest successfully, but continuity failed.
That distinction matters: a successful model command is not release proof.
The underlying fallback sample was only 12 comparison rows and does not
support any claim of model advantage or production performance.

## Fix

An implementation-only change now retains the exact definition of an already
activated fixed trial if it occurs uniquely in the new inventory. This is not
an ID-only match: feature set, role and weights are included. It creates a new
revision and retires the old ledger without changing the old header or events.

An ordinary subsequent backtest must not undo this by replacing the new SHADOW
revision with that day's retrospective winner. The updater follows the existing
immutable retirement links back to the activated trial. Each link must have
the exact replacement revision and freeze time, unchanged definition, gate and
nomination-policy hashes, and no online effect. Ambiguous links are rejected;
traversal is cycle-bounded. No new lineage metadata is invented in old ledgers.

Only hypothesis selection is retained. Activation, sample counts, settled
results, calendar windows and eligibility are NOT inherited. Readiness for a
different candidate cannot activate this revision. Unactivated research trials
without such lineage retain their existing ranking-selection behavior. A
definition or policy change cannot borrow this lock.

## Evidence and limits

- 11 new tests exercise the real updater, competing winners, subsequent normal
  runs, multiple revisions, unchanged event prefixes, changed weights, broken
  lineage boundaries and the exact signed continuity verifier.
- Integrated with the candidate ledger gate (59 outer checks) and before
  release sequence reservation. The pre-signing contract now has 24 checks,
  including omission tests against both actual archive required-entry arrays.
- The exact signed revision-transition suite still passes 27 checks. No model
  probability formula, threshold, candidate declaration or promotion gate changed.
- At 14:48:29Z, two consecutive actual backtests plus continuity passed with
  copied live ledger SHA `80e3e15c0de6eec91a18852ec351221de4703c3126fd268fb1ffaa26026c72aa`.
  Old admitted/atomic 334, settled/formal 324 and finalized 524 were preserved.
  The new revision `@1007d2124017d211` had zero admitted/settled/formal rows.
  All workspace input hashes and the original model evaluation file were unchanged.

The rehearsal used Node on the workstation, public JSON fallback inputs and
isolated private SQLite outputs. It did NOT use the live publication's SQLite
rows and is not a production generation/cutover test. The signed release must
still seed its private store and execute its real candidate and final live checks.
No release sequence was reserved or deployed during this reproduction.

The standalone production-plan check against the unreconciled workspace
artifacts reported six failures: legacy `self-optimization-v1` strategy,
embedded calibration and missing current gate/selection/model-signal evidence.
These failures were not ignored or changed into passes. Source/configuration,
continuity and deadline checks passed; final plan/readiness checks must run
after the release's actual backtest and strategy reconciliation. This document
does not claim the unreconciled workspace is production-ready.

Local evidence: `outputs/candidate-backtest-rehearsal-xUNKyZ` (failure before
repair) and `outputs/candidate-backtest-rehearsal-ygL8MX` (two runs after repair).
These private runtime copies are not uploaded to Git.
