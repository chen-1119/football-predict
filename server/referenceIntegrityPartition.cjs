"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const baseline = require("./data/public-reference-unresolved-baseline.json");
const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
const { verifyPublicReferenceEvidence, digest } = require("../src/services/publicReferenceEvidence.cjs");
const VERSION = "public-reference-integrity-partition-v1";
const FILE_NAME = "reference-integrity.json";
const SOURCE_ID = "public-reference-unresolved:current";
const ROOT = "/var/lib/football-original-custody";
const INPUT_ROOT = "/var/lib/football-reference-integrity-input";
const contexts = new WeakMap();
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const baselineHash = digest(baseline);
const originals = new Map(baseline.rows.map(row => [row.referenceHash, row.recordSha256]));

function isOriginalUnresolvedRecord(record) {
  const expected = originals.get(record?.contentHash);
  if (!expected) return false;
  if (!attestPublicReferenceDecision(record, record) || !record.evidenceBinding
    || digest(record) !== expected) fail("REFERENCE_PARTITION_ORIGINAL_CHANGED");
  return true;
}

function validateUnresolvedRecords(records) {
  if (!Array.isArray(records) || records.length !== originals.size) fail("REFERENCE_PARTITION_MEMBERSHIP");
  const seen = new Set();
  for (const record of records) {
    if (!isOriginalUnresolvedRecord(record) || seen.has(record.contentHash)) fail("REFERENCE_PARTITION_MEMBERSHIP");
    seen.add(record.contentHash);
  }
  return records;
}

