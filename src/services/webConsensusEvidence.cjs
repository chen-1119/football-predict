const crypto = require("node:crypto");
const { URL } = require("node:url");

const WEB_CONSENSUS_EVIDENCE_VERSION = "web-consensus-evidence-v2";
const WEB_CONSENSUS_PROMOTION_MANIFEST_VERSION = "web-consensus-promotion-manifest-v1";
const WEB_CONSENSUS_NUMERIC_POLICY_VERSION = "web-consensus-numeric-policy-disabled-v2";
const WEB_CONSENSUS_EVIDENCE_SCHEMA_VERSION = "web-consensus-evidence-schema-v1";
const MIN_INDEPENDENT_SOURCES = 2;
const MIN_PROMOTION_ROWS = 500;
const MIN_PROMOTION_WINDOWS = 6;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_STORAGE_POLICIES = new Set(["metadata-only", "short-excerpt"]);
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?/i,
  /(?:reveal|print|repeat|show)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message)/i,
  /(?:system|developer)\s+(?:prompt|message)\s*[:：]/i,
  /follow\s+these\s+instructions?\s+instead/i,
  /disregard\s+(?:all\s+)?(?:previous|prior)/i,
  /忽略(?:此前|之前|以上|所有).{0,12}(?:指令|要求|提示)/i,
  /(?:泄露|输出|展示).{0,12}(?:系统提示|开发者消息|隐藏提示)/i,
];

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
};

const stableHash = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(stableValue(value)))
  .digest("hex");

const bodyWithoutHash = (value) => {
  const body = { ...(value || {}) };
  delete body.manifestHash;
  return body;
};

const promotionBlockers = (manifest = {}) => {
  const blockers = [];
  const rows = Number(manifest?.sample?.rows);
  const windows = Number(manifest?.sample?.independentWindows);
  const clockRows = Number(manifest?.sample?.completeDecisionClockRows);
  const brier = Number(manifest?.metrics?.brierImprovement);
  const logLoss = Number(manifest?.metrics?.logLossImprovement);
  const conflicts = Number(manifest?.evidence?.conflictingRows);
  const derivedRows = Number(manifest?.evidence?.derivedAvailabilityRows);
  if (manifest.version !== WEB_CONSENSUS_PROMOTION_MANIFEST_VERSION) blockers.push("promotion-manifest-version-invalid");
  if (manifest.featureVersion !== WEB_CONSENSUS_EVIDENCE_VERSION) blockers.push("promotion-feature-version-mismatch");
  if (manifest.policyVersion !== WEB_CONSENSUS_NUMERIC_POLICY_VERSION) blockers.push("promotion-policy-version-mismatch");
  if (!HASH_PATTERN.test(String(manifest.evaluationRootHash || ""))) blockers.push("promotion-evaluation-root-invalid");
  if (!Number.isInteger(rows) || rows < MIN_PROMOTION_ROWS) blockers.push(`promotion-rows:${Number.isFinite(rows) ? rows : "missing"}<${MIN_PROMOTION_ROWS}`);
  if (!Number.isInteger(windows) || windows < MIN_PROMOTION_WINDOWS) blockers.push(`promotion-windows:${Number.isFinite(windows) ? windows : "missing"}<${MIN_PROMOTION_WINDOWS}`);
  if (!Number.isInteger(clockRows) || clockRows !== rows) blockers.push("promotion-decision-clock-coverage-incomplete");
  if (manifest?.evidence?.pairedByMatch !== true) blockers.push("promotion-same-match-pairing-unverified");
  if (manifest?.evidence?.samePredictionTime !== true) blockers.push("promotion-same-time-pairing-unverified");
  if (!Number.isFinite(conflicts) || conflicts !== 0) blockers.push("promotion-evidence-conflict");
  if (!Number.isFinite(derivedRows) || derivedRows !== 0) blockers.push("promotion-derived-availability-present");
  if (!Number.isFinite(brier) || brier <= 0) blockers.push("promotion-brier-not-improved");
  if (!Number.isFinite(logLoss) || logLoss <= 0) blockers.push("promotion-logloss-not-improved");
  return blockers;
};

