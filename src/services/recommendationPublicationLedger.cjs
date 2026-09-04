const crypto = require("node:crypto");
const fs = require("node:fs");

const PUBLICATION_LEDGER_VERSION = "recommendation-publication-ledger-v1";
const PUBLICATION_RECORD_VERSION = "recommendation-publication-v1";
const PUBLICATION_BINDING_VERSION = "recommendation-publication-binding-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PUBLICATION_ID_PATTERN = /^pub_[a-f0-9]{32}$/;
const TIP_CODES = new Set(["1", "X", "2"]);
const MARKET_TYPES = new Set(["HAD", "HHAD"]);
const SELECTION_ROLES = new Set(["BEST", "1X2"]);

const RECORD_FIELDS = Object.freeze([
  "version",
  "sequence",
  "publicationId",
  "publishedAt",
  "cutoffTime",
  "matchId",
  "sourceMatchId",
  "selectionRole",
  "marketType",
  "tipCode",
  "handicapLine",
  "odds",
  "strategyVersion",
  "strategyHash",
  "evidenceHash",
  "featureHash",
  "previousRecordHash",
  "recordHash",
]);

const BINDING_FIELDS = Object.freeze([
  "version",
  "recordHash",
  "publishedAt",
  "cutoffTime",
  "strategyHash",
  "evidenceHash",
  "featureHash",
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashPublicationEvidence(value) {
  return sha256(canonicalJson(value));
}

function text(value) {
  return String(value ?? "").trim();
}

function canonicalInstant(value) {
  const millis = Date.parse(text(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function earliestCanonicalInstant(...values) {
  const instants = values
    .map(canonicalInstant)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return instants[0] || null;
}

function canonicalHandicapLine(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) || value === 0 ? "0" : String(Number(value));
  }
  const normalized = text(value)
    .replace(/\u2212|\uFF0D/g, "-")
    .replace(/\uFF0B/g, "+")
    .replace(/^\u8BA9\u7403\s*/u, "")
    .replace(/\s*\u7403$/u, "")
    .trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return Object.is(number, -0) || number === 0 ? "0" : String(number);
}

function canonicalOdds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 1) return null;
  return Number(number.toFixed(4));
}

function recordIdentityPayload(record) {
  return Object.fromEntries(
    RECORD_FIELDS
      .filter((key) => key !== "publicationId" && key !== "recordHash")
      .map((key) => [key, record[key]])
  );
}

function publicationIdForRecord(record) {
  return `pub_${hashPublicationEvidence(recordIdentityPayload(record)).slice(0, 32)}`;
}

function recordHashForRecord(record) {
  return hashPublicationEvidence(Object.fromEntries(
    RECORD_FIELDS
      .filter((key) => key !== "recordHash")
      .map((key) => [key, record[key]])
  ));
}

function normalizePublicationInput(input, sequence, previousRecordHash) {
  const marketType = text(input?.marketType).toUpperCase();
  const selectionRole = text(input?.selectionRole).toUpperCase();
  const tipCode = text(input?.tipCode).toUpperCase();
  const handicapLine = canonicalHandicapLine(input?.handicapLine);
  const publishedAt = canonicalInstant(input?.publishedAt);
  const cutoffTime = canonicalInstant(input?.cutoffTime);
  return {
    version: PUBLICATION_RECORD_VERSION,
    sequence,
    publishedAt,
    cutoffTime,
    matchId: text(input?.matchId),
    sourceMatchId: text(input?.sourceMatchId),
    selectionRole,
    marketType,
    tipCode,
    handicapLine: marketType === "HAD" ? "0" : handicapLine,
    odds: canonicalOdds(input?.odds),
    strategyVersion: text(input?.strategyVersion),
    strategyHash: text(input?.strategyHash).toLowerCase(),
    evidenceHash: text(input?.evidenceHash).toLowerCase(),
    featureHash: text(input?.featureHash).toLowerCase(),
    previousRecordHash: previousRecordHash || null,
  };
}

function buildPublicationRecord(input, options = {}) {
  const sequence = Number(options.sequence ?? input?.sequence ?? 1);
  const previousRecordHash = options.previousRecordHash ?? input?.previousRecordHash ?? null;
  const normalized = normalizePublicationInput(input, sequence, previousRecordHash);
  const withId = {
    ...normalized,
    publicationId: publicationIdForRecord(normalized),
  };
  const record = {
    ...withId,
    recordHash: recordHashForRecord(withId),
  };
  const validation = validatePublicationRecord(record, {
    expectedSequence: sequence,
    expectedPreviousRecordHash: previousRecordHash || null,
  });
  if (!validation.valid) {
    const error = new Error(`Invalid recommendation publication: ${validation.errors.join(", ")}`);
    error.code = "INVALID_RECOMMENDATION_PUBLICATION";
    throw error;
  }
  return Object.freeze(record);
}

function validatePublicationRecord(record, options = {}) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, errors: ["record-not-object"] };
  }
  const unknownFields = Object.keys(record).filter((key) => !RECORD_FIELDS.includes(key));
  const missingFields = RECORD_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknownFields.length) errors.push(`unknown-fields:${unknownFields.sort().join("|")}`);
  if (missingFields.length) errors.push(`missing-fields:${missingFields.join("|")}`);
  if (record.version !== PUBLICATION_RECORD_VERSION) errors.push("record-version-invalid");
  if (!Number.isInteger(record.sequence) || record.sequence < 1) errors.push("sequence-invalid");
  if (Number.isInteger(options.expectedSequence) && record.sequence !== options.expectedSequence) {
    errors.push("sequence-mismatch");
  }
  if (!PUBLICATION_ID_PATTERN.test(text(record.publicationId))) errors.push("publication-id-invalid");
  if (!text(record.matchId)) errors.push("match-id-missing");
  if (!text(record.sourceMatchId)) errors.push("source-match-id-missing");
  if (!SELECTION_ROLES.has(text(record.selectionRole).toUpperCase())) errors.push("selection-role-invalid");
  if (!MARKET_TYPES.has(text(record.marketType).toUpperCase())) errors.push("market-type-invalid");
  if (!TIP_CODES.has(text(record.tipCode).toUpperCase())) errors.push("tip-code-invalid");
  if (canonicalOdds(record.odds) !== record.odds) errors.push("odds-invalid");
  if (!text(record.strategyVersion)) errors.push("strategy-version-missing");
  for (const key of ["strategyHash", "evidenceHash", "featureHash", "recordHash"]) {
    if (!HASH_PATTERN.test(text(record[key]).toLowerCase())) errors.push(`${key}-invalid`);
  }
  const previousHash = record.previousRecordHash;
  if (previousHash !== null && !HASH_PATTERN.test(text(previousHash).toLowerCase())) {
    errors.push("previous-record-hash-invalid");
  }
  const expectedPrevious = options.expectedPreviousRecordHash ?? null;
  if ((previousHash || null) !== expectedPrevious) errors.push("previous-record-hash-mismatch");
  const publishedAt = canonicalInstant(record.publishedAt);
  const cutoffTime = canonicalInstant(record.cutoffTime);
  if (!publishedAt || publishedAt !== record.publishedAt) errors.push("published-at-invalid");
  if (!cutoffTime || cutoffTime !== record.cutoffTime) errors.push("cutoff-time-invalid");
  if (publishedAt && cutoffTime && Date.parse(publishedAt) > Date.parse(cutoffTime)) {
    errors.push("publication-after-cutoff");
  }
  const marketType = text(record.marketType).toUpperCase();
  const canonicalLine = canonicalHandicapLine(record.handicapLine);
  if (canonicalLine === null || canonicalLine !== record.handicapLine) errors.push("handicap-line-invalid");
  if (marketType === "HAD" && record.handicapLine !== "0") errors.push("had-line-must-be-zero");
  if (publicationIdForRecord(record) !== record.publicationId) errors.push("publication-id-mismatch");
  if (recordHashForRecord(record) !== record.recordHash) errors.push("record-hash-mismatch");
  return { valid: errors.length === 0, errors };
}

