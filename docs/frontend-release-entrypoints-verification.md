# Frontend release entrypoint routing verification

Run `node scripts/verifyFrontendReleaseEntrypoints.cjs` using the fixed Node 22 runtime.
Actual Bash is mandatory: `/bin/bash` on Linux; on Windows the verifier discovers
Git Bash or accepts `VERIFY_BASH_EXECUTABLE`. Missing Bash fails rather than skips.

This is a bounded integration delta, not another full-release acceptance run.
It reads the current wrapper/bootstrap and executes exact extracted source
functions and branches in private fixtures. It does not rewrite the production
entrypoints, execute the real controller, install dependencies, build Vite,
change real release sequences, or deploy.

## Proven boundaries

- RSA-3072 fixture signatures authenticate the exact bytes submitted to the
  wrapper's extracted kind-parser JavaScript. Missing kind remains full;
  frontend-only and full are the only accepted kinds. Unknown/null/object kinds
  and a full manifest carrying frontend authorization fail. The source contract
  additionally checks that the existing OpenSSL verification precedes parsing,
  and kind/sequence parsers use the fixed Node with a clean environment.
- UI apply executes once with fixed arguments, inherits fd 9, consumes the
  private fixture sequence once, writes kind/sequence status, and exits before
  the old trusted-source extraction and candidate release-script continuation.
  An injected controller failure preserves its exit code, writes failed status,
  and neither retries a build nor falls back to the full path.
- A pending recovery blocks UI before sequence consumption. The full kind
  retains its old continuation. The actual full tail records accepted completion
  before optional frontend initialization. Initialization failure does not
  relabel an already accepted full release or replay it; full failure never
  calls initialization.
- The frontend recovery markers select only the fixed controller with the same
  lock, including failure propagation. Absent and legacy state markers still
  select the fixed cold recovery helper; no frontend-to-legacy failure fallback
  is executed.
- Bootstrap/controller/guard module lists agree: the runtime's 13 modules plus
  the offline dependency importer are copied, including the server identity
  module. The actual copy branch compares source/destination bytes. The actual
  bootstrap import JavaScript executes dependency import then parser install,
  before wrapper installation. Import failure or a corrupted copied helper
  prevents wrapper installation.
- Both complete shell files receive real `bash -n` checks after CRLF-to-LF
  normalization, and all 14 bootstrap-installed Node modules receive real
  `node --check` checks. Raw source hashes and source stability are reported.

## Explicit limits

The controller and dependency importer are fixed-argument doubles: this suite
proves shell/JavaScript routing, not controller security, actual dependency
import validity, a sandbox build, acceptance receipts, or live deployment.
The fixture RSA check is Node crypto; it does not rerun the entire production
OpenSSL upload-validation pipeline. Existing signature and controller suites
remain authoritative for those separate boundaries.

Root ownership checks and sync/chown operations are doubled; there is no claim
of root-ownership or crash-durability proof. On Linux, real GNU install checks
fixture directory/file modes and real flock holds fd 9. The command child writes
through inherited fd 9 and a second independent open cannot acquire the lock.
Windows proves descriptor inheritance and byte copying only; POSIX lock
exclusion and install mode behavior are explicitly not claimed.

All fixture paths are newly created under the process temp directory, have
private parent permissions, and are checked by exact parent/name/path/inode
before recursive cleanup. Reports distinguish fixture count from Bash process
count and state whether actual OS flock was exercised. No production services,
configurations, journals, files, or provider APIs are touched.

## Retained actual Linux delta

`outputs/frontend-entrypoints-linux-1788866896259.json` records the pinned-SSH,
UID 1000, Node v22.22.1 run: 14 groups passed, 16 actual Bash fixtures, 14 Node
syntax checks, real flock proof, 1,596 ms suite elapsed, 2,263 ms SSH total.
Both nested and outer temporary directories were removed; local and remote
source hashes remained identical.

The wrapper hash was
`3ef22adf5a8e7f316de8df70542ef8d312482f49cb553a51482cd9aaa8248831`
and bootstrap hash was
`41683e89228113980f14930cad4347b03318d8fd9bbb5088d421c5c287e9360c`.
The report binds the verifier and the remaining source hashes as well. Later
source changes must be described as new deltas, not attached to this old proof.
