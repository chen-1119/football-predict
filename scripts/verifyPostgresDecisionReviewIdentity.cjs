"use strict";
const assert = require("node:assert/strict");
const { createPostgresPool, runPostgresMigrations } = require("../server/postgresStore.cjs");
const { persistSemanticRows } = require("./postgresProjectionSync.cjs");

async function verify({ legacyPersist } = {}) {
  const url = process.env.REVIEW_TEST_POSTGRES_URL;
  assert.match(new URL(url).pathname, /^\/football_review_test_\d+$/);
  const pool = createPostgresPool({ connectionString: url, max: 1 });
  try {
    await runPostgresMigrations(pool);
    const client = await pool.connect();
    try {
      const match = {
        id: "sporttery_review-test", sourceMatchId: "review-test", status: "FINISHED",
        kickoffTime: "2026-09-14T12:00:00Z", eventVersion: "2026-09-14T12:00:00Z",
        scoreHome: 1, scoreAway: 0, resultSource: "sporttery:official-api",
        resultObservedAt: "2026-09-14T14:00:00Z",
        postMatchReview: { generatedAt: "2026-09-14T14:01:00Z", predictionReview: { formalBestStatus: null } },
        archivedPreMatchPrediction: { capturedAt: "2026-09-14T11:00:00Z", cutoffTime: "2026-09-14T12:00:00Z",
          prediction: { tipCode: "1", oddsPoolCode: "HAD", recommendationAction: "reference", odds: 2.1 } },
      };
      const second = { ...match, archivedPreMatchPrediction: { ...match.archivedPreMatchPrediction,
        capturedAt: "2026-09-14T11:01:00Z" } };
      const rows = value => [{ payload: JSON.stringify(value) }];
      await (legacyPersist || persistSemanticRows)(client, rows(match), null);
      const original = (await client.query("SELECT review_id,decision_id FROM football.post_match_reviews")).rows[0];
      if (legacyPersist) {
        await client.query("BEGIN");
        try { await assert.rejects(legacyPersist(client, rows(second), null), { code: "23505" }); }
        finally { await client.query("ROLLBACK"); }
      }
      await persistSemanticRows(client, rows(second), null);
      await persistSemanticRows(client, rows(second), null);
      await persistSemanticRows(client, rows(match), null);
      const reviews = (await client.query("SELECT review_id,decision_id,formal_hit FROM football.post_match_reviews")).rows;
      assert.equal(reviews.length, 2);
      assert.equal(new Set(reviews.map(r => r.review_id)).size, 2);
      assert.equal(new Set(reviews.map(r => r.decision_id)).size, 2);
      assert(reviews.some(r => r.review_id === original.review_id && r.decision_id === original.decision_id));
      assert(reviews.every(r => r.formal_hit === null));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM football.frozen_recommendations")).rows[0].n, 2);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM football.formal_review_daily")).rows[0].n, 0);
      return { ok: true, legacyCollisionReproduced: Boolean(legacyPersist), repeatedUpsertStable: true,
        originalReviewIdPreserved: true, frozenDecisionsPreserved: 2, formalResultsCreated: 0 };
    } finally { client.release(); }
  } finally { await pool.end(); }
}
module.exports = { verify };
if (require.main === module) verify().then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(e.message); process.exitCode = 1;
});
