"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const {
  DataGenerationError,
  acquirePointerCommitLock,
  commitDataGeneration,
  readPointer,
  readGenerationFile,
  resolveCurrentGeneration,
  resolveGeneration,
  resolvePreviousGeneration,
  sha256File,
  storePaths,
} = require("./dataGenerationStore.cjs");

const PUBLICATION_VERSION = "immutable-base-generation-v1";
const GENERATION_ID_PATTERN = /^g-[a-f0-9]{64}$/;
const DEFAULT_RETENTION_COUNT = 4;
const DEFAULT_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_READER_LEASE_MS = 15 * 60 * 1000;
const LARGE_SEMANTIC_COMPARISON_DELTA_BYTES = 64 * 1024 * 1024;

const FILE_DEFINITIONS = Object.freeze([
  { path: "matches-current.json", required: true, kind: "array" },
  { path: "matches-history.json", required: true, kind: "array" },
  { path: "sync-meta.json", required: true, kind: "object" },
  { path: "external-signals.json", required: true, kind: "object" },
  { path: "odds-history.json", required: true, kind: "rows-object" },
  { path: "prediction-snapshots.json", required: true, kind: "rows-object" },
  { path: "model-calibration.json", required: true, kind: "object" },
  { path: "model-evaluation.json", required: false, kind: "object" },
  { path: "model-strategy.json", required: false, kind: "object" },
  { path: "post-match-reviews.json", required: false, kind: "object-or-array" },
  { path: "ai-arena.json", required: false, kind: "object" },
  { path: "pre-match-signals.json", required: false, kind: "object" },
  { path: "gpt-predictions.json", required: false, kind: "object-or-array" },
]);

const CORE_FILES = Object.freeze(
  FILE_DEFINITIONS.filter((definition) => definition.required).map((definition) => definition.path),
);

class DataPublicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DataPublicationError";
    this.code = code;
    this.details = details;
    this.statusCode = 503;
  }
}

const fail = (code, message, details) => {
  throw new DataPublicationError(code, message, details);
};

const isPlainObject = (value) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const validIso = (value) => Number.isFinite(Date.parse(String(value || "")));

const parseJsonBytes = (bytes, relativePath) => {
  try {
    const json = Buffer.isBuffer(bytes)
      ? bytes.toString("utf8")
      : Buffer.from(bytes).toString("utf8");
    return JSON.parse(json);
  } catch (error) {
    fail("GENERATION_JSON_INVALID", `invalid JSON in ${relativePath}`, {
      relativePath,
      cause: error.message || String(error),
    });
  }
};

const collectReleasedPayloads = () => {
  if (typeof global.gc === "function") global.gc();
};

const rowsForPayload = (payload) => {
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload?.rows)) return payload.rows.length;
  if (Array.isArray(payload?.matches)) return payload.matches.length;
  if (payload?.matches && typeof payload.matches === "object") return Object.keys(payload.matches).length;
  return 0;
};

const assertPayloadKind = (definition, payload) => {
  if (definition.kind === "array" && !Array.isArray(payload)) {
    fail("GENERATION_SEMANTIC_INVALID", `${definition.path} must be an array`);
  }
  if (definition.kind === "object" && !isPlainObject(payload)) {
    fail("GENERATION_SEMANTIC_INVALID", `${definition.path} must be a JSON object`);
  }
  if (definition.kind === "rows-object" && (!isPlainObject(payload) || !Array.isArray(payload.rows))) {
    fail("GENERATION_SEMANTIC_INVALID", `${definition.path} must be an object with rows[]`);
  }
  if (definition.kind === "object-or-array" && !isPlainObject(payload) && !Array.isArray(payload)) {
    fail("GENERATION_SEMANTIC_INVALID", `${definition.path} must be an object or array`);
  }
};

const assertMatchRows = (relativePath, rows) => {
  const ids = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isPlainObject(row)) {
      fail("GENERATION_SEMANTIC_INVALID", `${relativePath}[${index}] must be an object`);
    }
    const id = String(row.id || "").trim();
    if (!id) fail("GENERATION_SEMANTIC_INVALID", `${relativePath}[${index}] is missing id`);
    if (ids.has(id)) fail("GENERATION_SEMANTIC_INVALID", `${relativePath} has duplicate id ${id}`);
    ids.add(id);
  }
  return ids;
};

