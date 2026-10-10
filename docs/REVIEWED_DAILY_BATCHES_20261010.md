# Reviewed daily batches

Manual reviewed directions can be published before trained model coverage is available. They remain `reviewed-editorial`, with no model probability, no formal calibration claim and no old-strategy fallback.

Version 3 uses `manual-prematch-batch` / `reviewed-online-reference`. It embeds the exact UTF-8 original archived report as `originalArchive`, with its SHA-256 in `originalArchiveSha256`. Supported original report kinds cover the morning supplement and weekday/weekend selected/full reports. The original business date, freeze time, every original single field, directions, scores, confidence, links and original SP are bound exactly. Only the truthful `manual-prematch-research` classification may be added. The original local archive is never changed.

This manual path does not claim the Korean machine-evidence adapter accepted other leagues. Version 2 retains its original committed evidence requirements. Existing signed official event identity, ordered teams, actual sale cutoff, fresh HAD quote, score compatibility and separate PostgreSQL commit/ACK rules apply to every version.

New batches have immutable content-addressed keys. The same business day can append disjoint events, up to 32 records / 32 batches. Existing events cannot be replaced by submitting another batch. An uncertain commit or missing ACK must be inspected; retries do not overwrite or fill in missing records automatically. The normal publisher merges acknowledged batches; each row retains its actual publication and ACK clocks. Browser checks use those individual clocks, so an evening batch does not invalidate a morning record whose sale has since closed. Closed records remain in history but are excluded from new combination selection.

The original single-record versions remain readable and replayable. No database schema migration is needed. Rolling code back to a version that does not understand batch keys hides those new records in that older projection, but preserves their immutable database originals.

Operational sequence: preserve the original report; create a separate v3 wrapper; run installed `publishReviewedAnalysis.cjs --check ABS_DRAFT STABLE_HASH`; use the normal installed `--publish` only while all selected matches remain in sale; verify stored freeze and separate ACK, then the natural publisher and the actual browser. Never relabel a morning archive as a weekday evening report. If part of an original report has expired, do not edit that frozen report or backdate a new prediction.

This change does not train new parameters, prove improved hit rate, add automatic re-evaluation, or implement reviewed HHAD selections. Missing team facts remain disclosed. Accuracy is measured against the first real pre-match frozen direction, rather than the best subsequent version.
