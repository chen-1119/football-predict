"use strict";

const crypto = require("node:crypto");

const RETRIEVAL_VERSION = "llm-evidence-bundle-v1";
const REVIEW_POLICY_VERSION = "llm-risk-review-evidence-boundary-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
const stableStringify = (value) => JSON.stringify(stableValue(value));
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const canonicalIso = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const uniqSorted = (values) => Array.from(new Set(values.map(compact).filter(Boolean))).sort();

const evidenceBody = (evidence) => {
  const { evidenceId: _evidenceId, ...body } = evidence || {};
  return stableValue(body);
};
const finalizeEvidence = (evidence) => {
  const body = evidenceBody(evidence);
  return { ...body, evidenceId: sha256(stableStringify(body)) };
};
const bundleBody = (bundle) => {
  const { retrievalHash: _retrievalHash, ...body } = bundle || {};
  return stableValue(body);
};
const finalizeBundle = (bundle) => {
  const body = bundleBody(bundle);
  return { ...body, retrievalHash: sha256(stableStringify(body)) };
};

const compactPrediction = (prediction) => ({
  marketType: compact(prediction?.marketType) || null,
  oddsPoolCode: compact(prediction?.oddsPoolCode) || null,
  handicapLine: prediction?.handicapLine ?? null,
  tipCode: compact(prediction?.tipCode) || null,
  trustScore: Number.isFinite(Number(prediction?.trustScore)) ? Number(prediction.trustScore) : null,
  recommendationAction: compact(prediction?.recommendationAction) || null,
  recommendationTier: compact(prediction?.recommendationTier) || null,
});

const compactOdds = (value) => {
  if (!isObject(value)) return null;
  const odds1 = Number(value.odds1);
  const oddsX = Number(value.oddsX);
  const odds2 = Number(value.odds2);
  if (![odds1, oddsX, odds2].every((item) => Number.isFinite(item) && item > 1)) return null;
  return { odds1, oddsX, odds2 };
};

const compactTriplet = (value) => {
  if (!isObject(value)) return null;
  const home = Number(value.home);
  const draw = Number(value.draw);
  const away = Number(value.away);
  if (![home, draw, away].every(Number.isFinite)) return null;
  return { home, draw, away };
};

const qualityPayload = (quality) => {
  if (!isObject(quality)) return null;
  const components = isObject(quality.components)
    ? Object.fromEntries(Object.entries(quality.components).sort(([left], [right]) => left.localeCompare(right)).map(([key, component]) => [key, {
      status: compact(component?.status) || "missing",
      score: Number.isFinite(Number(component?.score)) ? Number(component.score) : null,
      source: compact(component?.source).slice(0, 80) || null,
    }]))
    : {};
  return stableValue({
    version: compact(quality.version) || null,
    score: Number.isFinite(Number(quality.score)) ? Number(quality.score) : null,
    sourceQuality: compact(quality.sourceQuality) || null,
    severeMissingCount: Number.isFinite(Number(quality.severeMissingCount)) ? Number(quality.severeMissingCount) : null,
    trustPenalty: Number.isFinite(Number(quality.trustPenalty)) ? Number(quality.trustPenalty) : null,
    components,
    missingKeys: uniqSorted((quality.missing || []).map((item) => item?.key)),
    lowQualityKeys: uniqSorted(quality.lowQuality || []),
  });
};

