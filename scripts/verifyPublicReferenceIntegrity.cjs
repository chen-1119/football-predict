"use strict";
const assert = require("node:assert/strict");
const { bindPublicReferenceDecision: bind, attestPublicReferenceDecision: attest } = require("../src/services/publicReferenceDecision.cjs");
const { evaluateMultiFactorRecommendation: evaluate } = require("../src/services/multiFactorRecommendation.cjs");
const { providerFailure } = require("./providerFailure.cjs");
const { evaluateFreshnessAwareShadow: shadow } = require("../src/services/freshnessAwareShadow.cjs");
const { buildArchivedPreMatchPrediction } = require("./syncData.cjs");
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const match = {
  id: "sporttery_2041270", sourceMatchId: "2041270", status: "SCHEDULED",
  kickoffTime: "2026-09-05T19:30:00+08:00", buyEndTime: "2026-09-05T19:30:00+08:00",
  predictionMeta: { generatedAt: "2026-09-04T02:02:04.943Z", decisionId: "decision_1gen9dx" },
  predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "X", odds: 3.55,
    recommendationAction: "reference", trustScore: 40, tipLabel: { zh: "平局", en: "Draw" } }],
};
const published = bind(match, null, "2026-09-04T02:03:00Z");
const record = published.predictionMeta.publicReferenceDecision;
check(record?.prediction.tipCode === "X", "only the finalized public draw is bound");
check(attest(record, { ...match, id: "fivehundred_2041270" }), "provider alias cannot invalidate canonical event");
check(!attest(record, { ...match, sourceMatchId: "wrong" }), "different event rejected");
check(!attest(record, { ...match, kickoffTime: "2026-09-06T19:30:00+08:00" }), "rescheduled event rejected");
check(!attest({ ...record, prediction: { ...record.prediction, tipCode: "1" } }, match), "direction tampering rejected");
check(!attest({ ...record, recordedAt: "2026-09-05T11:31:00Z" }, match), "clock tampering rejected");
const refreshed = bind(published, published, "2026-09-05T11:27:00Z");
check(refreshed.predictionMeta.publicReferenceDecision.contentHash === record.contentHash, "unchanged heartbeat retains exact identity");
const privateHome = { ...published, id: "fivehundred_2041270", status: "LIVE",
  predictions: [{ ...match.predictions[0], tipCode: "1", odds: 1.97 }] };
const after = bind(privateHome, published, "2026-09-05T11:39:02.947Z");
check(after.predictionMeta.publicReferenceDecision.contentHash === record.contentHash, "cutoff cannot adopt a different private home candidate");
const archive = buildArchivedPreMatchPrediction(after, new Map(), null, "2026-09-05T11:40:00Z");
check(archive?.prediction.tipCode === "X" && archive.prediction.odds === 3.55, "Newcastle event replay retains public draw and original quote without candidate snapshots");
check(archive?.prediction.recommendationAction === "reference", "archive cannot promote formal track");
const shadowOnlyMatch = { ...match, status: "LIVE", predictions: [], predictionMeta: {} };
const shadowOnly = { ...match, matchId: match.id, phase: "final", capturedAt: "2026-09-05T11:27:00Z",
  cutoffTime: match.buyEndTime, auditRole: "shadow-candidate", best: { ...match.predictions[0], tipCode: "1" } };
check(!buildArchivedPreMatchPrediction(shadowOnlyMatch, new Map([[match.sourceMatchId, [shadowOnly]]]), null,
  "2026-09-05T11:40:00Z"), "a private pre-cutoff candidate cannot manufacture a public archive");
check(!bind(match, null, "2026-09-05T11:30:00Z").predictionMeta.publicReferenceDecision, "exact cutoff cannot create a public record");
check(!bind({ ...privateHome, predictionMeta: match.predictionMeta }, null, "2026-09-05T11:39:00Z").predictionMeta.publicReferenceDecision, "legacy missing public proof cannot be backfilled");
const changed = bind({ ...match, predictions: [{ ...match.predictions[0], tipCode: "1" }],
  predictionMeta: { ...match.predictionMeta, decisionId: "new-public-decision" } }, published, "2026-09-05T10:00:00Z");
