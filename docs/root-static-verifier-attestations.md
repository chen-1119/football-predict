# Root-attested reuse of release-only static verifiers

This optimization executes an audited source-only test or isolated fixture once, then lets the candidate and live readiness processes reuse the authenticated result for the same signed release. It does not reuse live HTTP, PostgreSQL/SQLite generation checks, data freshness, recommendation history, worker state, or model promotion evidence.

## Trust and execution boundary

`createRootStaticVerificationAttestations.cjs` is invoked by the privileged release coordinator using the trusted signed helper, after the final NEXT tree is assembled and its source permissions have been normalized. It checks root ownership and non-writable ancestors for the exact audited inputs and Node executable.

Each actual verifier runs in a separate transient systemd service with a randomly named DynamicUser, an empty environment populated by a fixed small allowlist, private temporary storage, no provider networking, read-only application source, no capabilities, and inaccessible production stores/configuration. The signer remains outside that service, running as root. Neither `football-build` nor `football` receives a signing key, a writable trusted key file, or a writable signature directory.

An exit code or a JSON line alone is not sufficient. The producer requires complete bounded output, the profile-specific success contract, unchanged inputs, and authoritative process completion. It observes the systemd unit and checks remaining processes in a verified unified cgroup-v2 hierarchy. Unsupported/unknown process-state observations do not become successful cleanup.

The root producer signs create-only records with a fresh in-memory Ed25519 private key. The public key, result records and completion marker live in a root-owned `/run/football-release-static.XXXXXX` directory. The private key is never written to disk or handed to a consumer.

The attested identity includes:

- signed release SHA;
- exact command and complete audited file/tree membership and raw input bytes;
- exact-source audit pins and the profile's complete-result contract;
- Node executable hash, Node/native component versions, operating system and architecture;
- the fixed fixture execution environment;
- receipt policy, attestation reader and producer/isolation/completion implementation hashes.

Records are accepted only within the existing 24-hour age limit, never from the future. A changed source, dependency, runtime, release, producer policy, invalid signature, unsafe permissions or incomplete store is a cache miss. The reader rechecks input identity after opening a record.

## Release integration

Preparation runs once after root-owned NEXT assembly and worker write-permission checks, before the transition lease is captured or production writers are paused. The source-only workload therefore does not extend the stopped-worker or atomic-swap window.

The same release-bound directory is passed explicitly to these existing commands:

1. Candidate `verifyProductionReadiness.cjs`, running as `football-build` against the isolated candidate store.
2. Post-swap `verifyProductionReadiness.cjs`, running as `football` against the current live store and required primary read source.

Both receive `VERIFY_STATIC_ATTESTATION_DIR` and `VERIFY_STATIC_RELEASE_SHA` as invocation-local environment values. Both explicitly clear the legacy `VERIFY_STATIC_RECEIPT_DIR`. These settings are not persisted in the application runtime env file, candidate server environment or service unit. The live wrapper sources its ordinary runtime configuration first; the explicit readiness `env` arguments then take precedence.

The `/run` records remain root-owned and read-only to both consumers. They do not belong in the build user's writable tree or a permanent application cache. Moving NEXT to APP does not invalidate source-identical proof, while changing any bound source bytes does.

## Failure and cleanup behavior

- Producer exit 0 with a validated root directory and valid device/inode binding enables reuse.
- Producer exit 2 or unusable optimization evidence keeps both original readiness invocations. It does not manufacture a passing check or fall back to a service-user-writable HMAC cache.
- Producer exit 3 denotes an actual failed verifier and aborts before candidate readiness. Metadata problems must not downgrade that failure into an optional cache miss.
- Cleanup always clears the separate reuse pointer first. If cleanup fails, the original directory/device/inode binding is retained so later cleanup can retry; an incomplete directory is never advertised for reuse.
- Success, pre-swap abort, rollback and EXIT handling all invoke the exact bounded cleanup helper. It validates the named root store and its identity and does not recursively delete arbitrary directories.

An unavailable optimization can cost performance because the original checks run; it cannot lower the release's validation requirements. A test failure remains a test failure.

## Evidence and limits

`verifyRootStaticVerificationAttestations.cjs` covers signatures, age limits, source/runtime/release changes, unsafe producer arguments, completion-state contracts and no-HMAC downgrade. It is a contract test, not proof that systemd or Unix ownership work on the deployment host.

`verifyReleaseStaticAttestationIntegration.cjs` runs real Bash against the actual extracted prepare/cleanup functions and the actual candidate/live command argument lists. Its 26 checks include 23 isolated shell scenarios: successful handoff; missing, malformed and unsafe directory metadata; stat failures; preservation of real verifier failure; disabled reuse with retained cleanup authority; all four cleanup sites; pre-lease ordering; and invocation-local environment scope. Only the producer CLI and logical root-directory metadata are doubled. It never invokes the real deployment, creates a real `/run` store, or certifies root signatures/systemd isolation by itself.

The independent Linux proof must additionally run the real producer service and consume one result under two distinct non-root UIDs, then test tampering, changed inputs and exact cleanup. Keep its source hashes with the result. A prior proof for an earlier producer implementation is not current-source deployment proof.

Historical isolated measurements are not end-to-end release savings. Count actual fresh runs and attested reuses in the two readiness logs, then measure the complete guarded release and stopped-service window. Database preparation, upstream collection, enrichment and model work remain separate contributors to total deployment latency.
