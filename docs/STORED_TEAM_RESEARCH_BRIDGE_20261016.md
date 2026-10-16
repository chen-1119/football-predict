# Stored official team facts in prospective research

The normal sync cycle now reads the existing immutable team-evidence store in
one bounded PostgreSQL REPEATABLE READ READ ONLY transaction. Exact current-day
K League fixtures can carry the original schedule and standings evidence into
their prospective research input. This closes the readback gap between the
automatic collector and the detached research stream.

The existing bounded collector runs once in the official phase before
`sync:data`, retaining its own source cadence, retry intents and advisory lock.
It no longer waits behind the background slow-model task. Collection failures
remain optional and visible; they cannot authorize fabricated research data.
No second collector, forced synchronization or new worker is introduced.

The receipt preserves packet/raw hashes, ordered team identity, cutoff, actual
observation clocks, standings, the available five-game window and head-to-head
rows. One observed match is reported as one of five; neither complete recent
coverage nor complete H2H history is inferred from the bounded source window.
Future fixtures' default zero scores and unconfirmed results are excluded.

These source packets have `probabilityUseApproved=false`. They therefore stay
in `storedTeamEvidenceResearch`, independently of V3's admitted numeric feature
families. They cannot supply fitted weights, injury factors, confirmed lineups,
actual match end times or a second independent source. Missing source contracts,
parameters and formal model gates remain blockers. Model probabilities and the
parent frozen direction, scores, SP, ACK and settlement denominator are retained.

Unknown sale status stays explicitly unknown and never grants publication or
numeric feature admission. Closed events, swapped teams, missing/corrupt raw evidence,
future or stale receipts, failed transactions and ambiguous event bindings reject
attachment. Missing optional evidence does not abort the official collection.
The reader performs no networking, training, registration or production writes.

The full source batch also contains historical results. The caller selects the
current Beijing business day before invoking the unchanged 512-match reader;
it never truncates the first 512 rows. This prevents a 2,274-row source batch
from excluding a valid current fixture after the historical rows. A same-day
batch over the limit still rejects. Cycle metadata records the source batch,
selected day, source reads, attachment count and blockers so an absent research
field is observable without interpreting it as successful adoption.

The focused regression exercises the actual collector store/readback, prospective
input and V3 assessment boundary using synthetic fixtures. This proves software
behavior only. Live installation, a natural current-event read, and a source-
specific adoption receipt must be checked separately after normal deployment.
