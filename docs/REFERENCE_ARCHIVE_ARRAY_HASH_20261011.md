# Reference archive array hashing

The installed r844 worker logged `Invalid string length` from the syncData child
at 2026-10-11 10:06:26.990 UTC. The retained worker status reported a failed full
cycle; the current signed quote lane and stored recommendations continued to read.

A bounded read of the unchanged 981,179,206-byte snapshot established 7,169
decisions and 7,169 evidence companions. Their compact array serializations contain
31,467,169 and 535,388,090 UTF-16 code units respectively. Node 22's string limit is
536,870,888: the existing evidence array has only 1,482,798 characters of headroom
for the next append. This is a concrete large-array hazard. The old catch logged
only the error message; it does not prove the unique throwing call site.

The candidate hashes an archive array one original item at a time, retaining the
exact JSON.stringify ordering, commas, null handling and UTF-8 SHA-256 contract.
Archive construction and verification use the same digest. It retains all
companions, record versions, directions, prices, clocks and existing hashes.
It changes no model admission rule or data-size admission bound.

The mandatory public evidence verifier includes native digest parity, index-aware
toJSON, sparse/omitted entries, Unicode, original-length array mutation, invalid
cycles/BigInt and a guard against whole-array serialization. A separate private
synthetic fixture exercises the real Node string limit; it is not production
evidence or model validation.

Deployment and a naturally completed subsequent full cycle are still required
before reporting that production synchronization recovered. The already published
27 manual references and one registered model forecast must retain their original
record hashes and ACKs.