const validateBundleReader = ({
  hasPayload,
  readPayload,
  inspectMatchArray,
  sourceCycleId,
  reportedFiles,
  includeSemanticHash = false,
}) => {
  if (typeof hasPayload !== "function" || typeof readPayload !== "function") {
    fail("INVALID_ARGUMENT", "hasPayload and readPayload must be functions");
  }
  for (const definition of FILE_DEFINITIONS) {
    if (!hasPayload(definition.path)) {
      if (definition.required) fail("GENERATION_CORE_FILE_MISSING", `missing ${definition.path}`);
    }
  }

  let files = 0;
  let metaCycle = "";
  let metaTimestampValid = false;
  let declaredCurrent;
  let declaredHistory;
  let declaredPredictionSnapshots;
  let currentRows = 0;
  let historyRows = 0;
  let oddsRows = 0;
  let predictionRows = 0;
  let calibrationValid = false;

  const validationDefinitions = includeSemanticHash
    ? [
        ...[...CORE_FILES]
          .sort()
          .map((relativePath) => FILE_DEFINITIONS.find((entry) => entry.path === relativePath)),
        ...FILE_DEFINITIONS.filter((definition) => !CORE_FILES.includes(definition.path)),
      ]
    : FILE_DEFINITIONS;
  const semanticHasher = includeSemanticHash ? crypto.createHash("sha256") : null;
  let semanticEntries = 0;
  if (semanticHasher) semanticHasher.update("{");

  for (const definition of validationDefinitions) {
    if (!hasPayload(definition.path)) continue;
    if (
      definition.path === "matches-history.json"
      && typeof inspectMatchArray === "function"
    ) {
      files += 1;
      if (semanticHasher) {
        if (semanticEntries > 0) semanticHasher.update(",");
        semanticHasher.update(JSON.stringify(definition.path));
        semanticHasher.update(":");
      }
      const inspection = inspectMatchArray(definition.path, {
        semanticHasher,
      });
      historyRows = inspection.rows;
      if (semanticHasher) semanticEntries += 1;
      continue;
    }
    let payload = readPayload(definition.path);
    try {
      files += 1;
      assertPayloadKind(definition, payload);
      if (semanticHasher && CORE_FILES.includes(definition.path)) {
        if (semanticEntries > 0) semanticHasher.update(",");
        semanticHasher.update(JSON.stringify(definition.path));
        semanticHasher.update(":");
        writeSemanticPayload(semanticHasher, definition.path, payload);
        semanticEntries += 1;
      }
      switch (definition.path) {
        case "sync-meta.json": {
          metaCycle = String(payload?.sourceCycleId || "").trim();
          metaTimestampValid = validIso(payload?.updatedAt || payload?.capturedAt);
          const declared = payload?.files && typeof payload.files === "object" ? payload.files : {};
          declaredCurrent = declared.current;
          declaredHistory = declared.history;
          declaredPredictionSnapshots = declared.predictionSnapshots;
          break;
        }
        case "matches-current.json":
          assertMatchRows(definition.path, payload);
          currentRows = payload.length;
          break;
        case "matches-history.json":
          // A short current/history overlap is intentional during the terminal
          // event bridge, so uniqueness is enforced independently per lane.
          assertMatchRows(definition.path, payload);
          historyRows = payload.length;
          break;
        case "odds-history.json":
          oddsRows = payload.rows.length;
          break;
        case "prediction-snapshots.json":
          predictionRows = payload.rows.length;
          break;
        case "model-calibration.json":
          calibrationValid = Boolean(
            String(payload?.version || "").trim()
            && validIso(payload?.generatedAt)
          );
          break;
        default:
          break;
      }
    } finally {
      // Generation-backed callers parse only one file at a time. Explicitly
      // drop the reference before advancing to keep large history arrays out
      // of the next file's live set.
      payload = null;
      collectReleasedPayloads();
    }
  }

  if (!metaCycle) fail("GENERATION_SOURCE_CYCLE_MISSING", "sync-meta.json.sourceCycleId is required");
  if (sourceCycleId && metaCycle !== String(sourceCycleId).trim()) {
    fail("GENERATION_SOURCE_CYCLE_MISMATCH", "sync-meta sourceCycleId differs from generation", {
      expected: String(sourceCycleId).trim(),
      actual: metaCycle,
    });
  }
  if (!metaTimestampValid) {
    fail("GENERATION_SEMANTIC_INVALID", "sync-meta.json needs a valid updatedAt or capturedAt");
  }

  const exactCounts = [
    ["current", declaredCurrent, currentRows],
    ["history", declaredHistory, historyRows],
    ["predictionSnapshots", declaredPredictionSnapshots, predictionRows],
  ];
  for (const [key, declared, actual] of exactCounts) {
    if (declared !== undefined && Number(declared) !== actual) {
      fail("GENERATION_SEMANTIC_INVALID", `sync-meta files.${key} does not match ${actual}`, {
        declared,
        actual,
      });
    }
  }

  if (!calibrationValid) {
    fail("GENERATION_SEMANTIC_INVALID", "model-calibration.json needs version and generatedAt");
  }

  if (semanticHasher) semanticHasher.update("}");

  return Object.freeze({
    ok: true,
    sourceCycleId: metaCycle,
    files: Number.isSafeInteger(reportedFiles) ? reportedFiles : files,
    currentRows,
    historyRows,
    oddsRows,
    predictionRows,
    ...(semanticHasher ? { semanticHash: semanticHasher.digest("hex") } : {}),
  });
};

const validateBundlePayloads = ({ payloads, sourceCycleId }) => {
  if (!(payloads instanceof Map)) fail("INVALID_ARGUMENT", "payloads must be a Map");
  return validateBundleReader({
    hasPayload: (relativePath) => payloads.has(relativePath),
    readPayload: (relativePath) => payloads.get(relativePath),
    sourceCycleId,
    reportedFiles: payloads.size,
  });
};

const SYNC_META_VOLATILE_KEYS = new Set([
  "sourceCycleId",
  "updatedAt",
  "capturedAt",
  "lastAttemptAt",
  "checkedAt",
  "requestedAt",
  "receivedAt",
  "finishedAt",
  "startedAt",
  "durationMs",
  "ageSeconds",
  "ageMinutes",
  "freshnessTime",
  "currentFreshnessTime",
  "historyFreshnessTime",
  "resultFreshnessTime",
]);

const MATCH_SEMANTIC_VOLATILE_KEYS = new Set(["sourceCycleId"]);
const TOP_LEVEL_UPDATED_AT_FILES = new Set([
  "external-signals.json",
  "odds-history.json",
  "prediction-snapshots.json",
]);

const canonicalValueFail = (location, message) => {
  throw new DataGenerationError("INVALID_CANONICAL_VALUE", `${location} ${message}`);
};

