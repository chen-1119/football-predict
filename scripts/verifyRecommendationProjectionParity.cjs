const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERSION,
  buildRecommendationProjectionParityAudit,
  compareRecommendationProjectionPair,
  isExplicitlyWithheldBest,
  projectPublicPredictionRows,
  publicHadSupportingDirectionConflicts,
  scheduledWithoutBestIds,
  validateArchivedDecision,
} = require("../server/recommendationProjectionParity.cjs");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const nowMs = Date.parse("2026-07-31T12:00:00.000Z");
const scheduled = {
  id: "secret-match-id",
  sourceMatchId: "sporttery_secret-source-id",
  homeTeamName: "Secret Home",
  awayTeamName: "Secret Away",
  status: "SCHEDULED",
  sourceStatus: "SCHEDULED",
  kickoffTime: "2026-07-31T14:00:00.000Z",
  buyEndTime: "2026-07-31T13:55:00.000Z",
  eventVersion: "2026-07-31T14:00:00.000Z",
  odds: { odds1: 1.85, oddsX: 3.4, odds2: 4.2 },
  oddsSource: "sporttery:had",
  handicapLine: -1,
  predictions: [
    {
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "1",
      odds: 1.85,
      recommendationAction: "reference",
    },
    {
      marketType: "HHAD",
      oddsPoolCode: "HHAD",
      tipCode: "2",
      handicapLine: -1,
      odds: 2.1,
      recommendationAction: "reference",
    },
  ],
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const matching = compareRecommendationProjectionPair(scheduled, clone(scheduled), nowMs);
check(matching.ok === true, "matching scheduled projections must pass");
check(matching.reasons.length === 0, "matching scheduled projections must have no reason");

const pendingSale = clone(scheduled);
delete pendingSale.odds;
delete pendingSale.oddsSource;
const pendingSaleComparison = compareRecommendationProjectionPair(pendingSale, clone(pendingSale), nowMs);
check(
  pendingSaleComparison.ok === true
    && pendingSaleComparison.listDecision === null
    && pendingSaleComparison.detailDecision === null,
  "pre-match rows without official HAD SP must remain directionless and parity-consistent",
);

const changedDirection = clone(scheduled);
changedDirection.predictions[0].tipCode = "X";
const directionMismatch = compareRecommendationProjectionPair(scheduled, changedDirection, nowMs);
check(directionMismatch.ok === false, "changed BEST direction must fail");
check(directionMismatch.reasons.includes("canonical-decision-mismatch"), "BEST mismatch must be canonical");
check(directionMismatch.reasons.includes("had-hhad-projection-mismatch"), "BEST mismatch must affect pool projection");

const changedHhad = clone(scheduled);
changedHhad.predictions[1].handicapLine = 1;
const hhadMismatch = compareRecommendationProjectionPair(scheduled, changedHhad, nowMs);
check(hhadMismatch.ok === false, "changed HHAD line must fail");
check(hhadMismatch.reasons.includes("had-hhad-projection-mismatch"), "HHAD mismatch must be detected");

const missingBest = clone(scheduled);
missingBest.predictions = missingBest.predictions.filter((row) => row.marketType !== "BEST");
const missingMismatch = compareRecommendationProjectionPair(scheduled, missingBest, nowMs);
check(missingMismatch.reasons.includes("detail-canonical-decision-missing"), "missing detail BEST must fail closed");

const conflictingHadAnalysis = clone(scheduled);
conflictingHadAnalysis.predictions.unshift({
  marketType: "1X2",
  oddsPoolCode: "HAD",
  tipCode: "X",
  odds: 3.2,
  recommendationAction: "reference",
});
check(
  publicHadSupportingDirectionConflicts(conflictingHadAnalysis, nowMs).length === 1,
  "a different 1X2 direction in the same HAD pool must be detected",
);
const conflictingHadComparison = compareRecommendationProjectionPair(
  conflictingHadAnalysis,
  clone(conflictingHadAnalysis),
  nowMs,
);
check(
  conflictingHadComparison.reasons.includes("list-had-supporting-direction-conflict")
    && conflictingHadComparison.reasons.includes("detail-had-supporting-direction-conflict"),
  "matching list/detail payloads must still fail when both expose two HAD directions",
);
const projectedHadRows = projectPublicPredictionRows(conflictingHadAnalysis, { nowMs });
check(projectedHadRows.length === scheduled.predictions.length, "public projection must hide only the conflicting HAD analysis row");
check(
  projectedHadRows.some((row) => row.marketType === "BEST" && row.oddsPoolCode === "HAD" && row.tipCode === "1"),
  "public projection must preserve the canonical HAD BEST direction",
);
check(
  projectedHadRows.some((row) => row.marketType === "HHAD" && row.oddsPoolCode === "HHAD" && row.tipCode === "2"),
  "public projection must preserve the independent HHAD companion direction",
);
check(
  conflictingHadAnalysis.predictions[0].marketType === "1X2",
  "public projection must not mutate the private audit rows",
);
const projectedHadMatch = { ...conflictingHadAnalysis, predictions: projectedHadRows };
check(
  compareRecommendationProjectionPair(projectedHadMatch, clone(projectedHadMatch), nowMs).ok === true,
  "projected list/detail payloads must have one canonical HAD direction",
);

const explicitlyWithheld = clone(conflictingHadAnalysis);
const withheldBest = explicitlyWithheld.predictions.find((row) => row.marketType === "BEST");
withheldBest.recommendationAction = "withhold";
withheldBest.multiFactorEvidence = {
  eligible: false,
  grade: "WATCH",
  code: "1",
  blockers: ["evidence-score-below-threshold"],
};
withheldBest.liveRecommendationAction = "withhold";
withheldBest.liveRecommendation = { eligible: false, grade: "WITHHOLD" };
check(isExplicitlyWithheldBest(withheldBest), "failed BEST evidence must be recognized as explicitly withheld");
const withheldProjection = projectPublicPredictionRows(explicitlyWithheld, { nowMs });
check(
  withheldProjection.filter((row) => ["1", "X", "2"].includes(row.tipCode)).length === 0,
  "a withheld public projection must expose no result-pool direction",
);
check(
  withheldProjection.some((row) => (
    row.marketType === "BEST"
    && row.tipCode === "WATCH"
    && row.recommendationAction === "withhold"
    && row.multiFactorEvidence?.code === "WATCH"
  )),
  "a withheld BEST row must become one neutral public WATCH disposition",
);
check(
  explicitlyWithheld.predictions.some((row) => row.marketType === "BEST" && row.tipCode === "1"),
  "WATCH projection must preserve the private audit direction",
);
check(
  scheduledWithoutBestIds([{
    ...explicitlyWithheld,
    predictions: withheldProjection,
    archivedPreMatchPrediction: { prediction: withheldBest },
  }], nowMs).length === 0,
  "a scheduled public WATCH disposition must satisfy parity even when a private frozen direction exists",
);

const lowConfidenceReference = clone(conflictingHadAnalysis);
const referenceBest = lowConfidenceReference.predictions.find((row) => row.marketType === "BEST");
referenceBest.recommendationAction = "reference";
referenceBest.recommendationTier = "multi-factor-watch";
referenceBest.multiFactorEvidence = {
  eligible: false,
  grade: "WATCH",
  code: "1",
  blockers: ["evidence-score-below-threshold"],
};
referenceBest.liveRecommendationAction = "withhold";
referenceBest.liveRecommendation = { eligible: false, grade: "WITHHOLD" };
check(
  isExplicitlyWithheldBest(referenceBest) === false,
  "a directional REFERENCE must remain public even when formal promotion evidence is WATCH",
);
const referenceProjection = projectPublicPredictionRows(lowConfidenceReference, { nowMs });
check(
  referenceProjection.some((row) => (
    row.marketType === "BEST"
    && row.tipCode === "1"
    && row.recommendationAction === "reference"
    && row.multiFactorEvidence?.grade === "WATCH"
  )),
  "a low-confidence REFERENCE must retain its public direction and audit evidence",
);

const archivedOnlyPreMatch = clone(scheduled);
archivedOnlyPreMatch.predictions = archivedOnlyPreMatch.predictions.filter((row) => row.marketType !== "BEST");
archivedOnlyPreMatch.archivedPreMatchPrediction = {
  version: "archived-pre-match-prediction-v1",
  source: "immutable-pre-match-prediction-snapshot",
  sourceMatchId: "secret-source-id",
  eventVersion: scheduled.eventVersion,
  capturedAt: "2026-07-31T11:45:00.000Z",
  cutoffTime: scheduled.buyEndTime,
  marketEvidenceScope: "result-pool",
  signature: "archived-only-signature",
  prediction: {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "X",
    odds: 3.4,
    recommendationAction: "reference",
  },
};
const archivedOnlyProjection = projectPublicPredictionRows(archivedOnlyPreMatch, { nowMs });
check(
  archivedOnlyProjection.some((row) => (
    row.marketType === "BEST"
    && row.tipCode === "X"
    && row.immutableArchiveReference === true
  )),
  "a valid pre-match archive must restore a missing public BEST without rewriting the stored row",
);
check(
  archivedOnlyPreMatch.predictions.every((row) => row.marketType !== "BEST"),
  "restoring an archived public BEST must not mutate the private current row",
);
check(
  scheduledWithoutBestIds([{
    ...archivedOnlyPreMatch,
    predictions: archivedOnlyProjection,
  }], nowMs).length === 0,
  "an archived-only scheduled row must satisfy public BEST continuity",
);
check(
  compareRecommendationProjectionPair(
    { ...archivedOnlyPreMatch, predictions: archivedOnlyProjection },
    { ...clone(archivedOnlyPreMatch), predictions: clone(archivedOnlyProjection) },
    nowMs,
  ).ok === true,
  "an archived-only BEST projection must remain identical between list and detail",
);

// Route-wiring regression: list projection was already unconditional, while
// detail previously depended on an evidence helper guarded by
// status === SCHEDULED. A pre-match source can legitimately retain another
// lifecycle label (for example OPEN), so detail itself must apply the shared
// non-mutating projection after spreading the private read model.
const nonScheduledPreMatch = {
  ...clone(conflictingHadAnalysis),
  status: "OPEN",
  sourceStatus: "OPEN",
};
check(
  publicHadSupportingDirectionConflicts(nonScheduledPreMatch, nowMs).length === 1,
  "a non-SCHEDULED pre-match lifecycle must still expose the same HAD conflict to the public projector",
);
check(
  projectPublicPredictionRows(nonScheduledPreMatch, { nowMs }).length === scheduled.predictions.length,
  "the shared public projector must remove the conflict independently of the evidence-enrichment status gate",
);
const serverSource = fs.readFileSync(path.join(__dirname, "../server/index.cjs"), "utf8");
check(
  /if \(String\(prediction\.tipCode \|\| ""\)\.toUpperCase\(\) === "WATCH"\)[\s\S]*?recommendationAction: "withhold"[\s\S]*?recommendationTier: "public-watch"/.test(serverSource),
  "current-list evidence enrichment must preserve a neutral WATCH as an explicit withhold",
);
const detailProjectionBoundary = serverSource.match(
  /const normalizeMatchForDetailPayload = \(match\) => \{[\s\S]*?\n\};/,
)?.[0] || "";
check(
  /predictions:\s*projectPublicPredictionRows\(match\)/.test(detailProjectionBoundary),
  "the public detail normalizer must apply the shared prediction-row projection directly",
);
check(
  nonScheduledPreMatch.predictions[0].marketType === "1X2",
  "detail projection regression fixture must preserve private replay rows",
);

const bestHhadWithSeparateHad = clone(conflictingHadAnalysis);
bestHhadWithSeparateHad.predictions = [
  {
    marketType: "1X2",
    oddsPoolCode: "HAD",
    tipCode: "1",
    odds: 1.8,
    recommendationAction: "reference",
  },
  {
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    tipCode: "2",
    handicapLine: -1,
    odds: 2.1,
    recommendationAction: "reference",
  },
];
check(
  publicHadSupportingDirectionConflicts(bestHhadWithSeparateHad, nowMs).length === 0,
  "HAD 1X2 and HHAD BEST are different pools and must not be treated as a conflict",
);
check(
  projectPublicPredictionRows(bestHhadWithSeparateHad, { nowMs }).length === 2,
  "public projection must retain both HAD and HHAD when they are different pools",
);

const finished = {
  ...clone(scheduled),
  status: "FINISHED",
  sourceStatus: "FINISHED",
  kickoffTime: "2026-07-31T10:00:00.000Z",
  buyEndTime: "2026-07-31T09:55:00.000Z",
  eventVersion: "2026-07-31T10:00:00.000Z",
  archivedPreMatchPrediction: {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId: "secret-source-id",
    eventVersion: "2026-07-31T10:00:00.000Z",
    capturedAt: "2026-07-31T09:50:00.000Z",
    cutoffTime: "2026-07-31T09:55:00.000Z",
    marketEvidenceScope: "result-pool",
    signature: "secret-signature",
    prediction: {
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "X",
      odds: 3.2,
      recommendationAction: "reference",
    },
  },
};
const matchingArchive = compareRecommendationProjectionPair(finished, clone(finished), nowMs);
check(matchingArchive.ok === true, "matching immutable archives must pass");
check(matchingArchive.listDecision?.source === "archive", "result phase must use archive");
check(validateArchivedDecision(finished).valid === true, "valid archive must satisfy the strict UI-equivalent boundary");

const changedArchive = clone(finished);
changedArchive.archivedPreMatchPrediction.prediction.tipCode = "2";
const archiveMismatch = compareRecommendationProjectionPair(finished, changedArchive, nowMs);
check(archiveMismatch.ok === false, "changed immutable archive direction must fail");
check(archiveMismatch.reasons.includes("canonical-decision-mismatch"), "archive mismatch must be canonical");

const invalidArchiveMatrix = [
  ["version", (fixture) => { fixture.archivedPreMatchPrediction.version = "legacy"; }],
  ["source", (fixture) => { fixture.archivedPreMatchPrediction.source = "mutable-row"; }],
  ["identity", (fixture) => { fixture.archivedPreMatchPrediction.sourceMatchId = "another-match"; }],
  ["event-version", (fixture) => {
    fixture.archivedPreMatchPrediction.eventVersion = "2026-07-31T10:01:00.000Z";
  }],
  ["captured-after-deadline", (fixture) => {
    fixture.archivedPreMatchPrediction.capturedAt = "2026-07-31T09:56:00.000Z";
  }],
  ["captured-at-kickoff", (fixture) => {
    fixture.archivedPreMatchPrediction.capturedAt = "2026-07-31T10:00:00.000Z";
  }],
  ["invalid-model-only-scope", (fixture) => {
    fixture.archivedPreMatchPrediction.marketEvidenceScope = "model-only-reference";
  }],
  ["void", (fixture) => { fixture.resultDisposition = "VOID"; }],
];
for (const [label, mutate] of invalidArchiveMatrix) {
  const fixture = clone(finished);
  mutate(fixture);
  const validation = validateArchivedDecision(fixture);
  check(validation.valid === false, `${label} archive mutation must fail validation`);
  const comparison = compareRecommendationProjectionPair(finished, fixture, nowMs);
  check(
    comparison.reasons.includes("detail-canonical-decision-missing"),
    `${label} archive mutation must fail parity closed`,
  );
}

const validModelReference = clone(finished);
validModelReference.archivedPreMatchPrediction.marketEvidenceScope = "model-only-reference";
validModelReference.archivedPreMatchPrediction.prediction.odds = 0;
check(
  validateArchivedDecision(validModelReference).valid === true,
  "HAD model-only reference with zero odds must remain a valid explicit archive scope",
);

const audit = buildRecommendationProjectionParityAudit([
  { listMatch: scheduled, detailMatch: clone(scheduled) },
  { listMatch: scheduled, detailMatch: changedDirection },
  { listMatch: finished, detailMatch: clone(finished) },
], { nowMs });
check(audit.version === VERSION, "audit version must be stable");
check(audit.checkedRows === 3, "audit must count checked rows");
check(audit.preMatchRows === 2 && audit.resultPhaseRows === 1, "audit must separate phases");
check(audit.comparableRows === 3, "all fixtures must be comparable");
check(audit.canonicalDecisionMismatchRows === 1, "audit must aggregate canonical mismatches");
check(audit.hadHhadProjectionMismatchRows === 1, "audit must aggregate pool mismatches");
check(audit.mismatchRows === 1 && audit.ok === false, "audit must fail on one mismatched row");

const serializedAudit = JSON.stringify(audit);
check(!serializedAudit.includes("secret-match-id"), "public audit must not expose match id");
check(!serializedAudit.includes("secret-source-id"), "public audit must not expose source id");
check(!serializedAudit.includes("Secret Home"), "public audit must not expose home team");
check(!serializedAudit.includes("Secret Away"), "public audit must not expose away team");
check(!serializedAudit.includes("secret-signature"), "public audit must not expose archive signature");
check(!Object.values(audit).some(Array.isArray), "public audit must not expose per-row arrays");

const emptyAudit = buildRecommendationProjectionParityAudit([], { nowMs });
check(emptyAudit.checkedRows === 0 && emptyAudit.ok === true, "empty current lane must be vacuously consistent");

console.log(JSON.stringify({
  ok: true,
  verifier: "recommendation-projection-parity-contract-v1",
  checks,
  audit,
}, null, 2));
