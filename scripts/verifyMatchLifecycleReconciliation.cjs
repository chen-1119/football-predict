"use strict";

const assert = require("node:assert/strict");
const {
  MATCH_STATUS_PRIORITY,
  PENDING_RESULT_AFTER_MINUTES,
  canonicalSourceMatchId,
  sameEvent,
  isOfficialSportteryFinal,
  isOfficialSportteryVoid,
  resolveMatchLifecycle,
  reconcileMatchLifecycle,
} = require("../src/services/matchLifecycle.cjs");
const {
  matchStoreKey,
  mergeFreshWithExistingStore,
  stripOfficialResultOnlyPredictionContent,
  preserveCanonicalResultOnlyIdentities,
} = require("./syncData.cjs");
const { normalizeObservation, overlayFastObservedFinals, applyFastResultObservation } = require("./fastResultObservations.cjs");
const { validateBundlePayloads } = require("../server/dataGenerationBundle.cjs");

const NOW = "2026-07-13T12:00:00.000Z";
const FUTURE_KICKOFF = "2026-07-13T14:00:00.000Z";
const PAST_KICKOFF = "2026-07-13T09:40:00.000Z";
const OFFICIAL_RESULT_URL = "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result";

const fixture = (overrides = {}) => ({
  id: "sporttery_2041001",
  sourceMatchId: "2041001",
  source: "sporttery",
  sourceMethod: "current",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=current",
  kickoffTime: FUTURE_KICKOFF,
  homeTeamId: "home-a",
  awayTeamId: "away-b",
  status: "SCHEDULED",
  odds: { odds1: 1.92, oddsX: 3.2, odds2: 4.1 },
  oddsSource: "sporttery:HAD",
  handicapOdds: { odds1: 3.1, oddsX: 3.45, odds2: 1.84 },
  handicapLine: "-1",
  predictions: [{ marketType: "1X2", tipCode: "1" }],
  predictionMeta: { lockedAt: "2026-07-13T11:00:00.000Z", strategyVersion: "test-v1" },
  ...overrides,
});

const preMatchSnapshot = (marker, generatedAt) => ({
  odds: { odds1: marker === "new" ? 1.55 : 1.95, oddsX: 3.2, odds2: 4.1, marker },
  predictions: [{ marketType: "BEST", tipCode: marker === "new" ? "2" : "1", marker }],
  predictionMeta: { generatedAt, updatedAt: generatedAt, marker },
  probabilityModel: { generatedAt, marker },
});

const officialFinal = (overrides = {}) => fixture({
  sourceMethod: "result",
  sourceUrl: OFFICIAL_RESULT_URL,
  status: "FINISHED",
  scoreHome: 0,
  scoreAway: 0,
  postMatchReview: { version: "post-match-review-v1", finalScore: "0-0" },
  odds: undefined,
  handicapOdds: undefined,
  predictions: undefined,
  predictionMeta: undefined,
  ...overrides,
});

const officialVoid = (overrides = {}) => fixture({
  status: "PENDING_RESULT",
  resultDisposition: "VOID",
  voidReason: "取消竞猜",
  voidSource: "sporttery:official-api",
  voidObservedAt: "2026-07-13T12:05:00.000Z",
  voidSourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=current",
  voidSourceMethod: "current",
  ...overrides,
});

const terminalReview = ({ revision, generatedAt, rows = [] }) => ({
  version: "post-match-review-v2",
  generatedAt,
  finalScore: "0-0",
  settlement: {
    resultRevision: revision,
    resultObservedAt: "2026-07-13T11:50:00.000Z",
    reviewGeneratedAt: generatedAt,
  },
  predictionReview: { rows },
});

const provisionalResult = (overrides = {}) => ({
  version: "provisional-result-evidence-v1",
  status: "PROVISIONAL_RESULT_OBSERVED",
  provider: "500.com",
  source: "500.com:jczq-result",
  sourceMatchId: "2041001",
  kickoffTime: PAST_KICKOFF,
  eventVersion: PAST_KICKOFF,
  scoreHome: 0,
  scoreAway: 0,
  scoreText: "0:0",
  observedAt: "2026-07-13T11:00:00.000Z",
  firstObservedAt: "2026-07-13T11:00:00.000Z",
  latestObservedAt: "2026-07-13T11:00:00.000Z",
  official: false,
  trusted: false,
  promotionEligible: false,
  statisticsTrack: "shadow-provisional",
  resultRevision: 1,
  ...overrides,
});

const checks = [];
const check = (name, callback) => {
  callback();
  checks.push(name);
};

check("status priority is monotonic", () => {
  assert.ok(MATCH_STATUS_PRIORITY.FINISHED > MATCH_STATUS_PRIORITY.PENDING_RESULT);
  assert.ok(MATCH_STATUS_PRIORITY.PENDING_RESULT > MATCH_STATUS_PRIORITY.LIVE);
  assert.ok(MATCH_STATUS_PRIORITY.LIVE > MATCH_STATUS_PRIORITY.SCHEDULED);
  assert.equal(PENDING_RESULT_AFTER_MINUTES, 130);
});

