# Offline frontend dependency import

This is an independently approved bootstrap operation, not a source-release
authorization or automatic dependency installation. `frontendBuildDependencies`
never invokes npm, tar/Python subprocesses, package lifecycle scripts, candidate
code, ldd or a provider. It does not write APP, runtime environment or services.
There is no CLI and no caller-controlled output path or production hook.

## Fixed APIs

```js
await importFrontendBuildDependencies({
  materialDir, materialManifestSha256, materialArchiveSha256, lockSha256,
});
installFrontendBuildParser({ lockSha256 });
```

Both production entry points require the already-installed transaction module's
`assertFrontendReleaseLock()`: fixed clean Node 22.22.1, root, inherited fd 9's
actual exclusive kernel flock, fixed root-controlled paths, and existing release
bootstrap directories. Install the reviewed module closure before requiring it;
do not load these APIs from an uploaded candidate and check ownership afterwards.

Import input is only a canonical root-owned private
`/tmp/football-frontend-materials-<6-to-32-alphanumeric>/` directory. The only
members are single-link root-owned 0400 `manifest.json` and `dependencies.tgz`.
The root-owned sticky /tmp parent is explicitly permitted; private child ownership
and canonical identity remain mandatory. Fixture inputs use a factory-created
private directory instead and never select production paths.

All three hashes must be supplied by the independent bootstrap decision.
The manifest's exact raw-byte hash, archive's actual compressed-byte hash and
manifest.lockSha256 must match. The manifest is the existing inert-material
format: kind `task-private-dependency-material-not-acceptance`, createdAt,
lockSha256, archiveSha256, inventory, install and signingEligible=false. Its
historical install description is retained as input evidence, never executed or
accepted as a successful current installation claim.

The prepared KXCy3C material has been identified separately by the parent task.
This module has no default material directory/hash and does not automatically
import it. Synthetic fixture success is not approval of that material.

## Complete validation before extraction

The implementation makes two bounded streaming passes over the tgz:

1. Read-only pass validates all actual tar headers, complete file bytes/hashes,
   member metadata, exact material inventory and whole compressed SHA. No output
   extraction stage exists before the complete metadata graph has passed.
2. Create a fresh root-private stage. Precreate only validated real directories,
   stream files into create-only no-follow descriptors, fsync them, and compare
   every second-pass member with the first. Only after all regular files pass
   are the validated npm executable aliases created. Reinspect the complete
   extracted membership, content, normalized modes, owners and alias targets.

Only node_modules and its descendants are allowed. Paths must be normalized,
bounded, NFC, free of traversal/absolute paths, separators/control characters
and case aliases. Every parent must be a declared real directory. Hardlinks,
devices, FIFOs, sparse types and PAX headers are rejected. Both GNU long-name and
long-link records are supported with a 4096-byte metadata cap; their expanded
names/targets receive the same checks. Nonzero padding/trailing content after
the tar end, checksum errors, incomplete headers and dangling extensions reject.

Symlinks are allowed only where `frontendBuildEvidence.validateBuildBinAlias`
permits an npm .bin executable, including audited nested package/node_modules
chains. A link must be relative and resolve inside node_modules to a declared
ordinary file; not another symlink, directory, hidden cache or escaped path.
There is no extraction through a symlink parent and no general tar extractall.

Limits: compressed archive 512 MiB; ordinary member 160 MiB; ordinary bytes
2 GiB; 100,000 members; 32 MiB input manifest; 120 seconds per streaming pass.
Expanded stream/header counts are bounded separately. One FileHandle owns each
input descriptor; source/gunzip close completion is awaited before returning,
including failures, so a later caller's reused fd is not closed asynchronously.

## Store and consumer binding

Output is fixed:

```text
/var/lib/football-release/frontend-dependencies/<lockSHA>/  root 0700
  node_modules/
  dependencies.json
  complete.json
```

Directories become 0755, regular files become 0644 or 0755 according to whether
the original executable bits were present. The private root ancestor protects
the entire tree. This normalization is explicitly included in the final
dependency commitment; raw material modes still must match its inventory.

`dependencies.json` records exactly:

```text
version='frontend-build-dependencies-v1'
lockSha256, dependencySha256
materialManifestSha256, materialArchiveSha256
entryCount, totalBytes, importedAt, origin
```

dependencySha256 is the actual
`frontendBuildEvidence.snapshotBuildInputs(root,{beforeBuild:true}).dependencyHash`,
not an independently invented inventory hash. It includes npm alias targets and
their executable content/modes, and is directly compatible with
`frontendReleaseController.dependencyStore()` / `copyDependencies()`.
complete.json is written last, binds raw dependencies.json bytes including its
newline, and both files/directories are fsynced before the final atomic rename.

Before extraction, available space must cover 4 GiB untouched floor plus actual
member bytes, an 8 KiB-per-member allocation/metadata allowance and 4 MiB record
allowance. This is a precondition, not reserved capacity against other writers.
Conflicting or incomplete existing stores are rejected. An existing exact
material can be idempotently reused only after revalidating the archive, store
completion record, whole dependency content and alias/mode/owner graph.

No old version or failed stage is automatically removed. A failure leaves only
a private `.import-<24hex>` directory; it is not a complete selectable store.
Disk retention/cleanup remains a separately reviewed bootstrap/operator action.

## Trusted TypeScript parser installation

`installFrontendBuildParser({lockSha256})` first revalidates the sealed store,
then copies exactly package.json and lib/typescript.js into a fresh staging
directory under `/usr/local/libexec/football-release-frontend/node_modules`.
It requires package name typescript, version 6.0.3, the exact CommonJS main
`./lib/typescript.js`, no exports override, and library SHA:

`569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39`.

It does not require/load/execute those copied bytes. Only the exact two-file
tree is atomically published as `typescript`; conflicting existing packages are
never replaced. A matching installed two-file package is verified and reused.
The current runtime boundary's require('typescript') resolves its pinned main
from that fixed installed closure, without granting compiler-package scripts
root execution authority.

## Focused fixtures

`verifyFrontendBuildDependencies.cjs` builds small synthetic tgz inputs, including
late malicious members, PAX, hardlinks, traversal, symlink-parent and alias-target
attacks, duplicates, sparse oversized declarations, checksum/inventory mismatch,
low-space and incomplete-stage cases. A real pinned TypeScript library is copied
as bytes for the parser installation fixture; it is not executed by the importer.
The actual snapshot dependency hash and three-member consumer contract are
checked. Corrupt gzip failure is followed by an unrelated fd reuse check.

These tests create their own private Linux filesystem fixtures. They neither
inspect/import the retained production material nor prove production dependency
installation, application acceptance or a deployment.

Current isolated Linux proof:
`outputs/frontend-dependency-import-linux-1788865881774.json`: 24 checks passed
on Node 22.22.1 in 1288 ms, with DynamicUser, PrivateTmp/PrivateNetwork,
read-only copied source and inaccessible production configuration/state paths.
The unit/cgroup was quiescent, the exact isolated fixture was removed, and
copied-source hashes still matched local source afterwards. Production writes,
provider requests and package executions were zero. Targeted Node syntax and
ESLint recommended checks also passed. This proof did not inspect/import the
retained KXCy3C material and did not rerun application or release acceptance.
