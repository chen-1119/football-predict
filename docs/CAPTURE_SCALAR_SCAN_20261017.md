# Strict compact JSON scanning

The r890 natural preemptive capture observed at 2026-10-16T21:03:40Z completed
in 40180.366 ms with 64 observations. Its public ledger parse consumed
18673.777 ms. That attempt had zero due events; it does not prove a positive
due decision or stable capture latency. The earlier r889 natural capture was
46935.886 ms. Both observations are retained separately.

This candidate recognizes complete scalar properties inside unselected nested
objects with native scanning. It retains the complete JSON grammar, fatal UTF-8
decode, original full hash, file descriptor/path identity, scalar and depth
bounds. A container, selected value or incomplete chunk continues through the
existing state machine. Selected values still use JSON.parse after framing.

The mutable public-observation reader uses 1 MiB buffers, already within the
selected reader's supported bound. It still independently hashes the complete
file before a second full parse/hash pass. There is no trusted prefix, cache,
larger heap, extra timeout, weaker signature or caller-supplied expected hash.

Local validation includes the original ten checks, two additional compact
property grammar/scalar/chunk tests, and the complete 494927962-byte fixture
under a 128 MiB V8 heap. The actual public-observation caller's 96 MiB heap
fixture, malformed histories, missing-file fallback and admission checks pass.
The static receipt profile pins the new twelve-case list and both exact module
hashes; unknown or changed code still executes instead of reusing a receipt.

On the retained 67915414-byte compact-shape fixture, three interleaved process
runs produced median 508.102 ms for r890 and 404.400 ms for this candidate.
Both returned the same rows, SHA256 and 135830828 bytes read. This is a local
repeated-row benchmark, not a production speed guarantee.

Production adoption requires a new reviewed commit, complete CI, normal signed
release and independent checks. r890 must first complete its own natural whole,
fresh full and public TLS acceptance. Original recommendations, quote prices,
scores, ACKs and frozen combinations remain unchanged.
