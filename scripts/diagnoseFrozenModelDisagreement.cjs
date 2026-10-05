"use strict";
// Known online export only. Observed component alignment is not causal model
// attribution; omitted arithmetic receipts must never be reconstructed.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { probabilities, marketProbabilities, score } = require("./historyRegressionReplay.cjs");
const ROOT = path.resolve(__dirname, "..");
const PINNED = {
  base: ["outputs/history-regression-20261002/online-sample-v3.json", "151a20c0678b89ec41d0555f06149be75182beba0dbc17cd4a1b5a76435470e1"],
  supplement: ["outputs/next-phase-20261002/form-supplement.json", "d4924ea7e96e20d048f4fbb0066525ac15c1d9ea63defe9c7ad90ad43b995dec"],
  recovery: ["outputs/next-phase-20261002/form-recovery-receipt.json", "6dc4362fe05403c694c23b5fe9c33611c9a7dea0a85bc9329669ee0ce34d2675"],
  evidence: ["outputs/history-regression-20261002/report/per-match-evidence.jsonl", "cebb126e0344787c0cfe4be1773a98d473394b1c6d57cfc32c5704c9abc125b9"],
};
const SIDES = ["home", "draw", "away"];
const ORIGINAL_REPORT = ["outputs/implementation-20261003/model/disagreement-attribution.json", "d561e8d0eb0ac9861291943de9c8a6d9f3b3f2f1d76f67af4d40eec6398aab75"];
const CLOUD_QA = "outputs/implementation-20261003/cloud/cloud-model-review.json";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const ensure = (value, message) => { if (!value) throw new Error(message); };
const ns = value => {
  if (strictInstant(value) === null) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || "";
  return BigInt(Date.parse(value)) * 1000000n + BigInt(fraction.padEnd(9, "0").slice(3) || "0");
};
const direction = p => SIDES.reduce((best, key) => p[key] > p[best] ? key : best, "home");
function roundedComponent(value) {
  if (!value || value.omitted || !SIDES.every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100)) return { status: "unavailable", direction: null };
  const sum = SIDES.reduce((total, key) => total + value[key], 0);
  if (Math.abs(sum - 100) > 0.151) return { status: "invalid-percent-triplet", direction: null };
  const sorted = SIDES.map(key => ({ key, value: value[key] })).sort((a, b) => b.value - a.value);
  const reliableDirection = sorted[0].value - sorted[1].value > 0.1000000001;
  return { status: reliableDirection ? "rounded-component-observed" : "direction-ambiguous-after-rounding", percentages: { ...value },
    direction: reliableDirection ? sorted[0].key : null, displayedLeader: sorted[0].key, rounding: "stored 0.1 percentage points; not original unrounded arithmetic" };
}
function assessFrozenFormEvidence(form, decisionAt) {
  ensure(ns(decisionAt) !== null, "strict original decision time required");
  const evidence = form?.resultEvidence, latest = ns(evidence?.latestObservedAt), decision = ns(decisionAt);
  const summaryDecision = ns(evidence?.decisionAt);
  const sample = form?.sampleSize;
  const count = name => Number.isSafeInteger(evidence?.[name]) && evidence[name] >= 0 ? evidence[name] : null;
  const summaryCountsComplete = Number.isSafeInteger(sample) && sample > 0 && count("sampleRows") === sample
    && count("observedRows") === sample && count("missingObservedAtRows") === 0 && count("missingSourceRows") === 0;
  const summaryDecisionStatus = summaryDecision === null
    ? evidence?.decisionAt == null || evidence.decisionAt === "" ? "missing" : "invalid"
    : summaryDecision > decision ? "after-original-decision" : "at-or-before-original-decision";
  const blockers = [];
  if (!form) blockers.push("form-side-missing");
  if (!Number.isSafeInteger(sample) || sample <= 0) blockers.push("positive-form-sample-missing");
  if (!evidence) blockers.push("selected-result-evidence-missing");
  if (evidence) {
    if (evidence.version !== "recent-form-result-evidence-v1") blockers.push("result-evidence-version-unknown");
    if (count("sampleRows") !== sample || count("observedRows") !== sample || count("missingObservedAtRows") !== 0 || count("missingSourceRows") !== 0) blockers.push("result-clock-or-source-coverage-incomplete");
    if (count("beforeKickoffRows") !== 0 || count("afterDecisionRows") !== 0) blockers.push("declared-result-clock-conflict");
    if (latest === null || latest > decision) blockers.push("latest-result-not-observed-by-original-decision");
    // decisionAt is the summary's evaluation cutoff, not its creation time.
    // A later cutoff cannot attest what was available at the frozen decision,
    // even when all counted observations report earlier timestamps.
    if (summaryDecision === null) blockers.push("summary-decision-clock-missing-or-invalid");
    else {
      if (summaryDecision > decision) blockers.push("summary-decision-after-original-decision");
      if (latest !== null && latest > summaryDecision) blockers.push("latest-result-after-summary-decision");
    }
    if (!/^[a-f0-9]{64}$/.test(evidence.selectionHash || "")) blockers.push("selection-hash-missing");
    if (!Array.isArray(evidence.sourceLabels) || !evidence.sourceLabels.length) blockers.push("result-source-label-missing");
  }
  const last = ns(form?.lastMatchAt);
  if (last === null || last >= decision) blockers.push("last-match-not-before-original-decision");
  return { sampleSize: Number.isSafeInteger(sample) ? sample : null, lastMatchAt: form?.lastMatchAt || null,
    lastMatchAgeDays: last !== null && last <= decision ? Number(decision - last) / 86400000000000 : null,
    reportedTemporalStatus: evidence?.temporalStatus || "missing", observedRows: count("observedRows"),
    missingObservedAtRows: count("missingObservedAtRows"), missingSourceRows: count("missingSourceRows"),
    reportedEvidenceDecisionAt: evidence?.decisionAt || null, latestObservedAt: evidence?.latestObservedAt || null,
    summaryCountsComplete, summaryDecisionStatus, metadataCompleteAtOriginalDecision: blockers.length === 0, blockers,
    originalDecisionAvailabilityProven: false,
    selectedOriginalRowsAvailable: false, providerSourceVerified: false, candidateEligible: false,
    meaning: "Counts and cutoff consistency describe summary metadata only. The summary cutoff is not a creation timestamp; neither complete counts nor consistent clocks prove original-decision source availability or training admission." };
}
function buildDisagreementDiagnosis(base, supplement, recovery, evidence) {
  ensure(base.rows.length === 432 && supplement.rows.length === 432 && evidence.length === 432, "known source cohort size changed");
  ensure(recovery.ok === true && recovery.candidateEligible === false && recovery.summary.recoveredOmitted === 355 && recovery.summary.retainedCrossChecked === 24, "recovered form proof missing");
  ensure(JSON.stringify(base.publication) === JSON.stringify(supplement.publication) && JSON.stringify(base.publication) === JSON.stringify(recovery.sourcePublication), "source generation mismatch");
  const baseById = new Map(base.rows.map(row => [row.matchId, row])), supplementById = new Map(supplement.rows.map(row => [row.matchId, row]));
  ensure(baseById.size === 432 && supplementById.size === 432 && new Set(evidence.map(row => row.record.matchId)).size === 432, "duplicate source event");
  const paired = evidence.filter(row => row.pairedEligible === true).map(row => row.record);
  ensure(paired.length === 154, "paired cohort changed");
  const prepared = paired.map(record => {
    const source = baseById.get(record.matchId), recovered = supplementById.get(record.matchId)?.snapshot;
    ensure(source?.snapshot && recovered && source.snapshot.originalObjectCanonicalSha256 === record.sourceRows.snapshotObjectSha256
      && recovered.originalObjectCanonicalSha256 === record.sourceRows.snapshotObjectSha256
      && recovered.decisionBinding.decisionAt === record.decision.at && recovered.featureBinding.hash === record.decision.featureSnapshotHash,
    "same frozen snapshot binding required");
    const model = probabilities(record.decision.probabilities), market = marketProbabilities(record);
    const form = Object.fromEntries(["home", "away"].map(side => [side, assessFrozenFormEvidence(recovered.form?.[side], record.decision.at)]));
    return { record, source, recovered, model, market, form };
  });
  const allForm = supplement.rows.filter(row => row.snapshot?.form).flatMap(row => ["home", "away"].map(side => assessFrozenFormEvidence(row.snapshot.form[side], row.snapshot.decisionBinding.decisionAt)));
  const summarizeForm = slots => ({ slots: slots.length, reportedStatus: slots.reduce((counts, row) => { counts[row.reportedTemporalStatus] = (counts[row.reportedTemporalStatus] || 0) + 1; return counts; }, {}),
    summaryCountsComplete: slots.filter(row => row.summaryCountsComplete).length,
    metadataCompleteAtOriginalDecision: slots.filter(row => row.metadataCompleteAtOriginalDecision).length,
    summaryDecisionStatus: slots.reduce((counts, row) => { counts[row.summaryDecisionStatus] = (counts[row.summaryDecisionStatus] || 0) + 1; return counts; }, {}),
    countCompleteSummaryAfterOriginalDecision: slots.filter(row => row.summaryCountsComplete && row.summaryDecisionStatus === "after-original-decision").length,
    latestObservedAfterSummaryDecision: slots.filter(row => row.blockers.includes("latest-result-after-summary-decision")).length,
    latestObservedAfterOriginalDecision: slots.filter(row => row.blockers.includes("latest-result-not-observed-by-original-decision") && ns(row.latestObservedAt) !== null).length,
    originalDecisionAvailabilityProven: 0, candidateEligible: 0 });
  const rows = prepared.filter(row => direction(row.model) !== direction(row.market)).map(({ record, source, recovered, model, market, form }) => {
    const inputs = source.snapshot.featureSnapshot.modelInputs;
    const components = { baseMarket: roundedComponent(inputs.market), poisson: roundedComponent(inputs.poisson), baseFinal: roundedComponent(inputs.oneXTwoFinal) };
    const maxMarketRoundingDeltaPoints = components.baseMarket.percentages
      ? Math.max(...SIDES.map(key => Math.abs(components.baseMarket.percentages[key] - market[key] * 100))) : null;
    const location = components.poisson.direction === null ? "poisson-direction-unavailable-or-ambiguous"
      : components.poisson.direction !== direction(market) ? "poisson-component-already-disagrees-with-market"
        : "poisson-and-market-align-but-base-final-disagrees";
    return { matchId: record.matchId, kickoffAt: record.kickoffAt, decisionAt: record.decision.at, modelVersion: record.decision.modelVersion, league: record.league,
      sourceSnapshotHash: record.sourceRows.snapshotObjectSha256, sourceRecordHash: sha(JSON.stringify(record)), formCanonicalSha256: recovered.formAudit.canonicalSha256,
      originalFrozenProbabilities: record.decision.probabilities, sameDecisionMarket: market, officialSp: record.officialOdds.sp,
      frozenDirection: direction(model), marketDirection: direction(market), outcome: record.result.outcome,
      components, maxMarketRoundingDeltaPoints, observedComponentPattern: location, form,
      calculationEvidence: { usageSummaryStatus: inputs.usageSummary?.omitted ? "export-omitted" : inputs.usageSummary ? "summary-only" : "not-present-in-frozen-inputs",
        usageSummaryCommitment: inputs.usageSummary?.canonicalSha256 || null, usageSummaryBytes: inputs.usageSummary?.bytes || null,
        sourceJsonPointer: `/rows/${source.snapshot.inputFileRowIndex}/featureSnapshot/modelInputs/usageSummary`, originalStageReceiptsAvailable: false,
        exactStageReplayEligible: false, causalAttribution: "unresolved-without-original-unrounded-stage-inputs-weights-and-calibration-receipts" },
      productionEligible: false };
  }).sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) || a.matchId.localeCompare(b.matchId));
  ensure(rows.length === 26, "disagreement cohort changed");
  const counts = field => rows.reduce((out, row) => { const value = field(row); out[value] = (out[value] || 0) + 1; return out; }, {});
  return { version: "frozen-model-disagreement-diagnosis-v2", scope: "known-online-history-inspected-diagnostic-only", productionEligible: false, modelTrained: false, candidateRegistered: false,
    diagnosticCorrection: { trigger: "cloud-independent-qa-summary-cutoff-feedback", previousReport: { path: ORIGINAL_REPORT[0], sha256: ORIGINAL_REPORT[1], preservedByteIdentical: true },
      correction: "v1 checked latestObservedAt but omitted the summary's decisionAt cutoff. v2 separates complete counts from strict cutoff consistency at the original decision; missing, invalid, later or internally contradictory summary clocks block the old metadata label.",
      clockMeaning: "resultEvidence.decisionAt is an evaluation cutoff, not a proven summary generation/availability timestamp.",
      unchanged: ["154 paired events and frozen scores 78/83", "26 disagreements and observed patterns 19/5/2", "zero training admissions", "production probabilities and promotion gates"] },
    coverage: { sourceRows: 432, recoveredFormRows: 379, pairedRows: 154, disagreementRows: rows.length },
    pairedRecalculation: { modelHits: prepared.reduce((n, row) => n + score(row.model, row.record.result.outcome).accuracy, 0), marketHits: prepared.reduce((n, row) => n + score(row.market, row.record.result.outcome).accuracy, 0) },
    observations: { patterns: counts(row => row.observedComponentPattern), modelVersions: counts(row => row.modelVersion),
      allBaseMarketsMatchSameDecisionMarketDirection: rows.every(row => row.components.baseMarket.direction === row.marketDirection),
      baseFinalAlignment: { unambiguousSameDirection: rows.filter(row => row.components.baseFinal.direction === row.frozenDirection).length,
        ambiguousAfterRounding: rows.filter(row => row.components.baseFinal.direction === null).length,
        unambiguousDifferentDirection: rows.filter(row => row.components.baseFinal.direction !== null && row.components.baseFinal.direction !== row.frozenDirection).length,
        displayedArgmaxSameDirection: rows.filter(row => row.components.baseFinal.displayedLeader === row.frozenDirection).length },
      maximumBaseMarketDeltaPoints: Math.max(...rows.map(row => row.maxMarketRoundingDeltaPoints)),
      usageSummaryStatuses: counts(row => row.calculationEvidence.usageSummaryStatus) },
    formEvidence: { allRecovered: summarizeForm(allForm), paired: summarizeForm(prepared.flatMap(row => Object.values(row.form))), disagreement: summarizeForm(rows.flatMap(row => Object.values(row.form))) }, rows,
    boundedSupplementRequest: { status: "prepared-not-executed", productionWrites: false, generation: base.publication,
      sourceFile: base.files.find(file => file.path === "prediction-snapshots.json"), maximumFieldBytes: 1024,
      purpose: "recover committed summary metadata only; this cannot reconstruct exact arithmetic receipts",
      rows: rows.filter(row => row.calculationEvidence.usageSummaryStatus === "export-omitted").map(row => ({ matchId: row.matchId,
        sourceSnapshotHash: row.sourceSnapshotHash, jsonPointer: row.calculationEvidence.sourceJsonPointer,
        expectedCanonicalSha256: row.calculationEvidence.usageSummaryCommitment, expectedCanonicalBytes: row.calculationEvidence.usageSummaryBytes })),
      requirements: ["same immutable generation and unchanged original file hash", "verify each whole source snapshot hash and exact committed field hash/byte count", "read-only bounded export; preserve original captures; no historical eligibility upgrade"] },
    nextEvidence: ["Recover committed usageSummary without changing original source generation; summary weights are not arithmetic replay.", "For future decisions retain original model inputUsage plus pre/post feedback and cooldown probabilities, weights, original clocks and model version.", "Reuse existing candidateProspectiveLedger/challenger/common-cohort gates; this diagnosis cannot select, activate or promote a candidate."],
    limitations: ["Version mix v73/v75/v76 prevents treating all rows as one current model.", "Poisson direction alignment is observed component evidence, not proof that form or cooldown caused the final result.", "Already-inspected outcomes must not set model weights, confidence thresholds, or be reused as future holdout.", "Missing result observation records remain unverified even when recovered aggregate form values are present."] };
}
function run(outputFile) {
  const target = path.resolve(outputFile), allowed = path.join(ROOT, "outputs/implementation-20261003/model") + path.sep;
  ensure(target.startsWith(allowed) && !fs.existsSync(target), "new output required inside implementation model directory");
  const inputs = Object.fromEntries(Object.entries(PINNED).map(([key, [relative, expected]]) => {
    const bytes = fs.readFileSync(path.join(ROOT, relative)); ensure(sha(bytes) === expected, `known online source bytes changed: ${relative}`);
    return [key, { path: relative, sha256: expected, data: key === "evidence" ? bytes.toString("utf8").trim().split(/\r?\n/).map(JSON.parse) : JSON.parse(bytes) }];
  }));
  const report = buildDisagreementDiagnosis(...["base", "supplement", "recovery", "evidence"].map(key => inputs[key].data));
  ensure(sha(fs.readFileSync(path.join(ROOT, ORIGINAL_REPORT[0]))) === ORIGINAL_REPORT[1], "archived v1 report bytes changed");
  const qaBytes = fs.readFileSync(path.join(ROOT, CLOUD_QA));
  report.diagnosticCorrection.feedbackArtifact = { path: CLOUD_QA, sha256: sha(qaBytes), boundary: JSON.parse(qaBytes).finalIndependentQaBoundary };
  report.inputs = Object.fromEntries(Object.entries(inputs).map(([key, { path: file, sha256 }]) => [key, { path: file, sha256 }]));
  report.reportHash = sha(JSON.stringify(report));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return { output: target, reportHash: report.reportHash, coverage: report.coverage, observations: report.observations, formEvidence: report.formEvidence };
}
module.exports = { roundedComponent, assessFrozenFormEvidence, buildDisagreementDiagnosis, run };
if (require.main === module) { try { ensure(process.argv.length === 3, "usage: node scripts/diagnoseFrozenModelDisagreement.cjs NEW_OUTPUT.json"); console.log(JSON.stringify(run(process.argv[2]), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