const openResearchAuditPayload = (value) => {
  if (!isObject(value) || compact(value.version) !== "open-research-match-summary-v1") return null;
  const requestHash = compact(value.requestHash);
  const resultSetHash = compact(value.resultSetHash);
  if (!HASH_PATTERN.test(requestHash) || !HASH_PATTERN.test(resultSetHash)) return null;
  const boundedCount = (candidate) => {
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 1_000_000) : 0;
  };
  const providerStatuses = new Set(["success", "error", "disabled", "skipped"]);
  const providers = (Array.isArray(value.providers) ? value.providers : [])
    .map((provider) => ({
      provider: /^[a-z0-9-]{1,40}$/.test(compact(provider?.provider)) ? compact(provider.provider) : null,
      status: providerStatuses.has(compact(provider?.status)) ? compact(provider.status) : "error",
      resultCount: boundedCount(provider?.resultCount),
      durationMs: boundedCount(provider?.durationMs),
    }))
    .filter((provider) => provider.provider)
    .slice(0, 16)
    .sort((left, right) => left.provider.localeCompare(right.provider));
  const accessStatusSet = new Set(["open", "metadata_only", "restricted", "unknown"]);
  const accessStatuses = (Array.isArray(value.accessStatuses) ? value.accessStatuses : [])
    .map((entry) => ({
      accessStatus: accessStatusSet.has(compact(entry?.accessStatus)) ? compact(entry.accessStatus) : null,
      resultCount: boundedCount(entry?.resultCount),
    }))
    .filter((entry) => entry.accessStatus)
    .slice(0, accessStatusSet.size)
    .sort((left, right) => left.accessStatus.localeCompare(right.accessStatus));
  const resultHashes = uniqSorted(Array.isArray(value.resultHashes) ? value.resultHashes : [])
    .filter((hash) => HASH_PATTERN.test(hash))
    .slice(0, 50);
  return stableValue({
    version: "open-research-match-summary-v1",
    requestHash,
    resultSetHash,
    counts: {
      resultCount: boundedCount(value?.counts?.resultCount),
      providerCount: boundedCount(value?.counts?.providerCount),
      failureCount: boundedCount(value?.counts?.failureCount),
      cacheHitCount: boundedCount(value?.counts?.cacheHitCount),
    },
    providers,
    accessStatuses,
    resultHashes,
  });
};

