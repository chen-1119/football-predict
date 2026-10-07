# Signed live HAD input and publication latency

## Scope

The recommendation worker already polls every 30 seconds and listens for PG
input changes. Before this change, HAD inputs came from the PG generation or
the audited warehouse copy; the fast signed relay was used only for HHAD.
A fresh relay file therefore did not necessarily refresh the HAD input.

This change reads the same fast snapshot once after SQL input capture and
joins a signed `current` HAD observation to the still-valid prospective model.
It does not force a full sync, change a model timestamp/probability, train a
model, overwrite the parent match, or rewrite an old decision/combo/result.

## Source and identity contract

- Fixed official current endpoint role, exact GET request metadata, successful
  response, canonical payload hash and enabled collector Ed25519 signature.
- The complete signed current payload remains in the receipt. Replay verifies
  the unique event row and the signed HAD market-extraction member.
- The collector signature is not a Sporttery signature or proof that original
  raw HTTP bytes were independently re-fetched.
- Exact source match, kickoff/event, business day, official match number,
  ordered names, and the existing name-derived internal team IDs.
- Explicit `Selling`, sell flag and market sale permission are required.
  A verified `Define`/`OddsIn` observation prevents fallback to an old SP.
- Requested and received clocks must both be within 15 minutes. Explicit
  provider clocks must be valid and no later than acquisition; a repeated
  acquisition does not pretend that the provider changed its price.
- Original cutoff and model age limits remain. Missing, frozen or explicitly
  empty prospective inputs cannot borrow a parent model.
- Source limit 4 MiB / 512 rows; frozen receipt limit 256 KiB. Larger inputs
  are rejected, not truncated into purported signed evidence.

## Publication and replay

`current-input-capture-v2` adds a bounded HAD audit while preserving the exact
V1 frozen-record validator. Audit hashes are diagnostics, not credentials.
Only verified receipts from this transaction join `receiptHashes`. An old PG
generation still requires a verified fresh quote and a separately valid model.
The new source namespace cannot fall back to source-label-only admission.
Both decision replay and forecast-record replay verify the receipt and bind
its digest into the initial HAD input hash.

The publish lane records actual receipt request/receive and decision publication
clocks, including acquisition duration and publication lag. Empty accepted
rows produce null metrics. These describe this immutable decision, not the
first ever publication, a new odds movement, or a new independent match.
The 30-second polling interval is configuration, not measured end-to-end SLA.

Full payload receipts add storage and replay cost. Measure actual receipt bytes
and lane duration before claiming performance at larger match counts.

## Verification and release boundary

The normal signed full factory runs `verifySignedLiveHadPublication.cjs` before
sequence reservation, and requires its implementation and synthetic tests in
the archive. The actual factory routing test includes missing/failing child
cases; original worker/window/archive/UTF8 gates and the 9,429-second full
release budget remain unchanged.

At 11:00 Beijing on October 7, a new pinned read-only production observation
found a recently acquired fast snapshot and older PG quote inputs. Pure replay
of that exact source verified the signature and ordered identity, but all six
business-day targets lacked a selling state. That is a negative source test,
not a deployed successful-publication or measured-latency acceptance.

Meaningful synthetic checks cover fresh quotes with older valid models,
expired source/model clocks, invalid source bytes, identities, sale states,
receipt mutation, null prospective inputs, reserved source labels and V1
frozen compatibility. Local build/tests do not imply production acceptance.

V3 zero-market training and calibrated parameter admission are a separate
stage. This change proves neither market independence nor increased accuracy,
and does not relax selection quality or fabricate two/three-leg combinations.
