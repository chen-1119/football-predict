"use strict";

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  buildResultOnlyReviewCleanupCandidates,
  iterateMatchSnapshotRows,
  pruneStaleResultOnlyReviews,
  resultOnlyIdentityFromStoredRows,
  reviewFromMatch,
  upsertResultOnlyReviews,
} = require("./postgresProjectionSync.cjs");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const verifyMatchInventory = () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE match_snapshots (
      id TEXT PRIMARY KEY, dataset TEXT NOT NULL, match_id TEXT, source_match_id TEXT,
      kickoff_time TEXT, status TEXT, payload TEXT NOT NULL
    ); CREATE INDEX by_dataset ON match_snapshots(dataset); BEGIN`);
    assert.deepEqual([...iterateMatchSnapshotRows(db)], []); checks += 1;
    const insert = db.prepare("INSERT INTO match_snapshots VALUES(?,?,?,?,?,?,?)");
    const keys = ["excluded:key", "a' OR 1=1 --", "\u{10000}", "\uE000", "中文", "10", "2", ""];
    for (let i = 0; i < 403; i += 1) {
      insert.run(keys[i] ?? `row:${String(403-i).padStart(4,"0")}`,
        i % 5 === 0 ? "excluded" : i % 2 === 0 ? "current" : "history",
        i % 3 ? `match:${i}` : null, `source:${i}`, null, "FINISHED",
        `{ "z": ${i}, "a":2, "nested":{"draw":"平局","home":"主胜"} }`);
    }
    const reference = db.prepare("SELECT id,dataset,match_id,source_match_id,kickoff_time,status,payload FROM match_snapshots WHERE dataset IN ('current','history') ORDER BY id").all();
    for (const size of [1, 2, 17, 199, 200]) {
      assert.deepEqual([...iterateMatchSnapshotRows(db, size)], reference,
        `batch ${size}: every original column, JSON byte, null and binary ID order must match`);
      checks += 1;
    }
    for (const size of [0, -1, 201, 1.5, NaN, "2"]) {
      assert.throws(() => [...iterateMatchSnapshotRows(db, size)]); checks += 1;
    }
    const queries = [];
    const counted = { prepare(sql) {
      const statement = db.prepare(sql);
      return { *iterate(...ids) { queries.push({sql, ids}); yield* statement.iterate(...ids); } };
    } };
    assert.deepEqual([...iterateMatchSnapshotRows(counted)], reference); checks += 1;
    check(!queries[0].sql.includes("payload"), "only IDs enter the inventory sort");
    check(queries.slice(1).every(q => q.ids.length <= 200), "body lookups must remain bounded");
    check(queries.length === 1 + Math.ceil(reference.length/200), "one lookup per bounded batch, no per-row SQL");
    const payloadLookup = queries[1];
    const plan = db.prepare("EXPLAIN QUERY PLAN " + payloadLookup.sql).all(...payloadLookup.ids);
    check(plan.every(row => !row.detail.includes("TEMP B-TREE")), "PK body lookup must not sort complete payloads");
    const interrupted = iterateMatchSnapshotRows(db, 2);
    interrupted.next(); interrupted.return();
    assert.deepEqual([...iterateMatchSnapshotRows(db)], reference); checks += 1;
    const missing = { prepare(sql) {
      if (sql.startsWith("SELECT id FROM")) return db.prepare(sql);
      return { *iterate() {} };
    } };
    assert.throws(() => [...iterateMatchSnapshotRows(missing)], /inventory is incomplete/); checks += 1;
    const failedRead = { prepare(sql) {
      if (sql.startsWith("SELECT id FROM")) return db.prepare(sql);
      throw new Error("fixture required payload read failed");
    } };
    assert.throws(() => [...iterateMatchSnapshotRows(failedRead)], /required payload read failed/); checks += 1;
    for (const [field, value, error] of [["id", "wrong-id", /order changed/], ["dataset", "excluded", /dataset changed/]]) {
      const changedRow = { prepare(sql) {
        const statement = db.prepare(sql);
        if (sql.startsWith("SELECT id FROM")) return statement;
        return { *iterate(...ids) { for (const row of statement.iterate(...ids)) yield { ...row, [field]: value }; } };
      } };
      assert.throws(() => [...iterateMatchSnapshotRows(changedRow)], error); checks += 1;
    }
    insert.run(null, "current", null, null, null, null, "{}");
    assert.throws(() => [...iterateMatchSnapshotRows(db)], /ID must be text/); checks += 1;
    db.exec("ROLLBACK");
  } finally { db.close(); }
};

verifyMatchInventory();

const baseMatch = {
  sourceMatchId: "2040801",
  eventVersion: "2026-08-10T03:30:00+08:00",
  kickoffTime: "2026-08-10T03:30:00+08:00",
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 2,
  resultSource: "sporttery:official-api",
};
const baseObservation = {
  result_identity: "2:2|sporttery:official-api",
  observed_at: "2026-08-10T04:07:04.170Z",
  is_official_final: true,
};
const oldReviewPayload = {
  version: "post-match-review-v2",
  generatedAt: "2026-08-10T04:07:04.170Z",
  matchId: "fivehundred_2040801",
  sourceMatchId: "2040801",
  settlement: { settledAt: "2026-08-10T04:07:04.170Z" },
  predictionReview: { formalBestStatus: null },
};
const canonicalReviewPayload = {
  ...oldReviewPayload,
  generatedAt: "2026-09-01T11:16:32.799Z",
  matchId: "sporttery_2040801",
  eventVersion: "2026-08-09T19:30:00.000Z",
};

const oldProjected = reviewFromMatch({
  ...baseMatch,
  id: "fivehundred_2040801",
  postMatchReview: oldReviewPayload,
}, null, {
  ...baseObservation,
  observation_id: "result:157361fbf550cd4af3998e82c4fcf2f275390de0100ca3328ac48178c01394b8",
});
const canonicalProjected = reviewFromMatch({
  ...baseMatch,
  id: "sporttery_2040801",
  postMatchReview: canonicalReviewPayload,
}, null, {
  ...baseObservation,
  observation_id: "result:3cded2ad7a7acebb8d1a4c62841e0981b9334f91947852881d07ab73fe751d36",
});

check(oldProjected.review_id === canonicalProjected.review_id,
  "result-only review identity must survive fivehundred to sporttery alias rebasing and regeneratedAt changes");
check(canonicalProjected.review_id.startsWith("review:"), "stable result-only review id must be namespaced");
check(canonicalProjected._result_only_identity.sourceMatchId === "2040801",
  "cleanup identity must use the narrow canonical provider id");
check(canonicalProjected._result_only_identity.eventVersion === "2026-08-09T19:30:00.000Z",
  "cleanup identity must normalize the exact event version");

const candidates = buildResultOnlyReviewCleanupCandidates([canonicalProjected]);
check(candidates.some((row) => row.candidate_match_id === "fivehundred_2040801"),
  "active canonical keeper must explicitly cover the former fivehundred alias");
check(candidates.every((row) => row.keeper_review_id === canonicalProjected.review_id),
  "every alias candidate must retain one active keeper");

const formal = {
  ...canonicalProjected,
  review_id: "review:formal",
  decision_id: "decision:locked",
  settlement: "won",
  formal_hit: true,
};
check(buildResultOnlyReviewCleanupCandidates([formal]).length === 0,
  "formal or decision-bound reviews must never enter stale cleanup");

const rescheduled = reviewFromMatch({
  ...baseMatch,
  id: "sporttery_2040801",
  eventVersion: "2026-08-11T03:30:00+08:00",
  kickoffTime: "2026-08-11T03:30:00+08:00",
  postMatchReview: {
    ...canonicalReviewPayload,
    eventVersion: "2026-08-10T19:30:00.000Z",
  },
}, null, {
  ...baseObservation,
  observation_id: "result:rescheduled",
  observed_at: "2026-08-11T04:07:04.170Z",
});
check(buildResultOnlyReviewCleanupCandidates([canonicalProjected, rescheduled]).length === 0,
  "a reused provider id with two active event keepers must fail closed");

const reviewColumns = [
  "review_id", "match_id", "decision_id", "observation_id", "settlement", "formal_hit",
  "review_reason", "adjustment", "settled_at", "payload",
];
const oldObservationId = oldProjected.observation_id;
const keeperObservationId = canonicalProjected.observation_id;

class StatefulReviewClient {
  constructor({ unsafeFormal = false, reviews = null, observations = null } = {}) {
    this.queries = [];
    this.tempCandidates = new Map();
    const defaultObservations = [
      [oldObservationId, {
        observation_id: oldObservationId,
        result_identity: baseObservation.result_identity,
        observed_at: baseObservation.observed_at,
        is_official_final: true,
        payload: JSON.stringify({
          resultProvenance: {
            sourceMatchId: "2040801",
            eventVersion: "2026-08-09T19:30:00.000Z",
          },
        }),
      }],
      [keeperObservationId, {
        observation_id: keeperObservationId,
        result_identity: baseObservation.result_identity,
        observed_at: baseObservation.observed_at,
        is_official_final: true,
        payload: JSON.stringify({
          resultProvenance: {
            sourceMatchId: "2040801",
            eventVersion: "2026-08-09T19:30:00.000Z",
          },
        }),
      }],
    ];
    const defaultReviews = [[oldProjected.review_id, {
      ...oldProjected,
      decision_id: unsafeFormal ? "decision:locked" : null,
      settlement: unsafeFormal ? "won" : "result-only",
      formal_hit: unsafeFormal ? true : null,
    }]];
    this.observations = observations
      ? new Map(observations.map((row) => [row.observation_id, row]))
      : new Map(defaultObservations);
    this.reviews = reviews
      ? new Map(reviews.map((row) => [row.review_id, row]))
      : new Map(defaultReviews);
  }

  resultOnlyIdentity(row) {
    const observation = this.observations.get(row?.observation_id) || {};
    return resultOnlyIdentityFromStoredRows({
      ...row,
      review_payload: row?.payload,
      result_identity: observation.result_identity,
      observed_at: observation.observed_at,
      is_official_final: observation.is_official_final,
      observation_payload: observation.payload,
    });
  }

  strictlyMatchesCandidate(row, candidate) {
    const identity = this.resultOnlyIdentity(row);
    return Boolean(identity)
      && identity.sourceMatchId === candidate.source_match_id
      && identity.eventVersion === candidate.event_version
      && identity.resultIdentity === candidate.result_identity
      && identity.observedAt === candidate.observed_at
      && identity.settledAt === candidate.settled_at;
  }

  async query(sql, values = []) {
    const statement = String(sql);
    this.queries.push({ sql: statement, values });
    if (statement.includes("FROM football.post_match_reviews AS existing_review")) {
      const ids = new Set(values[0]);
      const rows = [...this.reviews.values()].filter((row) => ids.has(row.review_id)).map((row) => {
        const observation = this.observations.get(row.observation_id) || {};
        return {
          review_id: row.review_id,
          match_id: row.match_id,
          decision_id: row.decision_id,
          observation_id: row.observation_id,
          settlement: row.settlement,
          formal_hit: row.formal_hit,
          settled_at: new Date(row.settled_at),
          review_payload: row.payload,
          result_identity: observation.result_identity,
          observed_at: new Date(observation.observed_at),
          is_official_final: observation.is_official_final,
          observation_payload: observation.payload,
        };
      });
      return { rowCount: rows.length, rows };
    }
    if (statement.includes("INSERT INTO active_result_only_reviews_")) {
      const columns = [
        "candidate_match_id", "keeper_review_id", "keeper_match_id", "keeper_observation_id",
        "source_match_id", "event_version", "result_identity", "observed_at", "settled_at",
      ];
      for (let offset = 0; offset < values.length; offset += columns.length) {
        const row = Object.fromEntries(columns.map((column, index) => [column, values[offset + index]]));
        if (!this.tempCandidates.has(row.candidate_match_id)) {
          this.tempCandidates.set(row.candidate_match_id, row);
        }
      }
      return { rowCount: values.length / columns.length, rows: [] };
    }
    if (statement.includes("INSERT INTO football.post_match_reviews")) {
      const rows = [];
      for (let offset = 0; offset < values.length; offset += reviewColumns.length) {
        const row = Object.fromEntries(reviewColumns.map((column, index) => [column, values[offset + index]]));
        this.reviews.set(row.review_id, row);
        rows.push({ review_id: row.review_id });
      }
      return { rowCount: rows.length, rows };
    }
    if (statement.includes("DELETE FROM football.post_match_reviews")) {
      const boundedMatchIds = new Set(values[0] || []);
      const deletedByObservation = new Map();
      for (const row of [...this.reviews.values()]) {
        const candidate = this.tempCandidates.get(row.match_id);
        if (!candidate || !boundedMatchIds.has(candidate.candidate_match_id)) continue;
        const keeper = this.reviews.get(candidate.keeper_review_id);
        const keeperObservation = this.observations.get(candidate.keeper_observation_id);
        const keeperIsSafe = Boolean(keeper)
          && keeper.review_id === candidate.keeper_review_id
          && keeper.match_id === candidate.keeper_match_id
          && keeper.decision_id === null
          && keeper.formal_hit === null
          && keeper.settlement === "result-only"
          && keeper.observation_id === candidate.keeper_observation_id
          && keeperObservation?.is_official_final === true
          && this.strictlyMatchesCandidate(keeper, candidate);
        const staleIsSafe = row.review_id !== candidate.keeper_review_id
          && row.decision_id === null
          && row.formal_hit === null
          && row.settlement === "result-only"
          && this.observations.get(row.observation_id)?.is_official_final === true
          && this.strictlyMatchesCandidate(row, candidate);
        if (!keeperIsSafe || !staleIsSafe) continue;
        this.reviews.delete(row.review_id);
        deletedByObservation.set(
          row.observation_id,
          (deletedByObservation.get(row.observation_id) || 0) + 1,
        );
      }
      const rows = [...deletedByObservation].map(([observation_id, deleted_review_count]) => ({
        observation_id,
        deleted_review_count,
      }));
      return { rowCount: rows.length, rows };
    }
    if (statement.includes("DELETE FROM football.result_observations")) {
      const requested = values[0];
      const keepers = new Set(values[1]);
      const deleted = [];
      for (const observationId of requested) {
        if (keepers.has(observationId)) continue;
        if ([...this.reviews.values()].some((row) => row.observation_id === observationId)) continue;
        if (this.observations.delete(observationId)) deleted.push({ observation_id: observationId });
      }
      return { rowCount: deleted.length, rows: deleted };
    }
    if (statement.includes("CREATE TEMP TABLE") || statement.includes("ANALYZE active_result_only_reviews_")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected stateful SQL: ${statement.slice(0, 120)}`);
  }
}

