# Isolated frontend build controller

This is an execution-evidence prerequisite, not UI release authorization. It
does not run npm install, sign an artifact, update an application, contact a
provider, or infer an authenticated baseline from mutable APP files. Windows
and non-root execution are rejected. The ordinary frontendBuildEvidence
executor remains explicitly unsandboxed and ineligible for signing.

## Root integration API

Install/review the controller closure before requiring it as root:
frontendBuildSandbox.cjs, frontendBuildEvidence.cjs, releasePrebuiltDist.cjs.
The files and every production ancestor must be root-owned, real paths, and
not group/world writable. Never require these modules from mutable APP first
and attempt to check their ownership afterwards: require already executes code.

Use the fixed /opt/node-v22.22.1/bin/node, version 22.22.1, clean Node/loader
environment, Linux systemd and unified cgroup v2:

```js
const controller = require(TRUSTED_CONTROLLER_DIRECTORY + "/frontendBuildSandbox.cjs");
const execution = controller.runSandboxedFrontendBuild({
  rootDir: "/var/lib/football-release/frontend-builds/" + stageId + "/source",
  baselineDist: independentlyAuthenticatedBaseline.dist,
  baselineReleaseSha256: independentlyAuthenticatedBaseline.releaseSha256,
  timeoutMs: 300000,
});
const recorded = controller.readSandboxEvidence({
  directory: execution.directory,
  evidenceHash: execution.evidenceHash,
});
// Independently compare recorded baseline, source/dependency hashes, command
// policy, controller policy and runtime identities against this invocation's
// authenticated inputs; inspect the exported source/dist again before signing.
```

stageId must be exactly 24 lowercase hex characters. The outer controller
must create a new root-owned private stage, hydrate only authenticated source
and reviewed offline dependencies, and place no old dist/cache input inside
source. All source ancestors must remain root-protected. Arbitrary root-owned
directories, production APP and source outside this fixed stage are rejected.
The original accepted baseline remains outside the build root.

The return includes original source/dependency commitments, exact baseline
release SHA + dist tree/hash binding, runtime library hashes, all three
authoritative unit exit records, cgroup cleanup observations, fresh artifact
manifest and overlay plan. signingEligible and deploymentAuthorized remain
false: execution isolation does not authenticate caller-provided baseline or
prove it is the currently accepted active release.

The output exports only fresh dist into the same checked private source stage.
No compiler cache is copied back; the two cache files receive content digests.
The original stage device/inode and output directory identity are checked
around export. The source and dependency commitments are checked again before
export. Callers must still recheck exported bytes at their own signing boundary;
the root-owned receipt is not an indefinitely reusable validation cache.

## Isolation and authoritative completion

Each fixed command is a direct systemd ExecStart, not a source-controlled
trusted runner or a JSON success message:

1. Fixed Node + node_modules/typescript/bin/tsc -b.
2. Fixed Node + node_modules/vite/bin/vite.js build.
3. Fixed Node + scripts/stripLargeStaticPayloads.cjs.

Each gets a unique unit/cgroup and dedicated DynamicUser identity. The unit
remains after its main process exits so the root observer can read
ExecMainCode, ExecMainStatus, Result and InvocationID. The observer then stops
the unit, escalates to whole-cgroup SIGKILL if needed, and requires both a
quiescent systemd state and an empty/removed unified cgroup. It never trusts
child stdout, child JSON, a shell exit alone or a caller-provided success flag.
The next step starts only after the prior group is cleared.

The private rootfs contains only byte-identical source/dependency mirrors,
the fixed Node executable and its root-validated ldd library closure, plus
the fixed librt.so.1 compatibility library beside the actual libc.so.6.
No candidate native addon is passed to ldd. Every runtime file is checked
for root ownership, ordinary single-link identity, size, hash and stability.
Directories are normalized for traversal inside the rootfs even when the
outer release runs under umask 077; host parents stay 0700. File executable
bits are preserved as root-owned 0755/0644 modes; readonly authority comes
from the mount policy and unprivileged UID, not a copied 0444 file mode that
would make Vite's repeated output copies fail. The original
source/dependency tree is not made accessible to the build user.

There is no host-root bind, production mount, service socket, host /etc or
provider network access. The unit has PrivateNetwork, AF_UNIX-only socket
families, private devices/IPC, invisible other-UID proc entries, no capabilities,
and restrictions on namespaces, mounts, ptrace/debugging and privileged calls.
SystemCallErrorNumber=EPERM keeps the same denied syscall set while allowing
ordinary copy code to handle a denied ownership operation instead of SIGSYS.
HOME is fixed to an empty root-owned readonly /build-home directory inside
the rootfs; it exposes no host profile and grants no additional writable path.
Its filesystem is readonly except dist, the empty transient .vite-temp
directory, and two precreated .tmp compiler cache files. The .tmp parent is
readonly, so no third cache may be created. /tmp, /var/tmp and /dev/shm are
explicitly inaccessible; DynamicUser's implied temporary directory behavior
must not accidentally provide another writable location.

Important systemd detail: the ReadWritePaths, ReadOnlyPaths and
InaccessiblePaths entries use the + prefix to address the unit RootDirectory,
not the host root. The permitted temporary Vite directory must be empty again
after each command. Only the two exact ordinary single-link compiler cache
files may exist. Metadata budgets cover the entire dist tree before file
bodies are read; symlinks, hardlinks and excessive trees are rejected.

After every completed cgroup, only the now-quiescent output tree is normalized
for the next dedicated identity (a numeric DynamicUser UID may be reused).
This permits the third step to remove files inside
0755 subdirectories created by Vite without granting write access to source.
The complete readonly mirror membership, directory/file modes, executable
aliases and bytes are checked again at the end.