check("future scheduled fixture is unchanged", () => {
  const resolved = resolveMatchLifecycle(fixture(), { now: NOW });
  assert.equal(resolved.status, "SCHEDULED");
  assert.equal(resolved.sourceStatus, "SCHEDULED");
  assert.equal(resolved.effectiveStatus, "SCHEDULED");
  assert.equal(resolved.statusReason, "source-scheduled");
  assert.equal(resolved.resultProvenance, null);
});

check("newer pre-match snapshot replaces odds and prediction evidence atomically before cutoff", () => {
  const current = fixture({
    buyEndTime: "2026-07-13T13:30:00.000Z",
    oddsObservedAt: "2026-07-13T09:59:00.000Z",
    oddsReceivedAt: "2026-07-13T10:00:00.000Z",
    oddsMarketProvenance: { hash: "old-had-provenance" },
    handicapOddsObservedAt: "2026-07-13T09:59:00.000Z",
    handicapOddsReceivedAt: "2026-07-13T10:00:00.000Z",
    handicapOddsMarketProvenance: { hash: "old-hhad-provenance" },
    ...preMatchSnapshot("old", "2026-07-13T10:00:00.000Z"),
  });
  const incoming = fixture({
    buyEndTime: "2026-07-13T13:30:00.000Z",
    oddsObservedAt: "2026-07-13T10:59:00.000Z",
    oddsReceivedAt: "2026-07-13T11:00:00.000Z",
    oddsMarketProvenance: { hash: "new-had-provenance" },
    handicapOddsObservedAt: "2026-07-13T10:59:00.000Z",
    handicapOddsReceivedAt: "2026-07-13T11:00:00.000Z",
    handicapOddsMarketProvenance: { hash: "new-hhad-provenance" },
    ...preMatchSnapshot("new", "2026-07-13T11:00:00.000Z"),
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.odds.marker, "new");
  assert.equal(merged.predictions[0].marker, "new");
  assert.equal(merged.predictionMeta.marker, "new");
  assert.equal(merged.probabilityModel.marker, "new");
  assert.equal(merged.oddsObservedAt, "2026-07-13T10:59:00.000Z");
  assert.equal(merged.oddsReceivedAt, "2026-07-13T11:00:00.000Z");
  assert.equal(merged.oddsMarketProvenance.hash, "new-had-provenance");
  assert.equal(merged.handicapOddsObservedAt, "2026-07-13T10:59:00.000Z");
  assert.equal(merged.handicapOddsReceivedAt, "2026-07-13T11:00:00.000Z");
  assert.equal(merged.handicapOddsMarketProvenance.hash, "new-hhad-provenance");
});

check("out-of-order older pre-match response cannot roll back an accepted snapshot", () => {
  const older = fixture({
    buyEndTime: "2026-07-13T13:30:00.000Z",
    oddsUpdatedAt: "2026-07-13T11:30:00.000Z",
    ...preMatchSnapshot("old", "2026-07-13T10:00:00.000Z"),
  });
  const newer = fixture({
    buyEndTime: "2026-07-13T13:30:00.000Z",
    oddsUpdatedAt: "2026-07-13T11:00:00.000Z",
    ...preMatchSnapshot("new", "2026-07-13T11:00:00.000Z"),
  });
  const accepted = reconcileMatchLifecycle(older, newer, { now: NOW });
  const merged = reconcileMatchLifecycle(accepted, older, { now: NOW });
  assert.equal(merged.odds.marker, "new");
  assert.equal(merged.predictions[0].marker, "new");
  assert.equal(merged.predictionMeta.marker, "new");
  assert.equal(merged.probabilityModel.marker, "new");
});

check("post-cutoff pre-match response keeps the frozen decision snapshot", () => {
  const current = fixture({
    buyEndTime: "2026-07-13T11:30:00.000Z",
    ...preMatchSnapshot("old", "2026-07-13T10:00:00.000Z"),
  });
  const incoming = fixture({
    buyEndTime: "2026-07-13T11:30:00.000Z",
    ...preMatchSnapshot("new", "2026-07-13T11:45:00.000Z"),
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.odds.marker, "old");
  assert.equal(merged.predictions[0].marker, "old");
  assert.equal(merged.predictionMeta.marker, "old");
  assert.equal(merged.probabilityModel.marker, "old");
});

check("terminal event keeps its frozen pre-match snapshot", () => {
  const terminal = officialFinal({
    ...preMatchSnapshot("old", "2026-07-13T10:00:00.000Z"),
  });
  const incoming = fixture({
    ...preMatchSnapshot("new", "2026-07-13T11:45:00.000Z"),
  });
  const merged = reconcileMatchLifecycle(terminal, incoming, { now: NOW });
  assert.equal(merged.status, "FINISHED");
  assert.equal(merged.odds.marker, "old");
  assert.equal(merged.predictions[0].marker, "old");
  assert.equal(merged.predictionMeta.marker, "old");
  assert.equal(merged.probabilityModel.marker, "old");
});

check("overdue scheduled fixture becomes pending result without inventing a score", () => {
  const overdue = fixture({ kickoffTime: PAST_KICKOFF, odds: undefined, predictions: undefined });
  const resolved = resolveMatchLifecycle(overdue, { now: NOW });
  assert.equal(resolved.sourceStatus, "SCHEDULED");
  assert.equal(resolved.effectiveStatus, "PENDING_RESULT");
  assert.equal(resolved.status, "PENDING_RESULT");
  assert.equal(resolved.statusReason, "kickoff-overdue-awaiting-official-result");
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, "scoreHome"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, "scoreAway"), false);
  assert.equal(resolved.resultProvenance, null);
});

