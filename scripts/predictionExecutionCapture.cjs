"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const LIMITS = Object.freeze({ recordBytes: 2 * 1024 * 1024, batchBytes: 16 * 1024 * 1024, records: 128,
  storeBytes: 256 * 1024 * 1024, storeFiles: 512 });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
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
    let lock, lockPath;
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
      }
      const body = { ...status, cycleAt, runtime: { node: process.version, platform: process.platform, arch: process.arch }, records };
      const raw = Buffer.from(JSON.stringify(body)), sha256 = digest(raw), file = path.join(dir, `${sha256}.json.gz`);
      if (fs.existsSync(file)) {
        if (!zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: LIMITS.batchBytes + 1024 * 1024 }).equals(raw)) throw new Error("existing-capture-mismatch");
        return { ...status, persisted: true, sha256, duplicate: true };
      }
      const zipped = zlib.gzipSync(raw);
      if (names.length >= LIMITS.storeFiles || used + zipped.length > LIMITS.storeBytes) throw new Error("private-store-capacity-limit");
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, zipped); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: LIMITS.batchBytes + 1024 * 1024 }).equals(raw)) throw new Error("capture-readback-mismatch");
      return { ...status, persisted: true, sha256, duplicate: false };
    } catch (error) {
      const known = ["unsafe-private-directory", "unexpected-store-entry", "unsafe-store-entry", "existing-capture-mismatch", "private-store-capacity-limit", "capture-readback-mismatch"];
      return { ...status, persisted: false, reason: known.includes(error.message) ? error.message : error.code === "EEXIST" ? "private-store-busy" : "private-store-io-failed" };
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
module.exports = { LIMITS, encode, decode, createPredictionExecutionCapture };
