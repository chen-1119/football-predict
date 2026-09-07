# Final score publication guard

2026-09-07 Q1 null-value follow-through. Separate from the signed running r698.

An executable negative test reproduced a hole in `validateData.cjs`: a FINISHED
row with official HAD odds, no predictions and a missing home final score passed
validation. Result-only rows had a score check, but official-odds rows did not.

The validator now applies the existing lifecycle `isValidFinalScore` contract to
every FINISHED row: both scores must be finite numeric non-negative integers.
Official odds do not override it. This is a rejection guard, not an automatic
repair. Pending/scheduled null scores remain null; a real numeric 0-0 is valid.
No historical direction, score, settlement or data timestamp is rewritten.

The 70-case validation-scope suite includes 46 additional cases: both public and
server scope, official-odds/result-only records, either side missing/string/empty/
negative/fractional scores, numeric 0-0, and scheduled null scores. It still runs
two full actual-public-file passes and keeps the private archive isolated. The
original lifecycle reconciliation 29, detail lifecycle 23 and fast-result
reconciliation 23 checks pass; targeted lint and diff checks pass.

At 2026-09-07T11:01:40.221Z a bounded read-only production SQLite scalar audit
covered all 43 current records and all 2,227 historical records in a stable
generation `g-f78a76f70aca1bb9942b49f0f6974ffe1dc084b47948b7c6c0737b481ce74830`.
All 2,227 history rows were FINISHED, including 285 official-HAD-odds rows; invalid
final scores were zero. All 43 current rows were unfinished with null scores.
The generation pointer was unchanged; scan time was 3,628 ms. This is SQLite
evidence, not an independent PostgreSQL or upstream-score audit. The reproduced
validator defect is therefore not a claim of presently corrupted live scores.

Future release verification must still confirm this guard is in the live source.
The r698 transaction is not changed or restarted to include this later patch.