check("started scheduled fixture becomes live before the pending-result threshold", () => {
  const started = fixture({ kickoffTime: "2026-07-13T11:00:00.000Z" });
  const resolved = resolveMatchLifecycle(started, { now: NOW });
  assert.equal(resolved.sourceStatus, "SCHEDULED");
  assert.equal(resolved.effectiveStatus, "LIVE");
  assert.equal(resolved.status, "LIVE");
  assert.equal(resolved.statusReason, "kickoff-passed-awaiting-official-result");
  assert.equal(resolved.resultProvenance, null);
});

check("unattributed result-only row cannot publish predictions or simulated stats", () => {
  const resultOnly = fixture({
    id: "fivehundred_2040536",
    sourceMatchId: "2040536",
    source: "five-hundred",
    sourceMethod: "500-fallback",
    sourceUrl: "https://trade.500.com/jczq/",
    kickoffTime: PAST_KICKOFF,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    oddsSource: "500.com:HAD",
    resultSource: undefined,
    probabilityModel: { version: "fixture-model-v1" },
    projectedScoreHome: 2,
    projectedScoreAway: 1,
    stats: { version: "pre-match-model-estimates-v1", sourceType: "model-estimate" },
    predictions: [{ marketType: "1X2", tipCode: "1" }],
  });
  const sanitized = stripOfficialResultOnlyPredictionContent(resultOnly);
  assert.deepEqual(sanitized.predictions, []);
  assert.equal(sanitized.probabilityModel, undefined);
  assert.equal(sanitized.projectedScoreHome, undefined);
  assert.equal(sanitized.projectedScoreAway, undefined);
  assert.equal(sanitized.stats, undefined);
  assert.equal(sanitized.predictionMeta.lockedReason, "result-only");
});

check("attributed 500 result preserves genuine pre-match prediction evidence", () => {
  const attributed = fixture({
    id: "fivehundred_2040536",
    sourceMatchId: "2040536",
    source: "five-hundred",
    sourceMethod: "500-fallback",
    sourceUrl: "https://trade.500.com/jczq/",
    kickoffTime: PAST_KICKOFF,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    oddsSource: "500.com:HAD",
    resultSource: "500.com:jczq-result",
    probabilityModel: { version: "fixture-model-v1" },
    stats: { version: "pre-match-model-estimates-v1", sourceType: "model-estimate" },
    predictions: [{ marketType: "1X2", tipCode: "1" }],
  });
  const preserved = stripOfficialResultOnlyPredictionContent(attributed);
  assert.equal(preserved.predictions.length, 1);
  assert.equal(preserved.probabilityModel.version, "fixture-model-v1");
});

check("same-event official 0-0 final overrides scheduled and preserves pre-match evidence", () => {
  const current = fixture();
  const result = officialFinal();
  const merged = reconcileMatchLifecycle(current, result, { now: NOW });

  assert.equal(merged.status, "FINISHED");
  assert.equal(merged.sourceStatus, "FINISHED");
  assert.equal(merged.effectiveStatus, "FINISHED");
  assert.equal(merged.scoreHome, 0);
  assert.equal(merged.scoreAway, 0);
  assert.deepEqual(merged.odds, current.odds);
  assert.deepEqual(merged.handicapOdds, current.handicapOdds);
  assert.deepEqual(merged.predictions, current.predictions);
  assert.deepEqual(merged.predictionMeta, current.predictionMeta);
  assert.deepEqual(merged.postMatchReview, result.postMatchReview);
  assert.equal(merged.statusReason, "official-final-overrode-scheduled");
  assert.equal(merged.resultProvenance.provider, "sporttery");
  assert.equal(merged.resultProvenance.official, true);
  assert.equal(merged.resultProvenance.trusted, true);
  assert.equal(merged.resultProvenance.scoreHome, 0);
  assert.equal(merged.resultProvenance.scoreAway, 0);
});

