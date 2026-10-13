# Capacity preparation check

r813 stopped before candidate allocation with `native-release-insufficient-capacity`.
The application and completed release remained r812; no recovery transaction was pending.
A fresh observation at 2026-10-09 09:18 Beijing found 41,514,807,296 available bytes
against the existing conservative 44,604,301,892-byte requirement. This requirement
is a budget, not an observed peak or a reservation.

The previously authorized, exact r808 completed candidate database was reclaimed
under the normal fd9 lock, with matching cluster/name/OID, zero connections,
retired access roles, complete reference checks, signed original and dump hashes,
and a fresh plan/apply comparison. The retained backups and release records were
not deleted. The new 09:22 observation passed capacity. Private deletion receipts
and identity reviews remain outside Git.

`runReleaseCapacityPreflight.cjs` now runs during online full bundle preparation,
after the existing worker preparation check and before window/archive checks,
sequence reservation, compilation or signing. It sends the existing local
capacity observer over pinned SSH and recomputes the returned budget locally.
Missing transport, stale/future observations, changed source binding or altered
budget values fail closed. The existing remote allocation check remains mandatory.
Offline builds cannot claim current remote capacity; neither observation reserves space.

This is a preparation-order correction. It does not lower the capacity budget,
install an automatic database deletion executor, change model probabilities or
complete a model registration. r813 failure evidence and sequence remain preserved.

The model identity work prepared eight reviewed Brazil club mappings and a new
private registration packet. That preparation is not a production write, registry
readback, natural publisher adoption or formal calibrated recommendation.
