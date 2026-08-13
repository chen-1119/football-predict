const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCandidateDecisionSnapshot,
  isDecisionClockAuditEligible,
} = require("../src/services/decisionSnapshot.cjs");
const {
  applyPredictionPersistence,
  attachExternalSignals,
  enrichRawMatchWithPredictionSnapshot,
  finalizePublishedPredictionDecisions,
  marketSignalSignatureForMatch,
  mergeFreshWithExistingStore,
  matchesFromSportteryRelaySnapshot,
  sportteryPoolOdds,
  teamKey,
} = require("./syncData.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

const clone = (value) => JSON.parse(JSON.stringify(value));
const collectorCycleId = "sporttery-relay:clock-fixture-collector";
const collectorContext = createCollectorAttestationTestContext({ keyId: "clock-lineage-test-ed25519" });
const marketProvenance = (poolCode, providerObservedAt, receivedAt) => (
  collectorContext.buildSignedMarketProvenance({
    poolCode,
    sourceMatchId: "clock_fixture",
    odds: poolCode === "HAD"
      ? { "1": 1.9, X: 3.3, "2": 4.1 }
      : { "1": 2.8, X: 3.25, "2": 2.1 },
    handicapLine: poolCode === "HHAD" ? -1 : 0,
    sourceUrl: "https://webapi.sporttery.cn/test",
    providerObservedAt,
    sourceTiming: {
      sourceCycleId: collectorCycleId,
      requestedAt: "2026-07-16T10:24:00.000Z",
      receivedAt,
      sourceRequest: { method: "GET", page: 1, role: "clock-fixture" },
      httpStatus: 200,
      httpDate: "Thu, 16 Jul 2026 10:26:00 GMT",
      httpEtag: '"clock-fixture"',
      contentType: "application/json;charset=UTF-8",
      rawSha256: poolCode === "HAD" ? "a".repeat(64) : "b".repeat(64),
      rawBytes: poolCode === "HAD" ? 1200 : 1400,
      envelopeSourceCycleId: "sporttery-fast-upload-merge:later-envelope",
      envelopeCycleKind: "upload-merge",
      constituentSourceCycleIds: [collectorCycleId],
    },
  })
);

const fixture = () => ({
  id: "sporttery_clock_fixture",
  sourceMatchId: "clock_fixture",
  sourceCycleId: "sporttery-full-sync:later-refresh-must-not-win",
  kickoffTime: "2026-07-16T12:00:00.000Z",
  buyEndTime: "2026-07-16T11:50:00.000Z",
  odds: { odds1: 1.9, oddsX: 3.3, odds2: 4.1 },
  oddsObservedAt: "2026-07-16T10:30:00.000Z",
  oddsReceivedAt: "2026-07-16T10:31:00.000Z",
  oddsMarketProvenance: marketProvenance(
    "HAD",
    "2026-07-16T10:25:00.000Z",
    "2026-07-16T10:26:00.000Z",
  ),
  handicapLine: "-1",
  handicapOdds: { odds1: 2.8, oddsX: 3.25, odds2: 2.1 },
  handicapOddsObservedAt: "2026-07-16T10:30:30.000Z",
  handicapOddsReceivedAt: "2026-07-16T10:31:30.000Z",
  handicapOddsMarketProvenance: marketProvenance(
    "HHAD",
    "2026-07-16T10:25:30.000Z",
    "2026-07-16T10:26:30.000Z",
  ),
  predictionMeta: {
    generatedAt: "2026-07-16T10:40:00.000Z",
    decisionGeneratedAt: "2026-07-16T10:40:00.000Z",
    sourceCycleId: collectorCycleId,
    cutoffTime: "2026-07-16T11:50:00.000Z",
    policyVersion: "clock-fixture-policy",
    modelVersion: "clock-fixture-model",
    featureSnapshotHash: "clock-fixture-feature",
    featureSnapshot: {
      version: "prediction-feature-snapshot-v4-clock-lineage",
      capturedAt: "2026-07-16T10:40:00.000Z",
      sourceCycleId: collectorCycleId,
      market: {
        had: {
          observedAt: "2026-07-16T10:25:00.000Z",
          receivedAt: "2026-07-16T10:26:00.000Z",
          provenance: marketProvenance("HAD", "2026-07-16T10:25:00.000Z", "2026-07-16T10:26:00.000Z"),
        },
        hhad: {
          observedAt: "2026-07-16T10:25:30.000Z",
          receivedAt: "2026-07-16T10:26:30.000Z",
          provenance: marketProvenance("HHAD", "2026-07-16T10:25:30.000Z", "2026-07-16T10:26:30.000Z"),
        },
      },
    },
  },
  predictions: [{
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    recommendationAction: "reference",
  }],
  probabilityModel: {
    version: "clock-fixture-model",
    generatedAt: "2026-07-16T10:37:00.000Z",
    oneXTwo: { final: { home: 52, draw: 28, away: 20 } },
    handicap: {
      line: "-1",
      unifiedPosterior: { home: 31, draw: 42, away: 27 },
    },
    unifiedPosterior: {
      version: "clock-fixture-unified",
      generatedAt: "2026-07-16T10:39:00.000Z",
      selectedMarket: "HAD",
      selectedCode: "1",
      dataQuality: 0.8,
      candidates: [
        { market: "HAD", code: "1", probability: 52, odds: 1.9 },
        { market: "HAD", code: "X", probability: 28, odds: 3.3 },
        { market: "HAD", code: "2", probability: 20, odds: 4.1 },
        { market: "HHAD", code: "1", probability: 31, odds: 2.8 },
        { market: "HHAD", code: "X", probability: 42, odds: 3.25 },
        { market: "HHAD", code: "2", probability: 27, odds: 2.1 },
      ],
    },
  },
});

const capturedAt = "2026-07-16T10:20:00.000Z";
const providerRow = {
  oddsList: [
    { poolCode: "HAD", h: "1.900", d: "3.300", a: "4.100", updateDate: "2026-07-16", updateTime: "18:25:00" },
    { poolCode: "HHAD", h: "2.800", d: "3.250", a: "2.100", goalLine: "-1", updateDate: "2026-07-16", updateTime: "18:25:30" },
  ],
};
const providerReceivedAt = "2026-07-16T10:26:00.000Z";
const providerHad = sportteryPoolOdds(providerRow, "HAD", "https://webapi.sporttery.cn/test", "current", {
  receivedAt: providerReceivedAt,
});
const providerHhad = sportteryPoolOdds(providerRow, "HHAD", "https://webapi.sporttery.cn/test", "current", {
  receivedAt: providerReceivedAt,
});
assert.equal(providerHad.oddsObservedAt, "2026-07-16T10:25:00.000Z");
assert.equal(providerHad.oddsReceivedAt, providerReceivedAt);
assert.equal(providerHhad.oddsObservedAt, "2026-07-16T10:25:30.000Z");
assert.equal(providerHhad.oddsReceivedAt, providerReceivedAt);
assert.equal(
  sportteryPoolOdds(providerRow, "HAD", "https://webapi.sporttery.cn/test", "current").oddsReceivedAt,
  null,
  "missing response receipt must stay missing instead of using Date.now",
);
const relayRows = matchesFromSportteryRelaySnapshot({
  payload: {
    sourceCycleId: "relay-upload-cycle-must-not-win",
    sourceCycleKind: "upload-merge",
    constituentCycleIds: ["relay-endpoint-cycle-fixture"],
  },
  summary: {},
  entries: [{
    method: "current",
    url: "https://webapi.sporttery.cn/test",
    fetchedAt: providerReceivedAt,
    requestedAt: "2026-07-16T10:24:00.000Z",
    receivedAt: providerReceivedAt,
    sourceCycleId: "relay-endpoint-cycle-fixture",
    sourceRequest: { method: "GET" },
    httpStatus: 200,
    httpDate: "Thu, 16 Jul 2026 10:26:00 GMT",
    httpEtag: '"relay-fixture"',
    contentType: "application/json",
    rawSha256: "c".repeat(64),
    rawBytes: 2500,
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: [{
            ...providerRow,
            matchId: "clock-relay-fixture",
            matchDate: "2026-07-16",
            matchTime: "20:00:00",
            homeTeamAllName: "Clock Home",
            awayTeamAllName: "Clock Away",
            leagueAllName: "Clock League",
            matchStatus: "Selling",
          }],
        }],
      },
    },
  }],
});
assert.equal(relayRows.length, 1);
assert.equal(relayRows[0].sourceCycleId, "relay-endpoint-cycle-fixture");
assert.equal(relayRows[0].oddsMarketProvenance.cycles.collectorSourceCycleId, "relay-endpoint-cycle-fixture");
assert.equal(relayRows[0].oddsMarketProvenance.cycles.envelopeSourceCycleId, "relay-upload-cycle-must-not-win");
assert.equal(relayRows[0].oddsObservedAt, "2026-07-16T10:25:00.000Z");
assert.equal(relayRows[0].oddsReceivedAt, providerReceivedAt);
assert.equal(relayRows[0].handicapOddsObservedAt, "2026-07-16T10:25:30.000Z");
assert.equal(relayRows[0].handicapOddsReceivedAt, providerReceivedAt);
const reusedIdStaleSaleRows = matchesFromSportteryRelaySnapshot({
  payload: {
    sourceCycleId: "relay-upload-cycle-reused-id",
    sourceCycleKind: "upload-merge",
  },
  summary: {},
  entries: [{
    method: "current",
    url: "https://webapi.sporttery.cn/test",
    requestedAt: "2026-07-16T10:24:00.000Z",
    receivedAt: providerReceivedAt,
    sourceCycleId: "relay-endpoint-cycle-reused-id",
    sourceRequest: { method: "GET" },
    httpStatus: 200,
    httpDate: "Thu, 16 Jul 2026 10:26:00 GMT",
    httpEtag: '"relay-reused-id"',
    contentType: "application/json",
    rawSha256: "d".repeat(64),
    rawBytes: 2500,
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: [{
            ...providerRow,
            matchId: "clock-relay-reused-id",
            matchDate: "2026-07-16",
            matchTime: "20:00:00",
            buyEndTime: "2026-07-09 19:50:00",
            homeTeamAllName: "New Event Home",
            awayTeamAllName: "New Event Away",
            leagueAllName: "Clock League",
            matchStatus: "Selling",
          }],
        }],
      },
    },
  }],
});
assert.equal(reusedIdStaleSaleRows.length, 1);
assert.equal(reusedIdStaleSaleRows[0].kickoffTime, "2026-07-16T20:00:00+08:00");
assert.equal(reusedIdStaleSaleRows[0].buyEndTime, "");
assert.equal(reusedIdStaleSaleRows[0].odds, null, "stale HAD sale atom must not cross a reused event id");
assert.equal(reusedIdStaleSaleRows[0].handicapOdds, null, "stale HHAD sale atom must not cross a reused event id");
assert.equal(reusedIdStaleSaleRows[0].oddsMarketProvenance, null);
assert.equal(reusedIdStaleSaleRows[0].handicapOddsMarketProvenance, null);
const valid = buildCandidateDecisionSnapshot(fixture(), capturedAt);
assert.equal(valid.clockAudit.eligible, true);
assert.equal(isDecisionClockAuditEligible(valid), true);
assert.equal(valid.sourceCycleId, collectorCycleId);
assert.equal(valid.sourceTimestamps.modelGeneratedAt, "2026-07-16T10:39:00.000Z");
assert.equal(valid.sourceTimestamps.hadObservedAt, "2026-07-16T10:25:00.000Z");
assert.equal(valid.sourceTimestamps.hadReceivedAt, "2026-07-16T10:26:00.000Z");
assert.equal(valid.sourceTimestamps.hhadObservedAt, "2026-07-16T10:25:30.000Z");
assert.equal(valid.sourceTimestamps.hhadReceivedAt, "2026-07-16T10:26:30.000Z");
assert.equal(valid.exposure.shadowEligible, true);

