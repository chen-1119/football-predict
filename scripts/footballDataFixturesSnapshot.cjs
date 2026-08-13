"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { TextDecoder } = require("util");

const ROOT_DIR = path.resolve(__dirname, "..");
const OFFICIAL_SOURCE_URL = "https://www.football-data.co.uk/fixtures.csv";
const DOWNLOAD_POLICY_URL = "https://www.football-data.co.uk/downloadm.php";
const COLLECTION_SCHEDULE_URL = "https://www.football-data.co.uk/matches.php";
const SCHEMA_URL = "https://www.football-data.co.uk/notes.txt";
const DEFAULT_STORE_DIR = path.join(
  path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(ROOT_DIR, "server-data")),
  "training",
  "raw",
  "football-data",
  "fixtures",
);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_CONFIGURED_BODY_BYTES = 50 * 1024 * 1024;
const DEFAULT_STATUS_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATUS_LOCK_STALE_MS = 30_000;
const STATUS_LOCK_FILE_NAME = ".status.lock";
const REQUIRED_HEADER_COLUMNS = Object.freeze(["Div", "Date", "Time", "HomeTeam", "AwayTeam"]);

const RIGHTS_METADATA = Object.freeze({
  provider: "Football-Data.co.uk",
  rightsStatus: "research-use-documented-commercial-redistribution-not-cleared",
  documentedUse: "downloadable CSV data for quantitative testing of betting systems",
  researchUseDocumented: true,
  commercialUseCleared: false,
  redistributionCleared: false,
  rawRedistributionAllowed: false,
  downloadPolicyUrl: DOWNLOAD_POLICY_URL,
  collectionScheduleUrl: COLLECTION_SCHEDULE_URL,
  schemaUrl: SCHEMA_URL,
  reviewedAt: "2026-07-16",
});

class FootballDataSnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FootballDataSnapshotError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = {}) => {
  throw new FootballDataSnapshotError(code, message, details);
};

const boundedInteger = (value, fallback, { min, max }) => {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, candidate));
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalValue(value[key]);
    return result;
  }, {});
};

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

const hashWithoutField = (value, field) => {
  const body = { ...value };
  delete body[field];
  return sha256(Buffer.from(canonicalJson(body), "utf8"));
};

const metadataHashFor = (metadata) => hashWithoutField(metadata, "metadataSha256");
const statusHashFor = (status) => hashWithoutField(status, "statusSha256");

const isoFromClock = (clock) => {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("CLOCK_INVALID", "clock returned an invalid instant");
  return date.toISOString();
};

const validateClockBoundary = (requestStartedAt, receivedAt) => {
  const startedMs = Date.parse(requestStartedAt || "");
  const receivedMs = Date.parse(receivedAt || "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(receivedMs)) {
    fail("CLOCK_INVALID", "request clock fields must be canonical instants", { requestStartedAt, receivedAt });
  }
  if (receivedMs < startedMs) {
    fail("CLOCK_BOUNDARY", "receivedAt cannot precede requestStartedAt", { requestStartedAt, receivedAt });
  }
};

const validateSourceUrl = (sourceUrl) => {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    fail("SOURCE_URL_INVALID", "source URL is invalid", { sourceUrl });
  }
  if (parsed.protocol !== "https:") {
    fail("SOURCE_URL_INSECURE", "Football-Data fixtures must be downloaded over HTTPS", { sourceUrl });
  }
  if (parsed.href !== OFFICIAL_SOURCE_URL) {
    fail("SOURCE_URL_UNAPPROVED", "collector only accepts the official Football-Data fixtures CSV", {
      sourceUrl: parsed.href,
      expected: OFFICIAL_SOURCE_URL,
    });
  }
  return parsed;
};

const headerValue = (headers, name) => {
  if (!headers || typeof headers !== "object") return null;
  const wanted = String(name).toLowerCase();
  const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === wanted);
  if (!entry || entry[1] === null || entry[1] === undefined) return null;
  const raw = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
  const value = String(raw).trim();
  return value || null;
};

const parseContentLength = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d+$/.test(String(value))) fail("HTTP_CONTENT_LENGTH_INVALID", "invalid HTTP Content-Length", { value });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("HTTP_CONTENT_LENGTH_INVALID", "HTTP Content-Length is outside the safe integer range", { value });
  }
  return parsed;
};

const splitCsvRecords = (text) => {
  const records = [];
  let start = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && (character === "\r" || character === "\n")) {
      records.push(text.slice(start, index));
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      start = index + 1;
    }
  }
  if (inQuotes) fail("CSV_UNTERMINATED_QUOTE", "fixtures CSV contains an unterminated quoted field");
  if (start < text.length) records.push(text.slice(start));
  return records;
};

