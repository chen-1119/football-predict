const crypto = require("node:crypto");
const {
  isDecisionClockAuditEligible,
} = require("./decisionSnapshot.cjs");
const {
  buildResultProvenance,
} = require("./matchLifecycle.cjs");
const {
  MARKET_SOURCE_PROVENANCE_VERSION,
  isStrictMarketSourceProvenance,
  normalizeMarketSourceProvenance,
} = require("./marketSourceProvenance.cjs");

const LEGACY_PROMOTION_EVIDENCE_RECORD_VERSION = "promotion-evidence-record-v1";
const LEGACY_PROMOTION_EVIDENCE_MANIFEST_VERSION = "promotion-evidence-manifest-v1";
const PROMOTION_EVIDENCE_RECORD_VERSION = "promotion-evidence-record-v2";
const PROMOTION_EVIDENCE_MANIFEST_VERSION = "promotion-evidence-manifest-v2";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MARKETS = new Set(["HAD", "HHAD"]);

const IDENTITY_FIELDS = Object.freeze([
  "matchId",
  "sourceMatchId",
  "eventVersion",
  "market",
  "handicapLine",
]);

const CLOCK_FIELDS = Object.freeze([
  "capturedAt",
  "decisionAt",
  "cutoffTime",
  "kickoffTime",
  "modelGeneratedAt",
  "oddsObservedAt",
  "oddsReceivedAt",
  "resultObservedAt",
  "resultObservationSource",
  "resultObservationFallback",
]);

const PROVENANCE_FIELDS = Object.freeze([
  "snapshotVersion",
  "policyVersion",
  "modelVersion",
  "calibrationVersion",
  "sourceCycleId",
  "phase",
  "marketProvenanceVersion",
  "marketProvenanceHash",
  "collectorAttestationKeyId",
  "collectorAttestationKeyFingerprint",
  "collectorAttestationCommitmentHash",
  "marketExtractionHash",
  "collectorTrustBoundary",
]);

const HASH_FIELDS = Object.freeze([
  "featureSnapshotSha256",
  "decisionSnapshotSha256",
  "oddsSha256",
  "probabilitiesSha256",
  "resultSha256",
  "marketProvenanceSha256",
]);

const RECORD_FIELDS = Object.freeze([
  "version",
  "recordKey",
  "identity",
  "clocks",
  "provenance",
  "hashes",
  "promotionEligible",
  "blockers",
  "recordHash",
]);

const MANIFEST_FIELDS = Object.freeze([
  "version",
  "generatedAt",
  "previousManifestHash",
  "totalRows",
  "canonicalRows",
  "validRows",
  "invalidRows",
  "eligibleRows",
  "rejectedRows",
  "duplicateRowsRemoved",
  "conflictingDuplicateKeys",
  "rejectedByReason",
  "firstForecastAt",
  "lastForecastAt",
  "rowHashes",
  "eligibleRowHashes",
  "rootHash",
  "eligibleRootHash",
  "promotionEligible",
  "blockers",
  "manifestHash",
]);

