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

### 2026-09-08: isolated SSR verifier compatibility

r702 launched at 03:31 Beijing and failed before swap at 03:49:50. Its candidate
readiness report had 167 checks with one failing check: `match detail lifecycle
artifact`. The queue terminated without retry at 03:50:01; both live markers
remained r699. The app and sync worker were independently verified active.
This is not a successful deployment.

The verifier intentionally uses `configFile:false` to avoid Vite cache writes
inside a read-only candidate. That also omitted the browser alias above. The
original failure reproduced locally as `Cannot find module
'football-collector-diagnostics'`. A direct file externalization attempt then
failed with `require is not defined`; neither failure was treated as a pass.

The verifier now resolves only this exact alias through a virtual ESM bridge
using Node `createRequire` to load the real CJS implementation and dependencies.
It does not duplicate the policy or mock collector output. A new assertion
checks function identity against the native CJS export, a nonempty fixture ID,
and the complete projected output through the actual adoption service. All 24
lifecycle checks pass on Windows Node22.22.1, including actual detail SSR render.
The Vite cache remains under system temp and is realpath-validated before cleanup.
This follows the separation of SSR loading and client builds described in
[Vite SSR documentation](https://vite.dev/guide/ssr.html); production browser
configuration and page rendering logic are unchanged.

Readiness now requires the alias execution check and at least 24 lifecycle
checks. It also records the beginning of an error, not only a truncated stack
tail. Deployment configuration validation passes, and release-verifier contracts
now total 99 passing checks, including rejection of absent, insufficient or
failed alias proof. This repair is not in the frozen r702 package. Linux lifecycle
revalidation, a new signed package and complete guarded release remain pending;
the earlier 49-case Linux capture test is not lifecycle-release proof.

Linux lifecycle revalidation completed at 04:02:19 Beijing on September 8:
24/24 checks passed using the exact f1f1905 sources in an independent directory,
with no stderr. The ordinary ubuntu user received EACCES on a write probe into
the read-only test tree; all 131 source/fixture files retained their original
hashes after the actual Vite/React SSR run. Node22.22.1 used a 512MiB heap limit
and a 90-second child timeout. The production dependency directory was referenced
read-only; no package installation or production write occurred.
The fixture was one copied match, with lifecycle scenarios mutated only in memory;
this does not certify all live match states or a completed deployment.
Private report: `/var/tmp/football-lifecycle-EgispLXe/lifecycle-readonly-report.json`,
SHA `de01d85b02a6c96e53335a99865f853e117a257c1423f11beb809276d0163cae`.
This supersedes only the Linux lifecycle-pending statement above, not the remaining
new-package and guarded-release requirements.

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