const writeCanonicalSemanticValue = (hash, value, {
  relativePath,
  location,
  depth = 0,
  recursivelySanitized = false,
  omittedKeys = null,
}) => {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) canonicalValueFail(location, "must be finite");
    hash.update(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(",");
      // Array holes survive Array#map in the legacy canonicalizer and are
      // serialized by JSON.stringify as null. Preserve that byte contract.
      if (!(index in value)) {
        hash.update("null");
        continue;
      }
      writeCanonicalSemanticValue(hash, value[index], {
        relativePath,
        location: `${location}[${index}]`,
        depth: depth + 1,
        recursivelySanitized,
        omittedKeys,
      });
    }
    hash.update("]");
    return;
  }

  const objectAccepted = value
    && typeof value === "object"
    && (recursivelySanitized || isPlainObject(value));
  if (!objectAccepted) canonicalValueFail(location, "is not JSON-canonicalizable");

  hash.update("{");
  let written = 0;
  for (const key of Object.keys(value).sort()) {
    const omitRecursively = recursivelySanitized && omittedKeys?.has(key);
    const omitTopLevelUpdatedAt = depth === 0
      && TOP_LEVEL_UPDATED_AT_FILES.has(relativePath)
      && isPlainObject(value)
      && key === "updatedAt";
    if (omitRecursively || omitTopLevelUpdatedAt) continue;
    if (value[key] === undefined) canonicalValueFail(`${location}.${key}`, "is undefined");
    if (written > 0) hash.update(",");
    hash.update(JSON.stringify(key));
    hash.update(":");
    writeCanonicalSemanticValue(hash, value[key], {
      relativePath,
      location: `${location}.${key}`,
      depth: depth + 1,
      recursivelySanitized,
      omittedKeys,
    });
    written += 1;
  }
  hash.update("}");
};

const writeSemanticPayload = (hash, relativePath, payload) => {
  const recursivelySanitized = relativePath === "sync-meta.json"
    || relativePath === "matches-current.json"
    || relativePath === "matches-history.json";
  const omittedKeys = relativePath === "sync-meta.json"
    ? SYNC_META_VOLATILE_KEYS
    : MATCH_SEMANTIC_VOLATILE_KEYS;
  writeCanonicalSemanticValue(hash, payload, {
    relativePath,
    location: `projection.${relativePath}`,
    recursivelySanitized,
    omittedKeys,
  });
};

const inspectMatchArrayFile = (filePath, relativePath, { semanticHasher = null } = {}) => {
  const fd = fs.openSync(filePath, "r");
  const rawHasher = crypto.createHash("sha256");
  const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const ids = new Set();
  let bytes = 0;
  let rows = 0;
  let outerStarted = false;
  let outerFinished = false;
  let arrayState = "value-or-end";
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let rowSource = "";

  const invalid = (message, details = {}) => fail(
    "GENERATION_JSON_INVALID",
    `invalid JSON in ${relativePath}: ${message}`,
    { relativePath, ...details },
  );
  const finishRow = () => {
    let row;
    try {
      row = JSON.parse(rowSource);
    } catch (error) {
      invalid(error.message || String(error), { row: rows });
    }
    if (!isPlainObject(row)) {
      fail("GENERATION_SEMANTIC_INVALID", `${relativePath}[${rows}] must be an object`);
    }
    const id = String(row.id || "").trim();
    if (!id) fail("GENERATION_SEMANTIC_INVALID", `${relativePath}[${rows}] is missing id`);
    if (ids.has(id)) fail("GENERATION_SEMANTIC_INVALID", `${relativePath} has duplicate id ${id}`);
    ids.add(id);
    if (semanticHasher) {
      if (rows > 0) semanticHasher.update(",");
      writeCanonicalSemanticValue(semanticHasher, row, {
        relativePath,
        location: `projection.${relativePath}[${rows}]`,
        depth: 1,
        recursivelySanitized: true,
        omittedKeys: MATCH_SEMANTIC_VOLATILE_KEYS,
      });
    }
    rows += 1;
    row = null;
    rowSource = "";
    collecting = false;
    arrayState = "comma-or-end";
    // Parsed rows are not retained. A bounded periodic collection prevents
    // old-generation growth without turning a large history file into
    // thousands of full-GC pauses.
    if (rows % 256 === 0) collectReleasedPayloads();
  };
  const consume = (source) => {
    for (const char of source) {
      if (outerFinished) {
        if (!/\s/.test(char)) invalid("trailing content after top-level array");
        continue;
      }
      if (!outerStarted) {
        if (/\s/.test(char) || char === "\uFEFF") continue;
        if (char !== "[") invalid("top-level value must be an array");
        outerStarted = true;
        if (semanticHasher) semanticHasher.update("[");
        continue;
      }
      if (!collecting) {
        if (/\s/.test(char)) continue;
        if (arrayState === "comma-or-end") {
          if (char === ",") {
            arrayState = "value";
            continue;
          }
          if (char !== "]") invalid(`row ${rows} must be followed by a comma or array end`);
        }
        if (char === "]") {
          if (arrayState === "value") invalid("trailing comma is not valid JSON");
          outerFinished = true;
          if (semanticHasher) semanticHasher.update("]");
          continue;
        }
        if (char !== "{") invalid(`row ${rows} must start with an object`);
        collecting = true;
        depth = 1;
        inString = false;
        escaped = false;
        rowSource = char;
        continue;
      }

      rowSource += char;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth < 0) invalid(`row ${rows} has unbalanced JSON`);
        if (depth === 0) finishRow();
      }
    }
  };

  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      rawHasher.update(chunk);
      bytes += read;
      consume(decoder.write(chunk));
    }
    consume(decoder.end());
    if (!outerStarted || !outerFinished || collecting) {
      invalid("top-level array is incomplete");
    }
    const inspection = Object.freeze({
      rows,
      bytes,
      sha256: rawHasher.digest("hex"),
    });
    collectReleasedPayloads();
    return inspection;
  } finally {
    fs.closeSync(fd);
  }
};