function canonicalize(value, location = "root") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError(`${location} contains an invalid Date`);
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) throw new TypeError(`${location}[${index}] is undefined`);
      return canonicalize(item, `${location}[${index}]`);
    });
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} contains a non-plain object`);
    }
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key], `${location}.${key}`)]));
  }
  throw new TypeError(`${location} contains unsupported ${typeof value}`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const text = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const rawInstant = (value) => text(value);

const canonicalInstant = (value) => {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString() === value ? value : null;
};

const normalizedInstant = (value) => {
  const explicit = text(value);
  if (!explicit) return null;
  const millis = Date.parse(explicit);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const instantMs = (value) => {
  const canonical = canonicalInstant(value);
  return canonical ? Date.parse(canonical) : null;
};

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const canonicalHandicapLine = (value) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) || value === 0 ? "0" : String(Number(value));
  }
  const normalized = String(value ?? "")
    .trim()
    .replace(/\u2212|\uFF0D/g, "-")
    .replace(/\uFF0B/g, "+");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return Object.is(number, -0) || number === 0 ? "0" : String(number);
};

const tripletValue = (value, code) => {
  if (!isObject(value)) return null;
  const aliases = code === "1"
    ? ["1", "odds1", "home"]
    : code === "X"
      ? ["X", "oddsX", "draw"]
      : ["2", "odds2", "away"];
  for (const alias of aliases) {
    if (value[alias] === null || value[alias] === undefined || value[alias] === "") continue;
    const number = Number(value[alias]);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

const validOddsTriplet = (value) => ["1", "X", "2"]
  .map((code) => tripletValue(value, code))
  .every((number) => Number.isFinite(number) && number > 1);

const normalizedOddsTriplet = (value) => {
  const normalized = Object.fromEntries(["1", "X", "2"]
    .map((code) => [code, tripletValue(value, code)]));
  return Object.values(normalized).every((number) => Number.isFinite(number) && number > 1)
    ? normalized
    : null;
};

const validProbabilityTriplet = (value) => {
  const numbers = ["1", "X", "2"].map((code) => tripletValue(value, code));
  if (!numbers.every((number) => Number.isFinite(number) && number >= 0 && number <= 1)) return false;
  return Math.abs(numbers.reduce((sum, number) => sum + number, 0) - 1) <= 0.00001;
};

const validOfficialResult = (value) => {
  if (!isObject(value) || value.official !== true || String(value.status || "").toUpperCase() !== "FINISHED") {
    return false;
  }
  if (value.trusted !== true
      || String(value.provider || "").trim().toLowerCase() !== "sporttery"
      || value.provenanceValidated !== true
      || value.eventVersionConsistent !== true
      || !text(value.eventVersion)) {
    return false;
  }
  const scoreHome = Number(value.scoreHome);
  const scoreAway = Number(value.scoreAway);
  if (!Number.isSafeInteger(scoreHome) || scoreHome < 0
      || !Number.isSafeInteger(scoreAway) || scoreAway < 0) {
    return false;
  }
  const expectedCode = scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X";
  return String(value.outcomeCode || "").toUpperCase() === expectedCode && Boolean(text(value.source));
};

const withoutDeclaredFeatureHash = (featureSnapshot) => {
  if (!isObject(featureSnapshot)) return featureSnapshot;
  const { hash: ignoredSelfReportedHash, ...content } = featureSnapshot;
  void ignoredSelfReportedHash;
  return content;
};

const hashPayload = (value, label, blockers) => {
  if (!isObject(value) || Object.keys(value).length === 0) {
    blockers.add(`${label}-missing`);
    return null;
  }
  try {
    return sha256Json(value);
  } catch {
    blockers.add(`${label}-unhashable`);
    return null;
  }
};

const payloadsEqual = (left, right) => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const committedDecisionEvidence = (decisionSnapshot, market) => {
  const decisionMarket = decisionSnapshot?.markets?.[market] || null;
  const probabilityPayload = decisionSnapshot?.probabilities?.[market] || null;
  return {
    market: decisionMarket,
    odds: decisionMarket?.odds || null,
    probabilities: market === "HHAD"
      ? (probabilityPayload?.outcomes || null)
      : probabilityPayload,
    marketLine: canonicalHandicapLine(decisionMarket?.line),
    probabilityLine: market === "HHAD"
      ? canonicalHandicapLine(probabilityPayload?.line)
      : "0",
    marketProvenance: decisionMarket?.provenance || null,
    marketProvenanceHash: text(decisionMarket?.provenanceHash),
    clocks: {
      capturedAt: normalizedInstant(decisionSnapshot?.capturedAt),
      decisionAt: normalizedInstant(decisionSnapshot?.decisionAt),
      cutoffTime: normalizedInstant(decisionSnapshot?.cutoffTime),
      kickoffTime: normalizedInstant(decisionSnapshot?.kickoffTime),
      modelGeneratedAt: normalizedInstant(decisionSnapshot?.sourceTimestamps?.modelGeneratedAt),
      oddsObservedAt: normalizedInstant(decisionMarket?.observedAt),
      oddsReceivedAt: normalizedInstant(decisionMarket?.receivedAt),
    },
    provenance: {
      snapshotVersion: text(decisionSnapshot?.version),
      policyVersion: text(decisionSnapshot?.policyVersion),
      modelVersion: text(decisionSnapshot?.modelVersion),
      calibrationVersion: text(decisionSnapshot?.calibrationVersion),
      sourceCycleId: text(decisionSnapshot?.sourceCycleId),
    },
  };
};

const validatedResultProvenance = (input, identity, clocks) => {
  const result = input?.result;
  if (!isObject(result)) return null;
  return buildResultProvenance({
    id: identity.matchId,
    sourceMatchId: identity.sourceMatchId,
    status: result.status,
    kickoffTime: clocks.kickoffTime,
    eventVersion: result.eventVersion,
    scoreHome: result.scoreHome,
    scoreAway: result.scoreAway,
    resultProvenance: {
      provider: result.provider,
      source: result.source,
      official: result.official,
      trusted: result.trusted,
      sourceMatchId: identity.sourceMatchId,
      scoreHome: result.scoreHome,
      scoreAway: result.scoreAway,
      eventVersion: result.eventVersion,
      observedAt: clocks.resultObservedAt,
      observationSource: clocks.resultObservationSource,
      resultObservationFallback: clocks.resultObservationFallback,
    },
  });
};

const normalizeIdentity = (input = {}) => {
  const market = String(input.market || "").trim().toUpperCase();
  const line = canonicalHandicapLine(input.handicapLine);
  const lineMissing = input.handicapLine === null
    || input.handicapLine === undefined
    || String(input.handicapLine).trim() === "";
  return {
    matchId: text(input.matchId),
    sourceMatchId: text(input.sourceMatchId),
    eventVersion: text(input.eventVersion),
    market: market || null,
    handicapLine: market === "HAD" && lineMissing ? "0" : line,
  };
};

const normalizeClocks = (input = {}) => ({
  capturedAt: rawInstant(input.capturedAt),
  decisionAt: rawInstant(input.decisionAt),
  cutoffTime: rawInstant(input.cutoffTime),
  kickoffTime: rawInstant(input.kickoffTime),
  modelGeneratedAt: rawInstant(input.modelGeneratedAt),
  oddsObservedAt: rawInstant(input.oddsObservedAt),
  oddsReceivedAt: rawInstant(input.oddsReceivedAt),
  resultObservedAt: rawInstant(input.resultObservedAt),
  resultObservationSource: text(input.resultObservationSource),
  resultObservationFallback: input.resultObservationFallback === true,
});

const normalizeProvenance = (input = {}, phase = null) => ({
  snapshotVersion: text(input.snapshotVersion),
  policyVersion: text(input.policyVersion),
  modelVersion: text(input.modelVersion),
  calibrationVersion: text(input.calibrationVersion),
  sourceCycleId: text(input.sourceCycleId),
  phase: text(phase ?? input.phase),
  marketProvenanceVersion: text(input.marketProvenanceVersion),
  marketProvenanceHash: text(input.marketProvenanceHash)?.toLowerCase() || null,
  collectorAttestationKeyId: text(input.collectorAttestationKeyId),
  collectorAttestationKeyFingerprint: text(input.collectorAttestationKeyFingerprint)?.toLowerCase() || null,
  collectorAttestationCommitmentHash: text(input.collectorAttestationCommitmentHash)?.toLowerCase() || null,
  marketExtractionHash: text(input.marketExtractionHash)?.toLowerCase() || null,
  collectorTrustBoundary: text(input.collectorTrustBoundary),
});

const recordKeyFor = (record) => sha256Json({
  identity: record.identity,
  decisionAt: record.clocks?.decisionAt || null,
});

const recordHashFor = (record) => sha256Json(Object.fromEntries(
  RECORD_FIELDS
    .filter((field) => field !== "recordHash")
    .map((field) => [field, record[field]])
));

const addClockBlockers = (clocks, blockers) => {
  const required = [
    ["capturedAt", "captured-at-missing-or-invalid"],
    ["decisionAt", "decision-at-missing-or-invalid"],
    ["cutoffTime", "cutoff-time-missing-or-invalid"],
    ["kickoffTime", "kickoff-time-missing-or-invalid"],
    ["modelGeneratedAt", "model-generated-at-missing-or-invalid"],
    ["oddsObservedAt", "odds-observed-at-missing-or-invalid"],
    ["oddsReceivedAt", "odds-received-at-missing-or-invalid"],
    ["resultObservedAt", "result-observed-at-missing-or-invalid"],
  ];
  const times = {};
  for (const [field, blocker] of required) {
    times[field] = instantMs(clocks[field]);
    if (times[field] === null) blockers.add(blocker);
  }

  const after = (left, right, blocker) => {
    if (times[left] !== null && times[right] !== null && times[left] > times[right]) blockers.add(blocker);
  };
  after("oddsObservedAt", "oddsReceivedAt", "odds-observed-after-received");
  after("oddsReceivedAt", "decisionAt", "odds-received-after-decision");
  after("capturedAt", "decisionAt", "snapshot-captured-after-decision");
  after("modelGeneratedAt", "decisionAt", "model-generated-after-decision");
  after("decisionAt", "cutoffTime", "decision-after-cutoff");
  after("decisionAt", "kickoffTime", "decision-after-kickoff");
  after("cutoffTime", "kickoffTime", "cutoff-after-kickoff");

  if (times.resultObservedAt !== null && times.kickoffTime !== null
      && times.resultObservedAt < times.kickoffTime) {
    blockers.add("result-observed-before-kickoff");
  }
  if (times.resultObservedAt !== null && times.decisionAt !== null
      && times.resultObservedAt <= times.decisionAt) {
    blockers.add("result-not-after-decision");
  }
  if (!clocks.resultObservationSource) blockers.add("result-observation-source-missing");
  if (clocks.resultObservationFallback === true
      || clocks.resultObservationSource === "kickoff-plus-three-hours") {
    blockers.add("result-observation-fallback");
  }
};

function buildPromotionEvidenceRecord(input = {}, options = {}) {
  const blockers = new Set();
  const identity = normalizeIdentity(input.identity);
  const clocks = normalizeClocks(input.clocks);
  const provenance = normalizeProvenance(input.provenance, input.phase);
  const committed = committedDecisionEvidence(input.decisionSnapshot, identity.market);
  const resultProvenance = validatedResultProvenance(input, identity, clocks);
  const marketProvenance = normalizeMarketSourceProvenance(committed.marketProvenance, {
    trustRegistry: options.collectorTrustRegistry || null,
  });
  const marketProvenanceStrict = isStrictMarketSourceProvenance(committed.marketProvenance, {
    trustRegistry: options.collectorTrustRegistry || null,
  });
  const expectedMarketCommitment = {
    marketProvenanceVersion: marketProvenance?.version || null,
    marketProvenanceHash: marketProvenance?.hash || null,
    collectorAttestationKeyId: marketProvenance?.strict?.collectorAttestationKeyId || null,
    collectorAttestationKeyFingerprint: marketProvenance?.strict?.collectorAttestationKeyFingerprint || null,
    collectorAttestationCommitmentHash: marketProvenance?.strict?.collectorAttestationCommitmentHash || null,
    marketExtractionHash: marketProvenance?.extraction?.hash || null,
    collectorTrustBoundary: marketProvenance?.strict?.trustBoundary || null,
  };

  if (!identity.matchId) blockers.add("match-id-missing");
  if (!identity.sourceMatchId) blockers.add("source-match-id-missing");
  if (!identity.eventVersion) blockers.add("event-version-missing");
  if (!MARKETS.has(identity.market)) blockers.add("market-invalid");
  if (identity.market === "HHAD" && identity.handicapLine === null) blockers.add("handicap-line-invalid");
  if (identity.market === "HAD" && identity.handicapLine !== "0") blockers.add("had-line-must-be-zero");
  if (identity.eventVersion && clocks.kickoffTime
      && canonicalInstant(identity.eventVersion) !== canonicalInstant(clocks.kickoffTime)) {
    blockers.add("event-version-kickoff-mismatch");
  }

  for (const field of [
    "snapshotVersion",
    "policyVersion",
    "modelVersion",
    "calibrationVersion",
    "sourceCycleId",
    "marketProvenanceVersion",
    "marketProvenanceHash",
    "collectorAttestationKeyId",
    "collectorAttestationKeyFingerprint",
    "collectorAttestationCommitmentHash",
    "marketExtractionHash",
    "collectorTrustBoundary",
  ]) {
    if (!provenance[field]) blockers.add(`${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-missing`);
  }
  if (String(provenance.phase || "").toLowerCase() === "review") blockers.add("review-phase-not-promotable");
  if (input.decisionClockAuditEligible !== true
      || !isDecisionClockAuditEligible(input.decisionSnapshot, {
        collectorTrustRegistry: options.collectorTrustRegistry || null,
      })) {
    blockers.add("decision-clock-audit-ineligible");
  }
  if (MARKETS.has(identity.market) && !input.decisionSnapshot?.markets?.[identity.market]) {
    blockers.add("decision-market-missing");
  }
  if (!payloadsEqual(input.odds, committed.odds)) {
    blockers.add("decision-odds-source-mismatch");
  }
  if (!payloadsEqual(input.probabilities, committed.probabilities)) {
    blockers.add("decision-probabilities-source-mismatch");
  }
  if (MARKETS.has(identity.market)) {
    const expectedLine = identity.market === "HAD" ? "0" : committed.marketLine;
    if (identity.handicapLine !== expectedLine
        || (identity.market === "HHAD" && committed.probabilityLine !== committed.marketLine)) {
      blockers.add("decision-market-line-source-mismatch");
    }
  }
  if (Object.entries(committed.clocks).some(([field, value]) => clocks[field] !== value)) {
    blockers.add("decision-clock-source-mismatch");
  }
  if (Object.entries(committed.provenance).some(([field, value]) => provenance[field] !== value)) {
    blockers.add("decision-provenance-source-mismatch");
  }
  if (Object.entries(expectedMarketCommitment).some(([field, value]) => provenance[field] !== value)) {
    blockers.add("market-provenance-commitment-source-mismatch");
  }
  if (!committed.marketProvenance) {
    blockers.add("market-source-provenance-missing");
  } else if (!marketProvenanceStrict) {
    const sourceBlockers = marketProvenance?.strict?.blockers?.length
      ? marketProvenance.strict.blockers
      : ["invalid"];
    for (const blocker of sourceBlockers) blockers.add(`market-source-provenance-${blocker}`);
  }
  if (committed.marketProvenanceHash !== marketProvenance?.hash) {
    blockers.add("decision-market-provenance-hash-mismatch");
  }
  if (marketProvenance?.market?.sourceMatchId !== identity.sourceMatchId) {
    blockers.add("market-source-match-id-mismatch");
  }
  if (marketProvenance?.market?.poolCode !== identity.market
      || marketProvenance?.extraction?.poolCode !== identity.market) {
    blockers.add("market-pool-commitment-mismatch");
  }
  if (!payloadsEqual(marketProvenance?.extraction?.odds, normalizedOddsTriplet(committed.odds))) {
    blockers.add("market-extraction-decision-odds-mismatch");
  }
  if (marketProvenance?.extraction?.sourceMatchId !== identity.sourceMatchId) {
    blockers.add("market-extraction-source-match-id-mismatch");
  }
  if (marketProvenance?.extraction?.handicapLine !== identity.handicapLine) {
    blockers.add("market-extraction-handicap-line-mismatch");
  }
  if (marketProvenance?.extraction?.providerObservedAt !== clocks.oddsObservedAt) {
    blockers.add("market-extraction-observed-at-mismatch");
  }

  addClockBlockers(clocks, blockers);
  if (!validOddsTriplet(input.odds)) blockers.add("odds-triplet-invalid");
  if (!validProbabilityTriplet(input.probabilities)) blockers.add("probability-triplet-invalid");
  if (input.result?.trusted !== true
      || String(input.result?.provider || "").trim().toLowerCase() !== "sporttery") {
    blockers.add("trusted-sporttery-result-required");
  }
  if (input.result?.eventVersionConsistent !== true
      || canonicalInstant(input.result?.eventVersion) !== canonicalInstant(identity.eventVersion)
      || canonicalInstant(input.result?.eventVersion) !== canonicalInstant(clocks.kickoffTime)) {
    blockers.add("result-event-version-mismatch");
  }
  if (input.result?.provenanceValidated !== true
      || resultProvenance?.promotionEligible !== true) {
    blockers.add("result-lifecycle-provenance-ineligible");
  }
  if (!validOfficialResult(input.result)) blockers.add("official-result-invalid");

  const hashes = {
    featureSnapshotSha256: hashPayload(
      withoutDeclaredFeatureHash(input.featureSnapshot),
      "feature-snapshot",
      blockers,
    ),
    decisionSnapshotSha256: hashPayload(input.decisionSnapshot, "decision-snapshot", blockers),
    oddsSha256: hashPayload(input.odds, "odds", blockers),
    probabilitiesSha256: hashPayload(input.probabilities, "probabilities", blockers),
    resultSha256: hashPayload(input.result, "result", blockers),
    marketProvenanceSha256: HASH_PATTERN.test(marketProvenance?.hash || "")
      ? marketProvenance.hash
      : null,
  };
  if (!hashes.marketProvenanceSha256) blockers.add("market-provenance-hash-missing");

  const sortedBlockers = [...blockers].sort();
  const base = {
    version: PROMOTION_EVIDENCE_RECORD_VERSION,
    recordKey: null,
    identity,
    clocks,
    provenance,
    hashes,
    promotionEligible: sortedBlockers.length === 0,
    blockers: sortedBlockers,
  };
  base.recordKey = recordKeyFor(base);
  return {
    ...base,
    recordHash: recordHashFor(base),
  };
}

function validatePromotionEvidenceRecord(record, sourceInput = null, options = {}) {
  const errors = [];
  if (!isObject(record)) {
    return { valid: false, promotionEligible: false, errors: ["record-not-object"], blockers: [] };
  }
  if (record.version === LEGACY_PROMOTION_EVIDENCE_RECORD_VERSION) {
    if (!HASH_PATTERN.test(String(record.recordKey || ""))) errors.push("legacy-record-key-invalid");
    else if (recordKeyFor(record) !== record.recordKey) errors.push("legacy-record-key-mismatch");
    if (!HASH_PATTERN.test(String(record.recordHash || ""))) errors.push("legacy-record-hash-invalid");
    else if (recordHashFor(record) !== record.recordHash) errors.push("legacy-record-hash-mismatch");
    const legacyBlockers = [...new Set([
      ...(Array.isArray(record.blockers) ? record.blockers.filter((item) => typeof item === "string") : []),
      "legacy-promotion-evidence-v1-audit-only",
    ])].sort();
    return {
      valid: errors.length === 0,
      promotionEligible: false,
      legacyAuditOnly: true,
      errors,
      blockers: legacyBlockers,
      recordKey: record.recordKey || null,
      recordHash: record.recordHash || null,
    };
  }
  const unknownFields = Object.keys(record).filter((field) => !RECORD_FIELDS.includes(field));
  const missingFields = RECORD_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(record, field));
  if (unknownFields.length) errors.push(`record-unknown-fields:${unknownFields.sort().join("|")}`);
  if (missingFields.length) errors.push(`record-missing-fields:${missingFields.join("|")}`);
  if (record.version !== PROMOTION_EVIDENCE_RECORD_VERSION) errors.push("record-version-invalid");
  const exactObjectFields = (value, fields, label) => {
    if (!isObject(value)) {
      errors.push(`${label}-not-object`);
      return;
    }
    const unknown = Object.keys(value).filter((field) => !fields.includes(field));
    const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
    if (unknown.length) errors.push(`${label}-unknown-fields:${unknown.sort().join("|")}`);
    if (missing.length) errors.push(`${label}-missing-fields:${missing.join("|")}`);
  };
  exactObjectFields(record.identity, IDENTITY_FIELDS, "record-identity");
  exactObjectFields(record.clocks, CLOCK_FIELDS, "record-clocks");
  exactObjectFields(record.provenance, PROVENANCE_FIELDS, "record-provenance");
  exactObjectFields(record.hashes, HASH_FIELDS, "record-hashes");
  if (!HASH_PATTERN.test(String(record.recordKey || ""))) errors.push("record-key-invalid");
  else if (recordKeyFor(record) !== record.recordKey) errors.push("record-key-mismatch");
  for (const name of HASH_FIELDS) {
    const hash = record.hashes?.[name];
    if (hash !== null && !HASH_PATTERN.test(String(hash || ""))) errors.push(`${name}-invalid`);
  }
  const blockers = Array.isArray(record.blockers) ? record.blockers : [];
  const normalizedBlockers = [...new Set(blockers.filter((item) => typeof item === "string"))].sort();
  if (canonicalJson(blockers) !== canonicalJson(normalizedBlockers)) errors.push("record-blockers-noncanonical");
  if (isObject(record.identity)
      && canonicalJson(normalizeIdentity(record.identity)) !== canonicalJson(record.identity)) {
    errors.push("record-identity-noncanonical");
  }
  if (isObject(record.clocks)
      && canonicalJson(normalizeClocks(record.clocks)) !== canonicalJson(record.clocks)) {
    errors.push("record-clocks-noncanonical");
  }
  if (isObject(record.provenance)
      && canonicalJson(normalizeProvenance(record.provenance)) !== canonicalJson(record.provenance)) {
    errors.push("record-provenance-noncanonical");
  }
  const provenanceHashes = [
    "marketProvenanceHash",
    "collectorAttestationKeyFingerprint",
    "collectorAttestationCommitmentHash",
    "marketExtractionHash",
  ];
  for (const field of provenanceHashes) {
    const value = record.provenance?.[field];
    if (value !== null && !HASH_PATTERN.test(String(value || ""))) {
      errors.push(`record-provenance-${field}-invalid`);
    }
  }
  if (record.provenance?.marketProvenanceVersion !== null
      && record.provenance.marketProvenanceVersion !== MARKET_SOURCE_PROVENANCE_VERSION) {
    errors.push("record-provenance-market-version-invalid");
  }
  if (record.provenance?.collectorTrustBoundary !== null
      && ![
        "trusted-collector-signed-commitment-raw-response-not-rehashed",
        "trusted-collector-signature-and-canonical-payload-rehash",
      ].includes(record.provenance.collectorTrustBoundary)) {
    errors.push("record-provenance-trust-boundary-invalid");
  }
  if (record.provenance?.marketProvenanceHash !== null
      && record.hashes?.marketProvenanceSha256 !== record.provenance.marketProvenanceHash) {
    errors.push("record-market-provenance-hash-commitment-mismatch");
  }
  for (const name of HASH_FIELDS) {
    const hash = record.hashes?.[name];
    if (hash === null) {
      const blockerPrefix = name === "featureSnapshotSha256"
        ? "feature-snapshot-"
        : name === "decisionSnapshotSha256"
          ? "decision-snapshot-"
          : name === "oddsSha256"
            ? "odds-"
            : name === "probabilitiesSha256"
            ? "probabilities-"
            : name === "marketProvenanceSha256"
              ? "market-provenance-"
              : "result-";
      if (!normalizedBlockers.some((blocker) => blocker.startsWith(blockerPrefix))) {
        errors.push(`${name}-missing-without-blocker`);
      }
    }
  }
  if (record.promotionEligible !== (normalizedBlockers.length === 0)) {
    errors.push("record-promotion-claim-mismatch");
  }
  if (!HASH_PATTERN.test(String(record.recordHash || ""))) errors.push("record-hash-invalid");
  else if (recordHashFor(record) !== record.recordHash) errors.push("record-hash-mismatch");

  if (sourceInput !== null) {
    let expected = null;
    try {
      expected = buildPromotionEvidenceRecord(sourceInput, options);
    } catch {
      errors.push("source-evidence-unbuildable");
    }
    if (expected && canonicalJson(expected) !== canonicalJson(record)) errors.push("source-evidence-mismatch");
  }

  return {
    valid: errors.length === 0,
    promotionEligible: errors.length === 0 && record.promotionEligible === true,
    errors,
    blockers: normalizedBlockers,
    recordKey: record.recordKey || null,
    recordHash: record.recordHash || null,
  };
}

const manifestHashFor = (manifest) => sha256Json(Object.fromEntries(
  MANIFEST_FIELDS
    .filter((field) => field !== "manifestHash")
    .map((field) => [field, manifest[field]])
));

function buildPromotionEvidenceManifest(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const generatedAt = canonicalInstant(options.generatedAt);
  if (!generatedAt) throw new TypeError("generatedAt must be a canonical UTC ISO timestamp");
  const previousManifestHash = options.previousManifestHash ?? null;
  if (previousManifestHash !== null && !HASH_PATTERN.test(String(previousManifestHash))) {
    throw new TypeError("previousManifestHash must be null or a lowercase SHA-256 hash");
  }

  const validations = records.map((record, index) => ({
    index,
    record,
    validation: validatePromotionEvidenceRecord(record, null, options),
  }));
  const sorted = validations.slice().sort((left, right) => (
    String(left.record?.recordKey || "").localeCompare(String(right.record?.recordKey || ""))
    || String(left.record?.recordHash || "").localeCompare(String(right.record?.recordHash || ""))
    || left.index - right.index
  ));

  let duplicateRowsRemoved = 0;
  const conflictingKeys = new Set();
  const unique = [];
  const byKey = new Map();
  for (const entry of sorted) {
    const key = String(entry.record?.recordKey || `invalid:${entry.index}`);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, entry);
      unique.push(entry);
      continue;
    }
    if (prior.record?.recordHash === entry.record?.recordHash
        && canonicalJson(prior.record) === canonicalJson(entry.record)) {
      duplicateRowsRemoved += 1;
      continue;
    }
    conflictingKeys.add(key);
    unique.push(entry);
  }

  const validEntries = unique.filter((entry) => entry.validation.valid);
  const eligibleEntries = validEntries.filter((entry) => entry.validation.promotionEligible);
  const rejectedEntries = unique.filter((entry) => !entry.validation.promotionEligible);
  const rejectedByReason = {};
  for (const entry of rejectedEntries) {
    const reasons = entry.validation.valid
      ? entry.validation.blockers
      : entry.validation.errors.map((error) => `invalid-record:${error}`);
    for (const reason of reasons.length ? reasons : ["not-promotion-eligible"]) {
      rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
    }
  }

  const orderedRows = unique.map((entry) => ({
    recordKey: entry.record?.recordKey || null,
    recordHash: entry.record?.recordHash || null,
  }));
  const orderedEligibleRows = eligibleEntries.map((entry) => ({
    recordKey: entry.record.recordKey,
    recordHash: entry.record.recordHash,
  }));
  const forecastTimes = validEntries
    .map((entry) => canonicalInstant(entry.record?.clocks?.decisionAt))
    .filter(Boolean)
    .sort();
  const blockers = [];
  if (validEntries.length !== unique.length) blockers.push(`invalid-records:${unique.length - validEntries.length}`);
  if (conflictingKeys.size) blockers.push(`conflicting-duplicate-keys:${conflictingKeys.size}`);
  if (!eligibleEntries.length) blockers.push("eligible-records-missing");
  blockers.sort();

  const base = {
    version: PROMOTION_EVIDENCE_MANIFEST_VERSION,
    generatedAt,
    previousManifestHash,
    totalRows: records.length,
    canonicalRows: unique.length,
    validRows: validEntries.length,
    invalidRows: unique.length - validEntries.length,
    eligibleRows: eligibleEntries.length,
    rejectedRows: rejectedEntries.length,
    duplicateRowsRemoved,
    conflictingDuplicateKeys: conflictingKeys.size,
    rejectedByReason: Object.fromEntries(Object.entries(rejectedByReason).sort(([left], [right]) => left.localeCompare(right))),
    firstForecastAt: forecastTimes[0] || null,
    lastForecastAt: forecastTimes[forecastTimes.length - 1] || null,
    rowHashes: orderedRows.map((row) => row.recordHash),
    eligibleRowHashes: orderedEligibleRows.map((row) => row.recordHash),
    rootHash: sha256Json(orderedRows),
    eligibleRootHash: sha256Json(orderedEligibleRows),
    promotionEligible: blockers.length === 0,
    blockers,
  };
  return {
    ...base,
    manifestHash: manifestHashFor(base),
  };
}

function validatePromotionEvidenceManifest(manifest, records, options = {}) {
  const errors = [];
  if (!isObject(manifest)) {
    return { valid: false, promotionEligible: false, errors: ["manifest-not-object"] };
  }
  if (manifest.version === LEGACY_PROMOTION_EVIDENCE_MANIFEST_VERSION) {
    if (!HASH_PATTERN.test(String(manifest.manifestHash || ""))) errors.push("legacy-manifest-hash-invalid");
    else if (manifestHashFor(manifest) !== manifest.manifestHash) errors.push("legacy-manifest-hash-mismatch");
    return {
      valid: errors.length === 0,
      promotionEligible: false,
      legacyAuditOnly: true,
      blockers: ["legacy-promotion-evidence-v1-audit-only"],
      errors,
      manifestHash: manifest.manifestHash || null,
      rootHash: manifest.rootHash || null,
      eligibleRootHash: manifest.eligibleRootHash || null,
    };
  }
  const unknownFields = Object.keys(manifest).filter((field) => !MANIFEST_FIELDS.includes(field));
  const missingFields = MANIFEST_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(manifest, field));
  if (unknownFields.length) errors.push(`manifest-unknown-fields:${unknownFields.sort().join("|")}`);
  if (missingFields.length) errors.push(`manifest-missing-fields:${missingFields.join("|")}`);
  if (manifest.version !== PROMOTION_EVIDENCE_MANIFEST_VERSION) errors.push("manifest-version-invalid");
  if (!canonicalInstant(manifest.generatedAt)) errors.push("manifest-generated-at-invalid");
  if (manifest.previousManifestHash !== null
      && !HASH_PATTERN.test(String(manifest.previousManifestHash || ""))) {
    errors.push("manifest-previous-hash-invalid");
  }
  for (const field of [
    "totalRows",
    "canonicalRows",
    "validRows",
    "invalidRows",
    "eligibleRows",
    "rejectedRows",
    "duplicateRowsRemoved",
    "conflictingDuplicateKeys",
  ]) {
    if (!Number.isSafeInteger(manifest[field]) || manifest[field] < 0) errors.push(`manifest-${field}-invalid`);
  }
  if (Number.isSafeInteger(manifest.totalRows)
      && Number.isSafeInteger(manifest.canonicalRows)
      && Number.isSafeInteger(manifest.duplicateRowsRemoved)
      && manifest.totalRows !== manifest.canonicalRows + manifest.duplicateRowsRemoved) {
    errors.push("manifest-row-count-mismatch");
  }
  if (Number.isSafeInteger(manifest.canonicalRows)
      && Number.isSafeInteger(manifest.validRows)
      && Number.isSafeInteger(manifest.invalidRows)
      && manifest.canonicalRows !== manifest.validRows + manifest.invalidRows) {
    errors.push("manifest-validity-count-mismatch");
  }
  if (Number.isSafeInteger(manifest.canonicalRows)
      && Number.isSafeInteger(manifest.eligibleRows)
      && Number.isSafeInteger(manifest.rejectedRows)
      && manifest.canonicalRows !== manifest.eligibleRows + manifest.rejectedRows) {
    errors.push("manifest-eligibility-count-mismatch");
  }
  if (!Array.isArray(manifest.rowHashes)) errors.push("manifest-row-hashes-invalid");
  else if (manifest.rowHashes.some((hash) => hash !== null && !HASH_PATTERN.test(String(hash)))) {
    errors.push("manifest-row-hash-invalid");
  }
  if (!Array.isArray(manifest.eligibleRowHashes)) errors.push("manifest-eligible-row-hashes-invalid");
  else if (manifest.eligibleRowHashes.some((hash) => !HASH_PATTERN.test(String(hash)))) {
    errors.push("manifest-eligible-row-hash-invalid");
  }
  if (!HASH_PATTERN.test(String(manifest.rootHash || ""))) errors.push("manifest-root-hash-invalid");
  if (!HASH_PATTERN.test(String(manifest.eligibleRootHash || ""))) errors.push("manifest-eligible-root-hash-invalid");
  const manifestBlockers = Array.isArray(manifest.blockers) ? manifest.blockers : [];
  const canonicalManifestBlockers = [...new Set(manifestBlockers.filter((item) => typeof item === "string"))].sort();
  if (canonicalJson(manifestBlockers) !== canonicalJson(canonicalManifestBlockers)) {
    errors.push("manifest-blockers-noncanonical");
  }
  if (manifest.promotionEligible !== (canonicalManifestBlockers.length === 0)) {
    errors.push("manifest-promotion-claim-mismatch");
  }
  if (!HASH_PATTERN.test(String(manifest.manifestHash || ""))) errors.push("manifest-hash-invalid");
  else if (manifestHashFor(manifest) !== manifest.manifestHash) errors.push("manifest-hash-mismatch");

  let expected = null;
  try {
    expected = buildPromotionEvidenceManifest(records, {
      generatedAt: manifest.generatedAt,
      previousManifestHash: manifest.previousManifestHash,
      collectorTrustRegistry: options.collectorTrustRegistry || null,
    });
  } catch {
    errors.push("manifest-input-unbuildable");
  }
  if (expected && canonicalJson(expected) !== canonicalJson(manifest)) errors.push("manifest-records-mismatch");
  return {
    valid: errors.length === 0,
    promotionEligible: errors.length === 0 && manifest.promotionEligible === true,
    errors,
    manifestHash: manifest.manifestHash || null,
    rootHash: manifest.rootHash || null,
    eligibleRootHash: manifest.eligibleRootHash || null,
  };
}

module.exports = {
  HASH_PATTERN,
  LEGACY_PROMOTION_EVIDENCE_MANIFEST_VERSION,
  LEGACY_PROMOTION_EVIDENCE_RECORD_VERSION,
  PROMOTION_EVIDENCE_MANIFEST_VERSION,
  PROMOTION_EVIDENCE_RECORD_VERSION,
  buildPromotionEvidenceManifest,
  buildPromotionEvidenceRecord,
  canonicalJson,
  sha256Json,
  validatePromotionEvidenceManifest,
  validatePromotionEvidenceRecord,
};
