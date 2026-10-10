# Reviewed daily envelope parsing

## Observed defect

On 2026-10-10 the installed r834 client parser rejected the actual committed
27-record reviewed view with `PRD paper hash exceeds budget`. The canonical
body had 1,047 nodes, depth 5, 27,735 characters and 34,923 UTF-8 bytes. It was
being checked with the single-paper limits of 512 nodes / 16,384 characters.
Successful PostgreSQL publication and component rendering did not prove that
the complete response could pass this earlier client parsing step.

## Change

The reviewed envelope now validates each record, the combo collection and the
header separately under the original single-paper limits. Only its aggregate
hash calculation receives the sum of 34 component budgets (32 records, one
combo collection, one header). Maximum depth remains 8. The canonical JSON and
SHA-256 algorithm are unchanged, as are the 32-record / 3-combo bounds, all
identity, price, handicap, score, signature-content and publication-clock checks.
Other paper, model and evidence hashes keep their original limits.

This is a client read fix. It does not alter any frozen direction, price,
publication or acknowledgement, register parameters, or re-publish recommendations.

## Verification

- 59 targeted tests across reviewed analysis, visible state and paper parsing;
  includes 14/27/32-record views, HAD/HHAD, excessive rows, duplicate events,
  late ACK clocks, oversized individual records/header, depth and hash tampering.
- Actual readonly r834 27-record envelope now parses; altered price still fails.
  Private inputs and replay receipts remain outside Git.
- Source review: bounded aggregate hashing is called only by the reviewed view;
  the exported paper hashing function retains 512 / 16,384.

Local replay is not browser verification. Normal signed release, complete live
acceptance and authenticated desktop/mobile inspection are separate delivery gates.
Full-repository lint has existing failures and is not claimed to pass.