const freshModel = fixture();
delete freshModel.predictionMeta.featureSnapshot;
delete freshModel.predictionMeta.featureSnapshotHash;
const persistedFreshDecision = applyPredictionPersistence(freshModel, null, capturedAt, {
  finalizedAt: "2026-07-16T10:40:00.000Z",
});
assert.equal(
  persistedFreshDecision.predictionMeta.generatedAt,
  "2026-07-16T10:39:00.000Z",
  "sync persistence must use the latest real model layer time, not sync-start capturedAt",
);
assert.equal(persistedFreshDecision.predictionMeta.decisionGeneratedAt, "2026-07-16T10:39:00.000Z");
assert.equal(persistedFreshDecision.predictionMeta.modelGeneratedAt, "2026-07-16T10:37:00.000Z");
assert.equal(persistedFreshDecision.predictionMeta.sourceCycleId, collectorCycleId);
assert.equal(persistedFreshDecision.predictionMeta.featureSnapshot.sourceCycleId, collectorCycleId);
assert.equal(
  persistedFreshDecision.predictionMeta.featureSnapshot.market.had.observedAt,
  freshModel.oddsMarketProvenance.timing.providerObservedAt,
);
assert.equal(
  persistedFreshDecision.predictionMeta.featureSnapshot.market.had.receivedAt,
  freshModel.oddsMarketProvenance.timing.receivedAt,
);
assert.ok(
  Date.parse(persistedFreshDecision.predictionMeta.modelGeneratedAt)
    <= Date.parse(persistedFreshDecision.predictionMeta.decisionGeneratedAt),
);
const freshDecisionSnapshot = buildCandidateDecisionSnapshot(persistedFreshDecision, capturedAt);
assert.equal(freshDecisionSnapshot.clockAudit.eligible, true);
assert.equal(isDecisionClockAuditEligible(freshDecisionSnapshot), true);
assert.equal(freshDecisionSnapshot.decisionAt, "2026-07-16T10:39:00.000Z");