const buildLlmEvidenceBundle = ({
  match,
  evaluatedAt,
  cutoffTime,
  sourcePredictionSignature,
} = {}) => {
  const evaluationIso = canonicalIso(evaluatedAt);
  const cutoffIso = canonicalIso(cutoffTime);
  const matchId = compact(match?.id);
  const signature = compact(sourcePredictionSignature);
  if (!evaluationIso || !cutoffIso || !matchId || !signature) {
    return finalizeBundle({
      version: RETRIEVAL_VERSION,
      policyVersion: REVIEW_POLICY_VERSION,
      evaluatedAt: evaluationIso,
      cutoffTime: cutoffIso,
      matchId: matchId || null,
      sourcePredictionSignature: signature || null,
      evidence: [],
      blockers: [
        ...(!evaluationIso ? ["evaluation-time-invalid"] : []),
        ...(!cutoffIso ? ["cutoff-time-invalid"] : []),
        ...(!matchId ? ["match-id-missing"] : []),
        ...(!signature ? ["prediction-signature-missing"] : []),
      ],
      policy: "Only content-addressed structured pre-match state may enter the LLM prompt. Raw external signal payloads, snippets, URLs and instructions are excluded.",
    });
  }
  const evaluationMs = Date.parse(evaluationIso);
  const cutoffMs = Date.parse(cutoffIso);
  const decisionAvailableAt = canonicalIso(
    match?.predictionMeta?.decisionGeneratedAt
    || match?.predictionMeta?.generatedAt
    || match?.predictionMeta?.lockedAt
    || match?.probabilityModel?.generatedAt
    || evaluationIso
  );
  const evidence = [];
  if (decisionAvailableAt && Date.parse(decisionAvailableAt) <= evaluationMs && evaluationMs <= cutoffMs) {
    evidence.push(finalizeEvidence({
      version: "llm-structured-evidence-v1",
      kind: "algorithm-decision-state",
      source: "internal-content-addressed-prediction-state",
      matchId,
      availableAt: decisionAvailableAt,
      cutoffTime: cutoffIso,
      sourcePredictionSignature: signature,
      payload: {
        homeTeamId: compact(match?.homeTeamId) || null,
        awayTeamId: compact(match?.awayTeamId) || null,
        homeTeamName: compact(match?.homeTeamName).slice(0, 120) || null,
        awayTeamName: compact(match?.awayTeamName).slice(0, 120) || null,
        leagueId: compact(match?.leagueId) || null,
        leagueName: compact(match?.leagueName).slice(0, 120) || null,
        kickoffTime: canonicalIso(match?.kickoffTime),
        status: compact(match?.status) || null,
        officialOdds: {
          had: compactOdds(match?.odds),
          hhad: compactOdds(match?.handicapOdds),
          handicapLine: match?.handicapLine ?? null,
        },
        predictions: (Array.isArray(match?.predictions) ? match.predictions : []).map(compactPrediction),
        model: {
          version: compact(match?.probabilityModel?.version) || null,
          oneXTwoFinal: compactTriplet(match?.probabilityModel?.oneXTwo?.final),
          handicapFinal: compactTriplet(match?.probabilityModel?.handicap?.final),
          goalLines: isObject(match?.probabilityModel?.goalLines) ? {
            over25: Number.isFinite(Number(match.probabilityModel.goalLines.over25)) ? Number(match.probabilityModel.goalLines.over25) : null,
            under25: Number.isFinite(Number(match.probabilityModel.goalLines.under25)) ? Number(match.probabilityModel.goalLines.under25) : null,
          } : null,
        },
      },
    }));
  }
  const preMatch = match?.externalSignals?.preMatch;
  const quality = qualityPayload(preMatch?.quality);
  const qualityAvailableAt = canonicalIso(preMatch?.updatedAt);
  if (quality && qualityAvailableAt
      && Date.parse(qualityAvailableAt) <= evaluationMs
      && Date.parse(qualityAvailableAt) <= cutoffMs) {
    evidence.push(finalizeEvidence({
      version: "llm-structured-evidence-v1",
      kind: "pre-match-quality-audit",
      source: "pre-match-quality-layer",
      matchId,
      availableAt: qualityAvailableAt,
      cutoffTime: cutoffIso,
      sourcePredictionSignature: signature,
      payload: quality,
    }));
  }
  const openResearch = match?.externalSignals?.openResearch;
  const openResearchPayload = openResearchAuditPayload(openResearch);
  const openResearchAvailableAt = canonicalIso(openResearch?.updatedAt || openResearch?.generatedAt);
  if (openResearchPayload && openResearchAvailableAt
      && Date.parse(openResearchAvailableAt) <= evaluationMs
      && Date.parse(openResearchAvailableAt) <= cutoffMs) {
    evidence.push(finalizeEvidence({
      version: "llm-structured-evidence-v1",
      kind: "open-research-coverage-audit",
      source: "open-research-gateway",
      matchId,
      availableAt: openResearchAvailableAt,
      cutoffTime: cutoffIso,
      sourcePredictionSignature: signature,
      payload: openResearchPayload,
    }));
  }
  const blockers = [];
  if (evaluationMs > cutoffMs) blockers.push("evaluation-after-cutoff");
  if (!evidence.length) blockers.push("structured-evidence-empty");
  return finalizeBundle({
    version: RETRIEVAL_VERSION,
    policyVersion: REVIEW_POLICY_VERSION,
    evaluatedAt: evaluationIso,
    cutoffTime: cutoffIso,
    matchId,
    sourcePredictionSignature: signature,
    evidence: evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    blockers,
    policy: "Only content-addressed structured pre-match state may enter the LLM prompt. Raw external signal payloads, snippets, URLs and instructions are excluded.",
  });
};

const forbiddenKeys = new Set(["externalsignals", "rawsnippet", "rawhtml", "prompt", "instructions", "sourceurl", "url"]);
const findForbiddenKeys = (value, path = "$") => {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findForbiddenKeys(item, `${path}[${index}]`)));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) found.push(`${path}.${key}`);
      found.push(...findForbiddenKeys(child, `${path}.${key}`));
    }
  }
  return found;
};

