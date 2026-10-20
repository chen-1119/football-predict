# Original public reference companion custody (candidate)

This candidate prevents a future finalized public reference from relying only
on a process-local WeakMap when mutable current commits before its warehouse.
It does not recover r903's existing missing originals or authorize a release.

## Commit boundary

1. The original `appendPredictionSnapshots` still admits every retained pair.
   Only an exact original in the private custody store can supplement a missing
   companion for the current record. Its record, feature, model, prediction and
   evidence hashes are verified by the existing validators. The current model
   graph is never used to recreate an old companion.
2. Before any public current write, each bound current reference and its exact
   original companion are serialized into a private pending directory. Both
   files and the directory are synced. One rename commits the directory; its
   parent is then synced. Originals and interrupted pending directories remain.
3. All bound current/history records are checked again before either legacy or
   data-directory public current files can be written. Missing, corrupt or
   conflicting originals abort. No bound record is deleted to make this pass.
   When snapshot retention omits an expired reference and its entry, the exact
   previously durable original is read and fully verified for custody. The
   expired pair is not reinserted into retained warehouse output. A missing,
   corrupt or conflicting durable original still aborts.
   The custody parent directory is synced again before accepting this read,
   completing a possible earlier interruption after rename; sync failure aborts.
4. A later process can read the same original after a current/warehouse split.
   Custody alone grants no public publication, numerical input or win-rate
   eligibility. Other signed source, current identity and publication gates stay
   in place. The original warehouse and generation files are not rolled back.

The store is private under `SERVER_STORE_DIR/public-reference-companions`.
Each original has a fixed hash directory, `pair.json` and `seal.json`. The seal
is an integrity descriptor, not a signature or source attestation. A directory
is never replaced, and there is no cleanup, repair, CLI or production apply
entrypoint. Equal re-observation checks the complete original again. Different
bytes fail; pending directories are never discoverable as committed pairs.

## Bounds and limitations

Pairs have a fixed 32 MiB serialized limit. Complete warehouse import uses the
existing strict whole-file JSON/UTF8/hash/identity scanner and paired archive
builder before any pair is imported. The existing 768 MiB archive, 100000-item,
16 MiB item, file-size and depth bounds remain. Evidence is processed one item
at a time. Invalid trailing input, missing unrelated evidence and changed
source descriptors cannot contribute admitted prefixes.

The synthetic 136+ MiB complete-history test runs in an actual 128 MiB Node
child. It proves bounded custody import; it does **not** prove that the rest of
`syncData` no longer materializes history. That separate memory refactor and
its exact retention/output comparisons remain required before release.

Linux must successfully fsync directories. Windows Node cannot provide this
operation, so Windows results establish process-crash behavior only. Killing a
writer tests interruption, not a physical power cut. Full Linux CI and exact
HEAD review are required. Existing r903 remains unchanged and failed; no
package, grant, deployment, worker control or production recovery is included.
The consumed r903 publication-input-recovery contract keeps its original source
hash. The new sync source fails that old gate; its grant is not expanded.
