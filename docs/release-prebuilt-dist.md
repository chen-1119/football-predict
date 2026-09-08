# Bounded, stable prebuilt-dist inspection

`scripts/releasePrebuiltDist.cjs` keeps the existing `release-prebuilt-dist-v1` manifest, exported API, CLI commands, file ordering and `treeHash` serialization. Bundle capture, release verification/permission normalization, change classification and frontend build evidence can continue to consume the same manifests. Permission normalization after successful inspection does not change manifest hashes because modes and ownership are stability checks, not new manifest fields.

## Read limits and identity checks

The scanner inventories the complete tree before opening artifact contents. It rejects an individual file or total tree larger than 128 MiB, more than 4,096 files, or more than 4,097 directories. Individual-file size uses the same 128 MiB ceiling as the prior aggregate policy; no lower arbitrary asset limit has been introduced. Empty files remain allowed when the complete tree is nonempty and contains `index.html`.

Each artifact is then hashed using a 64 KiB buffer and one opened descriptor, with no whole-file `readFileSync`. The path must be a regular, singly linked file. `O_NOFOLLOW` is used where the platform provides it; path and descriptor identities are independently checked. Device/inode, type/mode, link count, owner/group, size and nanosecond modification/change timestamps must agree before opening, after opening and after reading. A short read or read error rejects the scan and closes the descriptor.

After all hashing, every file identity is checked again so a previously read file cannot change unnoticed while another is being read. Directory identity and sorted membership are rechecked, including empty directories, and the resolved root path must remain unchanged. Symlink and hardlink rejection is retained. This detects observed drift; it does not replace the caller's requirement to stop writers and protect the staging tree against modifications after the scan returns.

Manifest JSON is also read through the bounded stable-descriptor path, with a 32 MiB input ceiling before any content is opened. JSON parsing still materializes that bounded document; the artifact hashing path does not materialize entire artifact bodies.

## Verification scope

`node scripts/verifyReleasePrebuiltDist.cjs` passed 19 targeted checks under the fixed Node 22 runtime. Tests exercise the actual helper against real temporary files, with isolated filesystem interception to force precise interleavings. Oversized logical/sparse files and aggregate-overflow trees are rejected with zero content opens/reads. Other cases cover unchanged legacy manifest bytes/hash, tampering, symlink/junction and hardlink rejection, maximum read-buffer size, replacement before open and during read, growth/truncation/same-size edits, later modification of an earlier file, directory additions/replacement, short reads, errors and manifest replacement. Opened descriptors close on success and failure.

The existing `verifyReleaseChangeClassification.cjs` caller also passed all 36 checks with the hardened inspector. These were isolated local tests, not a frontend rebuild, deployment, production data read or repeat online acceptance. Windows replacement fixtures use two real renames where replacement of an open destination is disallowed; Linux uses direct rename-over. Both exercise identity drift rejection rather than claim atomic publication authorization.
