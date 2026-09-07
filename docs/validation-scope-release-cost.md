# Validation-scope regression cost

2026-09-07. This optimization is separate from the running signed r698 release.

## Measured cause

The completed r697 release took 4,173 seconds. Its two readiness invocations of
`verifyDataValidationScopes.cjs` took 96,757 and 52,796 milliseconds (149,553 ms
combined). That verifier repeated parsing/validating the full public history for
each of 22 archive-scope cases, even when only a single counter changed.

Across r697, all 176 readiness child checks totaled 713,859 ms. The managed live
SQLite prebuild took 402,106 ms and the post-cutover full worker cycle took
1,142,901 ms. These measurements are not additive to total release time because
some observed service/barrier intervals overlap. Frontend verification reused
the signed prebuilt dist; dependency installation took 10,138 ms. No claim that
frontend compilation accounts for the hour-long release is supported.

## Scope of the change

The existing 22 behavioral cases now execute the unchanged actual validator with
a strict in-memory filesystem containing one scheduled row, one settled row and
explicit retention metadata. Unknown file reads fail. No fixture is written into
production or the published distribution.

Two additional passes still validate the complete actual public files, without
sampling or truncation: explicit public-distribution scope, and server scope
with the same isolated empty private archive used by the old test. The latter
is not a validation of the actual production private archive. Normal production
validator, worker publication checks, private-archive gates, release transaction
checks and deployment admission settings are unchanged.

Production readiness requires 24 checks, exactly two complete actual-public-file
passes and all 63 fixture data reads. This is not a cached "pass" or a removal of
the scope boundary tests.

## Local verification

A one-run before/after comparison on the same local working data executed both
the committed old source and new source in separate Node processes:

| Version | Wall time | Peak RSS |
| --- | ---: | ---: |
| Old 22 repeated complete-data cases | 17,965 ms | 1,101,664 KiB |
| New 22 bounded cases + 2 complete-data passes | 1,057 ms | 587,764 KiB |

Both passed. Local timing is not a promise or a measurement of production release
savings. Report: `outputs/validation-scope-timing-1788778384194.json`. No model,
historical result, source data, or release gate was changed by this benchmark.
