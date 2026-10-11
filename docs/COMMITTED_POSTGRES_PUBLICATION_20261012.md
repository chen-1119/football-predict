# Committed PostgreSQL publication reads

## Observed failure

The 2026-10-11 16:06:08–16:08:06 UTC full worker cycle failed with
`SQLite publication identity matches neither the serving generation nor its immutable previous generation`.
The name belongs to a shared pairing helper. Production storage is PostgreSQL.
An earlier bounded read found projection_meta on generation `g-d9229561c59b61e978fda01a313c4886501f8fc8e7f5f85b12eb5ad0dd953d65`,
while both raw current and previous pointers had advanced. That read did not
hold the pointer commit lock and is not an atomic three-way observation.

The current/previous-only reader can reproduce this failure after two raw
advances. It prevents the worker from loading its existing PostgreSQL odds or
result inputs before the next projection transaction can run. This diagnoses
the latest observed failure; it does not prove every earlier sync failure had
the same cause. The earlier oversized reference-array hash repair remains in
this branch's parent.

## Change

PostgreSQL callers resolve the exact retained immutable generation named by
their committed projection metadata, with generation ID, manifest hash, source
cycle and the database's committed clock. The manifest and every payload SHA
are checked. Missing, linked, malformed or altered accepted material is refused.
Runtime readers defer unrelated whole-payload parsing; API/model readers retain
semantic validation by default. Generation reader leases and repeatable-read
transactions remain in place.

Normal generation cleanup holds the existing shared projection barrier and a
read lease, and explicitly protects the committed PostgreSQL generation beyond
the four most recent raw generations. If that read cannot be verified, cleanup
is skipped and the durable raw publication may still proceed to projection.

The commit clock is an authority value read from PostgreSQL. It is not copied
from a newer raw pointer or claimed to be embedded in the immutable manifest.
No latest-raw fallback, legacy fallback, PG metadata rewrite, record rewrite,
model registration, database copy or schema migration is introduced.

## Delivery boundary

This is a reader repair. Ordinary code activation still requires the live raw
pointer and PostgreSQL session to agree. The tests preserve that rejection.
The expired r847 incident authorization is not reusable. A separate fresh,
reviewed repair delivery contract is needed to install code while this known
projection divergence persists; extending the wait or deleting the affinity
check is not a repair. Until a normal signed deployment and a new natural
successful full cycle are observed, production sync is not repaired.

The new tests are included in the normal release verifier and both required
bundle inventories. The previous frontend fixture's access-verification mock
is updated to the current Navbar dependency; production UI is unchanged.
