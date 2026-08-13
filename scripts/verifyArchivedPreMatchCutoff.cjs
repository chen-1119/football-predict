const assert = require("node:assert/strict");
const {
  buildArchivedPreMatchPrediction,
  validArchivedPreMatchPrediction,
} = require("./syncData.cjs");

const match = {
  id: "sporttery_cutoff-fixture",
  sourceMatchId: "cutoff-fixture",
  status: "PENDING_RESULT",
  kickoffTime: "2026-07-28T01:00:00+08:00",
  eventVersion: "2026-07-28T01:00:00+08:00",
  buyEndTime: "2026-07-27T22:00:00+08:00",
  homeTeamName: "赫根",
  awayTeamName: "索尔纳",
};

const archiveAt = (capturedAt, tipCode) => ({
  version: "archived-pre-match-prediction-v1",
  source: "immutable-pre-match-prediction-snapshot",
  sourceMatchId: "cutoff-fixture",
  matchId: match.id,
  kickoffTime: match.kickoffTime,
  eventVersion: match.eventVersion,
  capturedAt,
  cutoffTime: match.buyEndTime,
  prediction: {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode,
    tipLabel: { zh: tipCode, en: tipCode },
    odds: tipCode === "X" ? 3.4 : 1.76,
  },
});

assert.equal(
  validArchivedPreMatchPrediction(match, archiveAt("2026-07-27T22:01:00+08:00", "1")),
  null,
  "a post-cutoff archive must be rejected even when it was captured before kickoff",
);
assert.equal(
  validArchivedPreMatchPrediction(match, archiveAt("2026-07-27T15:22:00+08:00", "X"))?.prediction?.tipCode,
  "X",
  "a same-event pre-cutoff archive must remain readable",
);

const snapshotIndex = new Map([[
  "cutoff-fixture",
  [
    {
      sourceMatchId: "cutoff-fixture",
      kickoffTime: match.kickoffTime,
      eventVersion: match.eventVersion,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
      capturedAt: "2026-07-27T15:22:00+08:00",
      cutoffTime: match.buyEndTime,
      phase: "locked",
      best: {
        marketType: "BEST",
        oddsPoolCode: "HAD",
        tipCode: "X",
        odds: 3.4,
        recommendationAction: "reference",
      },
    },
    {
      sourceMatchId: "cutoff-fixture",
      kickoffTime: match.kickoffTime,
      eventVersion: match.eventVersion,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
      capturedAt: "2026-07-27T22:01:00+08:00",
      cutoffTime: match.buyEndTime,
      phase: "locked",
      best: {
        marketType: "BEST",
        oddsPoolCode: "HAD",
        tipCode: "1",
        odds: 1.76,
        recommendationAction: "reference",
      },
    },
  ],
]]);

const rebuilt = buildArchivedPreMatchPrediction(
  { ...match, archivedPreMatchPrediction: archiveAt("2026-07-27T22:01:00+08:00", "1") },
  snapshotIndex,
  null,
  "2026-07-28T03:30:00+08:00",
);

assert.equal(rebuilt?.prediction?.tipCode, "X");
assert.equal(rebuilt?.capturedAt, "2026-07-27T15:22:00+08:00");
assert.ok(Date.parse(rebuilt.capturedAt) <= Date.parse(match.buyEndTime));

const frozenAfterCutoffBeforeKickoff = buildArchivedPreMatchPrediction(
  {
    ...match,
    status: "SCHEDULED",
    archivedPreMatchPrediction: undefined,
  },
  snapshotIndex,
  null,
  "2026-07-27T22:30:00+08:00",
);
assert.equal(
  frozenAfterCutoffBeforeKickoff?.prediction?.tipCode,
  "X",
  "a scheduled match must freeze its last valid pre-cutoff direction before kickoff",
);
assert.equal(
  frozenAfterCutoffBeforeKickoff?.capturedAt,
  "2026-07-27T15:22:00+08:00",
  "the early archive must retain the snapshot clock instead of the post-cutoff sync clock",
);

const modelOnlySnapshotIndex = new Map([[
  "cutoff-fixture",
  [{
    sourceMatchId: "cutoff-fixture",
    kickoffTime: match.kickoffTime,
    eventVersion: match.eventVersion,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    capturedAt: "2026-07-27T15:30:00+08:00",
    cutoffTime: match.buyEndTime,
    phase: "locked",
    best: {
      marketType: "BEST",
      tipCode: "1",
      odds: 0,
      recommendationAction: "reference",
      recommendationTier: "cold-start-reference",
    },
  }],
]]);
const modelOnlyArchive = buildArchivedPreMatchPrediction(
  { ...match, archivedPreMatchPrediction: undefined },
  modelOnlySnapshotIndex,
  null,
  "2026-07-28T03:30:00+08:00",
);
const liveModelOnlyArchive = buildArchivedPreMatchPrediction(
  { ...match, status: "LIVE", archivedPreMatchPrediction: undefined },
  modelOnlySnapshotIndex,
  null,
  "2026-07-28T01:15:00+08:00",
);
assert.equal(modelOnlyArchive?.marketEvidenceScope, "model-only-reference");
assert.equal(modelOnlyArchive?.prediction?.oddsPoolCode, "HAD");
assert.equal(modelOnlyArchive?.prediction?.tipCode, "1");
assert.equal(modelOnlyArchive?.prediction?.odds, 0);
assert.equal(modelOnlyArchive?.prediction?.recommendationAction, "reference");
assert.ok(validArchivedPreMatchPrediction(match, modelOnlyArchive));
assert.equal(
  liveModelOnlyArchive?.prediction?.tipCode,
  "1",
  "a live row must freeze the same pre-kickoff reference instead of dropping it",
);
assert.equal(
  validArchivedPreMatchPrediction(match, {
    ...modelOnlyArchive,
    prediction: {
      ...modelOnlyArchive.prediction,
      odds: 1.9,
    },
  }),
  null,
  "a model-only archive must not masquerade as a published SP row",
);
assert.equal(
  validArchivedPreMatchPrediction(match, {
    ...modelOnlyArchive,
    prediction: {
      ...modelOnlyArchive.prediction,
      recommendationAction: "recommend",
    },
  }),
  null,
  "a model-only archive must remain outside the formal recommendation track",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "archived-pre-match-cutoff-v1",
  postCutoffRejected: true,
  rebuiltTipCode: rebuilt.prediction.tipCode,
  rebuiltCapturedAt: rebuilt.capturedAt,
  scheduledAfterCutoffArchived: true,
  modelOnlyReferenceArchived: true,
  liveModelOnlyReferenceArchived: true,
  modelOnlyReferenceFormalPromotionRejected: true,
}, null, 2));