(async () => {
  const client = new StatefulReviewClient();
  const conflictState = await upsertResultOnlyReviews(client, [canonicalProjected], reviewColumns);
  check(conflictState.rebasedReviews === 1, "stable alias conflict must be recorded as one canonical rebase");
  check(conflictState.staleObservationIds.length === 1
    && conflictState.staleObservationIds[0] === oldObservationId,
  "rebase preflight must capture the old alias observation before ON CONFLICT replaces it");
  const storedKeeper = client.reviews.get(canonicalProjected.review_id);
  check(storedKeeper.match_id === "sporttery_2040801",
    "stateful stable-id conflict must update match_id to the active canonical id");
  check(storedKeeper.observation_id === keeperObservationId,
    "stateful stable-id conflict must bind the canonical official observation");

  const deleted = await pruneStaleResultOnlyReviews(
    client,
    [canonicalProjected],
    conflictState.staleObservationIds,
  );
  check(deleted.reviews === 0, "in-place stable-id rebase must leave no second alias review to delete");
  check(deleted.observations === 1, "rebase must delete exactly the orphaned old alias observation");
  check(client.observations.has(oldObservationId) === false,
    "stateful cleanup must remove the now-unreferenced old alias observation");
  check(client.observations.has(keeperObservationId) === true,
    "stateful cleanup must retain the canonical keeper observation");

  const cleanupSql = client.queries.find((row) => row.sql.includes("DELETE FROM football.post_match_reviews"))?.sql || "";
  for (const required of [
    "active.candidate_match_id = ANY($1::text[])",
    "stale.match_id = ANY($1::text[])",
    "stale.decision_id IS NULL",
    "stale.formal_hit IS NULL",
    "stale.settlement = 'result-only'",
    "stale_observation.is_official_final IS TRUE",
    "keeper_observation.is_official_final IS TRUE",
    "stale_observation.result_identity = active.result_identity",
    "stale_observation.observed_at = active.observed_at",
    "stale.settled_at = active.settled_at",
    "stale_observation.payload->'resultProvenance'->>'eventVersion'",
  ]) {
    check(cleanupSql.includes(required), `cleanup SQL must retain fail-closed guard: ${required}`);
  }
  check(!cleanupSql.includes("stale.match_id <> active.keeper_match_id"),
    "cleanup must include safe same-match legacy ids instead of limiting itself to provider aliases");
  check(cleanupSql.includes("WITH deleted AS (")
    && cleanupSql.includes("COUNT(*)::integer AS deleted_review_count"),
  "bounded DELETE must report both pruned review count and the returned observation ids");
  check(client.queries.some((row) => row.sql.includes("ANALYZE active_result_only_reviews_")),
    "temporary cleanup candidates must be analyzed before bounded indexed deletes");
  check(cleanupSql.includes("COALESCE(") && cleanupSql.includes("stale.payload->>'eventVersion'"),
    "legacy reviews without their own eventVersion must fall back to the bound official observation eventVersion");
  const observationCleanup = client.queries.find((row) => row.sql.includes("DELETE FROM football.result_observations"));
  check(Boolean(observationCleanup), "deleted stale reviews must feed a bounded observation cleanup");
  check(observationCleanup.sql.includes("stale_observation.observation_id = ANY($1::text[])"),
    "observation cleanup must be limited to ids returned by deleted stale reviews");
  check(observationCleanup.sql.includes("NOT (stale_observation.observation_id = ANY($2::text[]))"),
    "observation cleanup must explicitly preserve active keeper observations");
  check(observationCleanup.sql.includes("NOT EXISTS (")
    && observationCleanup.sql.includes("remaining_review.observation_id = stale_observation.observation_id"),
  "an observation still referenced by any review must fail closed");
  check(observationCleanup.values[0].includes(
    "result:157361fbf550cd4af3998e82c4fcf2f275390de0100ca3328ac48178c01394b8",
  ), "the exact online stale alias observation id must be carried from DELETE RETURNING");
  check(observationCleanup.values[1].includes(
    "result:3cded2ad7a7acebb8d1a4c62841e0981b9334f91947852881d07ab73fe751d36",
  ), "the exact online canonical keeper observation id must be protected");
  const upsertSql = client.queries.find((row) => row.sql.includes("INSERT INTO football.post_match_reviews"))?.sql || "";
  check(upsertSql.includes("match_id = EXCLUDED.match_id"),
    "stable-id conflict must explicitly rebase the stored match_id");
  check(upsertSql.includes("football.post_match_reviews.decision_id IS NULL")
    && upsertSql.includes("football.post_match_reviews.formal_hit IS NULL")
    && upsertSql.includes("football.post_match_reviews.settlement = 'result-only'"),
  "ON CONFLICT must retain a second SQL-level formal/locked fail-closed boundary");
  check(upsertSql.includes("EXCLUDED.settled_at >= football.post_match_reviews.settled_at"),
    "ON CONFLICT must retain a second SQL-level monotonic settlement-clock boundary");

  const onlineClockObservationId = "result:565bf07ffb59a5b1aa5dc757c0bd682208b6f93b4a5912da58cbce1897a6f179";
  const onlineExistingAt = "2026-09-01T12:22:13.237Z";
  const onlineIncomingAt = "2026-09-01T13:23:27.288Z";
  const onlineClockMatch = {
    id: "fivehundred_2040351",
    sourceMatchId: "2040351",
    eventVersion: "2026-07-01T02:00:00.000Z",
    kickoffTime: "2026-07-01T02:00:00.000Z",
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultSource: "sporttery:official-api",
  };
  const onlineClockObservation = (observedAt) => ({
    observation_id: onlineClockObservationId,
    result_identity: "2:0|sporttery:official-api",
    observed_at: observedAt,
    is_official_final: true,
    payload: JSON.stringify({
      resultProvenance: {
        sourceMatchId: "2040351",
        eventVersion: "2026-07-01T02:00:00.000Z",
      },
    }),
  });
  const onlineClockReview = (settledAt) => reviewFromMatch({
    ...onlineClockMatch,
    postMatchReview: {
      version: "post-match-review-v2",
      generatedAt: settledAt,
      matchId: onlineClockMatch.id,
      sourceMatchId: onlineClockMatch.sourceMatchId,
      eventVersion: onlineClockMatch.eventVersion,
      settlement: { settledAt, resultObservedAt: settledAt },
      predictionReview: { formalBestStatus: null },
    },
  }, null, onlineClockObservation(settledAt));
  const onlineExistingReview = onlineClockReview(onlineExistingAt);
  const onlineIncomingReview = onlineClockReview(onlineIncomingAt);
  check(onlineExistingReview.review_id
    === "review:00f8755ea8bb8f2d7eb77ca7a527ea8387d176810adb9441eaa68f6d7bb2999c",
  "stateful clock fixture must reproduce the exact online stable review id");
  check(onlineExistingReview.review_id === onlineIncomingReview.review_id
    && onlineExistingReview.match_id === onlineIncomingReview.match_id
    && onlineExistingReview.observation_id === onlineIncomingReview.observation_id,
  "online clock refresh must keep stable review, match, and observation identities unchanged");
  check(onlineExistingReview._result_only_identity.observedAt === onlineExistingAt
    && onlineExistingReview._result_only_identity.settledAt === onlineExistingAt
    && onlineIncomingReview._result_only_identity.observedAt === onlineIncomingAt
    && onlineIncomingReview._result_only_identity.settledAt === onlineIncomingAt,
  "stateful fixture must reproduce the exact existing and incoming online five-field identities");

  const onlineRawClockClient = new StatefulReviewClient({
    reviews: [onlineExistingReview],
    observations: [onlineClockObservation(onlineExistingAt)],
  });
  const onlineRawClockState = await upsertResultOnlyReviews(
    onlineRawClockClient,
    [onlineIncomingReview],
    reviewColumns,
  );
  check(onlineRawClockState.rebasedReviews === 0
    && onlineRawClockState.staleObservationIds.length === 0,
  "exact online two-clock drift must be accepted only as a same-object monotonic refresh");

  // persistSemanticRows upserts observations before review conflict
  // inspection, so also exercise the real transaction-stage joined shape.
  const onlineTransactionClockClient = new StatefulReviewClient({
    reviews: [onlineExistingReview],
    observations: [onlineClockObservation(onlineIncomingAt)],
  });
  const onlineClockState = await upsertResultOnlyReviews(
    onlineTransactionClockClient,
    [onlineIncomingReview],
    reviewColumns,
  );
  check(onlineClockState.rebasedReviews === 0
    && onlineClockState.staleObservationIds.length === 0,
  "same-object monotonic clock refresh must not be counted as an alias rebase or orphan an observation");
  check(onlineTransactionClockClient.reviews.get(onlineIncomingReview.review_id)?.settled_at === onlineIncomingAt,
    "same-object monotonic clock refresh must advance the result-only settlement clock");

  const backwardClockClient = new StatefulReviewClient({
    reviews: [onlineIncomingReview],
    observations: [onlineClockObservation(onlineIncomingAt)],
  });
  await assert.rejects(
    upsertResultOnlyReviews(backwardClockClient, [onlineExistingReview], reviewColumns),
    (error) => error?.code === "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE"
      && error?.reviewId === onlineIncomingReview.review_id
      && error?.existingIdentity?.settledAt === onlineIncomingAt
      && error?.incomingIdentity?.settledAt === onlineExistingAt,
    "a backward result-only ingestion clock must still fail closed with exact conflict evidence",
  );
  checks += 1;
  check(backwardClockClient.queries.every((row) => !row.sql.includes("INSERT INTO football.post_match_reviews")),
    "backward clock rejection must occur before the result-only mutating upsert");

  const changedBindingReview = {
    ...onlineIncomingReview,
    observation_id: "result:unexpected-same-match-binding",
  };
  const changedBindingClient = new StatefulReviewClient({
    reviews: [onlineExistingReview],
    observations: [onlineClockObservation(onlineIncomingAt)],
  });
  await assert.rejects(
    upsertResultOnlyReviews(changedBindingClient, [changedBindingReview], reviewColumns),
    (error) => error?.code === "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",
    "clock refresh must not authorize a different observation binding on the same match",
  );
  checks += 1;

  const aliasClockRefreshReview = {
    ...onlineIncomingReview,
    match_id: "sporttery_2040351",
    observation_id: "result:canonical-clock-refresh",
  };
  const aliasClockClient = new StatefulReviewClient({
    reviews: [onlineExistingReview],
    observations: [onlineClockObservation(onlineExistingAt)],
  });
  await assert.rejects(
    upsertResultOnlyReviews(aliasClockClient, [aliasClockRefreshReview], reviewColumns),
    (error) => error?.code === "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",
    "provider alias rebasing must retain exact five-field identity and cannot use the clock-refresh exception",
  );
  checks += 1;

  const observationRow = ({
    observationId,
    observedAt = baseObservation.observed_at,
    eventVersion = "2026-08-09T19:30:00.000Z",
  }) => ({
    observation_id: observationId,
    result_identity: baseObservation.result_identity,
    observed_at: observedAt,
    is_official_final: true,
    payload: JSON.stringify({
      resultProvenance: { sourceMatchId: "2040801", eventVersion },
    }),
  });

  const legacyCanonicalObservationId = "result:canonical-legacy-generated-at";
  const sameMatchLegacy = {
    ...canonicalProjected,
    review_id: "review:legacy-generated-at",
    observation_id: legacyCanonicalObservationId,
    payload: JSON.stringify({
      ...canonicalReviewPayload,
      generatedAt: "2026-08-10T04:07:04.170Z",
      eventVersion: undefined,
    }),
  };
  check(JSON.parse(sameMatchLegacy.payload).eventVersion === undefined,
    "same-match fixture must reproduce the online legacy review with null/missing eventVersion");
  const sameMatchClient = new StatefulReviewClient({
    reviews: [sameMatchLegacy],
    observations: [
      observationRow({ observationId: legacyCanonicalObservationId }),
      observationRow({ observationId: keeperObservationId }),
    ],
  });
  const sameMatchConflict = await upsertResultOnlyReviews(
    sameMatchClient,
    [canonicalProjected],
    reviewColumns,
  );
  check(sameMatchConflict.rebasedReviews === 0,
    "a different generatedAt legacy review id is not an ON CONFLICT rebase");
  check(sameMatchClient.reviews.size === 2,
    "stateful fixture must reproduce legacy and stable ids coexisting on one canonical match before prune");
  const sameMatchDeleted = await pruneStaleResultOnlyReviews(
    sameMatchClient,
    [canonicalProjected],
    sameMatchConflict.staleObservationIds,
  );
  check(sameMatchDeleted.reviews === 1,
    "strict same-match cleanup must prune the generatedAt legacy review id");
  check(sameMatchDeleted.observations === 1,
    "same-match cleanup must remove the unreferenced non-keeper legacy observation");
  check(sameMatchClient.reviews.size === 1
    && sameMatchClient.reviews.has(canonicalProjected.review_id),
  "after stable insertion and cleanup the canonical event must have exactly one result-only review");
  check(!sameMatchClient.observations.has(legacyCanonicalObservationId)
    && sameMatchClient.observations.has(keeperObservationId),
  "same-match cleanup must delete only the orphaned old observation and retain the keeper observation");

  const clockObservationId = "result:protected-observed-clock";
  const eventObservationId = "result:protected-event-version";
  const protectedFormal = {
    ...sameMatchLegacy,
    review_id: "review:protected-formal",
    decision_id: "decision:protected-formal",
    settlement: "won",
    formal_hit: true,
  };
  const protectedClock = {
    ...sameMatchLegacy,
    review_id: "review:protected-observed-clock",
    observation_id: clockObservationId,
  };
  const protectedEvent = {
    ...sameMatchLegacy,
    review_id: "review:protected-event-version",
    observation_id: eventObservationId,
    payload: JSON.stringify({
      ...canonicalReviewPayload,
      eventVersion: "2026-08-10T19:30:00.000Z",
    }),
  };
  const protectedClient = new StatefulReviewClient({
    reviews: [protectedFormal, protectedClock, protectedEvent],
    observations: [
      observationRow({ observationId: legacyCanonicalObservationId }),
      observationRow({
        observationId: clockObservationId,
        observedAt: "2026-08-10T04:07:05.170Z",
      }),
      observationRow({
        observationId: eventObservationId,
        eventVersion: "2026-08-10T19:30:00.000Z",
      }),
      observationRow({ observationId: keeperObservationId }),
    ],
  });
  await upsertResultOnlyReviews(protectedClient, [canonicalProjected], reviewColumns);
  const protectedDeleted = await pruneStaleResultOnlyReviews(
    protectedClient,
    [canonicalProjected],
  );
  check(protectedDeleted.reviews === 0 && protectedDeleted.observations === 0,
    "formal, observed-clock, and event-version mismatches must all fail closed during pruning");
  for (const protectedReviewId of [
    protectedFormal.review_id,
    protectedClock.review_id,
    protectedEvent.review_id,
  ]) {
    check(protectedClient.reviews.has(protectedReviewId),
      `strict cleanup must retain protected legacy review ${protectedReviewId}`);
  }

  const unsafeClient = new StatefulReviewClient({ unsafeFormal: true });
  await assert.rejects(
    upsertResultOnlyReviews(unsafeClient, [canonicalProjected], reviewColumns),
    (error) => error?.code === "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",
    "a formal or locked stable-id collision must abort the transaction before upsert",
  );
  checks += 1;
  check(unsafeClient.queries.every((row) => !row.sql.includes("INSERT INTO football.post_match_reviews")),
    "unsafe stable-id conflict must never reach the mutating upsert");
  console.log(JSON.stringify({
    ok: true,
    verifier: "postgres-semantic-review-cleanup",
    checks,
    fixture: {
      staleMatchId: "fivehundred_2040801",
      keeperMatchId: "sporttery_2040801",
      eventVersion: "2026-08-09T19:30:00.000Z",
      resultIdentity: "2:2|sporttery:official-api",
    },
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