function partitionReferenceRecords(records, entries) {
  const byHash = new Map();
  for (const record of records) {
    if (!attestPublicReferenceDecision(record, record) || byHash.has(record.contentHash)) fail("REFERENCE_PARTITION_RECORD_INVALID");
    byHash.set(record.contentHash, record);
  }
  const byReference = new Map();
  for (const entry of entries) {
    const record = byHash.get(entry?.referenceHash);
    if (!record) fail("REFERENCE_PARTITION_ORPHAN_EVIDENCE");
    if (!verifyPublicReferenceEvidence(entry, record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID");
    if (byReference.has(entry.referenceHash) && digest(byReference.get(entry.referenceHash)) !== digest(entry)) {
      fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_CONFLICT");
    }
    byReference.set(entry.referenceHash, entry);
  }
  const complete = [], unresolved = [], unbound = [];
  for (const record of byHash.values()) {
    const entry = byReference.get(record.contentHash);
    if (isOriginalUnresolvedRecord(record)) {
      if (entry) fail("REFERENCE_PARTITION_EXPLICIT_RESOLUTION_REQUIRED");
      unresolved.push(record);
    } else if (record.evidenceBinding) {
      if (!entry) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
      complete.push({ record, entry });
    } else {
      if (entry) fail("REFERENCE_PARTITION_UNBOUND_EVIDENCE");
      unbound.push(record);
    }
  }
  validateUnresolvedRecords(unresolved);
  return { complete, unresolved, unbound, historicalIntegrityAccepted: false, modelAdmissionGranted: false };
}

function buildReferenceIntegrity(records) {
  validateUnresolvedRecords(records);
  const body = { version: VERSION, baselineHash, originalSource: baseline.original,
    custodyManifestSha256: baseline.custodyManifestSha256,
    state: "original-evidence-unresolved", recoveredCompanions: 0,
    records: [...records].sort((left, right) => left.contentHash.localeCompare(right.contentHash)) };
  return { ...body, contentHash: digest(body) };
}

function validateReferenceIntegrity(value) {
  if (!value || value.version !== VERSION) fail("REFERENCE_PARTITION_VERSION");
  const expected = buildReferenceIntegrity(value.records);
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail("REFERENCE_PARTITION_CONTENT");
  return expected;
}

function validateSnapshotIntegrity(snapshot, integrity) {
  const embedded = snapshot?.publicReferenceIntegrity;
  if (snapshot?.version === 4 || embedded || integrity) {
    if (snapshot?.version !== 4 || !embedded || !integrity) fail("REFERENCE_PARTITION_SNAPSHOT_BINDING");
    validateReferenceIntegrity(embedded);
    validateReferenceIntegrity(integrity);
    if (JSON.stringify(embedded) !== JSON.stringify(integrity)) fail("REFERENCE_PARTITION_SNAPSHOT_BINDING");
  }
  return integrity || null;
}

function readSnapshotIntegrity(filePath, metadata) {
  const integrityPath = path.join(path.dirname(filePath), FILE_NAME);
  let integrity = null;
  if (fs.existsSync(integrityPath)) {
    const stat = fs.lstatSync(integrityPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) fail("REFERENCE_PARTITION_FILE");
    integrity = JSON.parse(fs.readFileSync(integrityPath, "utf8"));
  }
  return validateSnapshotIntegrity(metadata, integrity);
}

function storedReferenceIntegrity(integrity) {
  validateReferenceIntegrity(integrity);
  const originalJson = JSON.stringify(integrity);
  return { version: VERSION, originalJson, sha256: sha(originalJson) };
}

function validateStoredReferenceIntegrity(value) {
  if (!value || Object.keys(value).sort().join(",") !== "originalJson,sha256,version"
    || value.version !== VERSION || typeof value.originalJson !== "string"
    || Buffer.byteLength(value.originalJson) > 512 * 1024 || sha(value.originalJson) !== value.sha256) {
    fail("REFERENCE_PARTITION_DATABASE_BYTES");
  }
  return validateReferenceIntegrity(JSON.parse(value.originalJson));
}

function readProtected(file, maxBytes) {
  let current = path.dirname(file);
  while (current !== path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) {
      fail("REFERENCE_PARTITION_CUSTODY_PATH");
    }
    current = path.dirname(current);
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== 0
    || (before.mode & 0o022) || before.size < 1 || before.size > maxBytes) fail("REFERENCE_PARTITION_CUSTODY_FILE");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor), final = fs.lstatSync(file);
    for (const observed of [opened, after, final]) {
      if (before.dev !== observed.dev || before.ino !== observed.ino || before.size !== observed.size
        || before.mtimeMs !== observed.mtimeMs || before.ctimeMs !== observed.ctimeMs || before.nlink !== observed.nlink) {
        fail("REFERENCE_PARTITION_CUSTODY_CHANGED");
      }
    }
    if (bytes.length !== before.size || final.isSymbolicLink()) fail("REFERENCE_PARTITION_CUSTODY_CHANGED");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function readPartitionInput(directory) {
  const sealBytes = readProtected(path.join(directory, "seal.json"), 4096);
  const seal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sealBytes));
  const manifestBytes = readProtected(path.join(directory, "manifest.json"), 128 * 1024);
  if (seal.sha256 !== baseline.custodyManifestSha256 || seal.bytes !== manifestBytes.length
    || sha(manifestBytes) !== baseline.custodyManifestSha256) fail("REFERENCE_PARTITION_CUSTODY_SEAL");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (manifest.version !== "original-evidence-custody-v1" || manifest.durability !== "directory-fsync") {
    fail("REFERENCE_PARTITION_CUSTODY_SEAL");
  }
  const original = manifest.sources.filter(source => source.name === "current.json");
  if (original.length !== 1 || original[0].bytes !== baseline.original.bytes
    || original[0].sha256 !== baseline.original.sha256) fail("REFERENCE_PARTITION_CUSTODY_SOURCE");
  const bytes = readProtected(path.join(directory, "current.json"), baseline.original.bytes);
  if (bytes.length !== baseline.original.bytes || sha(bytes) !== baseline.original.sha256) fail("REFERENCE_PARTITION_ORIGINAL_BYTES");
  const matches = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(matches)) fail("REFERENCE_PARTITION_ORIGINAL_BYTES");
  const records = matches.map(match => match.predictionMeta?.publicReferenceDecision).filter(Boolean);
  validateUnresolvedRecords(records);
  return { records, files: { "seal.json": sealBytes, "manifest.json": manifestBytes, "current.json": bytes } };
}