const validateLlmEvidenceBundle = (bundle) => {
  const errors = [];
  if (!isObject(bundle)) return { valid: false, errors: ["bundle-invalid"] };
  if (bundle.version !== RETRIEVAL_VERSION) errors.push("bundle-version-invalid");
  if (bundle.policyVersion !== REVIEW_POLICY_VERSION) errors.push("bundle-policy-invalid");
  const evaluatedAt = canonicalIso(bundle.evaluatedAt);
  const cutoffTime = canonicalIso(bundle.cutoffTime);
  if (!evaluatedAt) errors.push("bundle-evaluated-at-invalid");
  if (!cutoffTime) errors.push("bundle-cutoff-invalid");
  if (evaluatedAt && cutoffTime && Date.parse(evaluatedAt) > Date.parse(cutoffTime)) errors.push("bundle-evaluated-after-cutoff");
  if (!compact(bundle.matchId)) errors.push("bundle-match-id-missing");
  if (!compact(bundle.sourcePredictionSignature)) errors.push("bundle-prediction-signature-missing");
  if (!Array.isArray(bundle.evidence) || !bundle.evidence.length) errors.push("bundle-evidence-empty");
  const ids = new Set();
  for (const evidence of bundle.evidence || []) {
    const expected = sha256(stableStringify(evidenceBody(evidence)));
    if (!HASH_PATTERN.test(compact(evidence.evidenceId))) errors.push("evidence-id-invalid");
    if (evidence.evidenceId !== expected) errors.push("evidence-id-mismatch");
    if (ids.has(evidence.evidenceId)) errors.push("evidence-id-duplicate");
    ids.add(evidence.evidenceId);
    const availableAt = canonicalIso(evidence.availableAt);
    if (!availableAt) errors.push("evidence-available-at-invalid");
    if (evidence.matchId !== bundle.matchId) errors.push("evidence-match-id-mismatch");
    if (evidence.sourcePredictionSignature !== bundle.sourcePredictionSignature) errors.push("evidence-prediction-signature-mismatch");
    if (availableAt && evaluatedAt && Date.parse(availableAt) > Date.parse(evaluatedAt)) errors.push("evidence-available-after-evaluation");
    if (availableAt && cutoffTime && Date.parse(availableAt) > Date.parse(cutoffTime)) errors.push("evidence-available-after-cutoff");
  }
  if (Array.isArray(bundle.blockers) && bundle.blockers.length) errors.push(...bundle.blockers.map((item) => `bundle-blocker:${item}`));
  const forbidden = findForbiddenKeys(bundle.evidence || []);
  if (forbidden.length) errors.push(...forbidden.map((item) => `forbidden-retrieval-field:${item}`));
  const expectedHash = sha256(stableStringify(bundleBody(bundle)));
  if (!HASH_PATTERN.test(compact(bundle.retrievalHash))) errors.push("retrieval-hash-invalid");
  if (bundle.retrievalHash !== expectedHash) errors.push("retrieval-hash-mismatch");
  return { valid: errors.length === 0, errors, evidenceIds: Array.from(ids).sort(), retrievalHash: expectedHash };
};

const citedEvidenceIdsFromParsed = (parsed, allowedIds = []) => {
  const allowed = new Set(allowedIds);
  const values = [
    ...(Array.isArray(parsed?.evidenceIds) ? parsed.evidenceIds : []),
    ...(Array.isArray(parsed?.citedEvidenceIds) ? parsed.citedEvidenceIds : []),
    ...(Array.isArray(parsed?.citations) ? parsed.citations : []),
  ].map((item) => typeof item === "string" ? item : item?.evidenceId);
  return uniqSorted(values).filter((item) => allowed.has(item));
};

