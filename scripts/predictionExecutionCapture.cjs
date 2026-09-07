"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const LIMITS = Object.freeze({ recordBytes: 2 * 1024 * 1024, batchBytes: 16 * 1024 * 1024, records: 128,
  storeBytes: 48 * 1024 ** 3, storeFiles: 60000, freeReserveBytes: 8 * 1024 ** 3 });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
// Capacity is bounded, not preallocated or a time-based deletion policy. Keep
// every original content-addressed batch; stop adding before the shared disk
// loses its reserve. Estimates are based on this batch, never a retention SLA.
function captureStorageCapacity({ files, bytes, nextBatchBytes, availableBytes }) {
  if (![files, bytes, nextBatchBytes, availableBytes].every(value => Number.isSafeInteger(value) && value >= 0)
    || nextBatchBytes === 0) throw new Error("invalid-storage-capacity-observation");
  const remainingFiles = Math.max(0, LIMITS.storeFiles - files);
  const remainingBytes = Math.max(0, LIMITS.storeBytes - bytes);
  const diskHeadroomBytes = Math.max(0, availableBytes - LIMITS.freeReserveBytes);
  const remainingBatches = Math.min(remainingFiles, Math.floor(remainingBytes / nextBatchBytes), Math.floor(diskHeadroomBytes / nextBatchBytes));
  const reason = remainingFiles === 0 || remainingBytes < nextBatchBytes ? "private-store-capacity-limit"
    : diskHeadroomBytes < nextBatchBytes ? "private-store-disk-reserve" : null;
  return { version: "prediction-capture-capacity-v2", files, bytes,
    maxFiles: LIMITS.storeFiles, maxBytes: LIMITS.storeBytes, freeReserveBytes: LIMITS.freeReserveBytes,
    availableBytes, nextBatchBytes, remainingFiles, remainingBytes, diskHeadroomBytes, remainingBatches,
    estimatedDaysAtFiveMinuteCadence: Math.floor(remainingBatches / 288 * 10) / 10,
    estimateAssumption: "constant current compressed batch size and one batch every five minutes; not guaranteed retention",
    status: reason ? "full" : remainingBatches < 30 * 288 ? "watch" : "ok", reason };
}
function availableStorageBytes(dir) {
  try {
    const stat = fs.statfsSync(dir, { bigint: true });
    const bytes = Number(stat.bavail * stat.bsize);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid available bytes");
    return bytes;
  } catch { throw new Error("private-store-free-space-unavailable"); }
}
function predictionCaptureStorageHealth(capture, nowMs = Date.now()) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const health = { status: "watch", reason: "capture-not-observed", persisted: capture?.persisted === true,
    captured: count(capture?.captured), attempted: count(capture?.attempted),
    sourceVerified: false, productionEligible: false };
  if (!capture) return health;
  if (capture.persisted !== true) {
    const reasons = ["no-captured-records", "private-store-capacity-limit", "private-store-disk-reserve", "private-store-free-space-unavailable",
      "private-store-busy", "private-store-io-failed", "unexpected-store-entry", "unsafe-private-directory", "unsafe-store-entry", "existing-capture-mismatch", "capture-readback-mismatch"];
    return { ...health, status: capture.reason === "no-captured-records" ? "watch" : "failed",
      reason: reasons.includes(capture.reason) ? capture.reason : "capture-persistence-failed" };
  }
  const observedAt = capture.storage?.observedAt;
  if (capture.storage?.version !== "prediction-capture-capacity-v2" || !strictInstant(observedAt)
    || !Number.isFinite(nowMs) || Date.parse(observedAt) > nowMs) return { ...health, reason: "capture-capacity-not-verifiable" };
  try {
    // Recompute the summary from numeric observations, not a stored healthy
    // flag. Only aggregate fields leave the private sync metadata boundary.
    const capacity = captureStorageCapacity({ files: capture.storage.files, bytes: capture.storage.bytes,
      nextBatchBytes: capture.storage.nextBatchBytes, availableBytes: capture.storage.availableBytes });
    const ageSeconds = Math.floor((nowMs - Date.parse(observedAt)) / 1000);
    return { ...health, status: capacity.reason ? "failed" : ageSeconds > 1800 ? "watch" : capacity.status,
      reason: capacity.reason || (ageSeconds > 1800 ? "capture-capacity-observation-stale" : capacity.status === "watch" ? "capture-capacity-low-headroom" : "capture-capacity-observed"),
      observedAt, ageSeconds, files: capacity.files, bytes: capacity.bytes,
      maxFiles: capacity.maxFiles, maxBytes: capacity.maxBytes, freeReserveBytes: capacity.freeReserveBytes,
      remainingBatches: capacity.remainingBatches, estimatedDaysAtFiveMinuteCadence: capacity.estimatedDaysAtFiveMinuteCadence,
      estimateAssumption: capacity.estimateAssumption };
  } catch { return { ...health, reason: "capture-capacity-not-verifiable" }; }
}
const secretKey = /^(?:api[-_]?key|authorization|password|secret|token|access[-_]?token|access[-_]?code|private[-_]?key)$/i;
const UNDEFINED = "$predictionExecutionUndefined";
function encode(value) {
  const json = JSON.stringify(value, function (key, item) {
    if (secretKey.test(key) || (typeof item === "string" && /[?&](?:api[-_]?key|token|access_token|secret)=/i.test(item))) throw new Error("sensitive-input-rejected");
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("non-json-number-rejected");
    if (["function", "symbol", "bigint"].includes(typeof item)
      || (Array.isArray(this) && key !== "" && !Object.hasOwn(this, key))
      || (this[key] && typeof this[key] === "object" && this[key] !== item)
      || (item && typeof item === "object" && (!Array.isArray(item)
        && ![null, Object.prototype].includes(Object.getPrototypeOf(item)) || Object.hasOwn(item, UNDEFINED)))) throw new Error("unsupported-value-rejected");
    if (item === undefined) return { [UNDEFINED]: 1 };
    return item;
  });
  if (typeof json !== "string" || Buffer.byteLength(json) > LIMITS.recordBytes) throw new Error("record-size-limit");
  return json;
}
function decode(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, UNDEFINED)) {
    if (Object.keys(value).length !== 1 || value[UNDEFINED] !== 1) throw new Error("invalid-undefined-marker");
    return undefined;
  }
  if (Array.isArray(value)) return value.map(decode);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}
