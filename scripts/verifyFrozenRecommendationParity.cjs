"use strict";

const assert = require("node:assert/strict");
const {
  archiveParityCorrection,
  repairFrozenRecommendationParity,
} = require("./postgresProjectionSync.cjs");

const recommendation = {
  decision_id: "decision:new-hash",
  match_id: "sporttery_parity-test",
  publication_id: "generation-test",
  track: "reference",
  market: "HAD",
  direction: "1",
  odds: 1.72,
  evidence_score: 48,
  frozen_at: "2026-08-20T13:52:16.000Z",
  cutoff_at: "2026-08-20T14:00:00.000Z",
  decision_hash: "b".repeat(64),
  payload: JSON.stringify({
    archivedPreMatchPrediction: {
      recoveryEvidence: {
        version: "published-direction-archive-parity-v1",
        reason: "archived-direction-diverged-from-user-visible-published-direction",
        previous: { market: "HAD", direction: "X", directionIdentity: "HAD:X:0" },
        canonical: { market: "HAD", direction: "1", directionIdentity: "HAD:1:0" },
        proof: { bindingHash: "c".repeat(64) },
      },
    },
  }),
};

assert.deepEqual(archiveParityCorrection(recommendation), {
  previousMarket: "HAD",
  previousDirection: "X",
  canonicalMarket: "HAD",
  canonicalDirection: "1",
});

const signedRecoveryRecommendation = {
  ...recommendation,
  payload: JSON.stringify({
    archivedPreMatchPrediction: {
      recoveryEvidence: {
        version: "archived-pre-match-recovery-v1",
        source: "signed-release-pre-cutoff-snapshot-recovery",
        integritySha256: "d".repeat(64),
        reason: "archived-direction-diverged-from-user-visible-published-direction",
        previous: { market: "HAD", direction: "X" },
        canonical: { market: "HAD", direction: "1" },
      },
    },
  }),
};
assert.deepEqual(
  archiveParityCorrection(signedRecoveryRecommendation),
  archiveParityCorrection(recommendation),
  "an integrity-checked signed recovery must be allowed to repair the one prior frozen direction",
);
const invalidSignedRecovery = structuredClone(signedRecoveryRecommendation);
invalidSignedRecovery.payload = JSON.stringify({
  archivedPreMatchPrediction: {
    recoveryEvidence: {
      ...JSON.parse(signedRecoveryRecommendation.payload).archivedPreMatchPrediction.recoveryEvidence,
      integritySha256: "not-a-hash",
    },
  },
});
assert.equal(
  archiveParityCorrection(invalidSignedRecovery),
  null,
  "an unsigned or malformed recovery must not mutate frozen recommendations",
);

const calls = [];
const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (/SELECT decision_id, match_id, market, direction, decision_hash/.test(sql)) {
      return {
        rows: [{
          decision_id: "decision:existing",
          match_id: recommendation.match_id,
          market: "HAD",
          direction: "X",
          decision_hash: "a".repeat(64),
        }],
      };
    }
    if (/UPDATE football\.frozen_recommendations/.test(sql)) return { rowCount: 1, rows: [] };
    if (/DELETE FROM football\.frozen_recommendations AS duplicate/.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected SQL in parity verifier: ${sql}`);
  },
};

(async () => {
  const corrected = await repairFrozenRecommendationParity(client, [recommendation]);
  assert.equal(corrected, 1);
  assert.equal(recommendation.decision_id, "decision:existing");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].params[3], "1", "the correction must persist the canonical direction");
  assert.equal(calls[1].params[10], "decision:existing", "the existing decision id must remain stable");
  assert.equal(calls[1].params[13], "X", "the guarded update must match the previous direction");
  assert.equal(calls[1].params[14], "a".repeat(64), "the guarded update must match the old hash");
  assert.deepEqual(
    calls[2].params,
    [recommendation.match_id, "decision:existing"],
    "duplicate cleanup must retain the stable corrected decision id",
  );

  const duplicateCalls = [];
  const duplicateClient = {
    async query(sql, params) {
      duplicateCalls.push({ sql, params });
      if (/SELECT decision_id, match_id, market, direction, decision_hash/.test(sql)) {
        return {
          rows: [
            { decision_id: "decision:previous", match_id: recommendation.match_id, market: "HAD", direction: "X", decision_hash: "a".repeat(64) },
            { decision_id: "decision:stale-home-one", match_id: recommendation.match_id, market: "HAD", direction: "1", decision_hash: "e".repeat(64) },
            { decision_id: "decision:stale-home-two", match_id: recommendation.match_id, market: "HAD", direction: "1", decision_hash: "f".repeat(64) },
          ],
        };
      }
      if (/UPDATE football\.frozen_recommendations/.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM football\.frozen_recommendations AS duplicate/.test(sql)) {
        assert.match(sql, /NOT EXISTS/, "duplicate cleanup must fail closed when any stale row has reviews");
        return { rowCount: 2, rows: [] };
      }
      throw new Error(`Unexpected duplicate correction SQL: ${sql}`);
    },
  };
  const duplicateRecommendation = { ...recommendation, decision_id: "decision:dedupe" };
  assert.equal(
    await repairFrozenRecommendationParity(duplicateClient, [duplicateRecommendation]),
    3,
    "one corrected row plus two unreferenced stale rows must produce one frozen decision",
  );
  assert.equal(duplicateRecommendation.decision_id, "decision:previous");

  const ambiguousClient = {
    async query(sql) {
      if (/SELECT decision_id, match_id, market, direction, decision_hash/.test(sql)) {
        return {
          rows: [
            { decision_id: "one", match_id: recommendation.match_id, market: "HAD", direction: "X", decision_hash: "d".repeat(64) },
            { decision_id: "two", match_id: recommendation.match_id, market: "HAD", direction: "X", decision_hash: "e".repeat(64) },
          ],
        };
      }
      throw new Error("ambiguous correction must fail closed before UPDATE");
    },
  };
  const ambiguousRecommendation = { ...recommendation, decision_id: "decision:ambiguous" };
  assert.equal(await repairFrozenRecommendationParity(ambiguousClient, [ambiguousRecommendation]), 0);
  assert.equal(ambiguousRecommendation.decision_id, "decision:ambiguous");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "frozen-recommendation-parity-v1",
    corrected,
    stableDecisionId: true,
    duplicateRowsConsolidated: true,
    ambiguousFailsClosed: true,
  }, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