const parseCsvRecord = (record) => {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (inQuotes && record[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (character === "," && !inQuotes) {
      fields.push(field);
      field = "";
      continue;
    }
    field += character;
  }
  if (inQuotes) fail("CSV_UNTERMINATED_QUOTE", "fixtures CSV header contains an unterminated quoted field");
  fields.push(field);
  return fields;
};

const inspectFixturesCsv = (raw) => {
  if (!Buffer.isBuffer(raw)) fail("RAW_BYTES_INVALID", "fixtures payload must be a Buffer");
  if (raw.includes(0)) fail("CSV_BINARY_PAYLOAD", "fixtures CSV contains NUL bytes");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    fail("CSV_UTF8_INVALID", "fixtures CSV is not valid UTF-8", { error: error.message });
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const records = splitCsvRecords(text).filter((record) => record.trim().length > 0);
  if (!records.length) fail("CSV_HEADER_MISSING", "fixtures CSV has no header record");
  const headerRecord = records[0];
  const headerColumns = parseCsvRecord(headerRecord).map((column) => column.trim());
  const duplicates = headerColumns.filter((column, index) => column && headerColumns.indexOf(column) !== index);
  if (duplicates.length) {
    fail("CSV_HEADER_DUPLICATE", "fixtures CSV contains duplicate header columns", {
      duplicates: Array.from(new Set(duplicates)),
    });
  }
  const missing = REQUIRED_HEADER_COLUMNS.filter((column) => !headerColumns.includes(column));
  if (missing.length) fail("CSV_HEADER_REQUIRED_FIELD_MISSING", "fixtures CSV is missing required columns", { missing });
  return {
    headerColumns,
    headerColumnCount: headerColumns.length,
    rowCount: Math.max(0, records.length - 1),
    schemaHeaderSha256: sha256(Buffer.from(headerRecord, "utf8")),
  };
};

const assertRawSha256 = (rawSha256) => {
  const normalized = String(rawSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail("RAW_SHA256_INVALID", "raw SHA-256 must be 64 lowercase hex characters");
  return normalized;
};

const snapshotPaths = (storeDir, rawSha256) => {
  const digest = assertRawSha256(rawSha256);
  const root = path.resolve(storeDir);
  const snapshotDir = path.join(root, digest);
  return {
    root,
    snapshotDir,
    rawPath: path.join(snapshotDir, "fixtures.csv"),
    metadataPath: path.join(snapshotDir, "metadata.json"),
  };
};

const writeFileDurably = (filePath, bytes, mode = 0o600) => {
  const descriptor = fs.openSync(filePath, "wx", mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const safeRemoveStagingDirectory = (storeDir, stagingDir) => {
  const root = path.resolve(storeDir);
  const candidate = path.resolve(stagingDir);
  if (path.dirname(candidate) !== root || !path.basename(candidate).startsWith(".staging-")) {
    fail("STAGING_PATH_UNSAFE", "refusing to remove a path outside the fixture snapshot staging area", {
      storeDir: root,
      stagingDir: candidate,
    });
  }
  fs.rmSync(candidate, { recursive: true, force: true });
};

const persistImmutableSnapshot = ({ storeDir, raw, metadata }) => {
  const paths = snapshotPaths(storeDir, metadata.rawSha256);
  fs.mkdirSync(paths.root, { recursive: true });
  if (fs.existsSync(paths.snapshotDir)) return false;

  const stagingDir = fs.mkdtempSync(path.join(paths.root, ".staging-"));
  try {
    writeFileDurably(path.join(stagingDir, "fixtures.csv"), raw);
    writeFileDurably(
      path.join(stagingDir, "metadata.json"),
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    );
    try {
      fs.renameSync(stagingDir, paths.snapshotDir);
      return true;
    } catch (error) {
      if (!fs.existsSync(paths.snapshotDir)) throw error;
      return false;
    }
  } finally {
    if (fs.existsSync(stagingDir)) safeRemoveStagingDirectory(paths.root, stagingDir);
  }
};

const buildMetadata = ({ raw, csv, requestStartedAt, receivedAt, headers }) => {
  const rawSha256 = sha256(raw);
  const body = {
    version: 1,
    kind: "football-data-fixtures-raw-snapshot",
    sourceName: "Football-Data.co.uk",
    sourceUrl: OFFICIAL_SOURCE_URL,
    requestStartedAt,
    receivedAt,
    sourceReceivedAt: receivedAt,
    collectorAvailableAt: receivedAt,
    httpStatusCode: 200,
    httpDate: headerValue(headers, "date"),
    httpEtag: headerValue(headers, "etag"),
    httpLastModified: headerValue(headers, "last-modified"),
    httpContentType: headerValue(headers, "content-type"),
    httpContentLength: headerValue(headers, "content-length"),
    rawSha256,
    rawBytes: raw.length,
    schemaHeaderSha256: csv.schemaHeaderSha256,
    schemaHeaderColumnCount: csv.headerColumnCount,
    schemaHeaderColumns: csv.headerColumns,
    rowCount: csv.rowCount,
    providerOddsObservedAt: null,
    clockPolicy: {
      providerOddsObservedAt: "unknown-not-provided-by-source",
      sourceReceivedAtMeaning: "collector-completed-receipt-of-the-raw-response",
      httpLastModifiedScope: "file-level-http-validator-only",
      httpLastModifiedMayBeUsedAsRowObservedAt: false,
      sourceReceivedAtMayBeUsedAsProviderObservedAt: false,
    },
    rights: { ...RIGHTS_METADATA },
    researchEligible: true,
    marketShadowEligible: true,
    marketPromotionEligible: false,
    officialResultEligible: false,
  };
  return { ...body, metadataSha256: metadataHashFor(body) };
};

const verifyStoredSnapshot = ({ storeDir = DEFAULT_STORE_DIR, rawSha256 }) => {
  const paths = snapshotPaths(storeDir, rawSha256);
  if (!fs.existsSync(paths.snapshotDir)) {
    fail("SNAPSHOT_MISSING", "content-addressed fixture snapshot directory is missing", { rawSha256 });
  }
  if (!fs.existsSync(paths.rawPath) || !fs.statSync(paths.rawPath).isFile()) {
    fail("SNAPSHOT_RAW_MISSING", "content-addressed fixture raw file is missing", { rawSha256 });
  }
  if (!fs.existsSync(paths.metadataPath) || !fs.statSync(paths.metadataPath).isFile()) {
    fail("SNAPSHOT_METADATA_MISSING", "content-addressed fixture metadata is missing", { rawSha256 });
  }

  const raw = fs.readFileSync(paths.rawPath);
  const actualRawSha256 = sha256(raw);
  if (actualRawSha256 !== rawSha256) {
    fail("INTEGRITY_ERROR", "fixture raw bytes do not match the content-addressed directory", {
      expected: rawSha256,
      actual: actualRawSha256,
    });
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(paths.metadataPath, "utf8"));
  } catch (error) {
    fail("INTEGRITY_ERROR", "fixture metadata is not valid JSON", { error: error.message });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("INTEGRITY_ERROR", "fixture metadata must be a JSON object");
  }
  if (metadata.metadataSha256 !== metadataHashFor(metadata)) {
    fail("INTEGRITY_ERROR", "fixture metadata semantic hash mismatch", { rawSha256 });
  }
  if (metadata.version !== 1 || metadata.kind !== "football-data-fixtures-raw-snapshot") {
    fail("METADATA_SCHEMA", "fixture metadata schema is unsupported", {
      version: metadata.version,
      kind: metadata.kind,
    });
  }
  if (metadata.sourceUrl !== OFFICIAL_SOURCE_URL || metadata.sourceName !== "Football-Data.co.uk") {
    fail("SOURCE_POLICY", "fixture metadata is not bound to the official Football-Data source");
  }
  if (metadata.rawSha256 !== rawSha256 || metadata.rawBytes !== raw.length) {
    fail("INTEGRITY_ERROR", "fixture metadata raw binding mismatch", {
      metadataRawSha256: metadata.rawSha256,
      rawSha256,
      metadataRawBytes: metadata.rawBytes,
      rawBytes: raw.length,
    });
  }
  if (metadata.httpStatusCode !== 200) fail("METADATA_SCHEMA", "immutable snapshots must originate from HTTP 200 responses");
  const contentLength = parseContentLength(metadata.httpContentLength);
  if (contentLength !== null && contentLength !== raw.length) {
    fail("INTEGRITY_ERROR", "stored raw byte length differs from HTTP Content-Length", {
      contentLength,
      rawBytes: raw.length,
    });
  }

  validateClockBoundary(metadata.requestStartedAt, metadata.receivedAt);
  if (metadata.sourceReceivedAt !== metadata.receivedAt || metadata.collectorAvailableAt !== metadata.receivedAt) {
    fail("CLOCK_POLICY", "collector availability must remain bound to receivedAt");
  }
  if (metadata.providerOddsObservedAt !== null) {
    fail("CLOCK_POLICY", "providerOddsObservedAt must remain null because the source does not provide it", {
      providerOddsObservedAt: metadata.providerOddsObservedAt,
    });
  }
  const clockPolicy = metadata.clockPolicy || {};
  if (clockPolicy.providerOddsObservedAt !== "unknown-not-provided-by-source"
    || clockPolicy.httpLastModifiedScope !== "file-level-http-validator-only"
    || clockPolicy.httpLastModifiedMayBeUsedAsRowObservedAt !== false
    || clockPolicy.sourceReceivedAtMayBeUsedAsProviderObservedAt !== false) {
    fail("CLOCK_POLICY", "fixture snapshot clock policy was weakened or altered", { clockPolicy });
  }

  if (metadata.researchEligible !== true
    || metadata.marketShadowEligible !== true
    || metadata.marketPromotionEligible !== false
    || metadata.officialResultEligible !== false) {
    fail("PROMOTION_POLICY", "fixture snapshot eligibility boundary was weakened or altered", {
      researchEligible: metadata.researchEligible,
      marketShadowEligible: metadata.marketShadowEligible,
      marketPromotionEligible: metadata.marketPromotionEligible,
      officialResultEligible: metadata.officialResultEligible,
    });
  }
  const rights = metadata.rights || {};
  if (rights.provider !== RIGHTS_METADATA.provider
    || rights.rightsStatus !== RIGHTS_METADATA.rightsStatus
    || rights.researchUseDocumented !== true
    || rights.commercialUseCleared !== false
    || rights.redistributionCleared !== false
    || rights.rawRedistributionAllowed !== false
    || rights.downloadPolicyUrl !== DOWNLOAD_POLICY_URL
    || rights.collectionScheduleUrl !== COLLECTION_SCHEDULE_URL
    || rights.schemaUrl !== SCHEMA_URL) {
    fail("RIGHTS_POLICY", "fixture snapshot rights metadata was weakened or altered", { rights });
  }

  const csv = inspectFixturesCsv(raw);
  if (metadata.schemaHeaderSha256 !== csv.schemaHeaderSha256
    || metadata.schemaHeaderColumnCount !== csv.headerColumnCount
    || metadata.rowCount !== csv.rowCount
    || canonicalJson(metadata.schemaHeaderColumns) !== canonicalJson(csv.headerColumns)) {
    fail("INTEGRITY_ERROR", "fixture CSV schema or row count differs from immutable metadata", {
      storedHeaderSha256: metadata.schemaHeaderSha256,
      actualHeaderSha256: csv.schemaHeaderSha256,
      storedRows: metadata.rowCount,
      actualRows: csv.rowCount,
    });
  }

  return { ...paths, metadata, csv };
};

const latestStatusPath = (storeDir) => path.join(path.resolve(storeDir), "status.json");

const buildStatus = (body) => ({ ...body, statusSha256: statusHashFor(body) });

const readStatus = (storeDir = DEFAULT_STORE_DIR) => {
  const statusPath = latestStatusPath(storeDir);
  if (!fs.existsSync(statusPath)) return null;
  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch (error) {
    fail("STATUS_INTEGRITY", "fixture status pointer is not valid JSON", { error: error.message });
  }
  if (!status || typeof status !== "object" || Array.isArray(status)
    || status.statusSha256 !== statusHashFor(status)) {
    fail("STATUS_INTEGRITY", "fixture status pointer semantic hash mismatch");
  }
  if (status.version !== 1
    || status.kind !== "football-data-fixtures-status"
    || status.sourceUrl !== OFFICIAL_SOURCE_URL
    || !status.latest?.rawSha256) {
    fail("STATUS_INTEGRITY", "fixture status pointer schema is invalid");
  }
  try {
    validateClockBoundary(status.requestStartedAt, status.receivedAt);
  } catch (error) {
    fail("STATUS_INTEGRITY", "fixture status pointer clock fields are invalid", {
      code: error?.code,
      requestStartedAt: status.requestStartedAt,
      receivedAt: status.receivedAt,
    });
  }
  if (status.checkedAt !== status.receivedAt) {
    fail("STATUS_INTEGRITY", "fixture status checkedAt must remain bound to receivedAt");
  }
  const verified = verifyStoredSnapshot({ storeDir, rawSha256: status.latest.rawSha256 });
  if (status.latest.rowCount !== verified.metadata.rowCount
    || status.latest.schemaHeaderSha256 !== verified.metadata.schemaHeaderSha256
    || status.latest.firstReceivedAt !== verified.metadata.receivedAt) {
    fail("STATUS_INTEGRITY", "fixture status pointer does not match its immutable snapshot");
  }
  return { status, statusPath, verified };
};

const writeStatusAtomic = (storeDir, status) => {
  const root = path.resolve(storeDir);
  fs.mkdirSync(root, { recursive: true });
  const statusPath = latestStatusPath(root);
  const tempPath = path.join(root, `.status-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileDurably(tempPath, Buffer.from(`${JSON.stringify(status, null, 2)}\n`, "utf8"));
    fs.renameSync(tempPath, statusPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  return statusPath;
};

const sleepSync = (milliseconds) => {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const removeStaleStatusLock = (lockPath, staleMs) => {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if ((Date.now() - stat.mtimeMs) <= staleMs) return false;

  const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
};

const acquireStatusLockSync = (storeDir, { timeoutMs, staleMs }) => {
  const root = path.resolve(storeDir);
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, STATUS_LOCK_FILE_NAME);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomBytes(16).toString("hex")}`;

  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      const owner = Buffer.from(`${JSON.stringify({
        version: 1,
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      })}\n`, "utf8");
      fs.writeFileSync(descriptor, owner);
      fs.fsyncSync(descriptor);
      return {
        lockPath,
        release() {
          if (descriptor !== null) {
            fs.closeSync(descriptor);
            descriptor = null;
          }
          let ownerRecord;
          try {
            ownerRecord = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          } catch (error) {
            if (error?.code === "ENOENT") return;
            fail("STATUS_LOCK_OWNERSHIP", "fixture status lock owner record is unreadable during release", {
              lockPath,
              error: error.message,
            });
          }
          if (ownerRecord?.token !== token) {
            fail("STATUS_LOCK_OWNERSHIP", "fixture status lock ownership changed before release", { lockPath });
          }
          fs.unlinkSync(lockPath);
        },
      };
    } catch (error) {
      if (descriptor !== undefined && descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
    }

    if (removeStaleStatusLock(lockPath, staleMs)) continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      fail("STATUS_LOCK_TIMEOUT", "timed out waiting for the fixture status publication lock", {
        lockPath,
        timeoutMs,
        staleMs,
      });
    }
    sleepSync(Math.min(20, remainingMs));
  }
};

const publishStatusMonotonically = ({
  storeDir,
  requestStartedAt,
  receivedAt,
  statusLockTimeoutMs,
  statusLockStaleMs,
  createCandidate,
}) => {
  const lock = acquireStatusLockSync(storeDir, {
    timeoutMs: statusLockTimeoutMs,
    staleMs: statusLockStaleMs,
  });
  try {
    const current = readStatus(storeDir);
    const currentReceivedMs = Date.parse(current?.status?.receivedAt || "");
    const candidateReceivedMs = Date.parse(receivedAt || "");
    if (!Number.isFinite(candidateReceivedMs)) {
      fail("CLOCK_INVALID", "status publication receivedAt is invalid", { receivedAt });
    }
    if (current && currentReceivedMs >= candidateReceivedMs) {
      return {
        published: false,
        reason: "current-status-is-newer-or-equal",
        statusPath: current.statusPath,
        record: current,
      };
    }

    const candidate = createCandidate(current);
    if (!candidate?.body || !candidate?.verified) {
      fail("STATUS_CANDIDATE_INVALID", "fixture status candidate must bind a body and verified snapshot");
    }
    if (candidate.body.requestStartedAt !== requestStartedAt || candidate.body.receivedAt !== receivedAt) {
      fail("STATUS_CANDIDATE_INVALID", "fixture status candidate clock binding changed inside publication");
    }
    const status = buildStatus(candidate.body);
    const statusPath = writeStatusAtomic(storeDir, status);
    const record = readStatus(storeDir);
    if (record.status.statusSha256 !== status.statusSha256) {
      fail("STATUS_INTEGRITY", "fixture status pointer differs immediately after atomic publication");
    }
    return {
      published: true,
      reason: "published",
      statusPath,
      record,
    };
  } finally {
    lock.release();
  }
};

const responseBody = (response) => {
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (response?.body === null || response?.body === undefined) return Buffer.alloc(0);
  if (typeof response.body === "string" || ArrayBuffer.isView(response.body)) return Buffer.from(response.body);
  fail("HTTP_BODY_INVALID", "transport response body must be bytes or a string");
};

const httpsBufferTransport = ({ url, headers, timeoutMs, maxBodyBytes }) => new Promise((resolve, reject) => {
  const parsed = validateSourceUrl(url);
  let settled = false;
  let request;
  let timer;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    callback(value);
  };
  const rejectOnce = (error) => finish(reject, error);
  const resolveOnce = (value) => finish(resolve, value);

  request = https.request(parsed, {
    method: "GET",
    headers,
  }, (response) => {
    const chunks = [];
    let bytes = 0;
    const declaredLength = headerValue(response.headers, "content-length");
    let parsedLength = null;
    try {
      parsedLength = parseContentLength(declaredLength);
    } catch (error) {
      response.destroy();
      rejectOnce(error);
      return;
    }
    if (parsedLength !== null && parsedLength > maxBodyBytes) {
      const error = new FootballDataSnapshotError(
        "RESPONSE_TOO_LARGE",
        "Football-Data fixtures response exceeds the configured size limit",
        { declaredBytes: parsedLength, maxBodyBytes },
      );
      response.destroy();
      rejectOnce(error);
      return;
    }
    response.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBodyBytes) {
        const error = new FootballDataSnapshotError(
          "RESPONSE_TOO_LARGE",
          "Football-Data fixtures response exceeded the configured size limit while streaming",
          { receivedBytes: bytes, maxBodyBytes },
        );
        response.destroy();
        rejectOnce(error);
        return;
      }
      chunks.push(buffer);
    });
    response.on("aborted", () => {
      rejectOnce(new FootballDataSnapshotError("HTTP_ABORTED", "Football-Data fixtures response was aborted"));
    });
    response.on("error", rejectOnce);
    response.on("end", () => {
      if (settled) return;
      resolveOnce({
        statusCode: Number(response.statusCode || 0),
        headers: response.headers,
        body: Buffer.concat(chunks, bytes),
      });
    });
  });

  request.on("error", rejectOnce);
  timer = setTimeout(() => {
    const error = new FootballDataSnapshotError(
      "HTTP_TIMEOUT",
      "Football-Data fixtures request exceeded the configured timeout",
      { timeoutMs },
    );
    request.destroy(error);
    rejectOnce(error);
  }, timeoutMs);
  request.end();
});