check("out-of-order scheduled row cannot regress a trusted terminal result", () => {
  const resultFirst = officialFinal();
  const staleScheduled = fixture();
  const merged = reconcileMatchLifecycle(resultFirst, staleScheduled, { now: NOW });

  assert.equal(merged.status, "FINISHED");
  assert.equal(merged.scoreHome, 0);
  assert.equal(merged.scoreAway, 0);
  assert.deepEqual(merged.odds, staleScheduled.odds);
  assert.deepEqual(merged.predictions, staleScheduled.predictions);
  assert.deepEqual(merged.postMatchReview, resultFirst.postMatchReview);
  assert.equal(merged.statusReason, "terminal-final-preserved");
});

check("same-score terminal review revisions are monotonic in both arrival orders", () => {
  const older = officialFinal({
    postMatchReview: terminalReview({
      revision: 1,
      generatedAt: "2026-07-13T11:51:00.000Z",
      rows: [],
    }),
  });
  const newer = officialFinal({
    postMatchReview: terminalReview({
      revision: 2,
      generatedAt: "2026-07-13T11:52:00.000Z",
      rows: [{ tipCode: "1", resultStatus: "WON" }],
    }),
  });

  const newerThenOlder = reconcileMatchLifecycle(newer, older, { now: NOW });
  const olderThenNewer = reconcileMatchLifecycle(older, newer, { now: NOW });
  for (const merged of [newerThenOlder, olderThenNewer]) {
    assert.equal(merged.postMatchReview.settlement.resultRevision, 2);
    assert.equal(merged.postMatchReview.predictionReview.rows.length, 1);
  }
});

check("same-revision terminal review generation time is monotonic in both arrival orders", () => {
  const older = officialFinal({
    postMatchReview: terminalReview({
      revision: 2,
      generatedAt: "2026-07-13T11:52:00.000Z",
      rows: [],
    }),
  });
  const newer = officialFinal({
    postMatchReview: terminalReview({
      revision: 2,
      generatedAt: "2026-07-13T11:53:00.000Z",
      rows: [{ tipCode: "1", resultStatus: "WON" }],
    }),
  });

  const newerThenOlder = reconcileMatchLifecycle(newer, older, { now: NOW });
  const olderThenNewer = reconcileMatchLifecycle(older, newer, { now: NOW });
  for (const merged of [newerThenOlder, olderThenNewer]) {
    assert.equal(merged.postMatchReview.generatedAt, "2026-07-13T11:53:00.000Z");
    assert.equal(merged.postMatchReview.predictionReview.rows.length, 1);
  }
});

check("timezone-equivalent scheduled row cannot regress a trusted terminal result", () => {
  const utcKickoff = "2026-07-13T02:00:00.000Z";
  const offsetKickoff = "2026-07-13T10:00:00+08:00";
  const resultFirst = officialFinal({ kickoffTime: utcKickoff, eventVersion: utcKickoff });
  const staleScheduled = fixture({ kickoffTime: offsetKickoff, eventVersion: offsetKickoff });

  assert.equal(sameEvent(resultFirst, staleScheduled), true);
  const merged = reconcileMatchLifecycle(resultFirst, staleScheduled, { now: NOW });
  assert.equal(merged.status, "FINISHED");
  assert.equal(merged.scoreHome, 0);
  assert.equal(merged.scoreAway, 0);
  assert.deepEqual(merged.postMatchReview, resultFirst.postMatchReview);
  assert.equal(merged.statusReason, "terminal-final-preserved");
});

check("opaque event versions are normalized without merging different revisions", () => {
  const normalizedLeft = fixture({ eventVersion: " Fixture   Revision A " });
  const normalizedRight = fixture({ eventVersion: "fixture revision a" });
  const differentRevision = fixture({ eventVersion: "fixture revision b" });

  assert.equal(sameEvent(normalizedLeft, normalizedRight), true);
  assert.equal(sameEvent(normalizedLeft, differentRevision), false);
});

check("legacy fivehundred id and explicit sourceMatchId share one canonical event key", () => {
  const legacy = fixture({
    id: "fivehundred_2040499",
    sourceMatchId: undefined,
  });
  const explicit = fixture({
    id: "fivehundred_2040499",
    sourceMatchId: "2040499",
  });

  assert.equal(canonicalSourceMatchId(legacy.id), "2040499");
  assert.equal(matchStoreKey(legacy), "2040499");
  assert.equal(matchStoreKey(explicit), "2040499");
  assert.equal(sameEvent(legacy, explicit), true);

  const fastObservation = normalizeObservation({
    id: legacy.id,
    eventVersion: FUTURE_KICKOFF,
    kickoffTime: FUTURE_KICKOFF,
    scoreHome: 2,
    scoreAway: 1,
    resultObservedAt: "2026-07-13T16:00:00.000Z",
    observationSource: "sporttery-direct-response-received-at",
    settledAt: "2026-07-13T16:00:01.000Z",
    publishedAt: "2026-07-13T16:00:02.000Z",
    sourceCycleId: "legacy-identity-regression",
    datasetRevision: "revision-1",
  });
  assert.equal(fastObservation?.sourceMatchId, "2040499");
});

