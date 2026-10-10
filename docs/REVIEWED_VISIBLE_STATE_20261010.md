# Published reviewed picks: visible state consistency

The authenticated r832 fixtures page showed both committed reviewed picks, but
its adjacent SP and result fields still read the legacy decision lane and showed
an empty frozen price and “awaiting publication”. This is a presentation defect.

The fixture row now uses the already parsed, exact-event/team matched reviewed
record for its direction, frozen official price, and publication status. The
price is explicitly the publication price, not a live price. After cutoff the
record remains visible as published and awaiting a verified result; this change
does not derive a win/loss from a live score. Details retain the same reviewed
record after the event status changes. Missing records explicitly say no pick
has been published, separately from fixture/odds freshness.

No collector, probability, registration, publication, identity matching,
settlement, database schema or frozen prediction is changed. This does not
create recommendations for uncovered events or claim model eligibility.

Verification: 40 targeted tests (reviewed rendering, publication contract and
match parity), TypeScript build. Full release gates and live verification must
be recorded separately; local tests do not prove deployment.
