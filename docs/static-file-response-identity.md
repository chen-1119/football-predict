# Static response identity during an atomic UI update

`server/index.cjs` now delegates only static-file descriptor handling to `server/staticFileResponse.cjs`. The helper opens the selected path once, obtains metadata from that `FileHandle`, and streams bytes from the same handle. Replacing `dist/index.html` by an atomic rename therefore cannot combine the old file's `Content-Length` with the new file's body. An already-open response completes with its original bytes; a later request opens the replacement.

The stream uses `FileHandle.createReadStream`, not an independently owned raw descriptor. Node can close the owning handle when the stream completes or is destroyed, and the helper's final idempotent `FileHandle.close()` covers setup errors, HEAD requests, and disconnects. This prevents a late close from targeting an unrelated request that reused the same numeric descriptor slot. `pipeline` tears down the read stream and optional gzip transform on read/compression failure or client disconnect.

## Compatibility and boundary

- Existing MIME selection, security/CORS headers, cache policy, gzip threshold and HEAD behavior are retained.
- Static files previously ignored Range/If-None-Match and returned full 200 responses without a file ETag. This change preserves that behavior; API JSON conditional responses are untouched.
- Existing static routing, protected-data authorization decisions, source/dot-path blocking, lexical containment and symlink/junction behavior are unchanged. This is not a symlink-hardening change.
- Failures before headers retain the existing not-found response; failures after response commitment abort the connection. A client already disconnected does not start a new file stream.
- This fixes rename-based replacement, not in-place writes to an already-open inode. UI publication must still prepare a complete file and use atomic rename, retain immutable old assets, and enforce release/source authorization separately.

## Narrow verification

Run `node scripts/verifyStaticFileResponseIdentity.cjs` with the project's fixed Node 22 runtime. The verifier extracts the actual `sendFile` wrapper, MIME/security/cache functions and static route guards from `server/index.cjs`; it does not boot the application or import its data/provider modules. Real HTTP requests use only an ephemeral loopback listener and test-created files.

The 19 checks / 18 isolated fixtures cover larger, smaller, equal-sized and empty original files; same-handle gzip; 16 concurrent requests across a replacement; HEAD; original header/routing policies; permitted directory symlinks/junctions; open/fstat/read/compressor errors; and disconnects during streaming or pending metadata. Every opened FileHandle is checked closed after the response settles. Authentication is an explicitly stubbed fixture decision, not a full application authentication proof.

Windows disallows rename-over an open destination. Its fixture reports `two real renames; not atomic on Windows` and tests pathname/handle identity only. On Linux the exact same verifier uses one atomic rename over the open destination and reports that distinction explicitly. A Linux result must be checked before claiming the production atomic replacement race is proven. No test result alone represents an application deployment or permission to mutate production assets.

The current implementation passed that Linux proof on 2026-09-08 using Node 22.22.1 in a transient DynamicUser service with private loopback networking/temporary storage and read-only copied source. `outputs/static-response-linux-1788859992821.json` records all 19 checks, 18 fixtures, the atomic replacement operation, unchanged source hashes, exited unit/absent cgroup, and removal of the exact isolated source directory. The verifier took 293 ms inside that unit; there were no provider requests or production data writes. This is a narrow implementation proof, not a deployed-release claim.
