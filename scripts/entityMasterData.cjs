"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateCandidateStore } = require("./wikidataEntityCandidates.cjs");

const VERSION = "entity-master-data-v1";
const WIKIDATA_PROVIDER = "wikidata";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const QID_PATTERN = /^Q[1-9][0-9]*$/;
const LOCAL_ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const APPROVED_STATUS = "approved";
const CONFLICT_STATUS = "quarantined-conflict";
const ALLOWED_MAPPING_STATUSES = new Set([APPROVED_STATUS, CONFLICT_STATUS]);
const ALLOWED_REVIEW_DECISIONS = new Set([APPROVED_STATUS, CONFLICT_STATUS]);
const ALLOWED_BASIS_METHODS = new Set([
  "federation-cross-check",
  "official-club-cross-check",
  "official-competition-cross-check",
  "licensed-provider-cross-check",
  "manual-documented-research",
]);

class EntityMasterDataError extends Error {
  constructor(message, code = "ENTITY_MASTER_DATA_ERROR") {
    super(message);
    this.name = "EntityMasterDataError";
    this.code = code;
  }
}

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
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashJson = (value) => sha256(Buffer.from(stableStringify(value), "utf8"));
const uniqSorted = (values) => Array.from(new Set((values || []).map(compact).filter(Boolean))).sort();
const validLocalEntityId = (value) => {
  const id = compact(value);
  return LOCAL_ENTITY_ID_PATTERN.test(id) && !new Set(["__proto__", "constructor", "prototype"]).has(id);
};

const canonicalIso = (value, field) => {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    throw new EntityMasterDataError(`${field} must be a valid timestamp`, "MDM_INVALID_TIMESTAMP");
  }
  return new Date(parsed).toISOString();
};

const canonicalOptionalIso = (value, field) => {
  if (value === null || value === undefined || value === "") return null;
  return canonicalIso(value, field);
};

const registryBody = (registry) => {
  const { registryHash: _registryHash, ...body } = registry || {};
  return stableValue(body);
};

const finalizeRegistry = (registry) => {
  const body = registryBody(registry);
  return { ...body, registryHash: hashJson(body) };
};

const recordBody = (record, idField) => {
  const body = { ...(record || {}) };
  delete body[idField];
  return stableValue(body);
};

const finalizeRecord = (record, idField) => {
  const body = recordBody(record, idField);
  return { ...body, [idField]: hashJson(body) };
};

const createEntityMasterData = ({ createdAt = new Date().toISOString() } = {}) => {
  const at = canonicalIso(createdAt, "createdAt");
  return finalizeRegistry({
    version: VERSION,
    createdAt: at,
    updatedAt: at,
    entities: {},
    reviews: [],
    conflicts: [],
  });
};

const intervalBounds = (validFrom, validTo) => {
  const start = Date.parse(validFrom);
  const end = validTo ? Date.parse(validTo) : Number.POSITIVE_INFINITY;
  return { start, end };
};

const intervalsOverlap = (left, right) => {
  const a = intervalBounds(left.validFrom, left.validTo);
  const b = intervalBounds(right.validFrom, right.validTo);
  return a.start < b.end && b.start < a.end;
};

const intervalContains = (mapping, at) => {
  const point = Date.parse(at);
  const { start, end } = intervalBounds(mapping.validFrom, mapping.validTo);
  return start <= point && point < end;
};

const normalizeReviewer = (reviewer) => {
  if (!isObject(reviewer)) {
    throw new EntityMasterDataError("an explicit human reviewer object is required", "MDM_REVIEWER_REQUIRED");
  }
  const id = compact(reviewer.id);
  if (!id || id.length < 3 || /^(auto|automatic|system|bot|agent)$/i.test(id)) {
    throw new EntityMasterDataError("reviewer.id must identify a human reviewer", "MDM_REVIEWER_INVALID");
  }
  if (reviewer.kind !== "human") {
    throw new EntityMasterDataError("reviewer.kind must be human", "MDM_REVIEWER_NOT_HUMAN");
  }
  return stableValue({
    id,
    kind: "human",
    displayName: compact(reviewer.displayName) || null,
  });
};

const trustedExternalUrl = (value) => {
  try {
    const parsed = new URL(String(value));
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return host && host !== "wikidata.org" && !host.endsWith(".wikidata.org")
      && host !== "wikipedia.org" && !host.endsWith(".wikipedia.org");
  } catch {
    return false;
  }
};