// Sporttery can reuse a provider match id for a later fixture. The old event's
// cutoff and lock must not be inherited by the new event merely because the
// sourceMatchId is equal.
const reusedIdFreshEvent = clone(freshModel);
delete reusedIdFreshEvent.predictionMeta;
reusedIdFreshEvent.kickoffTime = "2026-08-11T10:30:00.000Z";
reusedIdFreshEvent.buyEndTime = "2026-08-11T10:20:00.000Z";
reusedIdFreshEvent.probabilityModel.generatedAt = "2026-08-10T00:00:00.000Z";
reusedIdFreshEvent.probabilityModel.unifiedPosterior.generatedAt = "2026-08-10T00:01:00.000Z";
const reusedIdDecision = finalizePublishedPredictionDecisions(
  [reusedIdFreshEvent],
  new Map([[persistedFreshDecision.sourceMatchId, persistedFreshDecision]]),
  "2026-08-10T00:02:00.000Z",
  { finalizedAt: "2026-08-10T00:03:00.000Z" },
)[0];
assert.ok(reusedIdDecision.predictions.length > 0);
assert.equal(reusedIdDecision.predictionMeta.cutoffTime, reusedIdFreshEvent.buyEndTime);
assert.equal(reusedIdDecision.predictionMeta.publicationGate.status, "allowed");
assert.equal(reusedIdDecision.predictionMeta.decisionRevision, 1);
assert.notEqual(reusedIdDecision.predictionMeta.decisionId, persistedFreshDecision.predictionMeta.decisionId);
assert.equal(reusedIdDecision.predictionMeta.lockedAt, undefined);
assert.equal(reusedIdDecision.predictionMeta.lockedReason, undefined);

