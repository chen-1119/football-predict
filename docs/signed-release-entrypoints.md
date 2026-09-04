# Signed release entrypoints

Routine releases no longer upload a shell script for `sudo bash` execution. The deployment client signs the release manifest locally, uploads four SHA-addressed artifacts, and invokes a fixed root-owned entrypoint:

```text
/var/lib/football-release/incoming/<sha>.tgz
/var/lib/football-release/incoming/<sha>.sha256
/var/lib/football-release/incoming/<sha>.manifest.json
/var/lib/football-release/incoming/<sha>.manifest.sig
sudo -n /usr/local/sbin/football-release <sha>
```

The private signing key and the local anti-replay sequence state must remain on
the release workstation. Both live under `.codex-tmp/`, which is excluded from
release bundles by both the archive exclusions and the sensitive-file policy.

## One-time key creation

```powershell
npm.cmd run release:signing-key
```

Defaults:

- Private key: `.codex-tmp/football-release-signing-private.pem`
- Public key: `.codex-tmp/football-release-signing-public.pem`
- Highest locally reserved release sequence:
  `.codex-tmp/football-release-sequence.json`

CI or an external key store can use explicit paths:

```powershell
$env:RELEASE_SIGNING_PRIVATE_KEY = 'D:\secure\football-release-private.pem'
$env:RELEASE_SIGNING_PUBLIC_KEY = 'D:\secure\football-release-public.pem'
```

Only RSA keys of at least 3072 bits are accepted. Back up the private key in an access-controlled secret store before making it the production signing identity.

## One-time server bootstrap

Copy the public key and the `deploy/light-server` bootstrap files to an operator-controlled directory, then run the bootstrap as root:

```bash
sudo bash deploy/light-server/bootstrap-release-entrypoints.sh \
  /path/to/football-release-signing-public.pem \
  https://134.175.132.183 \
  ubuntu \
  football-predict \
  production \
  0
```

The last argument is the highest sequence already accepted by this server, not
the next sequence to issue. Use `0` for a new server. On a repeat bootstrap the
argument may be omitted to preserve the existing value, and an explicit value
may only increase it. The bootstrap installs root-owned expected identity files
at `/etc/football-release/expected-site` and
`/etc/football-release/expected-channel`, plus the root-only replay state at
`/var/lib/football-release/highest-accepted-sequence`.
Bootstrap takes the same `/run/lock/football-release.lock` used by routine
releases while it reads and writes that state, so re-running bootstrap cannot
overwrite a sequence accepted concurrently.

The bootstrap installs only the two root-owned entrypoints, the non-executable
root-owned helper at `/usr/local/libexec/football-release-recovery.cjs`, the
public key, fixed configuration, replay state, and spool directories. It
deliberately does **not** modify `/etc/sudoers`.

It also creates the root-only transaction directory
`/var/lib/football-release/recovery`. A routine release refuses to start when
`recovery/current` already exists; that directory represents an interrupted or
fail-stopped transaction and must not be deleted until its snapshots have been
reviewed.

Verify both entrypoints before changing sudo policy:

```bash
sudo /usr/local/sbin/football-release --check
sudo /usr/local/sbin/football-relay-promote --check
sudo visudo -cf deploy/light-server/football-automation.sudoers
```

Install the reviewed sudoers template as a separate operator action, keep a second SSH or cloud-console session open, and validate that arbitrary sudo now fails. Remove every old `ubuntu NOPASSWD: ALL` rule only after the wrapper checks succeed.

## Routine release

Signed manifests use schema v3. Every manifest binds the artifact to a fixed
site and channel, a strictly increasing positive integer sequence, and a short
authorization window:

- `site`: `football-predict` by default (`RELEASE_SITE`)
- `channel`: `production` by default (`RELEASE_CHANNEL`)
- `createdAt`: canonical UTC timestamp generated immediately before packaging
- `expiresAt`: 48 hours after creation by default
  (`RELEASE_MANIFEST_TTL_HOURS`, whole hours, maximum 168)
- `releaseSequence`: atomically reserved from the local state; a failed build
  may leave a gap, but an old number is never reused

Keep the workstation clock synchronized. The site, channel, timestamps, and
sequence are part of the exact bytes covered by the detached RSA signature.

```powershell
npm.cmd run release:bundle
npm.cmd run verify:release-bundle
$env:RELEASE_DEPLOY_KNOWN_HOSTS = '.codex-tmp\football-release.known_hosts'
$env:RELEASE_DEPLOY_HOST_KEY_SHA256 = 'SHA256:replace-with-cloud-console-fingerprint'
npm.cmd run release:deploy-bundle
```

The dedicated known-hosts file must contain exactly one ED25519 entry for the
exact `[host]:port` token. Obtain its public-key blob and fingerprint from the
cloud serial/VNC console. The client uses `StrictHostKeyChecking=yes`, ignores
global SSH configuration and known-hosts files, and never learns a key through
trust-on-first-use.

For disaster recovery only, `RELEASE_SEQUENCE` can explicitly reserve a number
greater than the local state. It can never lower or reuse the stored sequence:

```powershell
$env:RELEASE_SEQUENCE = '142'
npm.cmd run release:bundle
Remove-Item Env:RELEASE_SEQUENCE
```

