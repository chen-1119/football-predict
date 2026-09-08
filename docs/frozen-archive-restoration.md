# Exact restoration of omitted published archives

This complements the fresh-result persistence fix. It does not regenerate old
recommendations and does not assert that an unrecorded historical screen was
correct. It restores exact objects previously present in the published store.

The release-bound manifest `scripts/data/frozen-archive-restoration.json` holds
the complete original 601-entry hash baseline, all 601 original objects, and
the backup/loss observation identities. The original baseline root is
`dd5d5325cfcafb3f704fef96ba25d47c963a345887a24632c07f71efda9bc3fa`.
Its manifest digest is
`6b74c192a0408a3c0b6ccc5aabdd4f017d3523ffbd070027d74037fc1648e913` (v2).
Hashes detect changed contents; release signing, not a self-computed hash, is
the authority for deploying this fixed manifest. No environment or network
source selects the runtime manifest.

The allowlist is exactly the original baseline, not all historical matches or
all newly generated predictions. At the 04:06Z observation, nine of these
originals were missing: 2040407, 2040408, 2040427, 2040459, 2040467, 2040471,
2040475, 2040476 and 2040477. The observed-loss subset is separate from coverage:
if the old worker omits another of the same 601 originals while preparation is
running, the candidate can recover that already verified original without
changing the manifest again. Objects outside the baseline remain excluded.
Restoration requires a missing archive, exact source and
event clocks, matching teams, original baseline membership, and the existing
archive validator's pre-cutoff checks. It is unavailable before the recorded
loss observation. Existing records are not overwritten. Later explicitly
authorized archive correction remains under the established authority layer.

The archive is cloned without changes to its fields or hash. A separate
`predictionMeta.frozenArchiveRestoration` receipt records the restoration,
manifest and original hash. Valid receipts survive subsequent fresh-result
persistence. This does not bind a formal publication, change predictions,
rewrite scores or confer recommendation eligibility.

`verifyFrozenArchiveRestoration.cjs` checks all 601 fixed objects plus
tampering, event/team/cutoff conflicts, temporal boundaries, idempotence,
receipt continuity and non-overwrite behavior. It is wired into the existing
production public-reference integrity verifier. The manifest, implementation
and verifiers are mandatory signed bundle entries.

Local replay using the captured current/history files reconstructed the full
original 601-entry hash baseline after restoring the eight missing objects,
without changing prediction arrays, scores or public-reference decisions.
The capture's external-signals file changed, so this evidence is explicitly
limited to the individually stable match files, not a full-sync rehearsal.
Production restoration is not complete until a new signed release publishes
and live database/API continuity verifies the original objects.

The separate archive-migration verifier now uses fixed synthetic inputs. Its
prior dependence on two rolling historical rows made it expire as data changed.
Existing assertions about snapshot-only recovery, ambiguous event rejection,
model-only references and idempotence are retained. Synthetic migration
fixtures are not production recovery evidence.

## 2026-09-08 v2 evidence and early release checks

r708 was held **before dispatch** after the old production archive count fell
from 593 to 592. Its signed v1 manifest covered only the earlier eight omissions.
It is not modified or dispatched. This v2 candidate replaces repeated expansion
of the observed-loss list with complete, fixed original-baseline coverage.

Both match files in the original stable capture are byte-hash verified, along
with its capture receipt. `matches-current.json` SHA is
`0a683df46b0d593d2e4c3a3d8b0d3de45721e4469b8cbdee0ce3343ecfc0423c`;
the existing history and receipt hashes remain unchanged. Every one of the 601
full original archive objects matches the original baseline hash and passes the
existing archive validator. The generated manifest is 1,697,718 bytes; the
regular-file bound is 4 MiB. The manifest does not contain guessed replacements.

1,215 restoration checks pass, including an omission not present in the initial
loss subset; 17 preflight cases cover original mismatch, missing event, team and
nested cutoff conflicts, official voids, duplicate rows, stale/future clocks,
non-mutation, and the actual serialized read-only probe. The public-reference
integrity verifier still requires full original coverage and no formal creation.

`runReleaseArchivePreflight.cjs` uses the existing explicit SSH host-key pin to
read one stable generation. The collector returns original object hashes and a
bounded match projection retaining all cutoff inputs, not the private ledger or
runtime environment. It locally distinguishes preserved, safely restorable and
blocked originals. `readyToCutover` is always false. A restorable original is
not reported as already restored.

Online bundle callers that set `RELEASE_DEPLOY_KEY` now run this check before
sequence reservation and frontend build. Offline bundle creation makes no live
readiness claim. Every real deploy client rechecks before clone validation and
upload; dry-run performs no live observation. All three helper/test files are
required signed entries. Final signed transaction, immutable archive/ledger,
generation/SQLite/PG, worker-cycle and public/protected checks are unchanged.

At 04:21:26Z, live preflight found 592 preserved and nine safely restorable, with
zero blockers. A separate full-match fetch replayed the actual nine missing rows
through the candidate attach stage: all nine hashes matched, without changing
prediction arrays, scores, status or public-reference objects. This is a local
function-level replay, not complete sync replay or production restoration.

Evidence in the UI worktree: `outputs/complete-archive-coverage-1788840816251.json`,
`outputs/complete-archive-live-preflight-1788841287379.json`, and
`outputs/complete-archive-live-replay-1788841365669.json`. Production remains r699
until a fresh signed release succeeds. General portable phase receipts and the
rest of Q1–Q5 remain open.