check(changed.predictionMeta.publicReferenceDecision.previousHash === record.contentHash, "a real pre-cutoff public revision links previous record");
check(changed.predictionMeta.publicReferenceDecision.revision === 2, "public revision increments");
for (const value of [null, undefined, "", " ", false, true, [], {}, NaN, Infinity]) {
  const result = evaluate({ market: "HAD", code: "1", modelProbability: value, marketProbability: value,
    modelGap: value, dataQuality: value });
  check(result.modelProbability === null && result.marketProbability === null && result.dataQuality === null,
    "missing or invalid numbers are not zero");
  check(result.blockers.includes("missing-model-probability") && result.blockers.includes("missing-data-quality"),
    "missing evidence has explicit blockers");
}
check(evaluate({ modelProbability: 0 }).modelProbability === 0, "observed zero remains zero");
const secret = "DO-NOT-EXPOSE-TEST-KEY";
const failure = new AggregateError([Object.assign(new Error(secret), { code: "ENETUNREACH" }),
  Object.assign(new Error(secret), { code: "ETIMEDOUT" })], secret);
failure.cause = failure;
const diagnostic = providerFailure(failure);
check(diagnostic.category === "timeout" && diagnostic.codes.includes("ENETUNREACH"), "nested aggregate exposes transport codes");
check(!JSON.stringify(diagnostic).includes(secret) && diagnostic.accountState === "unknown", "transport diagnostic is redacted and not a suspension claim");
const shadowRow = { decisionSnapshot: {
  version: "candidate-decision-snapshot-v2", clockAudit: { eligible: true, markets: { HAD: { provenanceEligible: true } } },
  decisionAt: "2026-09-05T10:00:00Z", capturedAt: "2026-09-05T09:59:00Z",
  cutoffTime: "2026-09-05T11:30:00Z", kickoffTime: "2026-09-05T11:30:00Z", dataQuality: 1,
  probabilities: { HAD: { "1": .6, X: .2, "2": .2 } }, markets: { HAD: {
    marketProbabilities: { "1": .4, X: .3, "2": .3 }, observedAt: "2026-09-05T09:58:00Z", receivedAt: "2026-09-05T09:59:00Z" } },
}, featureSnapshot: { modelInputs: { form: { home: { lastMatchAt: "2026-07-07T10:00:00Z" }, away: { lastMatchAt: "2026-07-07T10:00:00Z" } } } } };
const trial = shadow(shadowRow);
check(trial.eligible && trial.promotionAllowed === false, "shadow cannot promote production");
check(Math.abs(trial.modelWeight - .125) < 1e-8 && Math.abs(trial.probabilities["1"] - .425) < 1e-8,
  "fixed 60-day half-life math is reproducible without outcomes");
check(Math.abs(Object.values(trial.probabilities).reduce((a,b)=>a+b,0)-1)<1e-8, "shadow probabilities sum to one");
const lateTrial = structuredClone(shadowRow); lateTrial.decisionSnapshot.decisionAt = "2026-09-05T11:31:00Z";
check(!shadow(lateTrial).eligible && shadow(lateTrial).probabilities === null, "postcutoff shadow inputs fail closed");
const missingTrial = structuredClone(shadowRow); missingTrial.decisionSnapshot.probabilities.HAD.X = null;
check(!shadow(missingTrial).eligible, "null probability cannot become a zero shadow input");
const noForm = structuredClone(shadowRow); delete noForm.featureSnapshot;
check(shadow(noForm).modelWeight === 0 && shadow(noForm).diagnostics.missingFormClock,
  "missing recent-data clocks yield explicit market baseline, not invented form");
const frozenArchiveAuthority = require("./verifyFrozenArchiveAuthority.cjs").verifyFrozenArchiveAuthority();
check(frozenArchiveAuthority.ok && frozenArchiveAuthority.checks >= 9,
  "unbound model and legacy reference declarations cannot overwrite frozen archives");
const archivePersistence = require("./verifyFrozenArchivePersistence.cjs").verifyFrozenArchivePersistence();
check(archivePersistence.ok && archivePersistence.checks >= 10,
  "fresh result persistence inherits exact event-qualified frozen archives");
const archiveRestoration = require("./verifyFrozenArchiveRestoration.cjs").verifyFrozenArchiveRestoration();
check(archiveRestoration.ok && archiveRestoration.checks >= 1215
  && archiveRestoration.restoredFixtureObjects === 601 && archiveRestoration.baselineRows === 601
  && archiveRestoration.restorationScope === "complete-original-published-baseline"
  && archiveRestoration.laterBaselineOmissionCovered === true,
  "release-bound backup restores missing original archives without changing their contents");
check(require("./verifyOfficialClubResults.cjs").strictAdmissionChecks >= 41,
  "official club ingress rejects coerced scores and invalid event clocks without erasing real zero scores");
console.log(JSON.stringify({ ok: true, checks, fixture: "synthetic reproduction of public draw/private home identity conflict", productionDataTouched: false }, null, 2));
