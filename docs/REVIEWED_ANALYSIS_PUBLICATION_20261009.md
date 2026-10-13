# Reviewed analysis publication — 2026-10-09

User authorization: the already frozen prematch analysis must appear on the live recommendation pages.

This lane publishes human-reviewed HAD directions with their original evidence and confidence. It does not claim learned probabilities, model admission or improved hit rate. The trained league lane and disabled legacy publisher retain their existing rules.

## Current scope

The importer accepts the frozen `weekday-2000-selected-two` research artifact. It verifies exact event, ordered official team IDs, business date, kickoff, current sale status and signed official HAD quote. It preserves the frozen direction and original SP, and records the actual publication quote separately. Both scores must agree with the direction. HHAD and other report kinds are rejected by this first implementation.

The installed Node 22 CLI is `scripts/publishReviewedAnalysis.cjs --check|--publish ABSOLUTE_DRAFT STABLE_CONTENT_HASH`. `--publish` is an explicitly authorized operational step after signed deployment, not an HTTP endpoint. Use the existing service PG environment; never expose it. The key is create-only per business day. An uncertain COMMIT or existing key requires readback, not retry or overwrite.

The freeze and ACK use separate PostgreSQL transactions. The normal publisher projects only a verified original plus committed readback ACK. No forced sync or worker invocation is required. The site shows the reviewed single directions and compatible 2-leg combinations. A missing tier stays empty. Closed records remain identified as frozen; no retrospective import is allowed.

## Verification boundaries

Synthetic signed-source tests exercise identity, clock, price, score, provenance, parser seals and combination arithmetic. The live read-only input replay is evidence of current input compatibility only, not a production write or displayed recommendation. A complete delivery requires the new signed release, actual committed import before each cutoff, normal publisher projection, exact source/dist verification and browser visibility.

The scope does not implement every scheduled report format, automatic learned feature weighting, or a formal calibrated model. Whole-repository lint has prior failures and is not claimed to pass.