const normalizeVerificationBasis = (basis, reviewedAt) => {
  if (!isObject(basis)) {
    throw new EntityMasterDataError("verificationBasis is required", "MDM_VERIFICATION_BASIS_REQUIRED");
  }
  const method = compact(basis.method);
  const summary = compact(basis.summary);
  if (!ALLOWED_BASIS_METHODS.has(method)) {
    throw new EntityMasterDataError("verification basis method is not allowed", "MDM_VERIFICATION_METHOD_INVALID");
  }
  if (summary.length < 12) {
    throw new EntityMasterDataError("verification basis summary is too short", "MDM_VERIFICATION_SUMMARY_INVALID");
  }
  if (!Array.isArray(basis.references) || basis.references.length === 0) {
    throw new EntityMasterDataError("verification basis requires at least one independent reference", "MDM_VERIFICATION_REFERENCE_REQUIRED");
  }
  const references = basis.references.map((reference, index) => {
    if (!isObject(reference)) {
      throw new EntityMasterDataError(`verification reference ${index} is invalid`, "MDM_VERIFICATION_REFERENCE_INVALID");
    }
    const url = compact(reference.url);
    const checkedAt = canonicalIso(reference.checkedAt, `verificationBasis.references[${index}].checkedAt`);
    if (Date.parse(checkedAt) > Date.parse(reviewedAt)) {
      throw new EntityMasterDataError("verification reference is from after the review", "MDM_VERIFICATION_REFERENCE_FUTURE");
    }
    if (!trustedExternalUrl(url) || reference.independentFromCandidateSource !== true) {
      throw new EntityMasterDataError(
        "verification reference must be an independent non-Wikidata HTTP(S) source",
        "MDM_VERIFICATION_REFERENCE_NOT_INDEPENDENT",
      );
    }
    if (reference.supportsFootballIdentity !== true || reference.supportsEntityEquivalence !== true) {
      throw new EntityMasterDataError(
        "verification reference must explicitly support football identity and entity equivalence",
        "MDM_VERIFICATION_REFERENCE_INSUFFICIENT",
      );
    }
    const contentSha256 = compact(reference.contentSha256) || null;
    if (contentSha256 && !HASH_PATTERN.test(contentSha256)) {
      throw new EntityMasterDataError("verification reference content hash is invalid", "MDM_VERIFICATION_HASH_INVALID");
    }
    return stableValue({
      sourceType: compact(reference.sourceType) || "manual-reference",
      url,
      checkedAt,
      independentFromCandidateSource: true,
      supportsFootballIdentity: true,
      supportsEntityEquivalence: true,
      contentSha256,
      note: compact(reference.note) || null,
    });
  });
  return stableValue({ method, summary, references });
};

const validateReviewer = (reviewer, prefix, errors) => {
  try {
    const normalized = normalizeReviewer(reviewer);
    if (stableStringify(normalized) !== stableStringify(reviewer)) errors.push(`${prefix}:not-canonical`);
  } catch (error) { errors.push(`${prefix}:${error.code}`); }
};

