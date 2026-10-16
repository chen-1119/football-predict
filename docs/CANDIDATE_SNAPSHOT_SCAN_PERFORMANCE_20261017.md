# Candidate snapshot lexical scanning

The r888 observation at 2026-10-16 18:25 UTC retained a real candidate capture
timeout after 33,142 ms. The most recent completed capture took 50,761.815 ms;
its public snapshot audit read 1,991,995,134 bytes from a 991,803,263-byte file
to retain 69 observations. These are observations, not a new accuracy result.

The candidate batches formatting whitespace and scalar text through native
scans, and reuses the string delimiter scanner within one read invocation.
Every original byte is still hashed. All skipped JSON grammar, UTF-8, depth,
scalar/key/selected-memory bounds, file identity and expected-hash checks remain.
The existing complete large-file verifier and receipt contract remain mandatory.

A local 48,037,224-byte synthetic ledger produced identical selected values,
hash and parser evidence in 862 ms with the old parser and 485 ms with the
prototype. A 126-case differential check also agreed. This is a local experiment;
it does not prove production speed or eliminate the live timeout. The candidate
adds valid compact/pretty JSON across chunk boundaries and invalid separators
to the actual mandatory verifier. It changes no capture deadline, source quota,
model probability, recommendation, frozen decision or publication eligibility.

Normal review, complete CI, a new signed release and independent live evidence
are required before this performance change can be reported as deployed.