const reviewHasContent = (review) => Boolean(
  compact(review?.riskReview?.summary)
  || (Array.isArray(review?.riskReview?.tags) && review.riskReview.tags.length)
  || (Array.isArray(review?.riskReview?.notes) && review.riskReview.notes.length)
  || compact(review?.tierAdjustment?.reason)
  || compact(review?.explanation?.zh)
  || compact(review?.explanation?.en)
  || (Array.isArray(review?.missingData) && review.missingData.length)
);

const validateLlmReviewRow = (row, {
  expectedMatchId = null,
  expectedPredictionSignature = null,
  expectedCutoffTime = null,
} = {}) => {
  const errors = [];
  if (!isObject(row)) return { valid: false, errors: ["row-invalid"] };
  const generatedAt = canonicalIso(row.generatedAt || row?.llmReview?.generatedAt);
  if (!generatedAt) errors.push("row-generated-at-invalid");
  if (expectedMatchId && row.matchId !== expectedMatchId) errors.push("row-match-id-mismatch");
  const review = row.llmReview;
  if (!isObject(review)) errors.push("llm-review-missing");
  if (review?.ok !== true || review?.skipped === true) errors.push("llm-review-not-successful");
  if (review?.reviewRole !== "llm-risk-review") errors.push("llm-review-role-invalid");
  const bundleValidation = validateLlmEvidenceBundle(row.retrievalBundle);
  if (!bundleValidation.valid) errors.push(...bundleValidation.errors.map((item) => `retrieval:${item}`));
  if (expectedPredictionSignature && row?.retrievalBundle?.sourcePredictionSignature !== expectedPredictionSignature) {
    errors.push("row-prediction-signature-mismatch");
  }
  if (expectedCutoffTime && canonicalIso(row?.retrievalBundle?.cutoffTime) !== canonicalIso(expectedCutoffTime)) {
    errors.push("row-cutoff-mismatch");
  }
  const cutoffTime = canonicalIso(row?.retrievalBundle?.cutoffTime);
  const evaluatedAt = canonicalIso(row?.retrievalBundle?.evaluatedAt);
  if (generatedAt && cutoffTime && Date.parse(generatedAt) > Date.parse(cutoffTime)) errors.push("row-generated-after-cutoff");
  if (generatedAt && evaluatedAt && Date.parse(evaluatedAt) > Date.parse(generatedAt)) errors.push("row-generated-before-retrieval");
  const audit = review?.audit || {};
  if (audit.retrievalVersion !== RETRIEVAL_VERSION) errors.push("audit-retrieval-version-invalid");
  if (audit.retrievalHash !== row?.retrievalBundle?.retrievalHash) errors.push("audit-retrieval-hash-mismatch");
  if (audit.sourcePredictionSignature !== row?.retrievalBundle?.sourcePredictionSignature) errors.push("audit-prediction-signature-mismatch");
  const cited = uniqSorted(audit.citedEvidenceIds || []);
  const allowed = new Set(bundleValidation.evidenceIds || []);
  if (reviewHasContent(review) && !cited.length) errors.push("review-citations-missing");
  if (cited.some((id) => !allowed.has(id))) errors.push("review-citation-unknown");
  if (audit.evidenceCitationsValid !== true) errors.push("review-citations-not-validated");
  if (Number(audit.retrievedEvidenceCount) !== allowed.size) errors.push("audit-evidence-count-mismatch");
  if (Array.isArray(audit.deniedOutputFields) && audit.deniedOutputFields.length) errors.push("review-denied-output-fields-present");
  if (audit.generatedBeforeCutoff !== true) errors.push("audit-generated-before-cutoff-false");
  return { valid: errors.length === 0, errors, citedEvidenceIds: cited, retrievalHash: row?.retrievalBundle?.retrievalHash || null };
};

module.exports = {
  HASH_PATTERN,
  RETRIEVAL_VERSION,
  REVIEW_POLICY_VERSION,
  buildLlmEvidenceBundle,
  citedEvidenceIdsFromParsed,
  finalizeBundle,
  finalizeEvidence,
  reviewHasContent,
  stableStringify,
  validateLlmEvidenceBundle,
  validateLlmReviewRow,
};