function createPredictionExecutionCapture(cycleAt) {
  const records = [], skipped = {}; let bytes = 0, attempted = 0;
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const summary = () => ({ version: "prediction-execution-capture-v1", attempted, captured: records.length,
    skipped: { ...skipped }, bytes, productionEligible: false, sourceVerified: false });
  function run(input, scorer) {
    attempted++;
    let inputJson, startedAt;
    try {
      startedAt = new Date().toISOString();
      if (!strictInstant(cycleAt) || Date.parse(cycleAt) > Date.parse(startedAt) || !strictInstant(input?.kickoffTime)
        || typeof input?.sourceMatchId !== "string" || !input.sourceMatchId.trim()
        || Date.parse(startedAt) >= Date.parse(input.kickoffTime)
        || !["SCHEDULED", "TIMED", "PENDING", "NOT_STARTED"].includes(input?.status)) throw new Error("not-strict-prematch");
      if (records.length >= LIMITS.records) throw new Error("batch-record-limit");
      inputJson = encode(input);
    } catch (error) { skip(error.message === "sensitive-input-rejected" ? error.message :
      ["not-strict-prematch", "batch-record-limit", "record-size-limit", "non-json-number-rejected", "unsupported-value-rejected"].includes(error.message) ? error.message : "input-serialization-failed"); }
    // The actual scorer executes once, with its original object and exception semantics.
    const output = scorer(input);
    if (!inputJson) return output;
    try {
      const finishedAt = new Date().toISOString();
      if (Date.parse(finishedAt) >= Date.parse(input.kickoffTime)) throw new Error("cutoff-crossed-during-calculation");
      if (encode(input) !== inputJson) throw new Error("input-mutated-during-calculation");
      const outputJson = encode(output);
      if (!output?.probabilityModel || typeof output.probabilityModel.version !== "string" || !output.probabilityModel.version.trim()
        || !strictInstant(output.probabilityModel.generatedAt)
        || Date.parse(output.probabilityModel.generatedAt) < Date.parse(startedAt)
        || Date.parse(output.probabilityModel.generatedAt) > Date.parse(finishedAt)) throw new Error("executed-model-clock-invalid");
      const body = { version: "prediction-execution-record-v1", cycleAt, startedAt, finishedAt,
        encoding: "json-with-explicit-undefined-v1",
        sourceMatchId: input.sourceMatchId || null, kickoffTime: input.kickoffTime,
        modelVersion: output.probabilityModel.version, input: JSON.parse(inputJson), output: JSON.parse(outputJson),
        inputHash: digest(inputJson), outputHash: digest(outputJson),
        productionEligible: false, sourceVerified: false,
        scope: "actual scorer argument and return value with explicit undefined; not upstream raw data, loaded module state, deterministic replay or public publication authority" };
      const record = { ...body, contentHash: digest(JSON.stringify(body)) };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (bytes + size > LIMITS.batchBytes) throw new Error("batch-byte-limit");
      records.push(record); bytes += size;
    } catch (error) { skip(["sensitive-input-rejected", "record-size-limit", "non-json-number-rejected", "unsupported-value-rejected", "cutoff-crossed-during-calculation",
      "input-mutated-during-calculation", "executed-model-clock-invalid", "batch-byte-limit"].includes(error.message) ? error.message : "output-serialization-failed"); }
    return output;
  }
  function persist(storeDir) {
    const status = summary();
    if (!records.length) return { ...status, persisted: false, reason: "no-captured-records" };
    let lock, lockPath, storage;
    try {
      const parent = fs.realpathSync(storeDir), dir = path.join(parent, "prediction-execution-captures");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error("unsafe-private-directory");
      lockPath = path.join(dir, ".writer.lock"); lock = fs.openSync(lockPath, "wx", 0o600);
      const names = fs.readdirSync(dir).filter(name => name !== ".writer.lock");
      let used = 0;
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json\.gz$/.test(name)) throw new Error("unexpected-store-entry");
        const stat = fs.lstatSync(path.join(dir, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe-store-entry");
        used += stat.size;
        if (!Number.isSafeInteger(used) || used < 0) throw new Error("unsafe-store-entry");
      }
      const body = { ...status, cycleAt, runtime: require("../src/services/predictionRuntimeIdentity.cjs").predictionRuntimeIdentity(), records };
      const raw = Buffer.from(JSON.stringify(body)), sha256 = digest(raw), file = path.join(dir, `${sha256}.json.gz`);
      if (fs.existsSync(file)) {
        if (!zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: LIMITS.batchBytes + 1024 * 1024 }).equals(raw)) throw new Error("existing-capture-mismatch");
        try {
          storage = { ...captureStorageCapacity({ files: names.length, bytes: used,
            nextBatchBytes: fs.statSync(file).size, availableBytes: availableStorageBytes(parent) }), observedAt: new Date().toISOString() };
        } catch { storage = { version: "prediction-capture-capacity-v2", status: "unknown", reason: "private-store-free-space-unavailable" }; }
        return { ...status, persisted: true, sha256, duplicate: true, storage };
      }
      const zipped = zlib.gzipSync(raw);
      storage = { ...captureStorageCapacity({ files: names.length, bytes: used,
        nextBatchBytes: zipped.length, availableBytes: availableStorageBytes(parent) }), observedAt: new Date().toISOString() };
      if (storage.reason) throw new Error(storage.reason);
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, zipped); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: LIMITS.batchBytes + 1024 * 1024 }).equals(raw)) throw new Error("capture-readback-mismatch");
      // This is a pre-write free-space observation, adjusted for our own write;
      // other processes can consume space too. ENOSPC still fails closed.
      storage = { ...captureStorageCapacity({ files: names.length + 1, bytes: used + zipped.length,
        nextBatchBytes: zipped.length, availableBytes: Math.max(0, storage.availableBytes - zipped.length) }), observedAt: storage.observedAt };
      return { ...status, persisted: true, sha256, duplicate: false, storage };
    } catch (error) {
      const known = ["unsafe-private-directory", "unexpected-store-entry", "unsafe-store-entry", "existing-capture-mismatch", "private-store-capacity-limit", "private-store-disk-reserve", "private-store-free-space-unavailable", "capture-readback-mismatch"];
      return { ...status, persisted: false, ...(storage ? { storage } : {}), reason: known.includes(error.message) ? error.message : error.code === "EEXIST" ? "private-store-busy" : "private-store-io-failed" };
    } finally {
      if (lock !== undefined) {
        // Diagnostics must never abort a successful public sync in cleanup.
        try { fs.closeSync(lock); } catch { /* later runs will expose a busy store */ }
        try { fs.unlinkSync(lockPath); } catch { /* never remove another lock or retry publication */ }
      }
    }
  }
  return { run, summary, persist };
}
module.exports = { LIMITS, captureStorageCapacity, predictionCaptureStorageHealth, encode, decode, createPredictionExecutionCapture };