const validateEntityMasterData = (registry) => {
  const errors = [];
  if (!isObject(registry)) return { valid: false, errors: ["registry-invalid"] };
  if (registry.version !== VERSION) errors.push("version-invalid");
  let createdAt = null;
  let updatedAt = null;
  try {
    createdAt = canonicalIso(registry.createdAt, "createdAt");
    if (createdAt !== registry.createdAt) errors.push("created-at-not-canonical");
  } catch { errors.push("created-at-invalid"); }
  try {
    updatedAt = canonicalIso(registry.updatedAt, "updatedAt");
    if (updatedAt !== registry.updatedAt) errors.push("updated-at-not-canonical");
  } catch { errors.push("updated-at-invalid"); }
  if (createdAt && updatedAt && Date.parse(updatedAt) < Date.parse(createdAt)) errors.push("updated-before-created");
  if (!isObject(registry.entities)) errors.push("entities-invalid");
  if (!Array.isArray(registry.reviews)) errors.push("reviews-invalid");
  if (!Array.isArray(registry.conflicts)) errors.push("conflicts-invalid");

  const reviewIds = new Set();
  const reviewsById = new Map();
  const reviewedCandidateRefs = new Set();
  for (const review of registry.reviews || []) {
    if (!isObject(review)) { errors.push("review-invalid"); continue; }
    if (review.reviewId !== hashJson(recordBody(review, "reviewId"))) errors.push(`review-hash-mismatch:${review.reviewId || "missing"}`);
    if (reviewIds.has(review.reviewId)) errors.push(`review-duplicate:${review.reviewId}`);
    reviewIds.add(review.reviewId);
    reviewsById.set(review.reviewId, review);
    if (!ALLOWED_REVIEW_DECISIONS.has(review.decision)) errors.push(`review-decision-invalid:${review.reviewId}`);
    if (review.provider !== WIKIDATA_PROVIDER || !QID_PATTERN.test(compact(review.providerEntityId))) {
      errors.push(`review-provider-invalid:${review.reviewId}`);
    }
    if (!HASH_PATTERN.test(compact(review.candidateStoreHash)) || !HASH_PATTERN.test(compact(review.candidateId))) {
      errors.push(`review-candidate-reference-invalid:${review.reviewId}`);
    }
    const replayKey = `${review.candidateStoreHash}:${review.localEntityId}:${review.candidateId}`;
    if (reviewedCandidateRefs.has(replayKey)) errors.push(`review-replay:${review.reviewId}`);
    reviewedCandidateRefs.add(replayKey);
    validateReviewer(review.reviewer, `reviewer-invalid:${review.reviewId}`, errors);
    try {
      const reviewedAt = canonicalIso(review.reviewedAt, "reviewedAt");
      if (reviewedAt !== review.reviewedAt) errors.push(`reviewed-at-not-canonical:${review.reviewId}`);
      const normalizedBasis = normalizeVerificationBasis(review.verificationBasis, reviewedAt);
      if (stableStringify(normalizedBasis) !== stableStringify(review.verificationBasis)) {
        errors.push(`review-basis-not-canonical:${review.reviewId}`);
      }
    } catch (error) {
      errors.push(`review-basis-invalid:${review.reviewId}:${error.code || "invalid"}`);
    }
  }

  const approvedMappings = [];
  const mappingIds = new Set();
  const mappingsById = new Map();
  const usedReviewIds = new Set();
  for (const [entityKey, entity] of Object.entries(registry.entities || {})) {
    if (!isObject(entity) || compact(entity.localEntityId) !== entityKey
        || !validLocalEntityId(entityKey) || entity.entityType !== "team") {
      errors.push(`entity-invalid:${entityKey}`);
      continue;
    }
    if (!Array.isArray(entity.canonicalNames) || entity.canonicalNames.length === 0) errors.push(`entity-names-invalid:${entityKey}`);
    if (!Array.isArray(entity.providerMappings)) { errors.push(`entity-mappings-invalid:${entityKey}`); continue; }
    for (const mapping of entity.providerMappings) {
      if (!isObject(mapping)) { errors.push(`mapping-invalid:${entityKey}`); continue; }
      if (mapping.mappingId !== hashJson(recordBody(mapping, "mappingId"))) errors.push(`mapping-hash-mismatch:${mapping.mappingId || "missing"}`);
      if (mappingIds.has(mapping.mappingId)) errors.push(`mapping-duplicate:${mapping.mappingId}`);
      mappingIds.add(mapping.mappingId);
      mappingsById.set(mapping.mappingId, mapping);
      if (mapping.localEntityId !== entityKey) errors.push(`mapping-local-mismatch:${mapping.mappingId}`);
      if (mapping.provider !== WIKIDATA_PROVIDER || !QID_PATTERN.test(compact(mapping.providerEntityId))) {
        errors.push(`mapping-provider-invalid:${mapping.mappingId}`);
      }
      if (!ALLOWED_MAPPING_STATUSES.has(mapping.status)) errors.push(`mapping-status-invalid:${mapping.mappingId}`);
      let validFrom = null;
      let validTo = null;
      try {
        validFrom = canonicalIso(mapping.validFrom, "validFrom");
        if (validFrom !== mapping.validFrom) errors.push(`mapping-valid-from-not-canonical:${mapping.mappingId}`);
      } catch { errors.push(`mapping-valid-from-invalid:${mapping.mappingId}`); }
      try {
        validTo = canonicalOptionalIso(mapping.validTo, "validTo");
        if (validTo !== mapping.validTo) errors.push(`mapping-valid-to-not-canonical:${mapping.mappingId}`);
      } catch { errors.push(`mapping-valid-to-invalid:${mapping.mappingId}`); }
      if (validFrom && validTo && Date.parse(validTo) <= Date.parse(validFrom)) errors.push(`mapping-interval-invalid:${mapping.mappingId}`);
      validateReviewer(mapping.reviewer, `mapping-reviewer-invalid:${mapping.mappingId}`, errors);
      if (!reviewIds.has(mapping.reviewId)) errors.push(`mapping-review-unknown:${mapping.mappingId}`);
      if (usedReviewIds.has(mapping.reviewId)) errors.push(`mapping-review-reused:${mapping.mappingId}`);
      usedReviewIds.add(mapping.reviewId);
      if (!HASH_PATTERN.test(compact(mapping.verificationBasisHash))) errors.push(`mapping-basis-hash-invalid:${mapping.mappingId}`);
      if (!Array.isArray(mapping.evidence) || mapping.evidence.length === 0) errors.push(`mapping-evidence-missing:${mapping.mappingId}`);
      for (const evidence of mapping.evidence || []) {
        if (evidence.evidenceId !== hashJson(recordBody(evidence, "evidenceId"))) {
          errors.push(`mapping-evidence-hash-mismatch:${mapping.mappingId}`);
        }
        if (!HASH_PATTERN.test(compact(evidence.candidateStoreHash)) || !HASH_PATTERN.test(compact(evidence.candidateId))) {
          errors.push(`mapping-evidence-reference-invalid:${mapping.mappingId}`);
        }
        if (!Array.isArray(evidence.receiptIds) || evidence.receiptIds.length === 0
            || evidence.receiptIds.some((id) => !HASH_PATTERN.test(compact(id)))) {
          errors.push(`mapping-evidence-receipts-invalid:${mapping.mappingId}`);
        }
        try {
          const generatedAt = canonicalIso(evidence.candidateGeneratedAt, "candidateGeneratedAt");
          if (generatedAt !== evidence.candidateGeneratedAt) errors.push(`mapping-evidence-time-not-canonical:${mapping.mappingId}`);
        } catch { errors.push(`mapping-evidence-time-invalid:${mapping.mappingId}`); }
      }
      const review = reviewsById.get(mapping.reviewId);
      if (review) {
        if (review.decision !== mapping.status
            || review.localEntityId !== mapping.localEntityId
            || review.provider !== mapping.provider
            || review.providerEntityId !== mapping.providerEntityId
            || review.requestedInterval?.validFrom !== mapping.validFrom
            || review.requestedInterval?.validTo !== mapping.validTo) {
          errors.push(`mapping-review-content-mismatch:${mapping.mappingId}`);
        }
        if (stableStringify(review.reviewer) !== stableStringify(mapping.reviewer)) {
          errors.push(`mapping-reviewer-mismatch:${mapping.mappingId}`);
        }
        if (mapping.verificationBasisHash !== hashJson(review.verificationBasis)) {
          errors.push(`mapping-review-basis-mismatch:${mapping.mappingId}`);
        }
        if (mapping.createdAt !== review.reviewedAt) errors.push(`mapping-created-at-mismatch:${mapping.mappingId}`);
        if ((mapping.evidence || []).some((evidence) => (
          evidence.candidateStoreHash !== review.candidateStoreHash || evidence.candidateId !== review.candidateId
        ))) errors.push(`mapping-review-evidence-mismatch:${mapping.mappingId}`);
      }
      if (mapping.status === APPROVED_STATUS) approvedMappings.push(mapping);
    }
  }

  for (const reviewId of reviewIds) {
    if (!usedReviewIds.has(reviewId)) errors.push(`review-without-mapping:${reviewId}`);
  }

  for (let leftIndex = 0; leftIndex < approvedMappings.length; leftIndex += 1) {
    const left = approvedMappings[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < approvedMappings.length; rightIndex += 1) {
      const right = approvedMappings[rightIndex];
      if (left.provider !== right.provider || !intervalsOverlap(left, right)) continue;
      if (left.localEntityId === right.localEntityId && left.providerEntityId !== right.providerEntityId) {
        errors.push(`approved-local-interval-conflict:${left.mappingId}:${right.mappingId}`);
      }
      if (left.localEntityId !== right.localEntityId && left.providerEntityId === right.providerEntityId) {
        errors.push(`approved-provider-interval-conflict:${left.mappingId}:${right.mappingId}`);
      }
      if (left.localEntityId === right.localEntityId && left.providerEntityId === right.providerEntityId) {
        errors.push(`approved-duplicate-interval:${left.mappingId}:${right.mappingId}`);
      }
    }
  }

  const conflictIds = new Set();
  const conflictedProposalIds = new Set();
  for (const conflict of registry.conflicts || []) {
    if (!isObject(conflict)) { errors.push("conflict-invalid"); continue; }
    if (conflict.conflictId !== hashJson(recordBody(conflict, "conflictId"))) errors.push(`conflict-hash-mismatch:${conflict.conflictId || "missing"}`);
    if (conflictIds.has(conflict.conflictId)) errors.push(`conflict-duplicate:${conflict.conflictId}`);
    conflictIds.add(conflict.conflictId);
    if (!mappingIds.has(conflict.proposedMappingId)) errors.push(`conflict-proposal-unknown:${conflict.conflictId}`);
    if (!Array.isArray(conflict.existingMappingIds) || conflict.existingMappingIds.length === 0
        || conflict.existingMappingIds.some((id) => !mappingIds.has(id))) {
      errors.push(`conflict-existing-unknown:${conflict.conflictId}`);
    }
    const proposedMapping = mappingsById.get(conflict.proposedMappingId);
    const existingMappings = (conflict.existingMappingIds || []).map((id) => mappingsById.get(id)).filter(Boolean);
    if (proposedMapping?.status !== CONFLICT_STATUS) errors.push(`conflict-proposal-not-quarantined:${conflict.conflictId}`);
    if (existingMappings.some((mapping) => mapping.status !== APPROVED_STATUS)) {
      errors.push(`conflict-existing-not-approved:${conflict.conflictId}`);
    }
    if (proposedMapping && existingMappings.some((mapping) => !intervalsOverlap(proposedMapping, mapping))) {
      errors.push(`conflict-interval-not-overlapping:${conflict.conflictId}`);
    }
    if (!proposedMapping || conflict.provider !== proposedMapping.provider
        || conflict.resolution !== "quarantined-no-overwrite") {
      errors.push(`conflict-policy-invalid:${conflict.conflictId}`);
    }
    if (proposedMapping && conflict.type === "local-entity-overlapping-provider-identities") {
      if (existingMappings.some((mapping) => mapping.localEntityId !== proposedMapping.localEntityId
          || mapping.providerEntityId === proposedMapping.providerEntityId)
          || stableStringify(conflict.localEntityIds) !== stableStringify([proposedMapping.localEntityId])
          || stableStringify(conflict.providerEntityIds) !== stableStringify(uniqSorted([
            proposedMapping.providerEntityId,
            ...existingMappings.map((mapping) => mapping.providerEntityId),
          ]))) {
        errors.push(`conflict-local-identity-invalid:${conflict.conflictId}`);
      }
    } else if (proposedMapping && conflict.type === "provider-entity-overlapping-local-identities") {
      if (existingMappings.some((mapping) => mapping.localEntityId === proposedMapping.localEntityId
          || mapping.providerEntityId !== proposedMapping.providerEntityId)
          || stableStringify(conflict.localEntityIds) !== stableStringify(uniqSorted([
            proposedMapping.localEntityId,
            ...existingMappings.map((mapping) => mapping.localEntityId),
          ]))
          || stableStringify(conflict.providerEntityIds) !== stableStringify([proposedMapping.providerEntityId])) {
        errors.push(`conflict-provider-identity-invalid:${conflict.conflictId}`);
      }
    } else if (proposedMapping) {
      errors.push(`conflict-type-invalid:${conflict.conflictId}`);
    }
    try {
      const detectedAt = canonicalIso(conflict.detectedAt, "conflict.detectedAt");
      if (detectedAt !== conflict.detectedAt) errors.push(`conflict-time-not-canonical:${conflict.conflictId}`);
    } catch { errors.push(`conflict-time-invalid:${conflict.conflictId}`); }
    conflictedProposalIds.add(conflict.proposedMappingId);
  }

  for (const mapping of mappingsById.values()) {
    if (mapping.status === CONFLICT_STATUS && !conflictedProposalIds.has(mapping.mappingId)) {
      errors.push(`quarantined-mapping-without-conflict:${mapping.mappingId}`);
    }
  }

  if (updatedAt && createdAt) {
    const latestReviewAt = (registry.reviews || []).reduce(
      (latest, review) => (Date.parse(review.reviewedAt) > Date.parse(latest) ? review.reviewedAt : latest),
      createdAt,
    );
    if (updatedAt !== latestReviewAt) errors.push("updated-at-not-latest-review");
  }

  if (!HASH_PATTERN.test(compact(registry.registryHash)) || registry.registryHash !== hashJson(registryBody(registry))) {
    errors.push("registry-hash-mismatch");
  }
  return { valid: errors.length === 0, errors };
};