// Reproduce the full r451 reused-id path: before persistence, an old official
// odds row and a source-id keyed 500/pre-match signal could contaminate the
// new raw fixture with the former event's cutoff and HHAD market.
const reusedIdRawEvent = clone(reusedIdFreshEvent);
for (const field of [
  "odds",
  "oddsSource",
  "oddsPoolCode",
  "oddsMarketProvenance",
  "handicapOdds",
  "handicapLine",
  "handicapOddsSource",
  "handicapOddsPoolCode",
  "handicapOddsMarketProvenance",
]) delete reusedIdRawEvent[field];
const reusedIdEnriched = enrichRawMatchWithPredictionSnapshot(
  reusedIdRawEvent,
  new Map([[persistedFreshDecision.sourceMatchId, persistedFreshDecision]]),
  [{
    sourceMatchId: persistedFreshDecision.sourceMatchId,
    kickoffTime: persistedFreshDecision.kickoffTime,
    capturedAt: "2026-07-16T10:30:00.000Z",
    cutoffTime: persistedFreshDecision.buyEndTime,
    poolCode: "HAD",
    odds1: 1.9,
    oddsX: 3.3,
    odds2: 4.1,
  }],
);
assert.equal(reusedIdEnriched.odds, undefined);
assert.equal(reusedIdEnriched.handicapOdds, undefined);
const reusedIdWithSignals = attachExternalSignals(
  [reusedIdEnriched],
  {
    source: "external-signal-clock-regression",
    matches: {
      [persistedFreshDecision.sourceMatchId]: {
        updatedAt: "2026-07-16T10:35:00.000Z",
        fiveHundred: {
          sale: { buyEndTime: persistedFreshDecision.buyEndTime },
          result: { eventVersion: persistedFreshDecision.kickoffTime },
        },
      },
    },
  },
  {
    matches: {
      [persistedFreshDecision.sourceMatchId]: {
        sourceMatchId: persistedFreshDecision.sourceMatchId,
        kickoffTime: persistedFreshDecision.kickoffTime,
      },
    },
  },
)[0];
assert.equal(reusedIdWithSignals.externalSignals, undefined);
const reusedIdEndToEndDecision = finalizePublishedPredictionDecisions(
  [reusedIdWithSignals],
  new Map([[persistedFreshDecision.sourceMatchId, persistedFreshDecision]]),
  "2026-08-10T00:02:00.000Z",
  { finalizedAt: "2026-08-10T00:03:00.000Z" },
)[0];
assert.ok(reusedIdEndToEndDecision.predictions.length > 0);
assert.equal(reusedIdEndToEndDecision.predictionMeta.cutoffTime, reusedIdRawEvent.buyEndTime);
assert.equal(reusedIdEndToEndDecision.odds, undefined);
assert.equal(reusedIdEndToEndDecision.handicapOdds, undefined);

// A formerly contaminated store can already carry the new kickoff together
// with the previous event's cutoff and locked market. The merge must use the
// cutoff lineage as an event boundary even though id/kickoff/version now match.
const contaminatedStoredEvent = clone(persistedFreshDecision);
contaminatedStoredEvent.kickoffTime = reusedIdRawEvent.kickoffTime;
contaminatedStoredEvent.eventVersion = reusedIdRawEvent.kickoffTime;
const cleanFreshEvent = clone(reusedIdRawEvent);
cleanFreshEvent.eventVersion = cleanFreshEvent.kickoffTime;
const repairedStoredMerge = mergeFreshWithExistingStore(
  [contaminatedStoredEvent],
  [cleanFreshEvent],
)[0];
assert.equal(repairedStoredMerge.kickoffTime, cleanFreshEvent.kickoffTime);
assert.equal(repairedStoredMerge.buyEndTime, cleanFreshEvent.buyEndTime);
assert.equal(repairedStoredMerge.odds, undefined, "contaminated HAD must not survive an exact-id merge");
assert.equal(repairedStoredMerge.handicapOdds, undefined, "contaminated HHAD must not survive an exact-id merge");
assert.notEqual(
  repairedStoredMerge.predictionMeta?.cutoffTime,
  contaminatedStoredEvent.predictionMeta.cutoffTime,
  "old decision cutoff must not be rebound to the reused event",
);

assert.equal(teamKey("\u5929\u72fc\u661f"), "sirius");
assert.equal(teamKey("\u5e03\u9c81\u9a6c\u6ce2\u5361\u7eb3"), "brommapojkarna");
assert.equal(teamKey("\u97e6\u65af\u7279\u7f57\u65af"), "vasteras sk");
assert.equal(teamKey("\u4f50\u52a0\u987f\u65af"), "djurgarden");
assert.equal(teamKey("\u5723\u514b\u62c9\u62c9"), "santa clara");
assert.equal(teamKey("\u8461\u8404\u7259\u56fd\u6c11"), "nacional");

const unchangedRefresh = clone(freshModel);
unchangedRefresh.sourceCycleId = "sporttery-full-sync:2026-07-16T10:45:00.000Z";
unchangedRefresh.oddsReceivedAt = "2026-07-16T10:46:00.000Z";
unchangedRefresh.handicapOddsReceivedAt = "2026-07-16T10:46:00.000Z";
const preservedDecision = applyPredictionPersistence(
  unchangedRefresh,
  persistedFreshDecision,
  "2026-07-16T10:45:00.000Z",
);
assert.equal(
  preservedDecision.predictionMeta.sourceCycleId,
  persistedFreshDecision.predictionMeta.sourceCycleId,
  "an unchanged decision must retain its original source cycle instead of adopting a later refresh cycle",
);
const preservedSnapshot = buildCandidateDecisionSnapshot(preservedDecision, "2026-07-16T10:45:00.000Z");
assert.equal(preservedSnapshot.sourceCycleId, persistedFreshDecision.predictionMeta.sourceCycleId);
assert.equal(preservedSnapshot.sourceTimestamps.hadReceivedAt, freshModel.oddsMarketProvenance.timing.receivedAt);

