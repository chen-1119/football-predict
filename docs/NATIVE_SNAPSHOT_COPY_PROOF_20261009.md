# Native snapshot copy proof — 2026-10-09

r823 failed before swap because the materialized prediction history was 819,651,928 bytes, larger than the generic 768 MiB history cache limit. Normal rollback completed to r822. No reviewed prediction was imported.

The old 768/512 MiB rules remain unchanged. For a code-only native release, the exact prediction-history path may instead prove that it is a byte-exact copy of the protected, accepted native generation. The verifier binds release SHA, seed identity, generation manifest, full generation hashes and target bytes. It rejects links, multiple links, altered files, unknown generations and reader-bound violations. Hashing uses 64 KiB buffers and the existing 2 GiB chunked-reader ceiling; it does not parse the whole history into a string. Database release paths and other caches retain the old rules.

Tests include the actually observed file length under a 32 MiB heap, changed bytes/length, multiple links, original limits, and controlled end-to-end proof wiring. The controlled root filesystem facade is not a production Linux test. Actual signed deployment still checks real Linux ownership, file shape, native generation and copy bytes.

This branch includes PR134's reviewed-analysis publication. r823 and its rollback evidence remain preserved; a new signed archive and transaction are required.
