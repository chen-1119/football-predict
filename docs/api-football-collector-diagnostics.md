# Supplemental collector diagnostics, separate from frozen decisions

The current-list compactor and stored external summary previously omitted the
API-Football mapping and rejected-fragment diagnostics. A bounded public
projection now carries fixture identity, recorded check time, mapping state and
three feature states (injuries, lineups, provider odds). Raw provider errors,
keys, arbitrary fields and recommendation directions are excluded.

The actual DataAdoptionDetails component adds a separate responsive
“补充源采集记录” section. It distinguishes missing fragments, legacy timestamps,
rejected clocks and recorded local receipts. Provider update clocks remain
explicitly unverified. Missing injury data is not zero injuries. A mapping claim
does not become an independent identity attestation or proof of model adoption.

The panel reads the response's collector record, not the original decision's
evidence. Its data must not backfill the published recommendation, change its
direction, evidence hash, frozen rows or gap totals. It does not inflate accuracy.

## Development and production compatibility

A direct named CJS import rendered successfully in the production bundle but
failed in the real Vite browser. The shared pure implementation is now consumed
through an exact bare alias and explicitly prebundled; TypeScript resolves the
matching declaration. No duplicated browser policy or new dependency was added.
Reference: [Vite dependency optimization](https://vite.dev/config/dep-optimization-options).

## Verified scope

- 24 checks: projection allowlist, strict clocks, re-projection, actual current-list
  compaction, and isolated JSON-store persistence. Added to production readiness.
- 62 adoption checks: actual publisher, pure rules and TSX rendering, including
  immutable frozen evidence when newer collector diagnostics arrive.
- 48 browser checks: actual component and CSS, Chinese/English, complete/missing/
  collector fixtures, closed/keyboard-open, 320/390/768/1440 widths. No runtime
  errors or horizontal overflow. 390/1440 collector screenshots visually checked.
- Current-list privacy contract now tests the actual normalizer: public extras
  survive while private inputUsage is omitted. The replaced spread-name regex
  was already invalid on the pre-change source; privacy was not relaxed.
- 63 full-app browser checks passed at 14:31:12Z: real routes, navigation,
  responsive layout, empty/paired/version-specific review states, and published
  draws surviving a newer private home-win candidate on all three match surfaces.
  These use synthetic HTTP responses, not production data.

Synthetic UI fixtures and JSON-store checks are not end-to-end PostgreSQL/API
proof. Live adoption, live collector coverage and deployment still need verification.
The production build retains the pre-existing missing hero-image warning.