check("legacy fallback identity merges upstream without losing official terminal evidence", () => {
  const legacyTerminal = officialFinal({
    id: "fivehundred_2040499",
    sourceMatchId: undefined,
    scoreHome: 2,
    scoreAway: 1,
  });
  const freshFallback = fixture({
    id: "fivehundred_2040499",
    sourceMatchId: "2040499",
    source: "five-hundred",
    sourceMethod: "500-fallback",
    sourceUrl: "https://trade.500.com/jczq/",
    oddsSource: "500.com:HAD",
  });

  const merged = mergeFreshWithExistingStore([legacyTerminal], [freshFallback]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "fivehundred_2040499");
  assert.equal(merged[0].sourceMatchId, "2040499");
  assert.equal(merged[0].source, "sporttery");
  assert.equal(merged[0].status, "FINISHED");
  assert.equal(merged[0].scoreHome, 2);
  assert.equal(merged[0].scoreAway, 1);
  assert.equal(merged[0].resultProvenance?.provider, "sporttery");
  assert.equal(merged[0].oddsSource, "sporttery:HAD");

  const payloadsFor = (history) => new Map([
    ["matches-current.json", []],
    ["matches-history.json", history],
    ["sync-meta.json", {
      sourceCycleId: "legacy-identity-regression",
      updatedAt: NOW,
      files: { current: 0, history: history.length, predictionSnapshots: 0 },
    }],
    ["external-signals.json", {}],
    ["odds-history.json", { rows: [] }],
    ["prediction-snapshots.json", { rows: [] }],
    ["model-calibration.json", { version: "identity-regression-v1", generatedAt: NOW }],
  ]);

  assert.throws(
    () => validateBundlePayloads({
      payloads: payloadsFor([legacyTerminal, freshFallback]),
      sourceCycleId: "legacy-identity-regression",
    }),
    (error) => error?.code === "GENERATION_SEMANTIC_INVALID"
      && /duplicate id fivehundred_2040499/.test(error.message),
  );
  const validated = validateBundlePayloads({
    payloads: payloadsFor(merged),
    sourceCycleId: "legacy-identity-regression",
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.historyRows, 1);
});

check("same id with a changed kickoff rejects the old final", () => {
  const rescheduled = fixture({
    kickoffTime: "2026-07-14T14:00:00.000Z",
    eventVersion: "2026-07-14T14:00:00.000Z",
  });
  const oldResult = officialFinal({
    kickoffTime: FUTURE_KICKOFF,
    eventVersion: FUTURE_KICKOFF,
    scoreHome: 2,
    scoreAway: 1,
  });

  assert.equal(sameEvent(rescheduled, oldResult), false);
  const merged = reconcileMatchLifecycle(rescheduled, oldResult, { now: NOW });
  assert.equal(merged.status, "SCHEDULED");
  assert.equal(merged.statusReason, "incoming-event-mismatch-kept-current");
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreHome"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "postMatchReview"), false);
  assert.equal(merged.resultProvenance, null);
});

check("explicit event version mismatch rejects a result even when kickoff is equal", () => {
  const current = fixture({ eventVersion: "fixture-revision-2" });
  const staleResult = officialFinal({ eventVersion: "fixture-revision-1", scoreHome: 3, scoreAway: 0 });
  assert.equal(sameEvent(current, staleResult), false);
  const merged = reconcileMatchLifecycle(current, staleResult, { now: NOW });
  assert.equal(merged.status, "SCHEDULED");
  assert.equal(merged.resultProvenance, null);
});

check("same-event provisional result survives a refresh that omits shadow evidence", () => {
  const current = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult(),
  });
  const incoming = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "SCHEDULED",
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.status, "PENDING_RESULT");
  assert.equal(merged.provisionalResult.scoreText, "0:0");
  assert.equal(merged.provisionalResult.resultRevision, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreHome"), false);
  assert.equal(merged.resultProvenance, null);
});

check("newer same-event provisional revision replaces an older observation monotonically", () => {
  const current = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult(),
  });
  const incoming = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult({
      scoreHome: 1,
      scoreText: "1:0",
      observedAt: "2026-07-13T11:10:00.000Z",
      latestObservedAt: "2026-07-13T11:10:00.000Z",
      resultRevision: 2,
    }),
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.provisionalResult.scoreText, "1:0");
  assert.equal(merged.provisionalResult.resultRevision, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreHome"), false);
});

check("malformed or different-event provisional evidence cannot replace a valid shadow result", () => {
  const current = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult(),
  });
  const incoming = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult({
      sourceMatchId: "different-event",
      scoreHome: -1,
      resultRevision: 99,
    }),
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.provisionalResult.scoreText, "0:0");
  assert.equal(merged.provisionalResult.resultRevision, 1);
});

