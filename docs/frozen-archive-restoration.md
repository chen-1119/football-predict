# Exact restoration of omitted published archives

This complements the fresh-result persistence fix. It does not regenerate old
recommendations and does not assert that an unrecorded historical screen was
correct. It restores exact objects previously present in the published store.

The release-bound manifest `scripts/data/frozen-archive-restoration.json` holds
the complete original 601-entry hash baseline, the eight original objects, and
the backup/loss observation identities. The original baseline root is
`dd5d5325cfcafb3f704fef96ba25d47c963a345887a24632c07f71efda9bc3fa`.
Its manifest digest is
`10c2b912403630cf71639ba15a450a9444104056209e8b43b5e59026800b0528`.
Hashes detect changed contents; release signing, not a self-computed hash, is
the authority for deploying this fixed manifest. No environment or network
source selects the runtime manifest.

The allowlist is 2040408, 2040427, 2040459, 2040467, 2040471, 2040475,
2040476 and 2040477. Restoration requires a missing archive, exact source and
event clocks, matching teams, original baseline membership, and the existing
archive validator's pre-cutoff checks. It is unavailable before the recorded
loss observation. Existing records are not overwritten. Later explicitly
authorized archive correction remains under the established authority layer.

The archive is cloned without changes to its fields or hash. A separate
`predictionMeta.frozenArchiveRestoration` receipt records the restoration,
manifest and original hash. Valid receipts survive subsequent fresh-result
persistence. This does not bind a formal publication, change predictions,
rewrite scores or confer recommendation eligibility.

`verifyFrozenArchiveRestoration.cjs` checks all eight fixed objects plus
tampering, event/team/cutoff conflicts, temporal boundaries, idempotence,
receipt continuity and non-overwrite behavior. It is wired into the existing
production public-reference integrity verifier. The manifest, implementation
and verifiers are mandatory signed bundle entries.

Local replay using the captured current/history files reconstructed the full
original 601-entry hash baseline after restoring the eight missing objects,
without changing prediction arrays, scores or public-reference decisions.
The capture's external-signals file changed, so this evidence is explicitly
limited to the individually stable match files, not a full-sync rehearsal.
Production restoration is not complete until a new signed release publishes
and live database/API continuity verifies the original objects.

The separate archive-migration verifier now uses fixed synthetic inputs. Its
prior dependence on two rolling historical rows made it expire as data changed.
Existing assertions about snapshot-only recovery, ambiguous event rejection,
model-only references and idempotence are retained. Synthetic migration
fixtures are not production recovery evidence.
