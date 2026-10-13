# Match detail: useful content first

## Changes

- Keep original published picks, scores, prices and evidence. Do not show an empty model-score card underneath an editorial score pair.
- Render historical team results, head-to-head and standings only when records exist. Missing records remain explicitly described in a collapsed note, including the difference between no matched history and no previous meetings.
- Move unavailable live statistics into the same collapsed explanation. Not-started, cancelled and unconnected-statistics states retain their distinct wording; absence is never converted to zero.
- Empty injuries/lineups use one collapsed disclosure. Real player records stay expanded, including previous-record warnings and original timestamps. Partial coverage hides empty columns and metric tiles. No unavailable refresh request is enabled.
- Preserve all stored directions, prices, score choices, recommendation IDs, signatures, ACKs and settlement data.

## Verification

TypeScript project checks pass. Eleven rendered supplemental-panel cases pass, including empty/error/unsupported identities, real player fields, old timestamps, partial coverage, authentication and request cooldown. Eight original-publication cases pass, including real Dijon frozen SP 3.15, HAD/HHAD identity and same-snapshot history. MatchDetail scoped lint passes; the supplemental component retains two pre-existing React hook lint findings (effect setState and render clock). This is not a full-repository lint claim.

## Production status at 2026-10-13 15:22 Beijing

These display changes are not deployed. The preceding r860 full release failed the post-swap public PostgreSQL publication-identity check and rolled back. At 15:09:19 the independent observer confirmed r853 APP and completion markers, no release process or pending recovery, API PID 468942 and worker PID 469013 active.

Frontend-only preparation then found root frontend metadata still bound to r844/r848 and no public frontend metadata in the current r853 tree. One normal installed-controller initialization of the completed r853 baseline rejected `frontend-installed-runtime-unavailable:reviewed-baseline-runtime-boundary-failed`, with no pending recovery. No files were overlaid, no service was forced, and r860 was not retried.

Next production work must resolve the independently installed frontend policy compatibility and obtain a valid current-runtime binding through the normal controller, or deliver a newly reviewed full release after fixing its actual publication-identity failure. Do not reuse an old signature/sequence or bypass either check. Supplemental source collection itself remains incomplete; hiding empty cards does not create injury, lineup or xG evidence.
