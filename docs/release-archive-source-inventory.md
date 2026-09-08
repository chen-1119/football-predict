# Signed complete archive-source inventory

The bundle creator now inventories the **actual gzip/tar bytes** and includes
`archiveSourceEvidence` in the existing detached signed release manifest. It does
not infer membership from a working tree, file count, or timestamp, and does not
extract an untrusted archive to discover its contents.

This is the complete-source-evidence integration for release classification.
**The frontend build binding is explicitly unavailable, and the execution path
remains full.** The existing successful frontend build and signed dist manifest
do not prove that all build inputs were sealed and unchanged before/after build.
No caller flag or environment variable can turn them into that proof here.

## Actual creator and verifier paths

`createReleaseBundle.cjs` still performs the existing historical-archive preflight,
verifier contract preflight, actual frontend build, tar creation and model/dist
artifact checks. After creating the tar and observing its SHA/size/list, it runs
the bounded child command:

```text
node scripts/releaseArchiveSourceInventory.cjs capture <actual-release.tgz>
```

The child hashes the compressed bytes while streaming the decompressed tar. The
creator checks that the returned compressed SHA, bytes and effective entry count
match its independent archive observations. Every regular member receives a
SHA-256/byte count; directories, canonical paths and permission bits are retained.
The exact canonical `complete-release-tree-v1` inventory is included in signed
metadata. The manifest's 1 MiB cap is checked before signing; it was not increased.

`releaseSigning.validateReleaseManifestV3` validates this optional new structure
when present. Legacy v3 manifests without it remain acceptable to the existing
full release flow and do not import any new module merely to validate a legacy
manifest. A partially present field, inconsistent member/hash/count binding or
fabricated frontend-success field is rejected.

`verifyArchiveSourceEvidence(bundlePath, verifiedManifest)` provides an explicit
actual-byte recheck against a signature-verified manifest. A valid signature alone
only authenticates the signer's claim; this API compares it to the real archive.
The future fast-path consumer must call that recheck and retain the verified raw
extracted tree as its baseline, before any ownership/mode normalization or runtime
data linking. Capturing the later mutable app directory is not equivalent.

## Parser boundary

The parser accepts regular files/directories in USTAR, bounded POSIX PAX path and
size metadata, and GNU long-name records. Effective canonical member identities
are checked, so duplicate raw names, `./` aliases, case aliases, PAX aliases,
traversal, absolute/drive paths, missing parent directories and link/special
members cannot disappear into an apparently complete extracted tree.

Checksums, payload boundaries, zero padding and two zero terminator blocks are
mandatory. Unknown or ambiguous extension records, sparse files, xattrs, global
PAX path/size overrides and elevated permission bits are rejected. Rejection is
before signing or extraction, not a reason to omit such a member from inventory.

Limits: 512 MiB compressed, the classifier's 128 MiB per member / 1 GiB summed
content / 20,000 effective entries / depth 32, 64 KiB extension metadata and a
30-second capture deadline. The parser streams 64 KiB chunks and keeps only the
inventory and bounded header metadata, not the entire uncompressed archive.
Archive file identity is checked through an opened regular single-link file
descriptor and rechecked after read. The caller must still keep the archive in
its private staging directory; this is not a hostile-filesystem sandbox.

Descriptor lifetime has a single `FileHandle` owner. Capture waits for both
stream close events and the handle's close before resolving or rejecting,
including corrupt gzip and early parser rejection. It never races
`ReadStream.destroy()` against a separate raw `closeSync(fd)`, and does not
suppress `EBADF`. This prevents delayed stream cleanup from closing a descriptor
number already reused by a subsequent baseline/sentinel file.

## Observed existing artifact and fixed production wrapper

Read-only inspection of the already signed r711 archive succeeded without changing
it or its metadata:

- Archive SHA: `3c38e8cc7fa8f0d0dee06f2314ac8fccc640fab28efd476dc2811a57eb3b3a89`.
- 937 effective members, 261,367,302 bytes of member content.
- Inventory hash: `46991ca79b548eda0aaaa0d6db6503071f87bbe7ebf6eaf47cde5882b804fe5d`.
- Compact source evidence was 149,446 bytes; local capture took 486 ms in that
  observation. This is not a deployment benchmark or a new signed release.

The deployed `/usr/local/sbin/football-release` was read through the existing
pinned SSH identity. Its SHA-256 was
`3dacaea295f31b2061e704b569a4090edbe2488dd87153816ac99a91b0efc380`, exactly matching
the LF-normalized repository wrapper. Its real `assert_regular_upload` manifest
cap is 1 MiB. The actual inline manifest validator has no blanket unknown-key
rejection; the new verifier executes that exact block locally with the new
inventory-bearing signed fixture and confirms acceptance. No fixed wrapper,
public key, signature rule, sequence guard or bootstrap permission was changed.

The fixed production wrapper does not independently enforce this new inventory's
semantics yet; it already verifies the whole archive SHA and detached signature
and performs its own tar safety checks. That is compatible with observation/full
mode. Adding a trusted fast-path consumer or changing root trust bootstrap still
requires a separately reviewed integration, not an inferred skip.

## Dependency and historical-preflight audit

The new conditional validation dependency closure is:

```text
releaseSigning.cjs
  releaseArchiveSourceInventory.cjs
    releaseChangeClassification.cjs
      releasePrebuiltDist.cjs
```

The source-inventory creator also uses `releaseArchiveSourceInventory.cjs` as a
child entrypoint. All four must be packaged for new manifests; required-entry
lists include the new helper/verifier and the classifier. A real isolated fixture
containing only `releaseSigning.cjs` still verifies a legacy signed manifest. Any
isolated fixture that starts verifying new inventory-bearing manifests must copy
this explicit closure instead of silently depending on the workspace.

`releaseArchivePreflight.cjs` is the historical recommendation preservation and
restoration preflight, despite its similar name. Its meaning and code were left
unchanged. Source archive evidence does not replace original-object preservation,
generation consistency, restoration receipts or final live acceptance.

## Verification

```text
node scripts/verifyReleaseArchiveSourceInventory.cjs
```

The verifier runs actual system tar creation, streaming gzip/member inspection,
malformed/duplicate/link/PAX/truncation mutation cases, real detached RSA signing
and tamper rejection, standalone legacy-module compatibility, the exact fixed
wrapper manifest validator, and the actual creator's child-capture block. It
requires no provider calls, production writes, real signing key, sequence
reservation, build, deployment or service restart.

The focused verifier also performs 100 small filesystem-backed descriptor reuse
cycles across successful capture, corrupt gzip and early parser rejection. Each
cycle immediately opens a sentinel descriptor, yields through subsequent event
loop ticks, and then validates its identity, writes, fsyncs and reads it. No
large production archive is needed for this lifetime regression.

Remaining work before an executable frontend-only path: real pre/post sealed
build inputs and toolchain/environment provenance, retained authenticated baseline
storage, reviewed runtime/UI execution closure, retained frontend/data/endpoint
gates, and a separately tested frontend cutover/rollback implementation.