const buildWebConsensusPromotionManifest = (input = {}) => {
  const base = stableValue({
    version: WEB_CONSENSUS_PROMOTION_MANIFEST_VERSION,
    featureVersion: WEB_CONSENSUS_EVIDENCE_VERSION,
    policyVersion: WEB_CONSENSUS_NUMERIC_POLICY_VERSION,
    generatedAt: input.generatedAt || null,
    evaluationRootHash: input.evaluationRootHash || null,
    sample: {
      rows: Number(input?.sample?.rows),
      independentWindows: Number(input?.sample?.independentWindows),
      completeDecisionClockRows: Number(input?.sample?.completeDecisionClockRows),
    },
    metrics: {
      brierImprovement: Number(input?.metrics?.brierImprovement),
      logLossImprovement: Number(input?.metrics?.logLossImprovement),
    },
    evidence: {
      pairedByMatch: input?.evidence?.pairedByMatch === true,
      samePredictionTime: input?.evidence?.samePredictionTime === true,
      conflictingRows: Number(input?.evidence?.conflictingRows),
      derivedAvailabilityRows: Number(input?.evidence?.derivedAvailabilityRows),
    },
  });
  const blockers = promotionBlockers(base);
  const body = { ...base, promotionEligible: blockers.length === 0, blockers };
  return { ...body, manifestHash: stableHash(body) };
};

const verifyWebConsensusPromotionManifest = (manifest, { expectedHash = null } = {}) => {
  const blockers = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, manifestHash: null, blockers: ["promotion-manifest-missing"] };
  }
  const actualHash = String(manifest.manifestHash || "").toLowerCase();
  if (!HASH_PATTERN.test(actualHash)) blockers.push("promotion-manifest-hash-invalid");
  if (HASH_PATTERN.test(actualHash) && stableHash(bodyWithoutHash(manifest)) !== actualHash) {
    blockers.push("promotion-manifest-hash-mismatch");
  }
  const recomputedBlockers = promotionBlockers(manifest);
  if (JSON.stringify(manifest.blockers || []) !== JSON.stringify(recomputedBlockers)) {
    blockers.push("promotion-manifest-blockers-mismatch");
  }
  if (manifest.promotionEligible !== (recomputedBlockers.length === 0)) {
    blockers.push("promotion-manifest-decision-mismatch");
  }
  blockers.push(...recomputedBlockers);
  const normalizedExpected = String(expectedHash || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(normalizedExpected)) blockers.push("promotion-expected-hash-missing");
  else if (actualHash !== normalizedExpected) blockers.push("promotion-expected-hash-mismatch");
  return {
    valid: blockers.length === 0 && manifest.promotionEligible === true,
    manifestHash: HASH_PATTERN.test(actualHash) ? actualHash : null,
    blockers: unique(blockers),
  };
};

