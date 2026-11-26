"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  persistSemanticRows,
  reviewFromMatch,
  upsertResultOnlyReviews,
} = require("../scripts/postgresProjectionSync.cjs");
const { buildStreamedPublicReferenceArchive } = require("../server/streamedPublicReferenceArchive.cjs");
const { buildPublicReferenceArchive, SOURCE_ID } = require("../server/publicReferenceArchive.cjs");
const { isFileJsonPayload, fileJsonPayloadChunks } = require("../scripts/postgresFileJsonPayload.cjs");
const { fixture, trust, auditAt } = require("../scripts/verifyPublicReferencePairs.cjs");
const { fetchJsonBounded } = require("../scripts/syncCloudflareSportteryEvidence.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-opt-contracts-"));
let seq = 0;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

after(() => {
  trust.cleanup();
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("upsertResultOnlyReviews skips redundant UPDATE when existing row is byte-identical", async () => {
  const match = {
    id: "sporttery_990001",
    sourceMatchId: "990001",
    eventVersion: "2026-09-01T12:00:00.000Z",
    kickoffTime: "2026-09-01T12:00:00.000Z",
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 1,
    resultSource: "sporttery:official-api",
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: "2026-09-01T14:30:00.000Z",
      matchId: "sporttery_990001",
      sourceMatchId: "990001",
      eventVersion: "2026-09-01T12:00:00.000Z",
      settlement: { settledAt: "2026-09-01T14:30:00.000Z" },
      predictionReview: { formalBestStatus: null },
    },
  };
  const observation = {
    observation_id: "result:unchanged-test",
    result_identity: "1:1|sporttery:official-api",
    observed_at: "2026-09-01T14:30:00.000Z",
    is_official_final: true,
    payload: JSON.stringify({
      resultProvenance: { sourceMatchId: "990001", eventVersion: "2026-09-01T12:00:00.000Z" },
    }),
  };
  const review = reviewFromMatch(match, null, observation);
  const columns = [
    "review_id", "match_id", "decision_id", "observation_id", "settlement", "formal_hit",
    "review_reason", "adjustment", "settled_at", "payload",
  ];
  const queries = [];
  const identicalClient = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes("FROM football.post_match_reviews AS existing_review")) {
        return {
          rowCount: 1,
          rows: [{
            review_id: review.review_id,
            match_id: review.match_id,
            decision_id: null,
            observation_id: review.observation_id,
            settlement: review.settlement,
            formal_hit: null,
            review_reason: review.review_reason,
            adjustment: review.adjustment,
            settled_at: new Date(review.settled_at),
            review_payload: review.payload,
            result_identity: observation.result_identity,
            observed_at: new Date(observation.observed_at),
            is_official_final: true,
            observation_payload: observation.payload,
          }],
        };
      }
      throw new Error("Should not execute INSERT when row is completely unchanged");
    },
  };
  const state = await upsertResultOnlyReviews(identicalClient, [review], columns);
  assert.equal(state.rebasedReviews, 0);
  assert.equal(state.unchangedReviewIds.size, 1);
  assert.equal(queries.length, 1);

  let inserted = 0;
  const changedClient = {
    async query(sql) {
      if (String(sql).includes("FROM football.post_match_reviews AS existing_review")) {
        return {
          rowCount: 1,
          rows: [{
            review_id: review.review_id,
            match_id: review.match_id,
            decision_id: null,
            observation_id: review.observation_id,
            settlement: review.settlement,
            formal_hit: null,
            review_reason: "old reason",
            adjustment: review.adjustment,
            settled_at: new Date(review.settled_at),
            review_payload: review.payload,
            result_identity: observation.result_identity,
            observed_at: new Date(observation.observed_at),
            is_official_final: true,
            observation_payload: observation.payload,
          }],
        };
      }
      if (String(sql).includes("INSERT INTO football.post_match_reviews")) {
        inserted += 1;
        return { rowCount: 1, rows: [{ review_id: review.review_id }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const changedState = await upsertResultOnlyReviews(changedClient, [review], columns);
  assert.equal(changedState.unchangedReviewIds.size, 0);
  assert.equal(inserted, 1);
});

test("persistSemanticRows guards semantic upserts with IS DISTINCT FROM", async () => {
  const executed = [];
  const client = {
    async query(sql) {
      executed.push(String(sql));
      return { rowCount: 1, rows: [] };
    },
  };
  const match = {
    id: "sporttery_990002",
    sourceMatchId: "990002",
    status: "FINISHED",
    kickoffTime: "2026-09-14T12:00:00Z",
    eventVersion: "2026-09-14T12:00:00Z",
    scoreHome: 2,
    scoreAway: 1,
    resultSource: "sporttery:official-api",
    resultObservedAt: "2026-09-14T14:00:00Z",
    postMatchReview: { generatedAt: "2026-09-14T14:01:00Z", predictionReview: { formalBestStatus: null } },
    archivedPreMatchPrediction: {
      capturedAt: "2026-09-14T11:00:00Z",
      cutoffTime: "2026-09-14T12:00:00Z",
      prediction: { tipCode: "1", oddsPoolCode: "HAD", recommendationAction: "reference", odds: 1.95 },
    },
  };
  await persistSemanticRows(client, [{ payload: JSON.stringify(match) }], "g-" + "a".repeat(64));
  const frozenInsert = executed.find((sql) => sql.includes("INSERT INTO football.frozen_recommendations"));
  const obsInsert = executed.find((sql) => sql.includes("INSERT INTO football.result_observations"));
  const reviewInsert = executed.find((sql) => sql.includes("INSERT INTO football.post_match_reviews"));
  assert.match(frozenInsert, /IS DISTINCT FROM/);
  assert.match(obsInsert, /IS DISTINCT FROM/);
  assert.match(reviewInsert, /IS DISTINCT FROM/);
});

test("buildStreamedPublicReferenceArchive uses one streaming pass for both decision and evidence orders", async () => {
  const fixtures = [fixture({ id: "990101" }), fixture({ id: "990102" })];
  const normalObj = {
    updatedAt: auditAt,
    retentionDays: 31,
    rows: [],
    publicReferenceDecisions: fixtures.map((f) => f.record),
    publicReferenceEvidence: fixtures.map((f) => f.entry),
  };
  const reversedObj = {
    updatedAt: auditAt,
    retentionDays: 31,
    publicReferenceEvidence: fixtures.map((f) => f.entry),
    publicReferenceDecisions: fixtures.map((f) => f.record),
    rows: [],
  };
  const expectedArchive = JSON.stringify(buildPublicReferenceArchive(normalObj));

  for (const [label, obj] of [["normal", normalObj], ["reversed", reversedObj]]) {
    const dir = path.join(root, `${label}-${seq++}`);
    fs.mkdirSync(dir);
    const text = JSON.stringify(obj);
    const snapPath = path.join(dir, "prediction-snapshots.json");
    fs.writeFileSync(snapPath, text);
    const ctx = {
      generationDir: dir,
      manifest: { files: [{ path: "prediction-snapshots.json", bytes: Buffer.byteLength(text), sha256: sha(text) }] },
    };
    const origOpen = fs.openSync;
    let snapOpens = 0;
    fs.openSync = function (file, ...args) {
      if (path.resolve(String(file)) === path.resolve(snapPath)) snapOpens += 1;
      return origOpen.call(fs, file, ...args);
    };
    let archive;
    try {
      archive = buildStreamedPublicReferenceArchive(ctx, { tempDir: root, inlineBytes: 0 });
    } finally {
      fs.openSync = origOpen;
    }
    try {
      // 1 open for selected metadata + 1 single streaming pass (down from 3 total opens).
      assert.equal(snapOpens, 2, `${label}: expected 2 total file opens (metadata + 1 streaming pass)`);
      let archiveJson = "";
      for (const row of archive.rows()) {
        if (row.id !== SOURCE_ID) continue;
        if (isFileJsonPayload(row.payload)) {
          for await (const chunk of fileJsonPayloadChunks(row.payload)) archiveJson += chunk;
        } else {
          archiveJson = row.payload;
        }
      }
      assert.equal(archiveJson, expectedArchive, `${label}: exact archive bytes preserved`);
    } finally {
      archive.close();
    }
  }
});

test("fetchJsonBounded surfaces network cause code in error message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    throw Object.assign(new Error("fetch failed"), { cause });
  };
  try {
    await assert.rejects(
      fetchJsonBounded("https://worker.example/api/sporttery-evidence", {}, {
        timeoutMs: 5000,
        maxBytes: 1024,
        label: "Cloudflare evidence pull",
      }),
      /Cloudflare evidence pull failed: fetch failed \(UND_ERR_CONNECT_TIMEOUT: connect timeout\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
