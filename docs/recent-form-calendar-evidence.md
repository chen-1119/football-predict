# Strict calendar checks for recent-form metadata

## Reproduced failure and scope

The selected-row evidence summarizer accepted `2026-02-29T14:00:00Z`
because JavaScript Date.parse rolls impossible dates forward. The new negative
test failed against 8082c677 before the repair. Similar rollover can affect an
invalid decision clock or a 24:00 clock. This is a metadata admission defect;
the reproduction is synthetic, not proof of corrupt live results.

The summarizer now validates calendar days, Gregorian leap years, hour/minute/
second and explicit-zone syntax before Date.parse. Invalid result observations
remain missing/unverified; invalid kickoff remains conflicting; invalid decision
time remains unverified. Valid timestamp representations are retained, without
recanonicalizing valid selection-hash inputs. Neither input row selection,
model arithmetic/weights nor historical/frozen records are rewritten.

This change is deliberately limited to selected-row metadata. It is not a claim
that every legacy ingestion or lifecycle clock parser has been made strict, nor
that a local clock receipt proves an independent upstream source.

Verification: 23 recent-form tests (11 new), 61 actual publisher/TS/TSX data
adoption tests, 15 as-of timeline assertions, targeted ESLint and diff checks.
The actual model/feature/public capture test remains, not only isolated parsing.
This patch was developed independently while signed r699 was running and is not
part of r699.

## Actual current-input observation, 2026-09-07 11:28:14Z

A read-only complete SQLite current-match projection, paired to the unchanged
generation `g-d7bad6b5a190bb3132dbd9b039964082facce6a10da3c37e94254c7362cedbdb`,
found 43 matches / 86 team slots. Fifteen slots had no form rows and 71 had rows.
The selected-row total 685 is not a count of unique matches or independent sources.
Seventy-four slots lacked the selected-row evidence object. Among the objects
present, recorded observed rows were zero and missing observed rows totaled 132.
Do not extrapolate the missing-clock count to the 74 unknown objects.

The existing entity registry validated its content/hash contract, but only 2 of
86 current distinct local team IDs had a verified API-Football mapping label;
the registry had 7 total entities and updatedAt 01:21:30.125Z. This is not a fresh
upstream response audit. Current model input-sufficiency blockers affected 23
matches for Elo and 24 for form, with overlap. Frozen gap records were present
on 15 current records. Older frozen model metadata remains immutable and is not
backfilled to make coverage appear complete.

Audit implementation: outputs/read-live-current-input-inventory.cjs. No production
writes, secret export or complete payload export. This is SQLite/current metadata
and existing registry evidence, not an independent full PostgreSQL or historical
decision-chain audit. Next Q2 work still requires current-season authorized input,
verified entity/season mapping and real observation clocks; do not promote a model
or claim higher prediction accuracy from this repair.