const changedOfficialObservation = clone(freshModel);
changedOfficialObservation.oddsMarketProvenance = marketProvenance(
  "HAD",
  "2026-07-16T10:32:00.000Z",
  "2026-07-16T10:33:00.000Z",
);
changedOfficialObservation.handicapOddsMarketProvenance = marketProvenance(
  "HHAD",
  "2026-07-16T10:32:30.000Z",
  "2026-07-16T10:33:30.000Z",
);
changedOfficialObservation.oddsObservedAt = "2026-07-16T10:32:00.000Z";
changedOfficialObservation.oddsReceivedAt = "2026-07-16T10:33:00.000Z";
changedOfficialObservation.handicapOddsObservedAt = "2026-07-16T10:32:30.000Z";
changedOfficialObservation.handicapOddsReceivedAt = "2026-07-16T10:33:30.000Z";
changedOfficialObservation.probabilityModel.generatedAt = "2026-07-16T10:42:00.000Z";
changedOfficialObservation.probabilityModel.unifiedPosterior.generatedAt = "2026-07-16T10:44:00.000Z";
assert.notEqual(
  marketSignalSignatureForMatch(changedOfficialObservation),
  marketSignalSignatureForMatch(persistedFreshDecision),
  "a new trusted provider observation must invalidate market-signal deduplication even when SP values are unchanged",
);
const refreshedOfficialDecision = applyPredictionPersistence(
  changedOfficialObservation,
  persistedFreshDecision,
  "2026-07-16T10:40:00.000Z",
  { finalizedAt: "2026-07-16T10:45:00.000Z" },
);
assert.equal(
  refreshedOfficialDecision.predictionMeta.sourceCycleId,
  collectorCycleId,
  "a new trusted provider observation must produce a forward decision bound to its collector lineage",
);
assert.equal(refreshedOfficialDecision.predictionMeta.decisionRevision, persistedFreshDecision.predictionMeta.decisionRevision + 1);
assert.equal(
  buildCandidateDecisionSnapshot(refreshedOfficialDecision, "2026-07-16T10:40:00.000Z").clockAudit.eligible,
  true,
  "the forward decision created from unchanged SP and a newer trusted observation must enter the strict cohort",
);

// Reproduce the former two-stage failure: an early model already exists, then
// a later external-signal rebuild changes the probabilities. Finalization must
// bind metadata and features to the later model, not retain the earlier clock.
const finalModelAfterExternalSignals = clone(freshModel);
delete finalModelAfterExternalSignals.predictionMeta;
finalModelAfterExternalSignals.sourceCycleId = "sporttery-full-sync:2026-07-16T10:20:00.000Z";
finalModelAfterExternalSignals.externalSignals = {
  fiveHundred: {
    source: "500.com",
    updatedAt: "2026-07-16T10:15:00.000Z",
    europeOdds: {
      currentAverage: { odds1: 1.84, oddsX: 3.45, odds2: 4.35 },
    },
    asianHandicap: { lineMovement: -0.25 },
    marketConsensus: { riskLevel: "medium" },
  },
};
finalModelAfterExternalSignals.probabilityModel.generatedAt = "2026-07-16T10:42:00.000Z";
finalModelAfterExternalSignals.probabilityModel.oneXTwo.final = { home: 61, draw: 24, away: 15 };
finalModelAfterExternalSignals.probabilityModel.unifiedPosterior.generatedAt = "2026-07-16T10:44:00.000Z";
finalModelAfterExternalSignals.probabilityModel.unifiedPosterior.selectedCode = "1";
const finalDecision = finalizePublishedPredictionDecisions(
  [finalModelAfterExternalSignals],
  new Map([[persistedFreshDecision.sourceMatchId, persistedFreshDecision]]),
  capturedAt,
  { finalizedAt: "2026-07-16T10:45:00.000Z" },
)[0];
const finalFeatureSnapshot = finalDecision.predictionMeta.featureSnapshot;
assert.equal(finalDecision.predictionMeta.decisionRevision, persistedFreshDecision.predictionMeta.decisionRevision + 1);
assert.equal(finalDecision.predictionMeta.modelGeneratedAt, "2026-07-16T10:42:00.000Z");
assert.equal(finalDecision.predictionMeta.unifiedPosteriorGeneratedAt, "2026-07-16T10:44:00.000Z");
assert.equal(finalDecision.predictionMeta.decisionGeneratedAt, "2026-07-16T10:44:00.000Z");
assert.equal(finalFeatureSnapshot.modelGeneratedAt, "2026-07-16T10:44:00.000Z");
assert.equal(finalFeatureSnapshot.sourceCycleId, collectorCycleId);
assert.deepEqual(finalFeatureSnapshot.market.had.odds, finalDecision.odds);
assert.deepEqual(finalFeatureSnapshot.market.hhad.odds, finalDecision.handicapOdds);
assert.deepEqual(finalFeatureSnapshot.modelInputs.oneXTwoFinal, finalDecision.probabilityModel.oneXTwo.final);
assert.deepEqual(finalFeatureSnapshot.modelOutputs.had, finalDecision.probabilityModel.oneXTwo.final);
assert.equal(finalDecision.predictionMeta.featureSnapshotHash, finalFeatureSnapshot.hash);
assert.ok(
  Date.parse(finalDecision.probabilityModel.generatedAt)
    <= Date.parse(finalDecision.predictionMeta.decisionGeneratedAt),
  "the final base model must not be newer than its decision",
);
assert.ok(
  Date.parse(finalDecision.probabilityModel.unifiedPosterior.generatedAt)
    <= Date.parse(finalDecision.predictionMeta.decisionGeneratedAt),
  "the final unified model must not be newer than its decision",
);
const finalDecisionSnapshot = buildCandidateDecisionSnapshot(finalDecision, capturedAt);
assert.equal(
  finalDecisionSnapshot.clockAudit.eligible,
  true,
  JSON.stringify(finalDecisionSnapshot.clockAudit, null, 2),
);
assert.equal(isDecisionClockAuditEligible(finalDecisionSnapshot), true);

