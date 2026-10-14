# Broker installer inventory contract repair

The r868 normal application deployment completed successfully. The first separate
signed broker installer rejected its release boundary before creating any broker
directory, journal directory, unit or install receipt. Signature, exact installer
function hash, all three payload-source hashes and the actual exclusive kernel
flock were independently checked and matched. No installation retry was made.

A separate read-only execution of validation, with every filesystem write and
mutating command blocked, located `RESEARCH_INSTALL_RELEASE`. The normal archive
producer commits the inventory **body**, excluding its own `treeHash` field.
The installer incorrectly hashed the entire inventory, including `treeHash`.
For the actual r868 manifest the normal commitment is
`0da2bf0d972917b1d8c08d21560b726aab309a4e8bbacc80cd59f1102150ebfd`;
hashing the complete inventory gives
`76ed0484b966dbdbc46294e81b76e6ee9b96355e79318b55081d245bedd409e5`.

The repair uses the existing normal archive validator and closes its full source
dependency tree before importing it. Schema, sorted safe paths, complete entry
counts, file/total byte counts, recomputed tree commitment, archive bytes/SHA and
outer signature identity remain mandatory. No signature, source, lock, caller,
capacity or 900-second installation boundary is relaxed.

The regression constructs a genuine gzip/ustar source archive and calls the real
normal archive evidence producer. It executes the actual installer release gate
and canonical-validator call, then rejects tampered source sizes, counts, paths,
commitments, archive size and signing/release identities. The original installer
authority tests remain. Both suites are required before signing and in Linux CI.

The previous worker-1209823 v7 preparation input is retained byte-for-byte as
history. It cannot authorize the new worker incarnation 1242501. Any new package
must use its actual current healthy route or a newly reviewed exact incident.
The failed broker grant is retained and must never be retried. Current r868 code,
database and frozen recommendations are not changed by this candidate.

The temporary 3072 MiB API command-line bootstrap has already been retired by a
separate signed fixed operation. A real cold start with the original 1536 MiB
environment heap passed two health checks, with the worker PID unchanged. The
old bootstrap bytes remain under the ignored `.conf.r868-retired-...` filename.
Cloud network permission, actual broker caller/archive/publisher acceptance and
the offline handover remain separate unfinished gates.
