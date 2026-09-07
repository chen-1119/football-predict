# API-Football alias revalidation and actual coverage diagnosis

## Implemented consistency repair

The existing collector already passed its curated API-Football aliases to
append-only registry ingestion. Current-cycle revalidation, however, compared
only raw match names. A Chinese-only Santos/Palmeiras fixture could be committed
correctly and then be labelled registry-exact without its valid live-current-cycle
qualification. The new actual ingestion-to-revalidation test failed before the
fix. Both stages now use one matchWithTeamAliases helper with the unchanged
API-Football alias table. No new aliases, IDs or historical mappings are invented.

95 API hardening assertions (5 new) and 36 registry assertions pass, plus targeted
ESLint/diff checks. Tests distinguish a new valid response from exact cached
registry identity, reject a genuinely mismatched response hash for live proof,
and preserve reversed-fixture and category conflict rejection. These tests make
zero provider requests. The repair does not relabel cached evidence as newly
fetched, change recommendation authority or loosen entity admission thresholds.

This independent patch is not part of the already signed/running r699.

## Read-only production source diagnosis

At 2026-09-07 11:32Z the existing 10:06Z operational report showed the Free
subscription active and not suspended; the recorded quota was 10/100, remaining
90 at that earlier check, not a new quota query. The fixture access response
allowed 2026-09-06 through 2026-09-08. No provider request was made for this audit.
The cache held 191 provider summaries for September 8, but the last collector
cycle reported zero mapped target matches.

The full current SQLite inventory had 43 matches: Beijing kickoff dates Sep 8
(10), Sep 9 (13), Sep 10 (13), Sep 11 (7). The cached date covers only the first
10. Pure replay at 11:42:05Z paired to unchanged generation
g-6d4efb45bad5c89709876e9d377d9aff73c86db8b36e4f0ceff8f848ae91885b
confirmed missing name/league aliases, not a missing API response, for those 10.
For example Getafe-Celta Vigo and Elche-Real Sociedad share exact kickoff and
league but their Chinese-only target names produce teamScore=0.

An explicitly non-adopting diagnostic replay with the existing historical alias
dictionary produced four candidate scores above 0.9 (Getafe-Celta, Elche-Sociedad,
Vitoria-Gremio, Ulsan-Seoul). These are *proposals*, not verified provider IDs or
four repaired production mappings. The historical dictionary is not automatically
installed as provider identity authority: it contains short names and scope-
specific aliases. Other candidate pairs still lack team or league resolution.
No original names, published match identities, registry or model outputs were
changed. Current-cycle live receipt and full entity/event checks remain necessary.

The separate current-season football-data.co.uk 2627/E0 probe at 11:29:26Z again
returned HTTP503; downloads/imports remained zero. It was a single local isolated
probe, not a production retry loop, purchase or automatic source replacement.

## Remaining Q2 work

Resolve proposed provider-specific names with reviewable league/season/team IDs,
preserve youth/women/reserve distinctions and ambiguous-name rejection, then use
the normal bounded live collector to establish current-cycle evidence. Do not
copy cached responses into a new receipt. Keep out-of-plan dates visibly
unavailable until they enter the provider window or an authorized alternative is
verified. Preserve missing/stale source clocks; this work does not raise measured
prediction accuracy or authorize formal recommendations.

Read-only probes: outputs/read-live-api-football-operational.cjs,
outputs/read-live-current-input-inventory.cjs and
outputs/read-live-fixture-match-diagnostic.cjs. These are bounded current SQLite /
cached-summary audits, not full historical or independent provider reattestations.
