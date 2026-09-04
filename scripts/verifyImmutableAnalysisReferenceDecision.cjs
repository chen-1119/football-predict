"use strict";

const assert = require("node:assert/strict");
const {
  IMMUTABLE_ANALYSIS_REFERENCE_VERSION,
  buildImmutableAnalysisReferenceDecision,
  verifyImmutableAnalysisReferenceDecision,
} = require("../src/services/immutableAnalysisReferenceDecision.cjs");
const {
  attachImmutableAnalysisReferenceDecisions,
} = require("./syncData.cjs");

const DECISION_AT = "2026-08-18T08:00:00.000Z";
const BASE_MATCH = {
  id: "fivehundred_9001",
  sourceMatchId: "9001",
  eventVersion: "event-9001-v1",
  status: "SCHEDULED",
  kickoffTime: "2026-08-18T12:00:00.000Z",
  buyEndTime: "2026-08-18T11:50:00.000Z",
  odds: {
    odds1: 1 / 0.30,
    oddsX: 1 / 0.29,
    odds2: 1 / 0.41,
    updatedAt: "2026-08-18T07:55:00.000Z",
  },
  oddsSource: "500.com:HAD",
  oddsUpdatedAt: "2026-08-18T07:55:00.000Z",
  probabilityModel: {
    inputSufficiency: { sufficient: false },
  },
  predictionMeta: {
    cutoffTime: "2026-08-18T11:50:00.000Z",
    publicationFinalizedAt: DECISION_AT,
    sourceCycleId: "cycle-9001",
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const decision = buildImmutableAnalysisReferenceDecision(clone(BASE_MATCH), DECISION_AT);
assert.ok(decision, "a clear 41% away leader must produce a pre-cutoff reference decision");
assert.equal(decision.version, IMMUTABLE_ANALYSIS_REFERENCE_VERSION);
assert.equal(decision.code, "2");
assert.equal(decision.marketProbability, 0.41);
assert.equal(decision.integrityVerified, true);
assert.equal(decision.formalEligible, false);
assert.equal(decision.statisticsTrack, "analysis-only");
assert.equal(verifyImmutableAnalysisReferenceDecision(decision, BASE_MATCH).valid, true);

const tampered = { ...decision, code: "1" };
const tamperVerification = verifyImmutableAnalysisReferenceDecision(tampered, BASE_MATCH);
assert.equal(tamperVerification.valid, false);
assert.ok(tamperVerification.blockers.includes("analysis-reference-hash-mismatch"));

assert.equal(buildImmutableAnalysisReferenceDecision({
  ...clone(BASE_MATCH),
  probabilityModel: { inputSufficiency: { sufficient: true } },
}, DECISION_AT), null, "sufficient model inputs must not enter the fallback lane");
assert.equal(buildImmutableAnalysisReferenceDecision(clone(BASE_MATCH), BASE_MATCH.buyEndTime), null,
  "a decision at cutoff must fail closed");
assert.equal(buildImmutableAnalysisReferenceDecision({
  ...clone(BASE_MATCH),
  oddsUpdatedAt: "2026-08-18T08:05:00.000Z",
  odds: { ...clone(BASE_MATCH.odds), updatedAt: "2026-08-18T08:05:00.000Z" },
}, DECISION_AT), null, "future source data must not be backdated into the decision");

const existing = {
  ...clone(BASE_MATCH),
  predictionMeta: {
    ...clone(BASE_MATCH.predictionMeta),
    immutableAnalysisReferenceDecision: decision,
  },
};
const changedMarket = {
  ...clone(BASE_MATCH),
  odds: {
    odds1: 1 / 0.45,
    oddsX: 1 / 0.30,
    odds2: 1 / 0.25,
    updatedAt: "2026-08-18T08:10:00.000Z",
  },
  oddsUpdatedAt: "2026-08-18T08:10:00.000Z",
  predictionMeta: {
    ...clone(BASE_MATCH.predictionMeta),
    publicationFinalizedAt: "2026-08-18T08:15:00.000Z",
  },
};
const preserved = attachImmutableAnalysisReferenceDecisions(
  [changedMarket],
  new Map([["9001", existing]]),
  "2026-08-18T08:15:00.000Z",
)[0].predictionMeta.immutableAnalysisReferenceDecision;
assert.equal(preserved.code, "2");
assert.equal(preserved.contentHash, decision.contentHash);
assert.equal(preserved.decisionAt, DECISION_AT);

const reusedProviderId = {
  ...clone(changedMarket),
  kickoffTime: "2026-08-25T12:00:00.000Z",
  buyEndTime: "2026-08-25T11:50:00.000Z",
  eventVersion: "event-9001-v2",
  probabilityModel: { inputSufficiency: { sufficient: true } },
  predictionMeta: {
    ...clone(changedMarket.predictionMeta),
    cutoffTime: "2026-08-25T11:50:00.000Z",
  },
};
const reused = attachImmutableAnalysisReferenceDecisions(
  [reusedProviderId],
  new Map([["9001", existing]]),
  "2026-08-25T08:15:00.000Z",
)[0];
assert.equal(reused.predictionMeta.immutableAnalysisReferenceDecision, undefined,
  "a reused provider id must not inherit a prior event decision");

console.log(JSON.stringify({
  ok: true,
  version: IMMUTABLE_ANALYSIS_REFERENCE_VERSION,
  direction: decision.code,
  probability: decision.marketProbability,
  preservedHash: preserved.contentHash,
}, null, 2));