const bundleSemanticHashFromReader = ({ hasPayload, readPayload }) => {
  const hash = crypto.createHash("sha256");
  hash.update("{");
  const sortedCoreFiles = [...CORE_FILES].sort();
  for (let index = 0; index < sortedCoreFiles.length; index += 1) {
    const relativePath = sortedCoreFiles[index];
    if (!hasPayload(relativePath)) {
      fail("GENERATION_CORE_FILE_MISSING", `missing ${relativePath}`);
    }
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(relativePath));
    hash.update(":");
    let payload = readPayload(relativePath);
    try {
      writeSemanticPayload(hash, relativePath, payload);
    } finally {
      payload = null;
      collectReleasedPayloads();
    }
  }
  hash.update("}");
  return hash.digest("hex");
};

const bundleSemanticHash = (payloads) => {
  if (!(payloads instanceof Map)) fail("INVALID_ARGUMENT", "payloads must be a Map");
  return bundleSemanticHashFromReader({
    hasPayload: (relativePath) => payloads.has(relativePath),
    readPayload: (relativePath) => payloads.get(relativePath),
  });
};

const generationPayloadReader = (context) => {
  const manifestPaths = new Set(context.manifest.files.map((entry) => entry.path));
  return {
    hasPayload: (relativePath) => manifestPaths.has(relativePath),
    readPayload: (relativePath) => readGenerationFile(context, relativePath, { parseJson: true }),
    inspectMatchArray: (relativePath, options) => inspectMatchArrayFile(
      path.join(context.generationDir, ...relativePath.split("/")),
      relativePath,
      options,
    ),
    reportedFiles: FILE_DEFINITIONS.filter((definition) => manifestPaths.has(definition.path)).length,
  };
};

const readMutableBundle = ({ publicDataDir }) => {
  const resolvedDir = path.resolve(publicDataDir);
  const files = new Map();
  const observations = new Map();
  for (const definition of FILE_DEFINITIONS) {
    const filePath = path.join(resolvedDir, definition.path);
    if (!fs.existsSync(filePath)) {
      if (definition.required) fail("GENERATION_CORE_FILE_MISSING", `missing ${filePath}`);
      continue;
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("GENERATION_FILE_UNSAFE", `${filePath} must be a regular file`);
    }
    files.set(definition.path, Object.freeze({
      definition,
      filePath,
    }));
  }
  const readPayload = (relativePath) => {
    const entry = files.get(relativePath);
    if (!entry) fail("GENERATION_CORE_FILE_MISSING", `missing ${relativePath}`);
    const bytes = fs.readFileSync(entry.filePath);
    const payload = parseJsonBytes(bytes, relativePath);
    observations.set(relativePath, Object.freeze({
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      rows: rowsForPayload(payload),
    }));
    return payload;
  };
  const inspectMatchArray = (relativePath, options) => {
    const entry = files.get(relativePath);
    if (!entry) fail("GENERATION_CORE_FILE_MISSING", `missing ${relativePath}`);
    const inspection = inspectMatchArrayFile(entry.filePath, relativePath, options);
    observations.set(relativePath, Object.freeze({
      sha256: inspection.sha256,
      bytes: inspection.bytes,
      rows: inspection.rows,
    }));
    return inspection;
  };
  const descriptors = () => {
    const result = {};
    for (const [relativePath, entry] of files.entries()) {
      const observation = observations.get(relativePath);
      if (!observation) {
        fail("GENERATION_SOURCE_NOT_OBSERVED", `source file was not validated: ${relativePath}`);
      }
      const currentStat = fs.lstatSync(entry.filePath);
      if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
        fail("GENERATION_FILE_UNSAFE", `${entry.filePath} must remain a regular file`);
      }
      const currentHash = sha256File(entry.filePath);
      if (currentStat.size !== observation.bytes || currentHash !== observation.sha256) {
        fail("GENERATION_SOURCE_CHANGED", `source file changed during generation preparation: ${relativePath}`, {
          relativePath,
          expectedBytes: observation.bytes,
          actualBytes: currentStat.size,
          expectedSha256: observation.sha256,
          actualSha256: currentHash,
        });
      }
      result[relativePath] = {
        sourcePath: entry.filePath,
        expectedSha256: observation.sha256,
        expectedBytes: observation.bytes,
        rows: observation.rows,
      };
    }
    return result;
  };
  return Object.freeze({
    hasPayload: (relativePath) => files.has(relativePath),
    readPayload,
    inspectMatchArray,
    reportedFiles: files.size,
    descriptors,
  });
};

const validateGenerationBundle = (context, { includeSemanticHash = false } = {}) => {
  const reader = generationPayloadReader(context);
  return validateBundleReader({
    ...reader,
    sourceCycleId: context.sourceCycleId,
    includeSemanticHash,
  });
};