check("trusted official final clears provisional shadow evidence", () => {
  const current = fixture({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    status: "PENDING_RESULT",
    provisionalResult: provisionalResult(),
  });
  const incoming = officialFinal({
    kickoffTime: PAST_KICKOFF,
    eventVersion: PAST_KICKOFF,
    scoreHome: 2,
    scoreAway: 0,
  });
  const merged = reconcileMatchLifecycle(current, incoming, { now: NOW });
  assert.equal(merged.status, "FINISHED");
  assert.equal(merged.scoreHome, 2);
  assert.equal(merged.scoreAway, 0);
  assert.equal(merged.provisionalResult, undefined);
});

check("non-official final cannot close a fixture or smuggle a score", () => {
  const current = fixture();
  const untrusted = officialFinal({
    source: "sporttery",
    sourceUrl: "https://example.invalid/copied-result",
    resultSource: "community-tip",
    scoreHome: 4,
    scoreAway: 0,
  });

  assert.equal(isOfficialSportteryFinal(untrusted), false);
  const standalone = resolveMatchLifecycle(untrusted, { now: NOW });
  assert.equal(standalone.status, "SCHEDULED");
  assert.equal(Object.prototype.hasOwnProperty.call(standalone, "scoreHome"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(standalone, "postMatchReview"), false);
  const merged = reconcileMatchLifecycle(current, untrusted, { now: NOW });
  assert.equal(merged.status, "SCHEDULED");
  assert.equal(merged.sourceStatus, "SCHEDULED");
  assert.equal(merged.statusReason, "untrusted-final-rejected");
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreHome"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreAway"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "postMatchReview"), false);
  assert.equal(merged.resultProvenance, null);
});

check("official row without both scores cannot close an overdue fixture", () => {
  const current = fixture({ kickoffTime: PAST_KICKOFF, odds: undefined, predictions: undefined });
  const incomplete = officialFinal({
    kickoffTime: PAST_KICKOFF,
    scoreHome: 1,
    scoreAway: undefined,
    postMatchReview: undefined,
  });

  assert.equal(isOfficialSportteryFinal(incomplete), false);
  const merged = reconcileMatchLifecycle(current, incomplete, { now: NOW });
  assert.equal(merged.status, "PENDING_RESULT");
  assert.equal(merged.sourceStatus, "SCHEDULED");
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreHome"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "scoreAway"), false);
  assert.equal(merged.resultProvenance, null);
});

check("score alone on a non-final official row does not upgrade status", () => {
  const current = fixture();
  const premature = officialFinal({ status: "SCHEDULED", scoreHome: 1, scoreAway: 0 });
  assert.equal(isOfficialSportteryFinal(premature), false);
  const merged = reconcileMatchLifecycle(current, premature, { now: NOW });
  assert.equal(merged.status, "SCHEDULED");
  assert.equal(merged.resultProvenance, null);
});

check("official void is terminal against stale scheduled and live snapshots", () => {
  const voided = officialVoid();
  assert.equal(isOfficialSportteryVoid(voided), true);
  const resolved = resolveMatchLifecycle(voided, { now: NOW });
  assert.equal(resolved.status, "PENDING_RESULT");
  assert.equal(resolved.statusReason, "official-sporttery-void");

  const staleScheduled = fixture({ status: "SCHEDULED" });
  const staleLive = fixture({ status: "LIVE" });
  for (const stale of [staleScheduled, staleLive]) {
    const merged = reconcileMatchLifecycle(voided, stale, { now: NOW });
    assert.equal(merged.resultDisposition, "VOID");
    assert.equal(merged.voidReason, "取消竞猜");
    assert.equal(merged.status, "PENDING_RESULT");
    assert.equal(merged.resultProvenance, null);
  }
});

