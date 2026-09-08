# Deadline-only research and the admin contract

2026-09-08. r709 finished with exit 1 at 05:43:23 UTC after a controlled rollback.
Its post-cutover readiness had 176/177 successful checks. The failing check was
the model-evaluation admin contract: challengerSuiteIsSanitized=false, with no
challenger trials. Worker/exact-heartbeat and public aggregate checks had passed.

The corresponding code defect is reproducible: deadlineOnlyResearchStatus(null)
produced an unavailable, shadow-only suite without `trials`. The public aggregate
treated that as zero trials, but the unchanged admin contract correctly required
an explicit array. Real isolated HTTP replay reproduced this exact mismatch.
The failed production response did not retain the entire original suite object;
the diagnosis combines its failure fields with the reproduced producer path.

## Fix

- New absent suites include `trials: []`, while available, chainValid and
  onlineEffect remain false and the unavailable blocker remains visible.
- An exact legacy unavailable deadline-only placeholder missing the property is
  normalized on the next producer call. Existing null/malformed trials, available
  suites, unknown versions/reasons and prior failures are not silently repaired.
- No trials, candidates, recommendations, settlement results or history are
  created. Existing input objects are not mutated. The API gate is unchanged.

## Regression and release prevention

- 36 deadline-capture behaviors passed. Real active deadline-only producer output
  now runs through the exact admin predicate read from verifyApiContracts.cjs,
  in addition to the worker and public-aggregate checks.
- An isolated real HTTP server reproduced the old rejected shape, accepted new
  and legacy-normalized shapes, accepted repeated deferral, and preserved prior
  research failures. Five cases passed. The temporary server and fixture were
  closed/removed; production writes and provider requests were zero.
- Three small producer/consumer checks also run in the existing pre-signing
  contract gate, before sequence reservation, without replaying the full SQLite
  or deadline test suite. The full live acceptance gate remains mandatory.
- Changed JavaScript ESLint and diff whitespace checks passed before commit.

Local HTTP evidence: outputs/deadline-admin-http-1788846651105.json.
The signed r709 package was not modified, re-signed or replayed. This source fix
needs a new signed release and external acceptance; it is not itself deployment
or improved recommendation accuracy.

## Rollback outcome

05:44:04 UTC: strict HTTPS reported serviceOk/dataFresh=true, PostgreSQL read
source and a running worker; recommendationReliable remained false.
Read-only rollback audit preserved all 592 pre-release frozen archive objects
and all 40 original public-ledger objects. Nine previously identified missing
archives remain missing versus the 601-original target; no restoration success
is claimed. The r709 external success-only acceptance was not started.