const commitCurrentDataGeneration = ({
  storeDir,
  publicDataDir,
  sourceCycleId = null,
  committedAt = new Date().toISOString(),
  faultInjector,
  pointerLockTimeoutMs = 10_000,
  pointerLockStaleMs = 60_000,
}) => {
  const loaded = readMutableBundle({ publicDataDir });
  const syncMeta = loaded.readPayload("sync-meta.json");
  const metaCycle = String(syncMeta?.sourceCycleId || "").trim();
  const effectiveCycle = String(sourceCycleId || metaCycle).trim();
  const inspected = validateBundleReader({
    ...loaded,
    sourceCycleId: effectiveCycle,
    includeSemanticHash: true,
  });
  const { semanticHash, ...validationFields } = inspected;
  const validation = Object.freeze(validationFields);
  const sourceFiles = loaded.descriptors();
  const paths = storePaths(storeDir);
  fs.mkdirSync(paths.root, { recursive: true });
  const pointerLock = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: pointerLockTimeoutMs,
    staleMs: pointerLockStaleMs,
  });
  try {
    if (fs.existsSync(paths.currentPointer)) {
      const activeContext = resolveCurrentGeneration({ storeDir });
      const activeManifestByPath = new Map(
        activeContext.manifest.files.map((entry) => [entry.path, entry])
      );
      const coreByteShapeChanged = FILE_DEFINITIONS
        .filter((definition) => definition.required && definition.kind === "rows-object")
        .some(({ path: relativePath }) => {
          const source = sourceFiles[relativePath];
          const active = activeManifestByPath.get(relativePath);
          if (!source || !active) return true;
          return Math.abs(Number(source.expectedBytes) - Number(active.bytes))
            >= LARGE_SEMANTIC_COMPARISON_DELTA_BYTES;
        });
      if (!coreByteShapeChanged) {
        const activeInspection = validateGenerationBundle(activeContext, { includeSemanticHash: true });
        const activeSemanticHash = activeInspection.semanticHash;
        if (activeSemanticHash === semanticHash) {
          // Re-hash the mutable source after the potentially long active
          // generation validation. This preserves the old in-memory snapshot
          // guarantee without retaining every parsed payload and raw file.
          loaded.descriptors();
          return Object.freeze({
            committed: true,
            idempotent: true,
            semanticNoop: true,
            reusedGeneration: true,
            generationPublished: false,
            pointer: activeContext.pointer,
            previousPointer: readPointer(paths.previousPointer, { optional: true }),
            context: activeContext,
            validation,
            semanticHash,
            activeComparison: "semantic-equality",
            requestedSourceCycleId: effectiveCycle,
            activeSourceCycleId: activeContext.sourceCycleId,
          });
        }
      }
    }
    // Keep the same pointer lock through staging and pointer publication.  This
    // closes the compare/release/commit race where two semantically identical
    // source cycles could otherwise create consecutive immutable directories.
    const result = commitDataGeneration({
      storeDir,
      sourceCycleId: effectiveCycle,
      files: sourceFiles,
      coreFiles: CORE_FILES,
      committedAt,
      faultInjector,
      validate: validateGenerationBundle,
      pointerLockHandle: pointerLock,
    });
    return Object.freeze({
      ...result,
      validation,
      semanticHash,
      semanticNoop: false,
      activeComparison: "new-generation",
      requestedSourceCycleId: effectiveCycle,
      activeSourceCycleId: result.pointer.sourceCycleId,
    });
  } finally {
    pointerLock.release();
  }
};

const publicationIdentity = ({ mode, context = null }) => Object.freeze({
  version: PUBLICATION_VERSION,
  mode,
  generationId: context?.generationId || null,
  manifestHash: context?.manifestHash || null,
  sourceCycleId: context?.sourceCycleId || null,
  committedAt: context?.pointer?.committedAt || null,
  active: mode === "active-generation",
});

const legacyPublication = (publicDataDir) => Object.freeze({
  mode: "legacy-bootstrap",
  context: null,
  publicDataDir: path.resolve(publicDataDir),
  identity: publicationIdentity({ mode: "legacy-bootstrap" }),
});

const resolveActivePublication = ({ storeDir, publicDataDir }) => {
  const paths = storePaths(storeDir);
  if (!fs.existsSync(paths.currentPointer)) return legacyPublication(publicDataDir);
  let context;
  try {
    context = resolveCurrentGeneration({ storeDir });
    validateGenerationBundle(context);
  } catch (error) {
    fail("ACTIVE_GENERATION_INVALID", "active data generation is invalid", {
      causeCode: error?.code || null,
      cause: error?.message || String(error),
    });
  }
  return Object.freeze({
    mode: "active-generation",
    context,
    publicDataDir: path.resolve(publicDataDir),
    identity: publicationIdentity({ mode: "active-generation", context }),
  });
};

const resolveServingPublication = ({ storeDir, publicDataDir, allowPrevious = true }) => {
  const paths = storePaths(storeDir);
  if (!fs.existsSync(paths.currentPointer)) return legacyPublication(publicDataDir);
  try {
    return resolveActivePublication({ storeDir, publicDataDir });
  } catch (activeError) {
    if (!allowPrevious || !fs.existsSync(paths.previousPointer)) throw activeError;
    try {
      const context = resolvePreviousGeneration({ storeDir });
      validateGenerationBundle(context);
      return Object.freeze({
        mode: "previous-generation",
        context,
        publicDataDir: path.resolve(publicDataDir),
        identity: publicationIdentity({ mode: "previous-generation", context }),
        activeError: Object.freeze({
          code: activeError.code || null,
          message: activeError.message || String(activeError),
        }),
      });
    } catch (previousError) {
      fail("PUBLICATION_GENERATIONS_INVALID", "active and previous data generations are invalid", {
        activeCode: activeError?.code || null,
        previousCode: previousError?.code || null,
      });
    }
  }
};

const readPublicationJson = (publication, relativePath, fallback = null) => {
  const definition = FILE_DEFINITIONS.find((entry) => entry.path === relativePath);
  if (publication?.context) {
    const present = publication.context.manifest.files.some((entry) => entry.path === relativePath);
    if (!present && definition?.required) {
      fail("GENERATION_CORE_FILE_MISSING", `missing ${relativePath}`);
    }
    if (!present) return fallback;
    try {
      return readGenerationFile(publication.context, relativePath, { parseJson: true });
    } catch (error) {
      // Optional projections must never turn the otherwise healthy public API
      // into a 500 after a late disk fault. Required base files still fail
      // closed, while optional files degrade to the caller's explicit fallback.
      if (!definition?.required && error instanceof DataGenerationError) return fallback;
      throw error;
    }
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(publication.publicDataDir, relativePath), "utf8"));
  } catch {
    return fallback;
  }
};

const samePublicationIdentity = (left, right) => Boolean(
  left?.version === right?.version
  && left?.mode === right?.mode
  && left?.generationId === right?.generationId
  && left?.manifestHash === right?.manifestHash
  && left?.sourceCycleId === right?.sourceCycleId
  && left?.committedAt === right?.committedAt
);