const lockedExisting = clone(persistedFreshDecision);
lockedExisting.predictionMeta.lockedAt = "2026-07-16T11:50:00.000Z";
lockedExisting.predictionMeta.lockedReason = "cutoff";
const lockedRefresh = clone(finalModelAfterExternalSignals);
lockedRefresh.predictionMeta = clone(lockedExisting.predictionMeta);
const lockedFinalDecision = finalizePublishedPredictionDecisions(
  [lockedRefresh],
  new Map([[lockedExisting.sourceMatchId, lockedExisting]]),
  "2026-07-16T11:55:00.000Z",
  { finalizedAt: "2026-07-16T11:56:00.000Z" },
)[0];
assert.equal(lockedFinalDecision.predictionMeta.decisionRevision, lockedExisting.predictionMeta.decisionRevision);
assert.equal(lockedFinalDecision.predictionMeta.sourceCycleId, lockedExisting.predictionMeta.sourceCycleId);
assert.deepEqual(lockedFinalDecision.probabilityModel, lockedExisting.probabilityModel);
assert.deepEqual(
  lockedFinalDecision.predictions.map((prediction) => ({
    marketType: prediction.marketType,
    oddsPoolCode: prediction.oddsPoolCode,
    tipCode: prediction.tipCode,
    recommendationAction: prediction.recommendationAction,
  })),
  lockedExisting.predictions.map((prediction) => ({
    marketType: prediction.marketType,
    oddsPoolCode: prediction.oddsPoolCode,
    tipCode: prediction.tipCode,
    recommendationAction: prediction.recommendationAction,
  })),
);

// A full sync can start with valid pre-cutoff observations and still finish
// after sales close. The finalizer's clock is injected so all four boundary
// cases are deterministic and cannot be made green by rewriting decisionAt.
const boundaryCandidate = clone(finalModelAfterExternalSignals);
delete boundaryCandidate.predictionMeta;
boundaryCandidate.sourceCycleId = "sporttery-full-sync:2026-07-16T11:45:00.000Z";
boundaryCandidate.probabilityModel.generatedAt = "2026-07-16T11:47:00.000Z";
boundaryCandidate.probabilityModel.unifiedPosterior.generatedAt = "2026-07-16T11:48:00.000Z";
boundaryCandidate.predictions[0].tipCode = "2";

let deterministicClockCalls = 0;
const beforeCutoffPublication = finalizePublishedPredictionDecisions(
  [clone(boundaryCandidate)],
  new Map(),
  "2026-07-16T11:45:00.000Z",
  {
    now: () => {
      deterministicClockCalls += 1;
      return "2026-07-16T11:49:00.000Z";
    },
  },
)[0];
assert.equal(deterministicClockCalls, 1, "the injected finalization clock is read at the publication gate");
assert.ok(beforeCutoffPublication.predictions.length > 0, "a decision finalized before cutoff remains publishable");
assert.equal(beforeCutoffPublication.predictionMeta.publicationGate.status, "allowed");
assert.equal(beforeCutoffPublication.predictionMeta.publicationGate.reasonCode, "finalized-before-cutoff");
assert.equal(beforeCutoffPublication.predictionMeta.syncCapturedAt, "2026-07-16T11:45:00.000Z");
assert.equal(beforeCutoffPublication.predictionMeta.publicationFinalizedAt, "2026-07-16T11:49:00.000Z");
assert.equal(
  beforeCutoffPublication.predictionMeta.decisionGeneratedAt,
  "2026-07-16T11:48:00.000Z",
  "decisionAt remains the real final-model clock and is not rewritten to the publication clock",
);

const crossedWithoutExisting = finalizePublishedPredictionDecisions(
  [clone(boundaryCandidate)],
  new Map(),
  "2026-07-16T11:45:00.000Z",
  { finalizedAt: "2026-07-16T11:51:00.000Z" },
)[0];
assert.deepEqual(crossedWithoutExisting.predictions, []);
assert.equal(crossedWithoutExisting.probabilityModel, undefined);
assert.equal(crossedWithoutExisting.projectedScoreHome, undefined);
assert.equal(crossedWithoutExisting.projectedScoreAway, undefined);
assert.equal(crossedWithoutExisting.stats, undefined);
assert.equal(crossedWithoutExisting.gptPrediction, undefined);
assert.equal(crossedWithoutExisting.predictionMeta.decisionGeneratedAt, undefined);
assert.equal(crossedWithoutExisting.predictionMeta.publicationGate.status, "blocked");
assert.equal(
  crossedWithoutExisting.predictionMeta.publicationGate.reasonCode,
  "cutoff-crossed-during-sync-no-trusted-pre-cutoff-decision",
);
assert.equal(crossedWithoutExisting.predictionMeta.publicationGate.crossedCutoffDuringSync, true);
assert.equal(crossedWithoutExisting.predictionMeta.publicationGate.syncCapturedAt, "2026-07-16T11:45:00.000Z");
assert.equal(crossedWithoutExisting.predictionMeta.publicationGate.finalizedAt, "2026-07-16T11:51:00.000Z");

