# Cloud report archive storage candidate

## Implemented scope

`server/researchReportStore.cjs` is an internal storage primitive for the five
scheduled research report slots. It preserves the original bounded UTF-8 JSON,
SHA-256, generation time and a separate PostgreSQL receipt time in the existing
`private_model_artifacts` table. It does not migrate any schema.

A business date and report kind identify one original completion. Identical
bytes can be read again; changed bytes conflict. There is no overwrite, UPSERT,
post-deadline replacement or implicit revision. Explicit append-only revisions
and on-demand report identities remain future work.

Inputs use version `cloud-research-report-v1`, `businessDate`, `reportKind`,
canonical UTC `generatedAt`, and an object `contents`. The entire original JSON
is limited to 512 KiB. Archiving verifies byte integrity only. It does not verify
source truth, forecast eligibility, official quotations, or publication.

Writes use a serializable transaction and the existing projection advisory lock.
A lost COMMIT reply produces `REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY`; the
caller must use the read method with the original date/kind/hash. No write retry
is automatic. A missing read is only `not-observed`, not proof that a prior
transaction can never commit. A successful COMMIT followed by an unavailable
readback is also explicitly unverified.

## Production integration remains disabled

No HTTP route, account permission, scheduled process or production wiring is
installed. The write method refuses to run without a supplied `runExclusive` broker.
That dependency is not itself a security proof: the later reviewed broker must
hold the actual `/run/lock/football-release.lock`, verify current release identity
and absence of pending recovery, and keep the lock through committed readback.
The database advisory lock alone does not exclude deployment.

The synthetic test callback is deliberately not described as a production lock.
Actual Linux release-lock contention and crash/child-lifetime tests are still
required when the broker is implemented. Authentication, CSRF/request origin,
bounded request reading, durable admission, controlled exact-draft publication,
second-transaction ACK replay and installed-source identity remain broker/API
work. Existing publication behavior and the original frozen records are intact.

## Verification

- Node unit tests cover exact bytes, input mutation, malformed encoding, size,
  schema, dates, hashes, missing broker, immutable conflicts, lost COMMIT reply,
  corrupt records, and lock-scope callback lifetime.
- `verifyResearchReportPostgres.cjs` uses a unique disposable schema in a local
  `recommendation_test` database. It checks real JSON text preservation,
  concurrent completion, immutable conflict, lost-reply readback and corruption.
- The PostgreSQL verifier is included in the existing Linux CI job. Local Docker
  was unavailable on this workstation; a unit pass is not a real database pass.

## Cloud handover

The dot platform network permission and independent production login remain
unverified. This candidate neither bypasses those restrictions nor completes
handover. Keep the two original dot tasks paused and local tasks active until
the full cloud read/archive/publish/ACK path is verified. Only then pause local
tasks, drain prior executions, enable the original cloud schedules and conduct
an actual workstation-offline acceptance interval.

## Root broker candidate

`researchReleaseBroker.cjs` is a fixed CLI candidate. It requires Linux root,
an already-held actual release lock acquired with util-linux `flock --no-fork`,
a root-owned binding, a verified RSA release manifest, exact source closure,
root-owned source bytes, accepted release markers and no pending recovery.
The binding and journal directories have no production installer yet; absence
is a refusal. The CLI does not reuse an old incident authorization.

It starts the fixed worker as `football` using only the current API's allowlisted
database and signed-snapshot settings. It passes the actual lock FD as FD3, so
a killed parent cannot release the mutex while the database child is running.
The Linux verifier exercises real contention and the parent-crash case with
isolated temporary files, without accessing the production lock.

Requests contain bounded original JSON and exact hashes, with four fixed actions:
archive, archive-read, publish and publication-read. Requests cannot select an
executable, key, database, file path or user. Publication calls the existing v3
publisher and replays the original record and second ACK. A present record
without ACK returns unverified and is never rewritten. The root journal fsyncs
an intent before execution and preserves its outcome. An unfinished prior
intent refuses automatic re-execution; a separate read request checks the result.

This is a candidate, not an installed publisher or scheduled research agent.
The signed installer, independent source review, actual runuser and installed
binding verification, authenticated caller admission, model API configuration
and budget, scheduled report generation and real offline acceptance remain
required. Keep local schedules active meanwhile.

## HTTP admission candidate

`researchWriteHttp.cjs` adds four exact POST route contracts for report archive,
report readback, exact-draft publication and publication readback. It is not
wired into `server/index.cjs`. The fixed submit adapter and signed root broker
installation remain absent; missing submit dependency returns unavailable.
There is no direct SQL fallback, new account role, credential export or timer.

Admission reuses the existing account session, exact Origin and session-bound
CSRF checks. Role and session are rechecked after the body arrives. Requests
are JSON UTF-8 only, uncompressed, at most 1 MiB and delivered within 8 seconds;
one operation can be active and each account has a bounded request window.
The original request bytes and action-to-route binding are preserved. Unknown
outcomes do not trigger an automatic write retry. Tests exercise the actual
account authorization helper with a synthetic read-only database fixture;
that is not independent production login or PostgreSQL integration proof.

The root CLI also bounds stdin delivery to 8 seconds and now includes its own
entry module in the signed source-closure verification. On pre-child failure,
stdin is closed. The existing release mutex and database-child lifetime
remain unchanged. Full new-head CI and installed caller validation are required.
