# Static verification receipts: foundation, not a deployment speed claim

## Why this exists

r709's real release log contained 206 completed child-check records for 103
distinct commands: each command ran twice. Recorded maxima included ~29 s for
release transaction safety, ~21 s for upload serialization and isolated-server
tests. These are child durations, not the full ~62 minute release wall time.
Mixed checks also read real PostgreSQL, HTTP, data or configuration. They cannot
be declared source-only simply because their filename begins with `verify`.

## Implemented boundary

`staticVerificationReceipts.cjs` is connected to the existing readiness child
runner. Unknown commands and absent/unsafe configuration execute the original
verifier. No live endpoint, SQLite/PG projection, current data, model gate,
production-plan coverage, source fetch or database-clone check is eligible.

The first audited profiles are two source scanners (bet-slip recommendation
gating and frontend evidence semantics) and one isolated large-JSON fixture.
Their exact LF-normalized verifier
hashes are pinned in the profile. Changed verifier code is **not automatically
enrolled**, even if a previous test passed: its dependency scope must be audited
again. The dependency binding includes actual bytes of every declared file,
the entire src tree and its membership where scanned, package/lock bytes, the
receipt policy, command, release SHA, Node binary and version, OS/architecture
and relevant locale settings. The scanners only import Node built-ins; TS files
are read as text, not executed, and no package implementation is loaded.

Successful output must reconcile to the parsed body, contain nonempty all-green
checks, exit 0 and not time out. A private 32-byte key authenticates each record.
Corruption, a wrong key, any changed identity, future timestamps, expiration
after 24 hours, unsafe filesystem permissions or inherited Node injection all
cause a real execution. Old verification time remains explicit; it is never
rewritten to pretend the test just ran. Source inputs are hashed again before
accepting or writing a receipt.

Files are create-only, regular, singly-linked, owner-only (directory 0700,
key/receipt 0600), under non-world/group-writable ancestors. Consumers use
no-follow file descriptors. Invalid existing receipts remain for investigation
and do not get silently overwritten. Windows reuse is disabled until real ACL
ownership verification is implemented; ordinary checks continue to run there.

The readiness runner also waits for child `close`, rather than `exit`, before
parsing JSON, so final buffered stdout cannot be lost. This fixes a general
completion-ordering hazard; it is not claimed as the cause of r709's reproduced
research-schema failure. The hard timeout still resolves failure even if a
descendant retains the pipes after the direct child exits; the forced deadline
remains referenced until the result is settled.

## Current activation and limitations

Reuse requires both an explicit `VERIFY_STATIC_RELEASE_SHA` and a provisioned
`VERIFY_STATIC_RECEIPT_DIR`. **The production shell does not set them yet.**
This is intentional: the candidate verifier and live verifier may run under
different Unix users; a service-user HMAC key must not be handed across that
trust boundary or treated as a root release attestation. Production activation
needs a root-owned signing/verification handoff and end-to-end proof of the
candidate-to-live receipt path. No r710 source, package or process is changed.

The two first scanner profiles prove the mechanism, not a meaningful release speedup.
They are cheap, and hashing the Node binary can cost more than rerunning them.
An isolated Linux experiment observed first call 733 ms and cached call 425 ms;
those numbers do **not** prove faster than an uncached original scanner.
Measure the direct baseline and amortize runtime identity over an immutable
execution scope before enabling. Next, audit the expensive fixture suites'
actual dependencies/environment and add only those whose isolation is proven.
Keep mixed/live checks fresh and retain full cutover/frozen-record acceptance.

## First measured expensive fixture profile (not production-enabled)

`verifySelectedJsonObjectFile.cjs` generates its own temporary input: 440 MiB
of ignored content and 32 MiB of retained content. It launches only the same
Node executable with a fixed 128 MiB V8 heap. It has no provider requests or
production data inputs. Its two executing modules, `selectedJsonObjectFile.cjs`
and `dataGenerationStore.cjs`, are both fully byte-bound and pinned to their
reviewed LF-normalized implementations. They import only Node builtins and the
already-pinned parser module. Any changed module requires dependency reaudit;
an added import cannot silently reuse or enroll a prior proof.

This verifier uses a numeric check count, unlike the scanners. A dedicated
result contract requires the exact nine-case inventory and full 494,927,962-byte
evidence, both retained keys, the bounded retained value, and memory below
320 MiB. An eight-case `VERIFY_SELECTED_JSON_SKIP_LARGE=1` result is neither
written nor reused. Failed, timed-out, malformed, partial or over-budget results
are not reusable. Default handling for all other verifiers is unchanged.

An isolated Linux measurement on Node v22.22.1 observed an original direct run
of 5,636 ms, a first receipt-path run of 6,267 ms, then three reuses of 417,
417 and 414 ms without launching the large fixture again. This includes receipt
input/runtime hashing and demonstrates a benefit for this **one** repeated
fixture, with a first-run overhead. It does not estimate total deployment
savings or enable the production cross-user handoff. The real shortened mode
ran afresh; a deliberately broken imported parser failed on each real run;
restoring exact bytes allowed the original proof to be reused. The temporary
test directory was removed, with no production writes or provider requests.

Evidence: `outputs/selected-receipt-linux-1788855564036.json`. The authenticated
receipt suite now also covers executable-module mutation, exact output shape,
case inventory, missing full-size evidence, memory limit and shortened mode.

## Evidence

- `npm.cmd run verify:static-receipts`: 42 authenticated-result, invalidation,
  scope, actual-source-scanner and exit-before-stdout ordering cases. The latter
  reproduce missing JSON with the old callback and complete JSON with the actual
  updated child runner, rather than only checking for a source-code string.
  An inherited-pipe counterexample also proves the hard timeout still completes.
- Isolated actual Linux: first write, second reuse without spawning, real source
  failure, failure re-execution, exact-source restoration, disk tampering,
  unsafe permissions and key/file mode checks. Five real scanner executions;
  no production data writes or provider requests; fixture removed.
- `outputs/r709-verification-latency-1788848175306.json`
- `outputs/static-receipt-linux-1788848834049.json`

This work does not complete dependency-based reuse for all verification, change
recommendation eligibility, improve measured hit rate, or prove any deployment.