const selectFastResultReceiptDuringPairTransition = ({
  sqliteState,
  cachedState,
  transitionActive = false,
  validatedAtMs = 0,
  nowMs = Date.now(),
  ttlMs = 120_000,
} = {}) => {
  if (sqliteState?.valid === true && sqliteState?.receipt) return sqliteState;
  const ageMs = Math.max(0, Number(nowMs || 0) - Number(validatedAtMs || 0));
  if (
    sqliteState?.reason !== "publication-identity-mismatch"
    || transitionActive !== true
    || cachedState?.valid !== true
    || !cachedState?.receipt
    || !Number.isFinite(ageMs)
    || ageMs > Math.max(1, Number(ttlMs || 0))
  ) return sqliteState;
  return {
    ...cachedState,
    reason: "sqlite-pair-refresh-pending",
    transition: true,
    transitionSource: "cached-validated-receipt",
    sqliteReason: sqliteState.reason,
    validatedAt: new Date(Number(validatedAtMs)).toISOString(),
  };
};

const assertActivePublicationUnchanged = ({ storeDir, publicDataDir, expected }) => {
  const actual = resolveActivePublication({ storeDir, publicDataDir });
  if (!samePublicationIdentity(expected?.identity, actual.identity)) {
    fail("DATA_GENERATION_POINTER_CHANGED", "data generation pointer changed during operation", {
      expected: expected?.identity || null,
      actual: actual.identity,
    });
  }
  return actual;
};

// Release prebuilds already performed the expensive immutable-generation
// validation before opening their cloned SQLite projection.  Re-reading the
// current pointer is sufficient for their final compare-and-swap check: every
// generation payload consumed by the exporter was independently checked
// against the validated manifest by readGenerationFile(), while the canonical
// release sync barrier prevents a supported writer from rotating the pointer.
// Keep this helper deliberately pointer-only so a 1GB projection does not pay
// for a second full generation hash + semantic parse immediately before COMMIT.
const assertActivePublicationPointerUnchanged = ({ storeDir, expected }) => {
  const expectedPointer = expected?.context?.pointer;
  if (
    expected?.mode !== "active-generation"
    || expected?.identity?.active !== true
    || !expectedPointer
  ) {
    fail("ACTIVE_GENERATION_EXPECTED", "pointer-only publication verification requires an active generation");
  }

  const currentPointer = readPointer(storePaths(storeDir).currentPointer);
  const fields = [
    "schemaVersion",
    "generationId",
    "manifestHash",
    "sourceCycleId",
    "committedAt",
  ];
  const changedFields = fields.filter((field) => (
    String(currentPointer?.[field] ?? "") !== String(expectedPointer?.[field] ?? "")
  ));
  if (changedFields.length) {
    fail("DATA_GENERATION_POINTER_CHANGED", "data generation pointer changed during operation", {
      changedFields,
      expected: Object.fromEntries(fields.map((field) => [field, expectedPointer?.[field] ?? null])),
      actual: Object.fromEntries(fields.map((field) => [field, currentPointer?.[field] ?? null])),
    });
  }
  return Object.freeze({ ...currentPointer });
};

// Execute the caller's final commit while holding the exact same lock used by
// supported generation-pointer writers. This makes the strict pointer CAS and
// the dependent SQLite COMMIT one atomic critical section without granting the
// read-only caller permission to publish or rewrite a generation pointer.
const commitWithActivePublicationPointerLock = ({
  storeDir,
  expected,
  commit,
  timeoutMs = 10_000,
  staleMs = 60_000,
}) => {
  if (typeof commit !== "function") {
    fail("INVALID_ARGUMENT", "pointer-guarded publication commit requires a commit callback");
  }
  const paths = storePaths(storeDir);
  fs.mkdirSync(paths.root, { recursive: true });
  const pointerLock = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs,
    staleMs,
  });
  try {
    const pointer = assertActivePublicationPointerUnchanged({ storeDir, expected });
    return commit(pointer);
  } finally {
    pointerLock.release();
  }
};

const sameResolvedPath = (left, right) => {
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  return normalize(left) === normalize(right);
};

const assertCleanupRootsSafe = (paths) => {
  for (const directory of [paths.root, paths.generationsDir]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("GENERATION_CLEANUP_UNSAFE_ROOT", `cleanup root is not a real directory: ${directory}`);
    }
    if (!sameResolvedPath(fs.realpathSync(directory), directory)) {
      fail("GENERATION_CLEANUP_UNSAFE_ROOT", `cleanup root resolves outside its canonical path: ${directory}`);
    }
  }
};

const safeGenerationCandidate = ({ generationsDir, candidatePath, generationId }) => {
  if (!GENERATION_ID_PATTERN.test(String(generationId || ""))) return false;
  const expected = path.join(path.resolve(generationsDir), generationId);
  if (!sameResolvedPath(candidatePath, expected)) return false;
  if (!sameResolvedPath(path.dirname(path.resolve(candidatePath)), generationsDir)) return false;
  let stat;
  try { stat = fs.lstatSync(candidatePath); } catch { return false; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  try {
    return sameResolvedPath(fs.realpathSync(candidatePath), expected);
  } catch {
    return false;
  }
};

const readerLeaseDirectory = (storeDir) => path.join(storePaths(storeDir).root, "readers");

const ensureReaderLeaseDirectory = (storeDir) => {
  const directory = readerLeaseDirectory(storeDir);
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameResolvedPath(fs.realpathSync(directory), directory)) {
    fail("GENERATION_READER_DIR_UNSAFE", "generation reader lease directory is unsafe");
  }
  return directory;
};

