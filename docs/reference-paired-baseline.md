# Complete-history reference paired baseline

Implemented 2026-09-07; this batch is not part of the running r697 release.

## Production follow-through correction

The first implementation at 08f783b covered the main sync but not the subsequent
`reconcileFastResultGeneration.cjs` rewrite. The reconciler now regenerates paired
counts as well, before any active or quarantine file write. It reads only the
original public reference/evidence keys using the existing strict streaming JSON
reader, verifies complete file bytes/hash/grammar, and does not retain unrelated
large candidate arrays. Missing files mean missing evidence; corrupt syntax or
bindings abort publication. Admission limits are 2 GiB input and 64 MiB selected
characters. No producer synthesizes missing original records.

The worker also reconciles receipt-owned reviews before the first official
generation/SQLite publication, not only after slow enrichment. Reconciliation is
fatal on failure, followed by data validation and then generation/export. The
actual worker orchestration is exercised with failure-injected transports to
prove a failed reconciliation or validation cannot reach generation commit.

Live read-only inspection on 2026-09-07 observed an intermediate official phase:
the source summary counted 164/334 while the same-generation guarded SQLite
history counted 164/333. Match 2040952 had a rebuilt losing reference in JSON but
the receipt-owned stored review had no BEST row. No historical record was edited.
Existing slow reconciliation restored agreement at 333; the new worker ordering
prevents exposing that intermediate mismatch in future cycles. The missing
reconciliation projection stamp was observed before the slow phase and present
afterwards; generation IDs alone were insufficient proof of result equivalence.

At 10:20:11Z, complete read-only production history (2,227 rows, 72,650,894 bytes)
exactly reproduced the published reference summary in g-110ee380… with the pointer
unchanged: 164/333, HAD 321 and HHAD 12. Paired settlements were **0**: all 333 lacked
the required frozen-version trace. The independent archive had 15 records, not 15
settlements. Thus the correct paired rates are null, not 0% or a claimed uplift.
The probe uses the nested reference summary generation clock, which can differ
from the container's original `generatedAt` after reconciliation.

Added reconciliation tests verify a real signed frozen pair survives an actual
SQLite receipt reconciliation, a repeated no-op preserves bytes, and corrupt
syntax/bindings leave all four active files unchanged. Existing 21 reconciliation
cases remain and the suite now requires 23. Worker cadence verification additionally
requires reconciliation-before-generation and failure-prevents-publication flags.
This correction still needs its own signed production release and live field proof.

## Production path

`syncData.cjs` builds `postMatchReviewsPayload.referencePerformance` from the full
`split.history`, the original `predictionSnapshotsPayload` reference ledger, and
the runtime collector public-key registry. `server/referencePairedBaseline.cjs`
uses the existing complete-history reference aggregation and signed frozen-market
audit. Missing legacy evidence is excluded from pairs, never from the original
reference denominator. A corrupt original ledger or unreconciled partition fails
generation; a malformed optional public count ledger fails closed in the API/UI
without erasing the separately valid historical hit rate.

The payload follows the existing post-match-reviews source document through
generation commit, SQLite export, PostgreSQL projection and the authenticated
public model scorecard (`publicScorecard.referenceReviewPerformance.pairedBaseline`).
It is not constructed from the capped or paginated browser match list. An actual
1,205-event regression retains all 1,205 historical rows.

Public cells contain only date, frozen version-label key, HAD/HHAD/UNKNOWN market,
and integer settled/paired/excluded/win/tie/paired-matrix counts. Every cell must
reconcile to the original version/market/day partition, including unselected days.
Quotes, source URLs, private proofs, per-match records and feature/model objects
are not published in these cells. This is an aggregate transport contract, not a
new cryptographic attestation of the statistics response.

## UI and statistical boundaries

The Data references tab filters pairs by 7/30 days, all time, or an explicitly
selected frozen version label, independently for HAD, HHAD and combined BEST.
Both rates use exactly the same paired subset. The card shows paired N, original
settled N and excluded N; it never compares subset baseline against the adjacent
full-history hit rate. Empty pairs display an em dash, not 0% or 50%. Invalid or
missing ledgers retain the evidence-pending state. Formal and shadow tabs do not
borrow reference pairs.

The baseline is the maximum proportionally de-vigged probability from the frozen
complete signed quote, equivalent to minimum decimal odds. Exact ties use the
declared order home, draw, away and are counted explicitly. Original integer
handicap lines, not mutable top-level lines, are used for HHAD settlement.

- Collector-signed extraction is reverified against the registry; the original
  upstream HTTP response is not rehashed by this feature.
- Final scores use existing application-trusted final-result rules, not new
  independent result attestations.
- Version labels do not prove full model parameter revisions.
- Pair availability is NOT recommendation coverage. The frozen eligible universe
  is still absent, so recommendationCoverage remains null.
- No gain claim, model promotion, threshold relaxation, training change, or old
  published-direction rewrite is performed.
- Complete supplied application history is not proof of upstream completeness.

## Verification this batch

- `verify:reference-paired-baseline`: 37 cases, real builders plus TS/TSX selectors,
  full input above 1,200 rows, partial/missing/revoked evidence, ties, duplicate and
  conflicting settlements, version/window/market separation, invalid public cells.
- Native disposable PostgreSQL 16.15 suite: 378 assertions; actual migrations,
  writers/readers, SQLite-primary and PostgreSQL-primary HTTP, authenticated public
  scorecard with paired counts, original draw preserved. Production data untouched;
  temporary native database cleanup confirmed.
- Actual full App browser: 63 scenarios at 390/768/1440 widths, including 15 new
  pair-specific scenarios; no runtime errors or unexpected network requests.
  Fixtures are synthetic; their September 20 publication date is a deliberate
  calendar-window test, not a real future production observation.
- Existing private pair audit 24, frozen-version 22, dashboard 23 and original
  reference summary 29 regressions passed. Build, production fixture isolation and
  deployment configuration checks passed.
- Full-page 390/1440 screenshots inspected. Expanded disclosure remains readable;
  browser tests reset scrolling before testing topbar/main overlap. Mobile bottom
  navigation is fixed in the viewport, not a duplicated in-document content bar.

Production readiness includes the 37-case check. These local checks are not live
release proof: a subsequent signed release, completed new worker cycle and exact
public field verification remain necessary. The running r697 source stays frozen.

## Remaining full plan

Preserve all Q1–Q5 work: actual current-season input availability and source clocks,
team/season mapping, immutable original-public response evidence, complete parameter
revision identity, other tracks and markets, frozen candidate universe denominator,
independent forward samples and admission gates. This aggregate UI does not close
those requirements and cannot establish an accuracy improvement.