function loadInstalledReferencePartition() {
  if (process.platform !== "linux") fail("REFERENCE_PARTITION_INSTALLED_LINUX_REQUIRED");
  const root = fs.existsSync(INPUT_ROOT) ? INPUT_ROOT : ROOT;
  const { records } = readPartitionInput(path.join(root, baseline.custodyManifestSha256));
  const context = Object.freeze({ version: VERSION, baselineHash });
  contexts.set(context, records.map(record => JSON.stringify(record)));
  return context;
}

function readLocalFootballGroup() {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readProtected("/etc/group", 1024 * 1024));
  const accounts = text.split(/\r?\n/).map(line => line.split(":")).filter(account => account[0] === "football");
  if (accounts.length !== 1 || accounts[0].length !== 4 || !/^[1-9]\d*$/.test(accounts[0][2])) fail("REFERENCE_PARTITION_GROUP");
  const group = Number(accounts[0][2]);
  if (!Number.isSafeInteger(group)) fail("REFERENCE_PARTITION_GROUP");
  return group;
}

function installReferenceIntegrityInputs() {
  if (process.platform !== "linux" || process.getuid() !== 0) fail("REFERENCE_PARTITION_ROOT_INSTALL_REQUIRED");
  const source = readPartitionInput(path.join(ROOT, baseline.custodyManifestSha256));
  const group = readLocalFootballGroup();
  if (!fs.existsSync(INPUT_ROOT)) {
    fs.mkdirSync(INPUT_ROOT, { mode: 0o750 });
    fs.chownSync(INPUT_ROOT, 0, group);
    fs.chmodSync(INPUT_ROOT, 0o750);
  }
  const rootStat = fs.lstatSync(INPUT_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0
    || rootStat.gid !== group || (rootStat.mode & 0o777) !== 0o750) fail("REFERENCE_PARTITION_INPUT_ROOT");
  const directory = path.join(INPUT_ROOT, baseline.custodyManifestSha256);
  if (!fs.existsSync(directory)) {
    const staging = fs.mkdtempSync(path.join(INPUT_ROOT, ".pending-"));
    for (const [name, bytes] of Object.entries(source.files)) {
      const descriptor = fs.openSync(path.join(staging, name), "wx", 0o440);
      try { fs.writeFileSync(descriptor, bytes); fs.fchownSync(descriptor, 0, group); fs.fchmodSync(descriptor, 0o440); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
    readPartitionInput(staging);
    fs.chownSync(staging, 0, group);
    fs.chmodSync(staging, 0o750);
    fs.renameSync(staging, directory);
    for (const folder of [directory, INPUT_ROOT, path.dirname(INPUT_ROOT)]) {
      const descriptor = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
  }
  const verified = readPartitionInput(directory);
  if (fs.readdirSync(directory).sort().join(",") !== "current.json,manifest.json,seal.json") fail("REFERENCE_PARTITION_INPUT_MEMBERSHIP");
  for (const name of Object.keys(verified.files)) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (stat.gid !== group || (stat.mode & 0o777) !== 0o440) fail("REFERENCE_PARTITION_INPUT_PERMISSIONS");
    if (!verified.files[name].equals(source.files[name])) fail("REFERENCE_PARTITION_INPUT_BYTES");
  }
  return { directory, originalRecords: verified.records.length, copiedFiles: 3,
    originalPermissionsChanged: false, originalBytesChanged: false, collectionEnabled: false };
}

function originalRecordsForContext(context) {
  if (!context || !contexts.has(context)) fail("REFERENCE_PARTITION_UNTRUSTED_CONTEXT");
  return contexts.get(context).map(value => JSON.parse(value));
}

function assertOriginalInContext(context, record) {
  originalRecordsForContext(context);
  if (!isOriginalUnresolvedRecord(record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
  return true;
}

module.exports = { VERSION, FILE_NAME, SOURCE_ID, baselineHash, isOriginalUnresolvedRecord,
  validateUnresolvedRecords, partitionReferenceRecords, buildReferenceIntegrity, validateReferenceIntegrity,
  loadInstalledReferencePartition, installReferenceIntegrityInputs, originalRecordsForContext, assertOriginalInContext,
  validateSnapshotIntegrity, readSnapshotIntegrity, storedReferenceIntegrity, validateStoredReferenceIntegrity };