const acquireGenerationReadLease = ({
  storeDir,
  generationId,
  context = null,
  owner = `pid-${process.pid}`,
  ttlMs = DEFAULT_READER_LEASE_MS,
  now = Date.now(),
}) => {
  if (!GENERATION_ID_PATTERN.test(String(generationId || ""))) {
    fail("INVALID_GENERATION_ID", "reader lease generationId is invalid");
  }
  const paths = storePaths(storeDir);
  fs.mkdirSync(paths.root, { recursive: true });
  const pointerLock = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 10_000,
    staleMs: 60_000,
  });
  let leasePath;
  let payload;
  try {
    resolveGeneration({
      storeDir,
      generationId,
      manifestHash: context?.manifestHash,
      sourceCycleId: context?.sourceCycleId,
    });
    const safeTtlMs = Math.max(1_000, Number(ttlMs || DEFAULT_READER_LEASE_MS));
    const directory = ensureReaderLeaseDirectory(storeDir);
    const leaseId = crypto.randomUUID();
    leasePath = path.join(directory, `reader-${leaseId}.json`);
    payload = {
      version: 1,
      leaseId,
      generationId,
      owner: String(owner || `pid-${process.pid}`).slice(0, 160),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + safeTtlMs).toISOString(),
    };
    fs.writeFileSync(leasePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    pointerLock.release();
  }
  let released = false;
  return Object.freeze({
    ...payload,
    path: leasePath,
    release: () => {
      if (released) return false;
      released = true;
      let stat;
      try { stat = fs.lstatSync(leasePath); } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail("GENERATION_READER_LEASE_UNSAFE", "reader lease changed before release");
      }
      fs.unlinkSync(leasePath);
      return true;
    },
  });
};

const readGenerationReaderLeases = ({ storeDir, now = Date.now(), removeExpired = true }) => {
  const directory = readerLeaseDirectory(storeDir);
  if (!fs.existsSync(directory)) return { protectedIds: new Set(), active: [], expired: [], ignored: [] };
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameResolvedPath(fs.realpathSync(directory), directory)) {
    fail("GENERATION_READER_DIR_UNSAFE", "generation reader lease directory is unsafe");
  }
  const protectedIds = new Set();
  const active = [];
  const expired = [];
  const ignored = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const leasePath = path.join(directory, entry.name);
    if (!/^reader-[0-9a-f-]{36}\.json$/i.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      ignored.push(entry.name);
      continue;
    }
    let lease;
    try { lease = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch {
      ignored.push(entry.name);
      continue;
    }
    const expiresAtMs = Date.parse(String(lease?.expiresAt || ""));
    if (lease?.version !== 1
        || !GENERATION_ID_PATTERN.test(String(lease?.generationId || ""))
        || !Number.isFinite(expiresAtMs)) {
      ignored.push(entry.name);
      continue;
    }
    if (expiresAtMs > now) {
      protectedIds.add(lease.generationId);
      active.push(lease);
      continue;
    }
    expired.push(lease);
    if (removeExpired) fs.unlinkSync(leasePath);
  }
  return { protectedIds, active, expired, ignored };
};

const cleanupDataGenerations = ({
  storeDir,
  retainCount = DEFAULT_RETENTION_COUNT,
  graceMs = DEFAULT_CLEANUP_GRACE_MS,
  now = Date.now(),
  protectedGenerationIds = [],
  faultInjector = null,
}) => {
  const paths = storePaths(storeDir);
  if (!fs.existsSync(paths.currentPointer)) {
    return Object.freeze({
      ok: true,
      skipped: true,
      reason: "current-pointer-missing",
      deleted: [],
      retained: [],
    });
  }
  assertCleanupRootsSafe(paths);
  const requestedRetainCount = Number(retainCount);
  const requestedGraceMs = Number(graceMs);
  const safeRetainCount = Math.max(
    DEFAULT_RETENTION_COUNT,
    Number.isFinite(requestedRetainCount) ? Math.floor(requestedRetainCount) : DEFAULT_RETENTION_COUNT,
  );
  const safeGraceMs = Math.max(0, Number.isFinite(requestedGraceMs) ? requestedGraceMs : DEFAULT_CLEANUP_GRACE_MS);
  const pointerLock = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 10_000,
    staleMs: 60_000,
  });
  try {
    // Re-check after lock acquisition so a concurrent pointer writer or path
    // replacement cannot invalidate the roots validated before waiting.
    assertCleanupRootsSafe(paths);
    const current = resolveCurrentGeneration({ storeDir });
    const previous = fs.existsSync(paths.previousPointer)
      ? resolvePreviousGeneration({ storeDir })
      : null;
    const readers = readGenerationReaderLeases({ storeDir, now, removeExpired: true });
    const explicitlyProtected = new Set(
      protectedGenerationIds
        .map((value) => String(value || ""))
        .filter((value) => GENERATION_ID_PATTERN.test(value)),
    );
    const candidates = [];
    const ignored = [];
    for (const entry of fs.readdirSync(paths.generationsDir, { withFileTypes: true })) {
      const candidatePath = path.join(paths.generationsDir, entry.name);
      if (!safeGenerationCandidate({
        generationsDir: paths.generationsDir,
        candidatePath,
        generationId: entry.name,
      })) {
        ignored.push(entry.name);
        continue;
      }
      const stat = fs.statSync(candidatePath);
      candidates.push({
        generationId: entry.name,
        path: candidatePath,
        mtimeMs: stat.mtimeMs,
      });
    }
    candidates.sort((left, right) => (
      right.mtimeMs - left.mtimeMs
      || right.generationId.localeCompare(left.generationId, "en")
    ));
    const knownCompleteIds = new Set([current.generationId, previous?.generationId].filter(Boolean));
    const recentCompleteIds = [];
    for (const entry of candidates) {
      if (recentCompleteIds.length >= safeRetainCount) break;
      if (!knownCompleteIds.has(entry.generationId)) {
        try {
          resolveGeneration({ storeDir, generationId: entry.generationId });
          knownCompleteIds.add(entry.generationId);
        } catch {
          ignored.push(entry.generationId);
          continue;
        }
      }
      recentCompleteIds.push(entry.generationId);
    }
    const retainedIds = new Set([
      current.generationId,
      previous?.generationId,
      ...readers.protectedIds,
      ...explicitlyProtected,
      ...recentCompleteIds,
    ].filter(Boolean));
    const deletable = candidates.filter((entry) => (
      !retainedIds.has(entry.generationId)
      && now - entry.mtimeMs >= safeGraceMs
    ));
    if (faultInjector) {
      const shouldFail = typeof faultInjector === "function"
        ? faultInjector("before-cleanup-delete", Object.freeze({
            deletable: Object.freeze(deletable.map((entry) => entry.generationId)),
          })) === true
        : faultInjector === "before-cleanup-delete";
      if (shouldFail) fail("GENERATION_CLEANUP_FAULT_INJECTED", "generation cleanup fault injected");
    }
    const deleted = [];
    for (const entry of deletable) {
      if (!safeGenerationCandidate({
        generationsDir: paths.generationsDir,
        candidatePath: entry.path,
        generationId: entry.generationId,
      })) {
        fail("GENERATION_CLEANUP_PATH_CHANGED", `generation path changed before delete: ${entry.generationId}`);
      }
      // Re-validate immediately before removal.  Incomplete, tampered, and
      // unknown directories are never eligible for cleanup.
      try {
        resolveGeneration({ storeDir, generationId: entry.generationId });
      } catch {
        ignored.push(entry.generationId);
        continue;
      }
      fs.rmSync(entry.path, { recursive: true, force: false });
      deleted.push(entry.generationId);
    }
    return Object.freeze({
      ok: true,
      skipped: false,
      retainCount: safeRetainCount,
      graceMs: safeGraceMs,
      currentGenerationId: current.generationId,
      previousGenerationId: previous?.generationId || null,
      readerProtected: Object.freeze([...readers.protectedIds]),
      explicitlyProtected: Object.freeze([...explicitlyProtected]),
      retained: Object.freeze(candidates
        .filter((entry) => retainedIds.has(entry.generationId))
        .map((entry) => entry.generationId)),
      graceProtected: Object.freeze(candidates
        .filter((entry) => !retainedIds.has(entry.generationId) && now - entry.mtimeMs < safeGraceMs)
        .map((entry) => entry.generationId)),
      deleted: Object.freeze(deleted),
      ignored: Object.freeze(ignored),
      expiredReaderLeases: readers.expired.length,
    });
  } finally {
    pointerLock.release();
  }
};