check("new official void is promoted but a later official final supersedes it", () => {
  const promoted = reconcileMatchLifecycle(fixture(), officialVoid(), { now: NOW });
  assert.equal(promoted.resultDisposition, "VOID");
  assert.equal(promoted.statusReason, "official-void-promoted");

  const final = reconcileMatchLifecycle(promoted, officialFinal({ scoreHome: 2, scoreAway: 1 }), { now: NOW });
  assert.equal(final.status, "FINISHED");
  assert.equal(final.scoreHome, 2);
  assert.equal(final.scoreAway, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(final, "resultDisposition"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(final, "voidReason"), false);
});

// Minimal projection of the 2026-10-13 same-RR receipt/history incident. The
// blocked metadata is intentional: a post-cutoff model attempt is not a frozen
// recommendation and must be retained, never silently erased by reconciliation.
const canonicalResultOnlyFixture = () => {
  const observed = "2026-10-13T01:18:18.385Z";
  const event = "2026-10-12T18:45:00.000Z";
  const raw = {
    id: "fivehundred_2041926", sourceMatchId: "2041926", source: "five-hundred",
    status: "FINISHED", effectiveStatus: "FINISHED", eventVersion: event, kickoffTime: event,
    homeTeamId: "team_70x0db", awayTeamId: "team_1p04q0t", homeTeamName: "第戎", awayTeamName: "梅斯",
    scoreHome: 4, scoreAway: 2, resultSource: "sporttery:official-api",
    resultObservedAt: observed, settledAt: observed,
    odds: { odds1: 2.7, oddsX: 3.3, odds2: 2.2 }, oddsSource: "500.com:HAD",
    handicapLine: "+1", handicapOddsSource: "500.com:HHAD", predictions: [],
    resultProvenance: { provider: "sporttery", official: true, trusted: true,
      source: "sporttery:official-api", sourceMatchId: "2041926", eventVersion: event,
      kickoffTime: event, scoreHome: 4, scoreAway: 2, observedAt: observed,
      resultObservationFallback: false, promotionEligible: true },
    predictionMeta: { decisionId: "decision_1tmft1v", lockedReason: "model-after-cutoff",
      modelGeneratedAt: "2026-10-13T03:44:03.776Z", publicationGate: {
        version: "prediction-publication-cutoff-gate-v1", status: "blocked",
        reasonCode: "model-after-cutoff", trustedExistingPreCutoffDecision: false,
      } },
    postMatchReview: { matchId: "fivehundred_2041926", sourceMatchId: "2041926", eventVersion: event,
      teams: { home: "第戎", away: "梅斯" }, finalScore: "4-2", generatedAt: observed,
      settlement: { publicationId: null, publicationVerified: false, settledAt: observed, resultObservedAt: observed },
      predictionReview: { rows: [], settled: 0, won: 0, mainSettled: 0, mainWon: 0,
        allSettled: 0, allWon: 0, referenceSettled: 0, referenceWon: 0, liveSettled: 0, liveWon: 0,
        bestStatus: null, formalBestStatus: null, liveBestStatus: null, referenceBestStatus: null,
        archivedBestStatus: null, oneXTwoStatus: null } },
  };
  const witness = structuredClone(raw);
  witness.id = "sporttery_2041926";
  witness.postMatchReview.matchId = witness.id;
  witness.predictionMeta.decisionId = "decision_1kwqs77";
  witness.predictionMeta.lockedReason = "cutoff";
  witness.predictionMeta.modelGeneratedAt = null;
  witness.predictionMeta.publicationGate.reasonCode = "cutoff";
  const receipt = { version: "sqlite-fast-result-receipt-v2", observations: [{
    sourceMatchId: "2041926", eventVersion: event, kickoffTime: event, scoreHome: 4, scoreAway: 2,
    resultObservedAt: observed, settledAt: observed, publishedAt: "2026-10-13T01:19:38.473Z",
    observationSource: "sporttery-relay-endpoint-received-at", resultObservationFallback: false,
    sourceCycleId: "sporttery-relay:20261013T011817455Z", datasetRevision: "sqlite-fast-result-r9487",
  }] };
  return { raw, witness, receipt };
};

check("verified canonical result-only identity survives 500 display odds without changing payloads", () => {
  const { raw, witness, receipt } = canonicalResultOnlyFixture();
  const before = structuredClone(raw);
  const [result] = preserveCanonicalResultOnlyIdentities([raw], receipt, [witness]);
  assert.equal(result.id, witness.id);
  assert.equal(result.postMatchReview.matchId, witness.id);
  assert.deepEqual(result, { ...before, id: witness.id,
    postMatchReview: { ...before.postMatchReview, matchId: witness.id } });
  assert.deepEqual(raw, before);
  assert.equal(preserveCanonicalResultOnlyIdentities([result], receipt, [witness])[0], result);
});

check("full-sync overlay may supply canonical review before the review builder", () => {
  const { raw, witness, receipt } = canonicalResultOnlyFixture();
  delete raw.postMatchReview;
  const overlaid = overlayFastObservedFinals([raw], [witness], receipt.observations)
    .map((match) => applyFastResultObservation(match, receipt.observations));
  assert.equal(overlaid[0].id, raw.id);
  assert.equal(overlaid[0].postMatchReview.matchId, witness.id);
  const [result] = preserveCanonicalResultOnlyIdentities(overlaid, receipt, [witness]);
  assert.equal(result.id, witness.id);
  assert.deepEqual(result, { ...overlaid[0], id: witness.id,
    postMatchReview: { ...overlaid[0].postMatchReview, matchId: witness.id } });
});

for (const [name, change] of [
  ["missing receipt", (f) => { f.receipt = null; }],
  ["missing witness", (f) => { f.finals = []; }],
  ["duplicate witness", (f) => { f.finals.push(structuredClone(f.witness)); }],
  ["noncanonical witness", (f) => { f.witness.id = f.raw.id; f.witness.postMatchReview.matchId = f.raw.id; }],
  ["changed source ID", (f) => { f.witness.sourceMatchId = "2041927"; }],
  ["changed event", (f) => { f.witness.eventVersion = "2026-10-12T19:45:00Z"; }],
  ["changed kickoff", (f) => { f.witness.kickoffTime = "2026-10-12T19:45:00Z"; }],
  ["reversed ordered teams", (f) => { [f.witness.homeTeamId, f.witness.awayTeamId] = [f.witness.awayTeamId, f.witness.homeTeamId]; }],
  ["missing team identity", (f) => { delete f.raw.homeTeamId; }],
  ["changed team name", (f) => { f.witness.homeTeamName = "另一球队"; }],
  ["changed score", (f) => { f.witness.scoreHome = 5; }],
  ["untrusted provenance", (f) => { f.witness.resultProvenance.trusted = false; }],
  ["provenance wrong source ID", (f) => { f.raw.resultProvenance.sourceMatchId = "2041927"; }],
  ["provenance wrong event", (f) => { f.raw.resultProvenance.eventVersion = "2026-10-12T19:45:00Z"; }],
  ["provenance wrong score", (f) => { f.raw.resultProvenance.scoreHome = 5; }],
  ["different result source", (f) => { f.raw.resultSource = "sporttery:other"; }],
  ["changed observation clock", (f) => { f.raw.resultObservedAt = "2026-10-13T01:19:18.385Z"; }],
  ["changed settlement clock", (f) => { f.raw.settledAt = "2026-10-13T01:19:18.385Z"; }],
  ["receipt wrong score", (f) => { f.receipt.observations[0].scoreHome = 5; }],
  ["receipt fallback", (f) => { f.receipt.observations[0].resultObservationFallback = true; }],
  ["third review identity", (f) => { f.raw.postMatchReview.matchId = "sporttery_2041927"; }],
  ["canonical review of other event", (f) => { f.raw.postMatchReview.matchId = f.witness.id; f.raw.postMatchReview.eventVersion = "2026-10-12T19:45:00Z"; }],
  ["canonical review of reversed teams", (f) => { f.raw.postMatchReview.matchId = f.witness.id; f.raw.postMatchReview.teams.home = f.raw.awayTeamName; }],
  ["canonical review with another score", (f) => { f.raw.postMatchReview.matchId = f.witness.id; f.raw.postMatchReview.finalScore = "5-2"; }],
  ["pre-cutoff trusted decision", (f) => { f.raw.predictionMeta.publicationGate.trustedExistingPreCutoffDecision = true; }],
  ["unblocked decision", (f) => { f.raw.predictionMeta.publicationGate.status = "published"; }],
  ["actual prediction", (f) => { f.raw.predictions = [{ tipCode: "1" }]; }],
  ["actual archive", (f) => { f.raw.archivedPreMatchPrediction = { prediction: { tipCode: "1" } }; }],
  ["public reference", (f) => { f.raw.predictionMeta.publicReferenceDecision = { hash: "frozen" }; }],
  ["immutable reference", (f) => { f.raw.predictionMeta.immutableAnalysisReferenceDecision = { hash: "frozen" }; }],
  ["dual market decision", (f) => { f.raw.predictionMeta.dualMarketDecision = { hash: "frozen" }; }],
  ["publication binding", (f) => { f.raw.predictionMeta.publicationBinding = { publicationId: "frozen" }; }],
  ["published settlement", (f) => { f.raw.postMatchReview.settlement.publicationId = "frozen"; }],
  ["settled prediction count", (f) => { f.raw.postMatchReview.predictionReview.referenceSettled = 1; }],
  ["formal review status", (f) => { f.raw.postMatchReview.predictionReview.formalBestStatus = "WON"; }],
  ["review rows", (f) => { f.raw.postMatchReview.predictionReview.rows = [{}]; }],
  ["witness actual archive", (f) => { f.witness.archivedPreMatchPrediction = {}; }],
]) {
  check(`canonical result-only preservation rejects ${name}`, () => {
    const f = canonicalResultOnlyFixture();
    f.finals = [f.witness];
    change(f);
    assert.equal(preserveCanonicalResultOnlyIdentities([f.raw], f.receipt, f.finals)[0], f.raw);
  });
}

console.log(JSON.stringify({
  ok: true,
  verifier: "match-lifecycle-reconciliation",
  checks: checks.length,
  covered: [
    "future-scheduled",
    "atomic-pre-match-snapshot-upgrade",
    "out-of-order-pre-match-monotonicity",
    "post-cutoff-pre-match-freeze",
    "terminal-pre-match-freeze",
    "overdue-pending-result",
    "official-zero-zero-final",
    "out-of-order-terminal-preservation",
    "same-score-review-revision-monotonicity",
    "same-revision-review-generation-monotonicity",
    "timezone-equivalent-terminal-preservation",
    "opaque-event-version-normalization",
    "legacy-fivehundred-source-identity-dedup",
    "generation-duplicate-id-fail-closed",
    "rescheduled-kickoff",
    "event-version-mismatch",
    "provisional-result-monotonicity",
    "provisional-result-official-clear",
    "non-official-final",
    "missing-final-score",
    "official-void-monotonicity",
    "official-final-overrides-void",
  ],
}, null, 2));
