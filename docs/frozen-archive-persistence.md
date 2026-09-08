# Preserve frozen archives across fresh result persistence

Fresh provider result rows do not include the locally published
`archivedPreMatchPrediction`. `applyPredictionPersistence` previously copied
only the fresh row through several early returns, losing the existing archive
before the archive-authority stage. Reconstructing it later is not equivalent:
the original snapshot may no longer be retained.

The persistence boundary now carries the original archive only when the prior
row matches the exact event and the complete archive passes validation against
both the old and fresh rows, including the fresh cutoff. It does not change
the archive contents, invent an archive, borrow across reused provider IDs,
or add formal recommendation eligibility. Official void handling and the later
signed-recovery / independently attested correction authority remain separate.

Verification: `node scripts/verifyFrozenArchivePersistence.cjs` covers HAD/HHAD,
model-only and priced references, tighter cutoffs, reused events and IDs,
invalid archives, conflicting fresh objects, and prospective isolation.

On 2026-09-08 the locally captured eight real before/after historical rows also
reproduced the missing field through the previous persistence function. The
patched function preserved each complete original canonical SHA-256 exactly.
This is a focused function-level replay, not a full historical sync replay.

This change prevents future omission when the existing store still has the
archive. It does not itself restore the eight objects already absent from the
production generation. Their exact historical evidence and a protected recovery
path must be resolved before claiming production recovery. The prepared r706
bundle is immutable and does not contain this subsequent patch.