const crossedWithTrustedExisting = finalizePublishedPredictionDecisions(
  [clone(boundaryCandidate)],
  new Map([[persistedFreshDecision.sourceMatchId, persistedFreshDecision]]),
  "2026-07-16T11:45:00.000Z",
  { finalizedAt: "2026-07-16T11:51:00.000Z" },
)[0];
assert.deepEqual(crossedWithTrustedExisting.predictions, persistedFreshDecision.predictions);
assert.deepEqual(crossedWithTrustedExisting.probabilityModel, persistedFreshDecision.probabilityModel);
assert.equal(crossedWithTrustedExisting.predictionMeta.decisionId, persistedFreshDecision.predictionMeta.decisionId);
assert.equal(crossedWithTrustedExisting.predictionMeta.decisionRevision, persistedFreshDecision.predictionMeta.decisionRevision);
assert.equal(crossedWithTrustedExisting.predictionMeta.decisionGeneratedAt, "2026-07-16T10:39:00.000Z");
assert.equal(crossedWithTrustedExisting.predictionMeta.publicationFinalizedAt, "2026-07-16T11:51:00.000Z");
assert.equal(crossedWithTrustedExisting.predictionMeta.publicationGate.status, "preserved");
assert.equal(
  crossedWithTrustedExisting.predictionMeta.publicationGate.reasonCode,
  "cutoff-crossed-during-sync-preserved-trusted-pre-cutoff-decision",
);

const startedAfterCutoff = finalizePublishedPredictionDecisions(
  [clone(boundaryCandidate)],
  new Map(),
  "2026-07-16T11:52:00.000Z",
  { finalizedAt: "2026-07-16T11:53:00.000Z" },
)[0];
assert.deepEqual(startedAfterCutoff.predictions, []);
assert.equal(startedAfterCutoff.probabilityModel, undefined);
assert.equal(startedAfterCutoff.predictionMeta.publicationGate.crossedCutoffDuringSync, false);
assert.equal(startedAfterCutoff.predictionMeta.publicationGate.syncStartedAfterCutoff, true);
assert.equal(
  startedAfterCutoff.predictionMeta.publicationGate.reasonCode,
  "sync-started-after-cutoff-no-trusted-pre-cutoff-decision",
);

const untrustedExisting = clone(persistedFreshDecision);
delete untrustedExisting.predictionMeta.featureSnapshotHash;
const crossedWithUntrustedExisting = finalizePublishedPredictionDecisions(
  [clone(boundaryCandidate)],
  new Map([[untrustedExisting.sourceMatchId, untrustedExisting]]),
  "2026-07-16T11:45:00.000Z",
  { finalizedAt: "2026-07-16T11:51:00.000Z" },
)[0];
assert.deepEqual(crossedWithUntrustedExisting.predictions, []);
assert.equal(crossedWithUntrustedExisting.predictionMeta.publicationGate.trustedExistingPreCutoffDecision, false);

