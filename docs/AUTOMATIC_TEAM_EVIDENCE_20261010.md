# Automatic evidence collection and reviewed adoption

## Implemented

The normal PostgreSQL worker's slow-enrichment stage invokes `sync:team-evidence` by default. `ENABLE_TEAM_EVIDENCE_SYNC=0` disables only this supplementary job. It uses its own PostgreSQL advisory lock; a second collector skips. Networking runs outside publication transactions.

- Select current Beijing business-day leagues from native current match records; at most 512 matches and 32 source plans.
- Community JSON: previous/current seasons of the 12 supported leagues when present in current matches, once daily. Fetch and verify the actual CC0 license hash before the source files. Changed license, 404, unsupported league or ambiguous score is not silently substituted.
- K League: official standings plus three calendar months of schedules every six hours, default TLS verification, no redirects, 12-second request timeout, bounded streaming, one request at a time with a one-second interval.
- Commit retry intent before networking. Known source failures retry after 30 minutes. Overall networking budget is 120 seconds; remaining plans are deferred. Each source is independent, and a failed request preserves the previous successful head.
- Store bodies by SHA-256 once in the existing `football.private_model_artifacts` table. Store acquisition receipts immutably and maintain separate latest-source/attempt pointers. No schema migration or database copy is introduced. Unknown COMMIT outcomes stop the job and require a read before retry.

The source allowlist and evidence validation are in `teamEvidenceSources.cjs`; PostgreSQL storage is in `teamEvidenceStore.cjs`. Existing broader OpenFootball research receipts remain independent; this addition does not declare them verified or overwrite their records.

## Actual downstream path

`publishReviewedAnalysis.cjs --publish ABS_DRAFT EXPECTED_STABLE_HASH` additionally accepts version 2:

- `reportKind: evidence-backed-prematch`
- `predictionScope: reviewed-online-reference`
- Each single retains the existing exact event, ordered Sporttery team IDs, kickoff, HAD selection, two compatible scores, real analysis URL, reason and original price fields.
- Each single adds 1–4 `evidenceKeys` naming immutable `team-evidence-<SHA256>` observations already committed to PostgreSQL.
- The importer reads and verifies the stored original bytes, source identity and receipt times. The current K League adapter also requires exact ordered provider teams and kickoff to match one official fixture and its standings.
- A single official source is labelled as such. It does not become independently corroborated; confidence must be low, optional facts remain unknown, and no fitted model probability is invented.
- Existing signed official current/HAD identity, sale cutoff, fresh price, immutable original and separate COMMIT/ACK checks remain. Frozen records retain the inputs; public records include a compact adoption hash and source hashes. The browser verifies and displays this evidence status.

The inherited one reviewed publication per business day remains. This feature does not implement recurring multi-version editorial reports, HHAD editorial publication, or automatic selection/re-evaluation. A real reviewed draft must still supply the direction and rationale. Automatic collection cannot impersonate human review.

## Explicit incomplete scope

The automated history path stores research inputs, not new approved parameters. Existing trained-model registration and held-out validation remain separate. New league mappings/calibrated models are not manufactured by this patch. Current event evidence adoption is implemented for the independently identified K League source; other leagues' current facts, injury/lineup/xG/weather providers and second-source corroboration still require adapters.

No old-model fallback is restored. Closed predictions are not changed. Code tests and local official HTTP success do not establish production database commits, a natural installed worker cycle, public recommendation adoption, improved hit rate, or a completed deployment.