STATIC_DIST_STRIP_SETTLE_MS=0 is fixed in the isolated environment and recorded
in evidence. The Windows-oriented 15-second late-copy wait is unnecessary
here because the prior Vite cgroup and all descendants have already stopped.
The actual strip command and its final assertStaticDistDataPolicy scan remain.
The ordinary unsandboxed builder keeps its original settling behavior.

## Storage, crash and cleanup behavior

The rootfs lives inside the dedicated build stage, not /run. The tested host
mounts /run with noexec and a roughly 768 MiB limit; copying an executable
rootfs there correctly failed with systemd 203/EXEC. No host mount settings
are changed.

Evidence and bounded stdout/stderr logs live under one random root-owned
0700 /run/football-frontend-sandbox-<24hex> directory. evidence.json is written
create-only, fsynced, and complete.json is written last with its exact hash.
Readback checks root ownership/path protection, the complete-last hash,
production scope, three successful unit results and cgroup quiescence. Fixture
receipts are explicitly rejected by the production reader.

Timeouts retain failure evidence. RuntimeMaxSec plus KillMode=control-group
also constrain descendants if the controller itself crashes. A crashed
controller cannot create a successful complete-last record. If quiescence
cannot be proved, the rootfs is retained for bounded operator recovery rather
than deleted underneath running processes. There is no automatic recovery,
resume, old-receipt reuse or broad directory deletion.

After the parent has consumed evidence, it may remove this exact private
receipt directory by checking its path/device/inode and allowlisting only
evidence.json, complete.json, stdout-[0-2].log and stderr-[0-2].log. No wildcard
cleanup of /run or frontend-builds is authorized by this module. Rootfs cleanup
is separately bounded, nofollow, exact-target and only after quiescence.

## Verification

```text
node scripts/verifyFrontendBuildSandbox.cjs
```

The portable suite checks policy, rejection and actual filesystem output
boundaries; it makes no Linux isolation claim. The explicit Linux fixture API
is usable only by a root-owned copy under a newly created private
/tmp/football-frontend-sandbox-fixture-<suffix> directory. It always emits
isolated-fixture scope and cannot become production proof.

The retained Linux report outputs/frontend-sandbox-linux-1788863648832.json
records 12 passing checks under actual Node 22.22.1/root/systemd/cgroup v2 and
umask 077. The two real hostile fixtures cover readonly source/dependencies,
extra-cache denial, IP socket denial, absent production paths, temporary
directory/HOME write denial, fchown returning EPERM, copying a source file
twice to the same output, successful three-unit output handoff, exited detached child
cleanup, and timeout/SIGTERM-resistant descendant killing. Both rootfs trees,
both exact /run receipt directories, and the /tmp fixture were removed; source
hashes remained unchanged. Production/provider writes were zero.

The separate real-build report
outputs/frontend-real-sandbox-linux-1788863923672.json records the actual
r711 TypeScript/Vite/strip build inside this same controller. All three commands
exited successfully and their cgroups were empty before the next boundary.
Independent scanning found all 63 files / 4,362,977 bytes identical to the
original archive's dist, with no differences and treeHash
d2bab0666563188226e07d0af0e223696ee7729992d177d71363f027075953c3.

Measured real-fixture spans (not production deployment/outage measurements):

| Boundary | Seconds |
| --- | ---: |
| Original archive validation and extraction | 2.667 |
| Exact inert dependency material reuse, no network | 1.561 |
| Dependency sealing into private fixture | 0.927 |
| Controller preflight | 2.615 |
| Readonly mirror preparation | 35.473 |
| TypeScript controlled unit | 13.878 |
| Vite controlled unit | 4.398 |
| Strip controlled unit | 0.216 |
| Post-build scan and export | 4.436 |
| Rootfs cleanup and receipt persistence | 0.303 |
| Independent baseline comparison | 0.030 |
| Exact private fixture/receipt cleanup | 0.907 |

The controller enclosing span was 61.340 seconds, remote preparation through
cleanup 67.432 seconds, and local SSH dispatch through receipt 77.342 seconds.
Command spans include systemd launch, observation and cleanup; they are not
pure subprocess CPU times. The subspans are measurements at separate boundaries
and need not sum exactly because of inter-step bookkeeping and clock rounding.
The biggest measured controller cost was copying/sealing the readonly mirror,
not the now-0.216-second strip step. This observation does not authorize reuse
of unverified mirrors or skipping the final static-data policy.

The original archive SHA is
3c38e8cc7fa8f0d0dee06f2314ac8fccc640fab28efd476dc2811a57eb3b3a89.
Its legacy manifest has no signed source inventory; reproduction does not
retroactively add authentication or make r711 eligible for a UI-only release.
This report is isolated-fixture proof, not current release acceptance,
signature eligibility, a live deployment, or zero production outage.

The successful run reused the exact root-only inert material
/tmp/football-frontend-materials-KXCy3C without installation or network.
This explicitly retained 0700 directory contains only 0400 manifest.json
(SHA 6f643eaaa33bba5905ab356918bca1843ecd3131172c3ab540ab710af216e18c)
and dependencies.tgz
(SHA 7421c6ffb99108d8cbbc9cfbc4e990be0509561352a700f566cc8a2e855e20f3).
It is inactive preparation material for separately authorized bootstrap, not
a trusted acceptance cache. The executable dependency preparation directory,
rootfs, exact /run receipt directory and complete source fixture were removed;
no build descendants remain. Production writes, provider requests, deployment
dispatches and this run's dependency installation requests were all zero.
Earlier failed fixture reports are retained rather than rewritten. The final
successful sources are bound by exact hashes in the report; earlier proofs
must not be relabeled as proof of later compatibility changes.