First compare against the server's root-owned highest accepted value. Back up
the sequence state together with the signing key; deleting the state and
guessing a lower number will produce a correctly signed bundle that the server
must reject.

Sequence reservation uses an atomic lock directory next to the local state. If
the workstation process is forcibly terminated, inspect the lock's
`owner.json`, confirm that the recorded PID is no longer running, and only then
remove the `.lock` directory. The tool deliberately does not auto-delete a
possibly stale lock because doing so can race with a new owner.

The root entrypoint copies uploader-owned files into a root-only work directory,
verifies owner/link/mode/size, SHA-256, RSA signature, signed manifest fields,
archive paths and archive entry types, then extracts the signed
`release-from-bundle.sh`. It requires the signed site and channel to equal the
root-owned configuration, rejects expired or overlong windows, and requires
`releaseSequence` to be greater than the highest accepted value. It holds the
release lock across validation and execution. After every signed field and
archive entry has been validated, it atomically consumes the sequence before
executing release code. A failed or interrupted release therefore burns its
sequence and cannot be replayed; gaps are expected and are safer than
re-executing a bundle after an ambiguous cutover. The caller cannot override
application, status, service, public-key, identity, replay-state, or target
paths.

Before the signed release mutates the runtime environment it atomically creates
`/var/lib/football-release/recovery/current`. Transaction schema v3 binds the
bundle SHA, site, channel, release sequence, old/new app device+inode identities,
ownership, modes, and markers. It also contains an exact runtime-env snapshot,
every managed systemd and Nginx file (including the enabled-site symlink and
absent-file state), original service/timer enabled+active state, SHA-256-protected
external `model-strategy.json` and `model-artifacts/evaluation.json` files, and
the live SQLite base/WAL/SHM rollback snapshot
once the service and managed maintenance jobs are quiesced. Pre-swap failures
restore the environment and clear the transaction.
Post-swap rollback restores the previous app tree, SQLite, external model
artifacts, host configuration, Nginx validation/reload, and timer state. It does
not execute restored application code to recompute rollback artifacts. If an
app-tree move or a critical
restore step fails, release stops immediately and preserves `recovery/current`
for operator inspection. Never delete that directory merely to make another
release start.

The HHAD companion row-level audit is not a third external recovery file. It is
stored only in SQLite's `private_model_artifacts` table and therefore follows
the already authenticated base/WAL/SHM snapshot. It must not be mirrored into
`public/data`, served by an API, or added to the external-model manifest. The
bundle release script and the fixed cold-recovery helper deliberately share the
same two-file external manifest; changing either side requires a new root-owned
helper bootstrap before a release can be attempted.

## Cold recovery

From the deployment workstation run `npm.cmd run release:recover`. From a
trusted server console, run:

```bash
sudo -n /usr/local/sbin/football-release --recover
```

`--recover` accepts no other arguments, takes the same release lock, clears the
environment, and executes only the root-owned helper installed by bootstrap. It
does not read or execute a bundle, app-tree script, or snapshot code. Before any
managed mutation, the helper validates the complete transaction, all hashes,
and the exact APP/BACKUP/FAILED inode topology, then stops transient build units,
maintenance jobs, timers, the worker, and the application.

Phases through `readiness-passed` recover by idempotent rollback. `finalizing`,
`committed`, and `recovering-commit` are roll-forward-only; the helper verifies
both new-app markers and never reactivates the old tree. Unknown phases,
symlinks, mountpoints, cross-device trees, unknown inodes, and tampered snapshots
are fail-stop conditions. After convergence, `current` is atomically renamed to
a private `.resolved.*` path before deletion. The deployment client then
requires localhost health and public SQLite/worker readiness.

The `committed` phase is an irreversible roll-forward boundary. If cleanup of a
committed transaction is interrupted, verify both live SHA markers, application
health, service/worker state, Nginx validation, and managed timers before
clearing it; do not roll the app back merely because snapshot cleanup failed.
The in-process exit trap also fail-stops without restoring any snapshot once
finalization has begun, closing the interval between the durable phase write and
the atomic `current`-to-`.resolved.*` rename.
Phases up to and including `readiness-passed` remain rollback-oriented. Snapshot
cleanup first renames `current` atomically to a `.resolved.*` directory and
fsyncs the recovery root before deletion, so a kill during deletion cannot
leave a partially deleted directory named `current`.

Run the repository guard independently with:

```powershell
npm.cmd run verify:signed-release-entrypoints
npm.cmd run verify:release-transaction-safety
npm.cmd run verify:release-recovery
```

## Sporttery relay

SSH relay uploads are addressed as:

```text
/var/lib/football-relay/incoming/<sha>.<timestamp-id>.json
```

The fixed promoter verifies the upload owner, regular-file/link/mode/size constraints, SHA-256, JSON structure, source, row floor, endpoint floor, and freshness. Its only writable production target is:

```text
/var/lib/football-predict/sporttery-relay-snapshot.json
```

There is no fallback to broad `sudo install`, `sudo mv`, or caller-selected destinations.

## Key rotation

Generate a new key pair in a separate secure path, carry forward the local
sequence state (or explicitly recover above the server's highest accepted
value), bootstrap the new public key during a maintenance window, run `--check`,
create a newly signed bundle, and perform one successful release. Key rotation
must not reset the server replay state. Retire the previous private key only
after the new release and rollback path have both been verified.