const assertEntityMasterData = (registry) => {
  const validation = validateEntityMasterData(registry);
  if (!validation.valid) {
    throw new EntityMasterDataError(`invalid entity master data: ${validation.errors.join(", ")}`, "MDM_REGISTRY_INVALID");
  }
  return registry;
};

const candidateFromStore = ({ candidateStore, localEntityId, candidateId, expectedCandidateStoreHash }) => {
  const validation = validateCandidateStore(candidateStore);
  if (!validation.valid) {
    throw new EntityMasterDataError(`candidate store is invalid: ${validation.errors.join(", ")}`, "MDM_CANDIDATE_STORE_INVALID");
  }
  if (!HASH_PATTERN.test(compact(expectedCandidateStoreHash)) || expectedCandidateStoreHash !== candidateStore.storeHash) {
    throw new EntityMasterDataError("candidate store hash was not explicitly pinned", "MDM_CANDIDATE_STORE_HASH_MISMATCH");
  }
  const entity = (candidateStore.entities || []).find((row) => row.localEntityId === localEntityId);
  const candidate = (entity?.candidates || []).find((row) => row.candidateId === candidateId);
  if (!entity || !candidate) {
    throw new EntityMasterDataError("candidate is not present for the requested local entity", "MDM_CANDIDATE_UNKNOWN");
  }
  if (candidate.provider !== WIKIDATA_PROVIDER || !QID_PATTERN.test(compact(candidate.providerEntityId))) {
    throw new EntityMasterDataError("candidate provider identity is invalid", "MDM_CANDIDATE_PROVIDER_INVALID");
  }
  if (candidate.reviewState !== "quarantined" || candidate.autoPromotable !== false) {
    throw new EntityMasterDataError("candidate was not received through the quarantine boundary", "MDM_CANDIDATE_NOT_QUARANTINED");
  }
  if (candidate.footballEvidence !== true) {
    throw new EntityMasterDataError("candidate lacks football identity evidence", "MDM_CANDIDATE_NOT_FOOTBALL");
  }
  if (candidate.exactBaseName !== true && candidate.exactContextQuery !== true) {
    throw new EntityMasterDataError("fuzzy-only candidate cannot be approved", "MDM_CANDIDATE_FUZZY_ONLY");
  }
  return { entity, candidate };
};