const timeMs = (value) => {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const httpsDomain = (value) => {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const normalizedText = (value) => String(value ?? "").trim();

const canonicalEvidencePayload = (source = {}) => ({
  schemaVersion: WEB_CONSENSUS_EVIDENCE_SCHEMA_VERSION,
  matchUuid: normalizedText(source.matchUuid || source.match_uuid),
  url: normalizedText(source.url),
  publisherOwner: normalizedText(source.publisherOwner || source.publisher_owner).toLowerCase(),
  publishedAt: normalizedText(source.publishedAt || source.publication_time),
  ingestedAt: normalizedText(source.ingestedAt || source.ingested_at || source.capturedAt),
  factCategory: normalizedText(source.factCategory || source.fact_category).toLowerCase(),
  extractedFact: normalizedText(source.extractedFact || source.extracted_fact),
  rawSnippet: normalizedText(source.rawSnippet || source.raw_snippet),
  riskDowngrade: normalizedText(source.riskDowngrade || source.risk_downgrade).toLowerCase(),
  lean: normalizedText(source.lean || source.oneXTwo || source.one_x_two).toLowerCase(),
  goals: normalizedText(source.goals).toLowerCase(),
  handicapView: normalizedText(source.handicapView || source.handicap_view).toLowerCase(),
  scoreShape: (Array.isArray(source.scoreShape || source.score_shape)
    ? (source.scoreShape || source.score_shape)
    : normalizedText(source.scoreShape || source.score_shape).split(/[\/,，、\s]+/))
    .map(normalizedText)
    .filter(Boolean)
    .slice(0, 5),
  rawSha256: normalizedText(source.rawSha256 || source.raw_sha256).toLowerCase(),
  sourceLicense: {
    retrievalAllowed: (source.sourceLicense || source.source_license || source.license)?.retrievalAllowed === true,
    storagePolicy: normalizedText((source.sourceLicense || source.source_license || source.license)?.storagePolicy
      || (source.sourceLicense || source.source_license || source.license)?.storage_policy).toLowerCase(),
    redistributionAllowed: (source.sourceLicense || source.source_license || source.license)?.redistributionAllowed === true,
    termsUrl: normalizedText((source.sourceLicense || source.source_license || source.license)?.termsUrl
      || (source.sourceLicense || source.source_license || source.license)?.terms_url),
  },
});

const buildWebConsensusEvidenceHash = (source) => stableHash(canonicalEvidencePayload(source));

const promptInjectionMatches = (value) => {
  const text = normalizedText(value);
  return PROMPT_INJECTION_PATTERNS
    .map((pattern) => pattern.exec(text)?.[0] || null)
    .filter(Boolean);
};

const sourceLicenseAudit = (source = {}) => {
  const value = source.sourceLicense || source.source_license || source.license;
  const present = Boolean(value && typeof value === "object" && !Array.isArray(value));
  const retrievalAllowed = present && value.retrievalAllowed === true;
  const storagePolicy = normalizedText(value?.storagePolicy || value?.storage_policy).toLowerCase();
  const redistributionAllowed = value?.redistributionAllowed === true;
  const termsUrl = normalizedText(value?.termsUrl || value?.terms_url) || null;
  const reasons = [];
  if (!present) reasons.push("source-license-missing");
  if (present && !retrievalAllowed) reasons.push("source-retrieval-not-allowed");
  if (present && !SAFE_STORAGE_POLICIES.has(storagePolicy)) reasons.push("source-storage-policy-unsafe");
  return {
    present,
    retrievalAllowed,
    storagePolicy: storagePolicy || null,
    redistributionAllowed,
    termsUrl,
    valid: reasons.length === 0,
    reasons,
  };
};

const normalizedDirection = (source = {}) => {
  const value = normalizedText(source.lean || source.oneXTwo || source.one_x_two).toLowerCase();
  if (["1", "home", "home_win", "home-win", "主胜"].includes(value)) return "home";
  if (["x", "draw", "tie", "平", "平局"].includes(value)) return "draw";
  if (["2", "away", "away_win", "away-win", "客胜"].includes(value)) return "away";
  return null;
};

const normalizedGoals = (source = {}) => {
  const value = normalizedText(source.goals).toLowerCase();
  if (["over", "over25", "over2.5", "o2.5", "大", "大2.5"].includes(value)) return "over25";
  if (["under", "under25", "under2.5", "u2.5", "小", "小2.5"].includes(value)) return "under25";
  return null;
};

const contradictionAudit = (sources = []) => {
  const dimensions = {
    oneXTwo: unique(sources.map((source) => normalizedDirection(source.raw))),
    goals: unique(sources.map((source) => normalizedGoals(source.raw))),
  };
  const conflictingDimensions = Object.entries(dimensions)
    .filter(([, values]) => values.length > 1)
    .map(([key]) => key);
  return {
    conflict: conflictingDimensions.length > 0,
    conflictingDimensions,
    dimensions,
  };
};

const assessWebConsensusEvidence = ({
  sources = [],
  capturedAt = null,
  cutoffTime = null,
  matchUuid = null,
  explicitModelOptIn = false,
  modelFeatureEnabled = false,
  promotionManifest = null,
  expectedPromotionManifestHash = null,
} = {}) => {
  const capturedMs = timeMs(capturedAt);
  const cutoffMs = timeMs(cutoffTime);
  const structuralBlockers = [];
  if (capturedMs === null) structuralBlockers.push("consensus-captured-at-missing");
  if (cutoffMs === null) structuralBlockers.push("cutoff-time-missing");
  if (capturedMs !== null && cutoffMs !== null && capturedMs > cutoffMs) {
    structuralBlockers.push("consensus-captured-after-cutoff");
  }

  const sourceAudit = (Array.isArray(sources) ? sources : []).map((source, index) => {
    const domain = httpsDomain(source?.url);
    const sourceMatchUuid = normalizedText(source?.matchUuid || source?.match_uuid);
    const expectedMatchUuid = normalizedText(matchUuid);
    // HTTP Date is a response clock and an LLM timestamp is a processing
    // clock. Neither is accepted as the publication or ingestion fact clock.
    const publishedMs = timeMs(source?.publishedAt || source?.publication_time);
    const receivedMs = timeMs(source?.ingestedAt || source?.ingested_at || source?.capturedAt);
    const extractedMs = timeMs(source?.extractedAt || source?.extracted_at);
    const evidenceHash = normalizedText(source?.evidenceHash || source?.evidence_hash).toLowerCase();
    const expectedEvidenceHash = buildWebConsensusEvidenceHash(source);
    const publisherOwner = normalizedText(source?.publisherOwner || source?.publisher_owner).toLowerCase();
    const factCategory = normalizedText(source?.factCategory || source?.fact_category).toLowerCase();
    const extractedFact = normalizedText(source?.extractedFact || source?.extracted_fact);
    const rawSnippet = normalizedText(source?.rawSnippet || source?.raw_snippet);
    const license = sourceLicenseAudit(source);
    const injectionMatches = promptInjectionMatches(`${rawSnippet}\n${extractedFact}`);
    const reasons = [];
    if (!domain) reasons.push("https-source-url-missing");
    if (!sourceMatchUuid) reasons.push("source-match-uuid-missing");
    if (expectedMatchUuid && sourceMatchUuid && sourceMatchUuid !== expectedMatchUuid) reasons.push("source-match-uuid-mismatch");
    if (!publisherOwner) reasons.push("source-publisher-owner-missing");
    if (publishedMs === null) reasons.push("source-published-at-missing");
    if (receivedMs === null) reasons.push("source-received-at-missing");
    if (!factCategory) reasons.push("source-fact-category-missing");
    if (!extractedFact) reasons.push("source-extracted-fact-missing");
    if (!rawSnippet) reasons.push("source-raw-snippet-missing");
    if (rawSnippet.length > 500) reasons.push("source-raw-snippet-too-long");
    if (!HASH_PATTERN.test(evidenceHash)) reasons.push("source-evidence-hash-missing");
    else if (evidenceHash !== expectedEvidenceHash) reasons.push("source-evidence-hash-mismatch");
    reasons.push(...license.reasons);
    if (injectionMatches.length) reasons.push("source-prompt-injection-detected");
    if (publishedMs !== null && receivedMs !== null && publishedMs > receivedMs) {
      reasons.push("source-published-after-received");
    }
    if (receivedMs !== null && extractedMs !== null && receivedMs > extractedMs) {
      reasons.push("source-received-after-extracted");
    }
    const availableMs = [publishedMs, receivedMs, extractedMs].filter((value) => value !== null);
    const latestAvailableMs = availableMs.length ? Math.max(...availableMs) : null;
    if (latestAvailableMs !== null && capturedMs !== null && latestAvailableMs > capturedMs) {
      reasons.push("source-available-after-evaluation");
    }
    if (latestAvailableMs !== null && cutoffMs !== null && latestAvailableMs > cutoffMs) {
      reasons.push("source-available-after-cutoff");
    }
    return {
      index,
      domain,
      publisherOwner: publisherOwner || null,
      matchUuid: sourceMatchUuid || null,
      factCategory: factCategory || null,
      evidenceHash: HASH_PATTERN.test(evidenceHash) ? evidenceHash : null,
      expectedEvidenceHash,
      publishedAt: publishedMs === null ? null : new Date(publishedMs).toISOString(),
      receivedAt: receivedMs === null ? null : new Date(receivedMs).toISOString(),
      extractedAt: extractedMs === null ? null : new Date(extractedMs).toISOString(),
      availableAt: latestAvailableMs === null ? null : new Date(latestAvailableMs).toISOString(),
      ignoredClocks: {
        httpDate: normalizedText(source?.httpDate || source?.http_date) || null,
        llmGeneratedAt: normalizedText(source?.llmGeneratedAt || source?.llm_generated_at) || null,
      },
      license,
      promptInjection: {
        detected: injectionMatches.length > 0,
        matches: injectionMatches,
      },
      valid: reasons.length === 0,
      reasons,
      raw: source,
    };
  });
  const validSources = sourceAudit.filter((source) => source.valid);
  const independentDomains = unique(validSources.map((source) => source.domain));
  const independentOwners = unique(validSources.map((source) => source.publisherOwner));
  const uniqueEvidenceHashes = unique(validSources.map((source) => source.evidenceHash));
  if (validSources.length < MIN_INDEPENDENT_SOURCES) {
    structuralBlockers.push(`valid-sources:${validSources.length}<${MIN_INDEPENDENT_SOURCES}`);
  }
  if (independentDomains.length < MIN_INDEPENDENT_SOURCES) {
    structuralBlockers.push(`independent-domains:${independentDomains.length}<${MIN_INDEPENDENT_SOURCES}`);
  }
  if (independentOwners.length < MIN_INDEPENDENT_SOURCES) {
    structuralBlockers.push(`independent-publisher-owners:${independentOwners.length}<${MIN_INDEPENDENT_SOURCES}`);
  }
  if (validSources.length >= MIN_INDEPENDENT_SOURCES && uniqueEvidenceHashes.length < validSources.length) {
    structuralBlockers.push("duplicate-evidence-hash-syndication");
  }
  const contradiction = contradictionAudit(validSources);
  const conflictFreeze = contradiction.conflict;
  const blockers = unique([
    ...structuralBlockers,
    ...(conflictFreeze ? ["contradictory-evidence-freeze"] : []),
  ]);
  const promotionAuthority = verifyWebConsensusPromotionManifest(promotionManifest, {
    expectedHash: expectedPromotionManifestHash,
  });
  const eligibleForRiskDisplay = structuralBlockers.length === 0;
  const eligibleForRiskAdvisory = eligibleForRiskDisplay && !conflictFreeze;
  // `eligible` used to authorize a runtime path. It is now permanently false;
  // callers must consume only the explicitly named display/advisory fields.
  const eligible = false;
  return {
    version: WEB_CONSENSUS_EVIDENCE_VERSION,
    schemaVersion: WEB_CONSENSUS_EVIDENCE_SCHEMA_VERSION,
    eligible,
    eligibleForNumericModel: false,
    eligibleForFormalQuality: false,
    eligibleForStrategyGate: false,
    eligibleForRiskDisplay,
    eligibleForRiskAdvisory,
    eligibleForRiskDowngrade: false,
    conflictFreeze,
    onlineEffect: eligibleForRiskDisplay ? "advisory-only" : "audit-only",
    blockers,
    sourceAudit: sourceAudit.map(({ raw, ...source }) => source),
    validSourceCount: validSources.length,
    independentDomains,
    independentPublisherOwners: independentOwners,
    contradiction,
    asOfPolicy: {
      rule: "publication_time <= ingested_at <= extracted_at(if present) <= evaluated_at <= forecast_cutoff",
      arbitrarySafetyBufferMinutes: 0,
      httpDateIsFactClock: false,
      llmGeneratedAtIsFactClock: false,
    },
    promotionAuthority: {
      valid: promotionAuthority.valid,
      manifestHash: promotionAuthority.manifestHash,
      expectedHashBound: promotionAuthority.valid,
      manifest: promotionAuthority.valid ? promotionManifest : null,
      role: "audit-only",
    },
    numericModelBlockers: unique([
      "numeric-model-permanently-disabled",
      ...(explicitModelOptIn ? [] : ["explicit-model-opt-in-missing"]),
      ...(modelFeatureEnabled ? [] : ["model-feature-disabled"]),
      ...promotionAuthority.blockers,
    ]),
    policy: "Web/RAG evidence is advisory display only. It cannot change formal quality, missing/trust penalties, lambda, probabilities, direction, recommendation thresholds, candidate eligibility, or optimizer gates. Conflicting evidence is frozen for review.",
  };
};

module.exports = {
  buildWebConsensusPromotionManifest,
  MIN_INDEPENDENT_SOURCES,
  MIN_PROMOTION_ROWS,
  MIN_PROMOTION_WINDOWS,
  WEB_CONSENSUS_EVIDENCE_VERSION,
  WEB_CONSENSUS_EVIDENCE_SCHEMA_VERSION,
  WEB_CONSENSUS_NUMERIC_POLICY_VERSION,
  WEB_CONSENSUS_PROMOTION_MANIFEST_VERSION,
  assessWebConsensusEvidence,
  buildWebConsensusEvidenceHash,
  canonicalEvidencePayload,
  httpsDomain,
  promptInjectionMatches,
  stableHash,
  timeMs,
  verifyWebConsensusPromotionManifest,
};
