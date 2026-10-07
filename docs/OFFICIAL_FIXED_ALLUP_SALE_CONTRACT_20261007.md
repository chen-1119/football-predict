# Official fixed all-up sale contract

## Confirmed defect and primary evidence

On October 7, a fresh collector-signed `current` response contained six current
business-day events with `matchStatus=Selling`, `sellStatus=1`, HAD
`poolStatus=Selling`, `cbtValue=1`, `cbtAllUp=1`, and `intAllUp=0`.
Five had `cbtSingle=0`; the remaining event had `cbtSingle=1`.
The V1 adapter required every recognized all-up flag to be one, including the
INT flag. It rejected all six and marked the ephemeral input suspended.
That derived `not-on-sale` verdict did not mean the official events were all
suspended.

The official [schedule consumer](https://static.sporttery.cn/res_1_0/jcw/default/jc/szsc/jc_szsc_gz.js)
uses the CBT fields in `getSingleStatus`: `cbtValue` selects the product;
`cbtSingle` selects its single-game indicator; otherwise `cbtAllUp` selects
its all-up indicator. The official
[schedule legend](https://www.sporttery.cn/jc/zqszsc/) identifies these as
single-game and all-up availability. A separate normal browser observation of
the official calculator showed that two events with single-game availability
off could be selected together, with single disabled and 2x1 enabled.
No expansion or separate product meaning of the INT acronym was established.

Primary evidence was acquired after the earlier diagnosis, around
06:50–06:54 UTC. The 06:46 source capture and 06:23 PG input observation are
different acquisition contexts and do not constitute one publisher transaction.

Private proof pins, kept outside Git:

| Evidence | SHA256 |
| --- | --- |
| Official schedule JavaScript | `f2a127de882579e0484c11230d96917bf01b24b79a64de2c36cc81d363e8ce24` |
| Literal `getSingleStatus` span | `74c00192a0c31780e314180ba87ded5ffdbf2ca0d94a696929813eefd9187147` |
| Official schedule HTML | `eb9c91c201fdb8cb1da1a51035e9423be63ed6c19e9f9c479f2c90e7703ee260` |
| Primary-source proof receipt | `9fa03e208dc48bb46227a83a2d982614591b5cc7552845dcbf3696d8baeb9872` |
| Complete signed source snapshot bytes | `df8c282d1be4f63029754a9a05bbe0da582f2b7d0558c6c07a44828ed1364629` |

## Versioned correction

New joins generate `signed-live-had-receipt-v2`. Fixed CBT all-up requires:

- Event `Selling` and its sell flag equal to numeric or string one.
- Exactly one HAD sale pool, with its status `Selling`.
- `cbtValue=1` and `cbtAllUp=1`, numeric or string one.

Missing, zero or malformed CBT permits are rejected. Single-game permission
does not substitute for all-up permission. INT flags and legacy aliases do not
grant or veto the new fixed CBT product. Single-game off does not veto a
separately explicit all-up permission.

The receipt schema, signed source namespace and audit schema are preserved.
Receipt replay dispatches by exact version. V1 retains the original
`saleOpen` function and original AND contract, including previously accepted
legacy alias shapes that lacked `cbtValue`. V2 replays the explicit fixed CBT
contract. New joins have no legacy sale fallback. The quote adapter defaults
to V2 only, so authentic V1 receipts cannot enter a new forecast candidate,
decision or publication. Only the historical decision and forecast-record
validators explicitly enable `allowLegacyReplay:true`; the complete V1
receipt validator remains available to verify the original frozen evidence.
Forecast-record and decision replay recognize both exact receipt versions,
including when a caller changes a source label. Latency reporting recognizes
both versions and ignores unknown versions.

The version and receipt hash are local policy metadata. Collector signatures
bind the full original endpoint payload and extraction members, rather than
cryptographically signing the policy version. The regression proves that the
observed INT-off V2 shape fails the V1 contract after a version-only rehash and
that unsigned payload changes fail signature verification. It does not claim
that every theoretically reconstructed version is separately policy-signed.

## Preserved boundaries and verification

All endpoint role, full payload signature, extraction membership, ordered
event identity, business date, requested/received 15-minute limits, provider
clock validation, receipt/source size limits, cutoffs and model age gates
remain. Frozen parent inputs, probabilities and model timestamps remain
unchanged. `Define`/`OddsIn`, suspended pools, missing CBT fields and closed
all-up permissions stay negative observations.

`tests/fixtures/signed-live-had-v1-frozen.json` contains three synthetic
accepted V1 inputs, decisions and forecast records generated with unchanged
E503 code before this edit. It contains public synthetic keys only, and no
private or production payload. Regression replays these exact frozen objects,
the six newly observed sale-field shapes with synthetic names/signatures,
true sale failures, downgrade/payload tampering and V2 publisher latency.
Authentic synthetic V1 receipts with CBT value zero, false or missing still
verify under their original V1 contract, but each is rejected for a new
candidate. Normal V1 receipts are rejected for new candidates as well.

The correction grants only source-sale admission. It does not make a selected
event a qualified recommendation or guarantee a two/three-leg combination.
Model, selection, correlation and publisher transaction gates remain.
Local regression and build evidence do not establish a live release, natural
worker publication, current recommendation or measured latency. Normal signed
release and fresh online acceptance are still required; the full release
budget remains 9,429 seconds.