const approvedMappingsFor = (registry, provider) => Object.values(registry.entities || {})
  .flatMap((entity) => entity.providerMappings || [])
  .filter((mapping) => mapping.provider === provider && mapping.status === APPROVED_STATUS);

const applyWikidataCandidateApproval = ({
  registry,
  candidateStore,
  localEntityId,
  candidateId,
  expectedCandidateStoreHash,
  reviewer,
  verificationBasis,
  reviewedAt = new Date().toISOString(),
  validFrom = reviewedAt,
  validTo = null,
}) => {
  assertEntityMasterData(registry);
  const localId = compact(localEntityId);
  if (!validLocalEntityId(localId)) {
    throw new EntityMasterDataError("localEntityId is missing or unsafe", "MDM_LOCAL_ENTITY_INVALID");
  }
  const reviewed = canonicalIso(reviewedAt, "reviewedAt");
  const start = canonicalIso(validFrom, "validFrom");
  const end = canonicalOptionalIso(validTo, "validTo");
  if (end && Date.parse(end) <= Date.parse(start)) {
    throw new EntityMasterDataError("validTo must be after validFrom", "MDM_INTERVAL_INVALID");
  }
  const humanReviewer = normalizeReviewer(reviewer);
  const basis = normalizeVerificationBasis(verificationBasis, reviewed);
  if (Date.parse(reviewed) < Date.parse(registry.updatedAt)) {
    throw new EntityMasterDataError("reviewedAt predates the current registry version", "MDM_REVIEW_TIME_REWIND");
  }
  const { entity: candidateEntity, candidate } = candidateFromStore({
    candidateStore,
    localEntityId: localId,
    candidateId,
    expectedCandidateStoreHash,
  });
  if (Date.parse(candidateStore.generatedAt) > Date.parse(reviewed)) {
    throw new EntityMasterDataError("candidate store is from after the review", "MDM_CANDIDATE_FROM_FUTURE");
  }
  if ((candidateStore.receipts || []).some((receipt) => Date.parse(receipt.receivedAt) > Date.parse(reviewed))) {
    throw new EntityMasterDataError("candidate receipt is from after the review", "MDM_CANDIDATE_RECEIPT_FROM_FUTURE");
  }
  const replayKey = `${candidateStore.storeHash}:${localId}:${candidate.candidateId}`;
  if ((registry.reviews || []).some((review) => (
    `${review.candidateStoreHash}:${review.localEntityId}:${review.candidateId}` === replayKey
  ))) {
    throw new EntityMasterDataError("candidate review replay was rejected", "MDM_CANDIDATE_REPLAY");
  }

  const proposal = {
    localEntityId: localId,
    provider: WIKIDATA_PROVIDER,
    providerEntityId: candidate.providerEntityId,
    validFrom: start,
    validTo: end,
  };
  const allApproved = approvedMappingsFor(registry, WIKIDATA_PROVIDER);
  const duplicate = allApproved.find((mapping) => mapping.localEntityId === localId
    && mapping.providerEntityId === candidate.providerEntityId && intervalsOverlap(mapping, proposal));
  if (duplicate) {
    throw new EntityMasterDataError("the provider mapping is already approved for this interval", "MDM_MAPPING_ALREADY_APPROVED");
  }
  const localConflicts = allApproved.filter((mapping) => mapping.localEntityId === localId
    && mapping.providerEntityId !== candidate.providerEntityId && intervalsOverlap(mapping, proposal));
  const reverseConflicts = allApproved.filter((mapping) => mapping.localEntityId !== localId
    && mapping.providerEntityId === candidate.providerEntityId && intervalsOverlap(mapping, proposal));
  const hasConflict = localConflicts.length > 0 || reverseConflicts.length > 0;
  const decision = hasConflict ? CONFLICT_STATUS : APPROVED_STATUS;

  const review = finalizeRecord({
    candidateStoreHash: candidateStore.storeHash,
    candidateId: candidate.candidateId,
    localEntityId: localId,
    provider: WIKIDATA_PROVIDER,
    providerEntityId: candidate.providerEntityId,
    decision,
    reviewer: humanReviewer,
    reviewedAt: reviewed,
    verificationBasis: basis,
    requestedInterval: { validFrom: start, validTo: end },
  }, "reviewId");
  const evidence = finalizeRecord({
    kind: "wikidata-quarantined-candidate-with-human-verification",
    candidateStoreHash: candidateStore.storeHash,
    candidateId: candidate.candidateId,
    candidateGeneratedAt: canonicalIso(candidateStore.generatedAt, "candidateStore.generatedAt"),
    receiptIds: uniqSorted(candidate.receiptIds),
    footballEvidence: true,
    exactBaseName: candidate.exactBaseName === true,
    exactContextQuery: candidate.exactContextQuery === true,
  }, "evidenceId");
  const mapping = finalizeRecord({
    localEntityId: localId,
    provider: WIKIDATA_PROVIDER,
    providerEntityId: candidate.providerEntityId,
    validFrom: start,
    validTo: end,
    status: decision,
    evidence: [evidence],
    reviewer: humanReviewer,
    reviewId: review.reviewId,
    verificationBasisHash: hashJson(basis),
    createdAt: reviewed,
  }, "mappingId");

  const next = JSON.parse(JSON.stringify(registry));
  const existingEntity = next.entities[localId] || {
    localEntityId: localId,
    entityType: "team",
    canonicalNames: [],
    providerMappings: [],
  };
  existingEntity.canonicalNames = uniqSorted([
    ...(existingEntity.canonicalNames || []),
    ...(candidateEntity.names || []),
    ...(candidate.labels || []),
    ...(candidate.aliases || []),
  ]);
  existingEntity.providerMappings = [...(existingEntity.providerMappings || []), mapping]
    .sort((left, right) => left.validFrom.localeCompare(right.validFrom) || left.mappingId.localeCompare(right.mappingId));
  next.entities[localId] = existingEntity;
  next.reviews.push(review);
  next.reviews.sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt) || left.reviewId.localeCompare(right.reviewId));

  const conflicts = [];
  if (localConflicts.length) {
    conflicts.push(finalizeRecord({
      type: "local-entity-overlapping-provider-identities",
      provider: WIKIDATA_PROVIDER,
      localEntityIds: [localId],
      providerEntityIds: uniqSorted([candidate.providerEntityId, ...localConflicts.map((row) => row.providerEntityId)]),
      proposedMappingId: mapping.mappingId,
      existingMappingIds: localConflicts.map((row) => row.mappingId).sort(),
      detectedAt: reviewed,
      resolution: "quarantined-no-overwrite",
    }, "conflictId"));
  }
  if (reverseConflicts.length) {
    conflicts.push(finalizeRecord({
      type: "provider-entity-overlapping-local-identities",
      provider: WIKIDATA_PROVIDER,
      localEntityIds: uniqSorted([localId, ...reverseConflicts.map((row) => row.localEntityId)]),
      providerEntityIds: [candidate.providerEntityId],
      proposedMappingId: mapping.mappingId,
      existingMappingIds: reverseConflicts.map((row) => row.mappingId).sort(),
      detectedAt: reviewed,
      resolution: "quarantined-no-overwrite",
    }, "conflictId"));
  }
  next.conflicts.push(...conflicts);
  next.conflicts.sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.conflictId.localeCompare(right.conflictId));
  next.updatedAt = reviewed;
  const finalized = finalizeRegistry(next);
  assertEntityMasterData(finalized);
  return {
    registry: finalized,
    mapping,
    review,
    activated: decision === APPROVED_STATUS,
    quarantined: decision === CONFLICT_STATUS,
    conflicts,
  };
};

