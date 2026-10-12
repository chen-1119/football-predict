# Watcher pause restart startup budget

r829 failed before code cutover: the old API did not listen within its 120 second
watcher-pause restart allowance. The restored API journal subsequently measured
150961 ms of immutable publication warmup before listening. This observation
does not prove the sole cause of every previous release failure.

The pause and restoration restarts now use a fixed 180 second health allowance,
consistent with the existing recovery startup allowance. Both still require two
consecutive service health successes and their existing watcher state proofs.
There is no environment override. The 900 second activation window, lease,
source, PostgreSQL identity, natural worker and recovery checks remain intact.
This does not promise a 900 second maximum overall duration or reserve a window.

The mandatory transaction verifier runs the actual Bash health polling function
with a controlled clock: 152 second warmup fails at 120, passes with two probes
at 154 under 180, persistent failure and intermittent success both time out.
These are isolated fixtures, not a production recovery or deployment receipt.

The r829 transaction and all failed artifacts must remain intact. This change
requires its own signed release after normal recovery; no repeated r829 activate.
Recommendation input scoping is inherited from c58b7210. Availability fixes do
not demonstrate improved forecast accuracy or authorize late recommendation import.
