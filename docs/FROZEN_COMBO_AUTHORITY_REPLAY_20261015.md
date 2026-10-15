# Replay persisted original groups in publication authority

The normal r876 release completed and its separately signed broker refresh
accepted a real administrator publication read. That read verified all 13
original manual decisions and their original second transaction ACK.

Independent business health then failed. Read-only replay of the actual r876
view reported `RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY`. PostgreSQL,
immutable generation pointers and the API's generation lease agreed. The
writer had added `persisted-original-groups-v1` metadata while the authority
reader still compared that view to the original combination generator.

The repair replays the original group archive in the same caller snapshot,
before comparing the complete published manual view. Original raw artifact
bytes, seals, stored hashes, ordered teams, original decisions, archived legs,
SP and archive identities are still verified. Later valid archives are not
allowed to change an earlier published view. Corrupt later artifacts still
fail verification. No original record or database pointer is rewritten.

The published `frozen` boolean records the view's publication clock. A later
LIVE observation cannot reconstruct an earlier status. This small historical
field is accepted only as an exact typed metadata tuple bound to a verified
original archive; a published open flag at or after a leg's cutoff or kickoff
is rejected. A historical closed flag is conservative. This SELECT-only replay
path cannot perform passive archival and cannot authorize an offer or write.

The existing display and mutation rules remain independent: any current leg
that has started, is LIVE, is closed, is unknown or is no longer on sale freezes
the whole original group. Live writers use their existing current observations,
never the historical replay option. Single review versions keep their original
settlement and do not add independent events.

Verification includes the actual authority reader with immutable synthetic
archives, live-state changes after view publication, tampered prices and
metadata, raw archive tampering and real disposable PostgreSQL transactions.
The source is not a production acceptance receipt. A new reviewed HEAD, complete
CI, a unique normal signed package and actual installed health and publication
acceptance remain required. Failed packages and used component grants are not
reused. Dot network permission and workstation-offline acceptance remain open.
# Exact r876 preparation boundary

The installed r876 reader rejects the new frozen group metadata with
`RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY`. A read only capture reproduced
that failure locally; the corrected reader verified the same original bytes.

The signed normal code release may prepare from this particular broken baseline
only after `baselineAuthorityReplayRepair.cjs` proves both r876 markers, its
installed signed manifest and complete reader source closure, the exact API and
worker incarnations, PostgreSQL database/role/OID in a real read only repeatable
read transaction, the original thirteen records and exact second ACK, and the
committed immutable generation identity. It must reproduce precisely that old
error and verify the corrected candidate against the same database snapshot.
The proof runs under the controller's inherited exclusive root kernel flock.

This is a preparation proof, with baseline health explicitly false. The old
worker admission failures remain failures. It grants no publication or database
mutation, migration, fallback data, additional process permission or cutover
lease. Other release identities keep the ordinary baseline service gate. The
controlled watcher pause rechecks the same proof, boot, parent lock and both
clocks within 900 seconds, and requires the old worker to be stopped. All new
candidate service health, schema, data bytes, frozen originals, archives,
capacity, publication identity, fresh final lease and post swap gates remain.

The actual installed controller acquires its lock with `exec 9>lock; flock -n 9`, then calls the signed shell and command substitution. The acquiring child has already exited, while the locked open-file description remains inherited. The preparation proof also compares the descriptor actual exclusive kernel entry with fixed FD 9 of its verified root controller ancestor. A same-inode independent open, unheld descriptor, shared lock or unrelated ancestor cannot substitute for it. The isolated Linux fixture executes that exact shell pattern and negative case. The independent research broker own-PID no-fork lock policy is unchanged.

After actual new candidate health and its complete core verifier have passed,
the final old-service checkpoint repeats the same bounded read only paused
baseline proof. This covers all three old baseline service checkpoints while
retaining actual new candidate health and both post swap health checkpoints.