const providerMappingAt = (registry, localEntityId, provider, asOf) => {
  assertEntityMasterData(registry);
  const at = canonicalIso(asOf, "asOf");
  const mappings = registry.entities?.[compact(localEntityId)]?.providerMappings || [];
  const eligible = mappings.filter((mapping) => mapping.provider === compact(provider)
    && mapping.status === APPROVED_STATUS && intervalContains(mapping, at));
  if (eligible.length > 1) {
    throw new EntityMasterDataError("multiple provider mappings are active at the requested time", "MDM_ASOF_AMBIGUOUS");
  }
  return eligible[0] ? JSON.parse(JSON.stringify(eligible[0])) : null;
};

const providerEntityIdAt = (registry, localEntityId, provider, asOf) => (
  providerMappingAt(registry, localEntityId, provider, asOf)?.providerEntityId || null
);

const loadEntityMasterData = (file, { allowMissing = false, createdAt = new Date().toISOString() } = {}) => {
  if (!fs.existsSync(file)) {
    if (allowMissing) return createEntityMasterData({ createdAt });
    throw new EntityMasterDataError(`entity master data file is missing: ${file}`, "MDM_REGISTRY_MISSING");
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    throw new EntityMasterDataError(`entity master data JSON is unreadable: ${error.message}`, "MDM_REGISTRY_UNREADABLE");
  }
  return assertEntityMasterData(parsed);
};

