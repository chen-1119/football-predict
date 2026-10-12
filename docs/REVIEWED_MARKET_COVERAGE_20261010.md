# Reviewed recommendation coverage and fixed evidence pack

## Scope

- Extend manual reviewed version 3 batches to HHAD using the actual HHAD pool in the collector-signed Sporttery current payload. Keep HAD replay output unchanged.
- Bind exact event, ordered teams, business date, signed integer handicap, CBT fixed-allup sale state, cutoff, fresh acquisition and extraction signature membership. No HAD availability prerequisite for HHAD.
- Validate the selected outcome against home goals + handicap - away goals. Preserve the line in frozen records, combo legs, API parsing, list result metadata and visible labels. No probabilities are created or calibrated.
- Add `on-demand-prematch-supplement` to the original manual archive kinds so an afternoon supplement need not pretend to be a scheduled morning/night report.
- Inherit the prior reviewed SP/status display correction. Production r832 still needs the new release; a local test is not visible acceptance.

## Read-only evidence pack

`node scripts/buildFixedPrematchEvidencePack.cjs ABS_CAPTURE_JSON ABS_NEW_OUTPUT_JSON YYYY-MM-DD`

The input is a bounded fresh readonly capture with original signed current endpoint and current 500 quotes. The tool validates identity and market separately, returns devig market probabilities, comparison differences, published coverage and explicit unknown team fields. It creates an immutable local JSON file only. It does not collect independently or publish directions. Existing price storage is compressed observed states, not proof of hourly continuous coverage. Stored movement summaries remain awaiting raw-history replay and cannot be represented as a newly verified time series.

## Release preparation correction

The maintenance quiescence function incorrectly required exit 0 for `systemctl is-active` when the state was `activating` or `deactivating`. Such states return 3. The exact managed unit is now stopped, with the original subsequent inactive/failed exit-3 check retained. Unknown or conflicting state/status still fails. Real r833 journal shows the daily prematch oneshot starting at the rejection boundary; a separate temporary Linux oneshot proved activating/3 then failed/3 on stop and was cleaned up. This supports the corrected path, but the old generic log does not independently identify its exact failed statement.

## Validation boundary

66 focused tests passed without skips, including real local Bash function execution and HHAD-only signed fixtures. Source TypeScript and focused CJS lint passed. Final release mandatory/build and production adoption/GUI receipts are separate gates. Old frozen recommendations and settlement are unchanged. This change does not claim automatic AI direction generation, all-league trained parameters, injury/xG completeness, improved hit rate, or automatic T-45 revision.
