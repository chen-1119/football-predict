# Bounded snapshot history candidate

The normal full sync opts into a cycle-owned private scratch workspace. This
does not import or repair any production archive, and cannot recreate missing
original public evidence. The existing r903 source pin and consumed grants are
unchanged. PR208 remains a draft until the required independent review and
applicable release acceptance are complete.

## Data flow

- The existing strict whole-document JSON/UTF8/identity/hash scanner consumes
  rows, observations, decisions and evidence. A second complete hash-bound pass
  reads the original `updatedAt`. No result is returned from a partial prefix.
- The unchanged history normalizer and merge rules select rows. The merge Map
  contains offsets, hashes and selection keys; each full row is read only while
  its current comparison/update is being processed.
- Retention uses the original first-seen time ordering, invalid-clock zero,
  stable Map insertion order, per-match tail and final global tail. Prospective
  capture ties retain the original observation precedence.
- Retained rows and reference sequences use explicit iterators. The output
  writer emits the same compact JSON bytes. The per-match summary and archive,
  post-match and provisional snapshot indexes read only that match's retained
  rows. Reference pairing validates the entire retained original ledger and
  companion set before computing each original pair, without retaining a full
  Merkle-shard/model graph solely for aggregate counts.
- Scratch items use a same-process V8 codec, with a SHA256 per item. This retains
  undefined keys and insertion order through merges; the unchanged JSON output
  semantics are applied only at the public serializer. This codec is private
  temporary storage, never durable original custody or public authority.
- Normal completion and errors close and remove only this cycle's newly created
  private temporary directory. A killed process may leave private scratch.
  Such scratch has no admission/discovery/import path. Original warehouse,
  custody and interrupted custody `.pending` directories are separate.

## Bounds and evidence

The original 2 GiB source-file, 16 MiB selected-item and depth gates remain.
Private spool bytes are limited to 2 GiB, each scratch item to 16 MiB, metadata
accounting to 32 MiB and each selected array/merge map to 100000 items. These are
fail-closed admission bounds, not a larger production heap or longer timeout.
The separate complete-public-archive importer retains its original 768 MiB and
100000-item gates. Production locks, source/schema/identity checks, publication
order and the 600/900/1050 budgets are unchanged.

The test oracle retains the three original load/retain/append function bodies
from HEAD20bb9a8b6a79d11fa8a9c1b9ba726566593ec9fd, source SHA256
13918572ab46e0bdb3b8a334393b86dd92d41cb4bbf79fe8c8b3f717918ae805.
It compiles those original bodies in the current unchanged helper context.
Tests compare complete compact warehouse bytes and derived public values,
including stable ties, duplicates, retention, prospective revisions, real signed
reference pairs, missing/conflicting companions, incomplete/invalid inputs and
scratch failures. A >256 MiB complete synthetic input runs append, all snapshot
consumers, reference pairing and twice-idempotent serialization in a fixed
128 MiB child, comparing its full output hash to the original algorithm.

This is a bounded algorithm/fixture proof. It is not proof that the original
missing29 companions have been recovered, that production sync has completed,
that all capture deadlines are resolved, or that the model is reliable. No
production archive import, sync trigger or deployment is part of these tests.
