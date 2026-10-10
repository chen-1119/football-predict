# Reviewed publication input scope

The first real morning publication on r828 failed with REVIEWED_ANALYSIS_BOUND.
Readback confirmed no record or ACK. The importer supplied all current match
payloads to a batch of two events; unrelated large payloads consumed its 8 MiB
input budget.

Select the draft event IDs from the existing bounded current-row read before
calling make. Preserve every candidate for each selected ID, the complete signed
official snapshot, the 8 MiB budget, same-event/ordered-team/cutoff/price checks,
immutable draft and the two-transaction commit/ACK protocol. Selected oversized
inputs and duplicate identities remain rejected. No production schema change.

Tests cover large unrelated rows with real transaction and browser-parser replay,
selected oversize rejection before COMMIT, and duplicate-identity rejection.
This fixes publication availability, not model accuracy or evidence coverage.