function emptyPublicationLedger() {
  return { version: PUBLICATION_LEDGER_VERSION, rows: [] };
}

function validatePublicationLedger(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["ledger-not-object"], rows: 0 };
  }
  if (payload.version !== PUBLICATION_LEDGER_VERSION) errors.push("ledger-version-invalid");
  if (!Array.isArray(payload.rows)) errors.push("ledger-rows-invalid");
  const allowedRootFields = new Set(["version", "rows"]);
  const unknownRootFields = Object.keys(payload).filter((key) => !allowedRootFields.has(key));
  if (unknownRootFields.length) errors.push(`ledger-unknown-fields:${unknownRootFields.sort().join("|")}`);
  const seenIds = new Set();
  let previousRecordHash = null;
  for (const [index, record] of (Array.isArray(payload.rows) ? payload.rows : []).entries()) {
    const validation = validatePublicationRecord(record, {
      expectedSequence: index + 1,
      expectedPreviousRecordHash: previousRecordHash,
    });
    if (!validation.valid) {
      errors.push(...validation.errors.map((error) => `row-${index + 1}:${error}`));
    }
    if (seenIds.has(record?.publicationId)) errors.push(`row-${index + 1}:publication-id-duplicate`);
    seenIds.add(record?.publicationId);
    previousRecordHash = record?.recordHash || null;
  }
  return {
    valid: errors.length === 0,
    errors,
    rows: Array.isArray(payload.rows) ? payload.rows.length : 0,
    headHash: previousRecordHash,
  };
}