const syncSource = fs.readFileSync(path.join(__dirname, "syncData.cjs"), "utf8");
const outputConstructionAt = syncSource.indexOf("let output = combinedRawMatchesForOutput");
const externalAttachAt = syncSource.indexOf("output = attachExternalSignals(output, externalSignals, preMatchSignals)", outputConstructionAt);
const finalRebuildAt = syncSource.indexOf("output = output.map((match) => rebuildPublishedPredictionModel(match, modelCalibration))", externalAttachAt);
const decisionFinalizeAt = syncSource.indexOf("output = finalizePublishedPredictionDecisions(output, existingBySourceId, capturedAt)", finalRebuildAt);
const snapshotAppendAt = syncSource.indexOf("const predictionSnapshotsPayload = appendPredictionSnapshots", decisionFinalizeAt);
assert.ok(outputConstructionAt >= 0 && externalAttachAt > outputConstructionAt);
assert.ok(finalRebuildAt > externalAttachAt);
assert.ok(decisionFinalizeAt > finalRebuildAt);
assert.ok(snapshotAppendAt > decisionFinalizeAt);
assert.equal(
  syncSource.slice(outputConstructionAt, externalAttachAt).includes("applyPredictionPersistence("),
  false,
  "the sync pipeline must not persist an early decision before external signals and the final rebuild",
);
const decisionPublishSegment = syncSource.slice(outputConstructionAt, snapshotAppendAt);
assert.equal(
  (decisionPublishSegment.match(/\boutput = finalizePublishedPredictionDecisions\(/g) || []).length,
  1,
  "the public output must have exactly one finalization boundary; the independent prospective audit may finalize its own source view",
);
assert.equal(
  decisionPublishSegment.includes("applyPredictionPersistence("),
  false,
  "the sync pipeline must have one finalization boundary and no second direct persistence pass",
);

const expectedFailures = [
  ["source cycle", (match) => {
    delete match.sourceCycleId;
    delete match.predictionMeta.sourceCycleId;
    delete match.predictionMeta.featureSnapshot.sourceCycleId;
    match.predictionMeta.featureSnapshot.market.had.provenance = null;
    match.predictionMeta.featureSnapshot.market.hhad.provenance = null;
  }, "source-cycle-id-missing"],
  ["HAD receipt", (match) => {
    delete match.oddsReceivedAt;
    delete match.predictionMeta.featureSnapshot.market.had.receivedAt;
    match.predictionMeta.featureSnapshot.market.had.provenance.timing.receivedAt = null;
  }, "had-odds-received-at-missing-or-invalid"],
  ["HHAD receipt", (match) => {
    delete match.handicapOddsReceivedAt;
    delete match.predictionMeta.featureSnapshot.market.hhad.receivedAt;
    match.predictionMeta.featureSnapshot.market.hhad.provenance.timing.receivedAt = null;
  }, "hhad-odds-received-at-missing-or-invalid"],
  ["model/decision order", (match) => {
    match.predictionMeta.generatedAt = "2026-07-16T10:38:00.000Z";
    match.predictionMeta.decisionGeneratedAt = "2026-07-16T10:38:00.000Z";
  }, "unified-posterior-generated-after-decision"],
  ["base/unified model order", (match) => {
    match.probabilityModel.generatedAt = "2026-07-16T10:40:00.000Z";
  }, "base-model-generated-after-unified-posterior"],
  ["HAD receipt/unified model order", (match) => {
    match.predictionMeta.featureSnapshot.market.had.receivedAt = "2026-07-16T10:39:30.000Z";
    match.predictionMeta.featureSnapshot.market.had.provenance.timing.receivedAt = "2026-07-16T10:39:30.000Z";
  }, "had-odds-received-after-unified-posterior"],
  ["HAD observed/received order", (match) => {
    match.predictionMeta.featureSnapshot.market.had.observedAt = "2026-07-16T10:27:00.000Z";
    match.predictionMeta.featureSnapshot.market.had.provenance.timing.providerObservedAt = "2026-07-16T10:27:00.000Z";
  }, "had-odds-observed-after-received"],
  ["HHAD received/decision order", (match) => {
    match.predictionMeta.featureSnapshot.market.hhad.receivedAt = "2026-07-16T10:41:00.000Z";
    match.predictionMeta.featureSnapshot.market.hhad.provenance.timing.receivedAt = "2026-07-16T10:41:00.000Z";
  }, "hhad-odds-received-after-decision"],
];

for (const [label, mutate, blocker] of expectedFailures) {
  const match = fixture();
  mutate(match);
  const snapshot = buildCandidateDecisionSnapshot(match, capturedAt);
  assert.equal(snapshot.clockAudit.eligible, false, `${label} must fail closed`);
  assert.equal(snapshot.exposure.shadowEligible, false, `${label} must not enter shadow evaluation`);
  assert.ok(snapshot.clockAudit.blockers.includes(blocker), `${label} reports ${blocker}`);
  assert.equal(isDecisionClockAuditEligible(snapshot), false, `${label} cannot be promotion-clock eligible`);
}

const invalidCapture = buildCandidateDecisionSnapshot(fixture(), "not-a-real-capture-time");
assert.equal(invalidCapture.capturedAt, null, "invalid capture must not be replaced by Date.now");
assert.ok(invalidCapture.clockAudit.blockers.includes("captured-at-missing-or-invalid"));
assert.equal(isDecisionClockAuditEligible(invalidCapture), false);

const tampered = clone(valid);
tampered.clockAudit.eligible = true;
tampered.clockAudit.markets.HAD.receivedAt = "2026-07-16T10:24:00.000Z";
assert.equal(isDecisionClockAuditEligible(tampered), false, "validator must recompute clock order instead of trusting eligible=true");

const root = path.resolve(__dirname, "..");
let persistedRows = [];
try {
  persistedRows = JSON.parse(fs.readFileSync(path.join(root, "public/data/prediction-snapshots.json"), "utf8"))?.rows || [];
} catch {
  persistedRows = [];
}
const persistedV2 = persistedRows.filter((row) => row?.decisionSnapshot?.version === "candidate-decision-snapshot-v2");
const persistedClockEligible = persistedV2.filter((row) => isDecisionClockAuditEligible(row.decisionSnapshot));
const legacyClockless = persistedV2.filter((row) => !row?.decisionSnapshot?.clockAudit);
assert.equal(
  legacyClockless.some((row) => isDecisionClockAuditEligible(row.decisionSnapshot)),
  false,
  "legacy v2 rows without a clock audit must remain fail closed",
);

console.log(JSON.stringify({
  ok: true,
  version: "decision-snapshot-clock-lineage-verifier-v1",
  syntheticCompleteEligible: isDecisionClockAuditEligible(valid),
  finalModelDecisionEligible: isDecisionClockAuditEligible(finalDecisionSnapshot),
  finalizationOrderVerified: true,
  cutoffCompletionGate: {
    deterministicClockCalls,
    beforeCutoffPublished: beforeCutoffPublication.predictions.length > 0,
    crossedWithoutExisting: crossedWithoutExisting.predictionMeta.publicationGate.reasonCode,
    crossedWithTrustedExisting: crossedWithTrustedExisting.predictionMeta.publicationGate.reasonCode,
    startedAfterCutoff: startedAfterCutoff.predictionMeta.publicationGate.reasonCode,
    untrustedExistingBlocked: crossedWithUntrustedExisting.predictions.length === 0,
  },
  relayLineageRows: relayRows.length,
  failClosedCases: expectedFailures.length + 2,
  realDataCompatibility: {
    persistedRows: persistedRows.length,
    persistedV2Rows: persistedV2.length,
    persistedClockEligibleRows: persistedClockEligible.length,
    legacyClocklessV2Rows: legacyClockless.length,
    policy: "legacy-clockless-v2-remains-audit-only-and-promotion-ineligible",
  },
}, null, 2));