const sqlitePublicationMatches = (sqliteIdentity, publicationIdentityInput) => {
  const expected = publicationIdentityInput;
  if (!expected || expected.mode === "legacy-bootstrap") return true;
  return ["active-generation", "previous-generation"].includes(expected.mode)
    && sqliteIdentity?.mode === "active-generation"
    && sqliteIdentity?.generationId === expected.generationId
    && sqliteIdentity?.manifestHash === expected.manifestHash
    && sqliteIdentity?.sourceCycleId === expected.sourceCycleId
    && sqliteIdentity?.committedAt === expected.committedAt;
};

const resolveServingPublicationForSqliteIdentity = ({
  storeDir,
  publicDataDir,
  sqliteIdentity,
  allowPrevious = true,
}) => {
  const preferred = resolveServingPublication({ storeDir, publicDataDir, allowPrevious });
  if (sqlitePublicationMatches(sqliteIdentity, preferred.identity)) return preferred;

  const paths = storePaths(storeDir);
  if (
    allowPrevious
    && preferred.mode === "active-generation"
    && fs.existsSync(paths.previousPointer)
  ) {
    try {
      const context = resolvePreviousGeneration({ storeDir });
      validateGenerationBundle(context);
      const previous = Object.freeze({
        mode: "previous-generation",
        context,
        publicDataDir: path.resolve(publicDataDir),
        identity: publicationIdentity({ mode: "previous-generation", context }),
        pairing: Object.freeze({
          version: "generation-sqlite-publication-pair-v1",
          reason: "sqlite-matches-previous-generation",
        }),
      });
      if (sqlitePublicationMatches(sqliteIdentity, previous.identity)) return previous;
    } catch {
      // The error below deliberately reports one fail-closed pairing failure;
      // callers must never fall through to mutable public files or staging.
    }
  }

  fail(
    "PUBLICATION_SQLITE_IDENTITY_MISMATCH",
    "SQLite publication identity matches neither the serving generation nor its immutable previous generation",
    {
      sqliteIdentity: sqliteIdentity || null,
      servingIdentity: preferred.identity || null,
    },
  );
};

module.exports = {
  CORE_FILES,
  DEFAULT_CLEANUP_GRACE_MS,
  DEFAULT_READER_LEASE_MS,
  DEFAULT_RETENTION_COUNT,
  DataPublicationError,
  FILE_DEFINITIONS,
  PUBLICATION_VERSION,
  assertActivePublicationPointerUnchanged,
  assertActivePublicationUnchanged,
  acquireGenerationReadLease,
  bundleSemanticHash,
  cleanupDataGenerations,
  commitWithActivePublicationPointerLock,
  commitCurrentDataGeneration,
  publicationIdentity,
  readMutableBundle,
  readPublicationJson,
  resolveActivePublication,
  resolveServingPublication,
  resolveServingPublicationForSqliteIdentity,
  safeGenerationCandidate,
  selectFastResultReceiptDuringPairTransition,
  samePublicationIdentity,
  sqlitePublicationMatches,
  validateBundlePayloads,
  validateGenerationBundle,
};
