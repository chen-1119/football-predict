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

No HTTP route, account permission, CLI, server process or production wiring is
added. The write method refuses to run without a supplied `runExclusive` broker.
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