const statusLatest = (verified) => ({
  rawSha256: verified.metadata.rawSha256,
  snapshotDirectory: verified.metadata.rawSha256,
  rawFile: `${verified.metadata.rawSha256}/fixtures.csv`,
  metadataFile: `${verified.metadata.rawSha256}/metadata.json`,
  firstReceivedAt: verified.metadata.receivedAt,
  rowCount: verified.metadata.rowCount,
  schemaHeaderSha256: verified.metadata.schemaHeaderSha256,
});

const conditionalsFrom = (statusRecord) => ({
  etag: statusRecord?.status?.conditionals?.etag || statusRecord?.verified?.metadata?.httpEtag || null,
  lastModified: statusRecord?.status?.conditionals?.lastModified
    || statusRecord?.verified?.metadata?.httpLastModified
    || null,
});

const collectFootballDataFixtures = async (options = {}) => {
  const sourceUrl = options.sourceUrl || OFFICIAL_SOURCE_URL;
  validateSourceUrl(sourceUrl);
  const storeDir = path.resolve(options.storeDir || DEFAULT_STORE_DIR);
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? process.env.FOOTBALL_DATA_FIXTURES_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    { min: 1, max: 120_000 },
  );
  const maxBodyBytes = boundedInteger(
    options.maxBodyBytes ?? process.env.FOOTBALL_DATA_FIXTURES_MAX_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    { min: 1, max: MAX_CONFIGURED_BODY_BYTES },
  );
  const writeStatus = options.writeStatus !== false && process.env.FOOTBALL_DATA_FIXTURES_NO_STATUS !== "1";
  const statusLockTimeoutMs = boundedInteger(
    options.statusLockTimeoutMs ?? process.env.FOOTBALL_DATA_FIXTURES_STATUS_LOCK_TIMEOUT_MS,
    DEFAULT_STATUS_LOCK_TIMEOUT_MS,
    { min: 1, max: 120_000 },
  );
  const statusLockStaleMs = boundedInteger(
    options.statusLockStaleMs ?? process.env.FOOTBALL_DATA_FIXTURES_STATUS_LOCK_STALE_MS,
    DEFAULT_STATUS_LOCK_STALE_MS,
    { min: 100, max: 600_000 },
  );
  const transport = options.transport || httpsBufferTransport;
  const clock = options.clock;
  const prior = readStatus(storeDir);
  const conditionals = conditionalsFrom(prior);
  const headers = {
    "User-Agent": "football-predict-research-fixtures-snapshot/1.0",
    Accept: "text/csv, text/plain;q=0.9, */*;q=0.1",
    "Accept-Encoding": "identity",
    ...(options.headers || {}),
  };
  if (conditionals.etag) headers["If-None-Match"] = conditionals.etag;
  if (conditionals.lastModified) headers["If-Modified-Since"] = conditionals.lastModified;

  const requestStartedAt = isoFromClock(clock);
  const response = await transport({
    url: sourceUrl,
    headers: { ...headers },
    timeoutMs,
    maxBodyBytes,
  });
  const receivedAt = isoFromClock(clock);
  validateClockBoundary(requestStartedAt, receivedAt);
  const statusCode = Number(response?.statusCode || 0);
  const responseHeaders = response?.headers || {};
  const raw = responseBody(response);
  const declaredLength = parseContentLength(headerValue(responseHeaders, "content-length"));
  if (declaredLength !== null && declaredLength > maxBodyBytes) {
    fail("RESPONSE_TOO_LARGE", "Football-Data fixtures response exceeds the configured size limit", {
      declaredBytes: declaredLength,
      maxBodyBytes,
    });
  }
  if (raw.length > maxBodyBytes) {
    fail("RESPONSE_TOO_LARGE", "Football-Data fixtures response exceeds the configured size limit", {
      receivedBytes: raw.length,
      maxBodyBytes,
    });
  }

  if (statusCode === 304) {
    if (!prior) fail("HTTP_304_WITHOUT_SNAPSHOT", "received HTTP 304 without a verified prior fixture snapshot");
    if (raw.length > 0) fail("HTTP_304_BODY", "HTTP 304 fixture response must not contain a body");
    const createStatusCandidate = (current) => {
      const base = current || prior;
      const currentChangedSinceRequest = Boolean(
        current && current.status.statusSha256 !== prior.status.statusSha256,
      );
      const baseConditionals = conditionalsFrom(base);
      const nextConditionals = currentChangedSinceRequest
        ? baseConditionals
        : {
          etag: headerValue(responseHeaders, "etag") || baseConditionals.etag,
          lastModified: headerValue(responseHeaders, "last-modified") || baseConditionals.lastModified,
        };
      return {
        verified: base.verified,
        body: {
          version: 1,
          kind: "football-data-fixtures-status",
          sourceUrl,
          checkedAt: receivedAt,
          requestStartedAt,
          receivedAt,
          lastResult: "not-modified",
          responseHttpStatusCode: 304,
          responseHttpDate: headerValue(responseHeaders, "date"),
          conditionals: nextConditionals,
          latest: statusLatest(base.verified),
        },
      };
    };
    let publication;
    if (writeStatus) {
      publication = publishStatusMonotonically({
        storeDir,
        requestStartedAt,
        receivedAt,
        statusLockTimeoutMs,
        statusLockStaleMs,
        createCandidate: createStatusCandidate,
      });
    } else {
      const candidate = createStatusCandidate(prior);
      publication = {
        published: false,
        reason: "status-publication-disabled",
        statusPath: null,
        record: { status: buildStatus(candidate.body), statusPath: null, verified: candidate.verified },
      };
    }
    const publishedRecord = publication.record;
    const publishedConditionals = conditionalsFrom(publishedRecord);
    return {
      ok: true,
      status: "not-modified",
      notModified: true,
      stored: false,
      idempotent: true,
      sourceUrl,
      requestStartedAt,
      receivedAt,
      statusPath: publication.statusPath,
      statusPublished: publication.published,
      statusPublicationReason: publication.reason,
      rawSha256: publishedRecord.verified.metadata.rawSha256,
      rawPath: publishedRecord.verified.rawPath,
      metadataPath: publishedRecord.verified.metadataPath,
      rowCount: publishedRecord.verified.metadata.rowCount,
      schemaHeaderSha256: publishedRecord.verified.metadata.schemaHeaderSha256,
      providerOddsObservedAt: null,
      researchEligible: true,
      marketShadowEligible: true,
      marketPromotionEligible: false,
      officialResultEligible: false,
      http: {
        statusCode: 304,
        date: headerValue(responseHeaders, "date"),
        etag: publishedConditionals.etag,
        lastModified: publishedConditionals.lastModified,
      },
    };
  }

  if (statusCode !== 200) {
    fail("HTTP_STATUS", `Football-Data fixtures request returned HTTP ${statusCode || "unknown"}`, {
      statusCode,
      bodyPrefix: raw.subarray(0, 160).toString("utf8").replace(/\s+/g, " "),
    });
  }
  if (declaredLength !== null && declaredLength !== raw.length) {
    fail("HTTP_CONTENT_LENGTH_MISMATCH", "Football-Data fixtures response body length differs from Content-Length", {
      declaredLength,
      receivedBytes: raw.length,
    });
  }

  const csv = inspectFixturesCsv(raw);
  const metadataCandidate = buildMetadata({ raw, csv, requestStartedAt, receivedAt, headers: responseHeaders });
  const paths = snapshotPaths(storeDir, metadataCandidate.rawSha256);
  const snapshotAlreadyExists = fs.existsSync(paths.snapshotDir);
  let stored = false;
  if (snapshotAlreadyExists) {
    verifyStoredSnapshot({ storeDir, rawSha256: metadataCandidate.rawSha256 });
  } else {
    stored = persistImmutableSnapshot({ storeDir, raw, metadata: metadataCandidate });
  }
  const verified = verifyStoredSnapshot({ storeDir, rawSha256: metadataCandidate.rawSha256 });
  const createStatusCandidate = (current) => {
    const latestConditionals = conditionalsFrom(current || prior);
    const nextConditionals = {
      etag: headerValue(responseHeaders, "etag") || latestConditionals.etag,
      lastModified: headerValue(responseHeaders, "last-modified") || latestConditionals.lastModified,
    };
    return {
      verified,
      body: {
        version: 1,
        kind: "football-data-fixtures-status",
        sourceUrl,
        checkedAt: receivedAt,
        requestStartedAt,
        receivedAt,
        lastResult: stored ? "stored" : "content-already-stored",
        responseHttpStatusCode: 200,
        responseHttpDate: headerValue(responseHeaders, "date"),
        conditionals: nextConditionals,
        latest: statusLatest(verified),
      },
    };
  };
  let publication;
  if (writeStatus) {
    publication = publishStatusMonotonically({
      storeDir,
      requestStartedAt,
      receivedAt,
      statusLockTimeoutMs,
      statusLockStaleMs,
      createCandidate: createStatusCandidate,
    });
  } else {
    const candidate = createStatusCandidate(prior);
    publication = {
      published: false,
      reason: "status-publication-disabled",
      statusPath: null,
      record: { status: buildStatus(candidate.body), statusPath: null, verified: candidate.verified },
    };
  }
  const responseConditionals = {
    etag: headerValue(responseHeaders, "etag") || conditionals.etag,
    lastModified: headerValue(responseHeaders, "last-modified") || conditionals.lastModified,
  };

  return {
    ok: true,
    status: stored ? "stored" : "content-already-stored",
    notModified: false,
    stored,
    idempotent: !stored,
    sourceUrl,
    requestStartedAt,
    receivedAt,
    statusPath: publication.statusPath,
    statusPublished: publication.published,
    statusPublicationReason: publication.reason,
    rawSha256: verified.metadata.rawSha256,
    rawPath: verified.rawPath,
    metadataPath: verified.metadataPath,
    rawBytes: verified.metadata.rawBytes,
    rowCount: verified.metadata.rowCount,
    schemaHeaderSha256: verified.metadata.schemaHeaderSha256,
    providerOddsObservedAt: null,
    researchEligible: true,
    marketShadowEligible: true,
    marketPromotionEligible: false,
    officialResultEligible: false,
    http: {
      statusCode: 200,
      date: headerValue(responseHeaders, "date"),
      etag: responseConditionals.etag,
      lastModified: responseConditionals.lastModified,
      contentType: headerValue(responseHeaders, "content-type"),
      contentLength: headerValue(responseHeaders, "content-length"),
    },
  };
};

const main = async () => {
  const result = await collectFootballDataFixtures();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      ok: false,
      code: error?.code || "UNEXPECTED_ERROR",
      error: error?.message || String(error),
      details: error?.details || {},
      preservedExistingSnapshot: true,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_SCHEDULE_URL,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_STORE_DIR,
  DEFAULT_TIMEOUT_MS,
  DOWNLOAD_POLICY_URL,
  FootballDataSnapshotError,
  OFFICIAL_SOURCE_URL,
  RIGHTS_METADATA,
  SCHEMA_URL,
  buildMetadata,
  buildStatus,
  canonicalJson,
  collectFootballDataFixtures,
  httpsBufferTransport,
  inspectFixturesCsv,
  metadataHashFor,
  readStatus,
  sha256,
  snapshotPaths,
  statusHashFor,
  verifyStoredSnapshot,
};