function appendPublicationRecord(payload, input) {
  const validation = validatePublicationLedger(payload);
  if (!validation.valid) {
    const error = new Error(`Cannot append to invalid recommendation publication ledger: ${validation.errors.join(", ")}`);
    error.code = "INVALID_RECOMMENDATION_PUBLICATION_LEDGER";
    throw error;
  }
  const rows = payload.rows.slice();
  const record = buildPublicationRecord(input, {
    sequence: rows.length + 1,
    previousRecordHash: rows[rows.length - 1]?.recordHash || null,
  });
  if (rows.some((row) => row.publicationId === record.publicationId)) {
    const error = new Error(`Recommendation publication already exists: ${record.publicationId}`);
    error.code = "DUPLICATE_RECOMMENDATION_PUBLICATION";
    throw error;
  }
  return {
    ledger: { version: PUBLICATION_LEDGER_VERSION, rows: [...rows, record] },
    record,
  };
}

function loadPublicationLedger(file) {
  if (!file || !fs.existsSync(file)) {
    const payload = emptyPublicationLedger();
    return {
      file: file || null,
      missing: true,
      payload,
      validation: validatePublicationLedger(payload),
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const validation = validatePublicationLedger(payload);
    return { file, missing: false, payload, validation };
  } catch (error) {
    return {
      file,
      missing: false,
      payload: emptyPublicationLedger(),
      validation: {
        valid: false,
        errors: [`ledger-read-failed:${error?.code || error?.name || "invalid-json"}`],
        rows: 0,
        headHash: null,
      },
    };
  }
}

function buildPublicationLedgerIndex(input) {
  const payload = input?.payload && input?.validation ? input.payload : input;
  const validation = input?.payload && input?.validation
    ? input.validation
    : validatePublicationLedger(payload);
  const byId = new Map();
  if (validation.valid) {
    for (const record of payload.rows) byId.set(record.publicationId, record);
  }
  return {
    valid: validation.valid,
    errors: validation.errors || [],
    rows: validation.valid ? byId.size : 0,
    sourceRows: Number(validation.rows || 0),
    headHash: validation.valid ? (validation.headHash || null) : null,
    byId,
  };
}

function publicationBindingForRecord(record) {
  return Object.freeze({
    version: PUBLICATION_BINDING_VERSION,
    recordHash: record.recordHash,
    publishedAt: record.publishedAt,
    cutoffTime: record.cutoffTime,
    strategyHash: record.strategyHash,
    evidenceHash: record.evidenceHash,
    featureHash: record.featureHash,
  });
}

function exactBindingMatchesRecord(binding, record) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  if (Object.keys(binding).some((key) => !BINDING_FIELDS.includes(key))) return false;
  if (BINDING_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(binding, key))) return false;
  return canonicalJson(binding) === canonicalJson(publicationBindingForRecord(record));
}

function matchIdentityMatchesRecord(match, record) {
  const matchId = text(match?.id);
  const sourceMatchId = text(match?.sourceMatchId || matchId.replace(/^sporttery_/, ""));
  return matchId === record.matchId && sourceMatchId === record.sourceMatchId;
}

function predictionMatchesRecord(match, prediction, record) {
  if (!prediction || !record) return false;
  if (text(prediction.publicationId) !== record.publicationId) return false;
  if (!exactBindingMatchesRecord(prediction.publicationEvidence, record)) return false;
  if (!matchIdentityMatchesRecord(match, record)) return false;
  const selectionRole = text(prediction.marketType).toUpperCase();
  const marketType = text(prediction.oddsPoolCode || (selectionRole === "1X2" ? "HAD" : "")).toUpperCase();
  const tipCode = text(prediction.tipCode).toUpperCase();
  const line = marketType === "HHAD" ? canonicalHandicapLine(prediction.handicapLine) : "0";
  const odds = canonicalOdds(prediction.odds);
  if (selectionRole !== record.selectionRole) return false;
  if (marketType !== record.marketType) return false;
  if (tipCode !== record.tipCode) return false;
  if (line !== record.handicapLine) return false;
  if (odds !== record.odds) return false;
  const matchCutoff = earliestCanonicalInstant(
    match?.predictionMeta?.cutoffTime,
    match?.buyEndTime,
    match?.kickoffTime
  );
  if (matchCutoff && matchCutoff !== record.cutoffTime) return false;
  const kickoff = canonicalInstant(match?.kickoffTime);
  if (kickoff && Date.parse(record.publishedAt) > Date.parse(kickoff)) return false;
  return true;
}

function resolvePublishedRecommendation(match, prediction, ledgerIndex) {
  if (!ledgerIndex?.valid || !(ledgerIndex.byId instanceof Map)) return null;
  const publicationId = text(prediction?.publicationId);
  if (!publicationId) return null;
  const record = ledgerIndex.byId.get(publicationId);
  return predictionMatchesRecord(match, prediction, record) ? record : null;
}

module.exports = {
  BINDING_FIELDS,
  PUBLICATION_BINDING_VERSION,
  PUBLICATION_LEDGER_VERSION,
  PUBLICATION_RECORD_VERSION,
  RECORD_FIELDS,
  appendPublicationRecord,
  buildPublicationLedgerIndex,
  buildPublicationRecord,
  canonicalJson,
  emptyPublicationLedger,
  hashPublicationEvidence,
  loadPublicationLedger,
  publicationBindingForRecord,
  resolvePublishedRecommendation,
  validatePublicationLedger,
  validatePublicationRecord,
};
