# Signed PostgreSQL-only release lane

This lane prepares an independent PostgreSQL database from a held read-only
snapshot, retains the custom-format backup, restores it, and verifies every
business row before accepting the seed. The exact corresponding immutable JSON
generation is copied with a real service-account lease and byte hashes. It does
not export or upload SQLite. Initial retirement reads the old learning/research
ledgers through their audited importers; subsequent native releases do not.

Build and candidate roles receive only candidate-database privileges. The
candidate HTTP role is read-only. Both roles are removed after their units drain.
The final stopped window requires a durable v4 recovery transaction, stopped
managed writers, an owned generation pointer lock and matching database OIDs.
The publisher fences new connections, performs the final authenticated mirror,
imports the final legacy ledgers, verifies PostgreSQL/SQLite retirement parity,
then atomically renames the independent database. Unknown sessions are rejected;
they are not forcibly disconnected. Recovery retains new data when reverting
application code, and never restores old SQLite or model-ledger state over it.

The signed policy and journal must pin the same already accepted native-capable
bootstrap. A null pin deliberately makes package creation and server dispatch
fail before sequence use or data changes. A failed full release cannot become
the bootstrap. Initial and future native releases retain candidate readiness,
revision continuity, a fresh official worker cycle, enrichment, live readiness
and public PostgreSQL-only verification before the completion marker is written.

The client verifies policy bytes inside the signed, hash-bound archive before
removing its legacy local SQLite clone check. Legacy packages retain that check.
Cold-recovery verification follows the actually recovered storage status and
then requires the full corresponding storage readiness checks.

Validation completed during implementation:

- Linux Node 22.22.1: actual peer IPC, snapshot pg_dump/pg_restore, complete mirror,
  service-account generation copy, read-only and writer grants, denial of original
  database access, role removal, and authenticated incremental correction. Four
  scenarios passed in a new PostgreSQL cluster with no TCP listener. Only fixed
  socket/store paths were relocated; no production database was changed.
- Real isolated PostgreSQL final-session tests: successful fenced rename,
  unexpected-reader rejection, and failure after fencing requiring recovery.
- Real v4 recovery/database tests: five recovery states, preserving appended data.
- Native publication/API/model regression: real migrations, exact evidence bytes,
  full/incremental writers and PostgreSQL-only HTTP, with forbidden SQLite loads.
- Five generation-copy/lease scenarios, six actual policy/client/shell routing
  scenarios, 33 early-window contracts, and 65 legacy transaction safety checks.
- Existing pre-sign contract suite passed 343 checks while bootstrap remained
  unaccepted. Final pinning and the final source tree must be reverified before
  signing. Fixture success is not evidence of an accepted production cutover.

The earlier full-size production-data rehearsal retained an 868,659,756-byte
backup with SHA256
`7b6adc28b73709008c0b2811d666a92a5f6dbe8cb523587ef47c3ed29d902821`.
All 27 then-existing tables matched after an independent restore. The subsequent
full-size mirror benchmark verified more than 1.65 million rows. These read-only
rehearsals are distinct from the mandatory fresh backup and retirement proof of
the actual signed native deployment. No model promotion is authorized here.
