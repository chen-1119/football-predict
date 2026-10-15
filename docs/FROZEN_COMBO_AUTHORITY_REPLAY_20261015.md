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
