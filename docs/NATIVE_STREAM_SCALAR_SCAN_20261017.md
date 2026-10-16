# Strict streaming array scalar scan

The native generation and historical reference readers use `streamJsonObjectArrays` to validate complete JSON while releasing selected array rows after each synchronous callback. Large unselected reference ledgers are still read, hashed, checked for valid UTF-8, and parsed through the full JSON grammar.

This candidate reuses invocation-local native string, scalar, and whitespace scans. Complete scalar properties may bypass the JavaScript token loop only inside unselected nested objects. Selected array items, retained descendants, root fields, containers, and chunk boundaries retain the existing state machine and callback semantics.

All original size, per-item/scalar, nesting, selected-field duplication, UTF-8, complete hash, descriptor/path identity, and callback ordering gates remain. There is no source-validation cache, incomplete prefix acceptance, timeout/heap/cadence change, PostgreSQL policy change, model promotion, or recommendation rewrite.

The offline compact reference-shaped fixture contains 67,915,414 bytes. Three interleaved processes per implementation measured a median 893.354 ms before and 389.662 ms in the prototype, with identical callback values/order, counts, full bytes, and SHA-256. This is a local sample and does not establish production latency or a stable SLA.

Prototype-only verification also passed 1,944 old/new differential checks across 216 inputs and the original 30 admission/archive/startup tests. Candidate-source tests additionally exercise malformed skipped scalars, small chunk boundaries, original memory/depth limits, escape-heavy keys/strings, and a complete file larger than 480 MiB under a 128 MiB V8 heap.

Production r891 has observed both successful natural captures and pointer-wait/child timeout failures. This candidate is not an established remedy for every failure. Its exact HEAD still requires normal local validation, full Linux CI, review, a fresh signed release, the original deployment gates, and independent live acceptance.