const sleepSync = (milliseconds) => {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
};

const withRegistryLock = (file, action, { timeoutMs = 5_000 } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  while (!handle) {
    try {
      handle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new EntityMasterDataError(`timed out waiting for MDM lock: ${lockFile}`, "MDM_LOCK_TIMEOUT");
      }
      sleepSync(25);
    }
  }
  try { return action(); } finally {
    try { fs.closeSync(handle); } catch { /* no-op */ }
    try { fs.unlinkSync(lockFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
};

const writeEntityMasterDataAtomic = (file, registry, { expectedRegistryHash, timeoutMs = 5_000 } = {}) => {
  assertEntityMasterData(registry);
  if (expectedRegistryHash === undefined) {
    throw new EntityMasterDataError("expectedRegistryHash is required for every write", "MDM_CAS_EXPECTATION_REQUIRED");
  }
  if (expectedRegistryHash !== null && !HASH_PATTERN.test(compact(expectedRegistryHash))) {
    throw new EntityMasterDataError("expectedRegistryHash is invalid", "MDM_CAS_EXPECTATION_INVALID");
  }
  return withRegistryLock(file, () => {
    const current = fs.existsSync(file) ? loadEntityMasterData(file) : null;
    const currentHash = current?.registryHash || null;
    if (currentHash !== expectedRegistryHash) {
      throw new EntityMasterDataError(
        `stale MDM compare-and-swap: expected ${expectedRegistryHash || "missing"}, found ${currentHash || "missing"}`,
        "MDM_CAS_STALE",
      );
    }
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* no-op */ }
    }
    const persisted = loadEntityMasterData(file);
    if (persisted.registryHash !== registry.registryHash) {
      throw new EntityMasterDataError("persisted MDM hash mismatch", "MDM_WRITE_VERIFICATION_FAILED");
    }
    return persisted;
  }, { timeoutMs });
};

module.exports = {
  APPROVED_STATUS,
  CONFLICT_STATUS,
  EntityMasterDataError,
  VERSION,
  WIKIDATA_PROVIDER,
  applyWikidataCandidateApproval,
  assertEntityMasterData,
  createEntityMasterData,
  finalizeRegistry,
  hashJson,
  intervalsOverlap,
  loadEntityMasterData,
  providerEntityIdAt,
  providerMappingAt,
  stableStringify,
  validateEntityMasterData,
  writeEntityMasterDataAtomic,
};
