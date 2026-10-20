"use strict";

// Private, cycle-owned scratch, never a public archive or recovery authority.
// Only compact offsets/selection keys survive across items. All original row
// transforms, comparisons and publication gates stay in syncData.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
const { serialize, deserialize } = require("node:v8");
const { streamJsonObjectArrays } = require("./streamedJsonObjectArrays.cjs");
const { readSelectedJsonObjectFile } = require("./selectedJsonObjectFile.cjs");
const { digest, verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
const ITEM_BYTES = 16 * 1024 * 1024, FILE_BYTES = 2 * 1024 ** 3;
const INDEX_BYTES = 32 * 1024 * 1024, MAX_ITEMS = 100000;
const arrays = new WeakMap(), payloads = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(message); };
const isSequence = value => Boolean(value && arrays.has(value));

class Sequence {
  constructor(owner, descriptors) {
    arrays.set(this, { owner, descriptors });
    this.length = descriptors.length;
    Object.freeze(this);
  }
  *[Symbol.iterator]() {
    const { owner, descriptors } = arrays.get(this);
    for (const descriptor of descriptors) yield owner.read(descriptor);
  }
}

function openWorkspace(publicDir, { cutoff, rowMetadata, acceptHistoryRow }) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "football-sync-snapshots-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "items.bin");
  let fd;
  try { fd = fs.openSync(file, "wx+", 0o600); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  const identity = fs.fstatSync(fd);
  let size = 0, indexBytes = 0, closed = false;
  const account = metadata => {
    indexBytes += Buffer.byteLength(JSON.stringify(metadata)) + 160;
    if (indexBytes > INDEX_BYTES) fail("PREDICTION_SNAPSHOT_INDEX_LIMIT");
  };
  const owner = {
    read(descriptor) {
      if (closed) fail("PREDICTION_SNAPSHOT_WORKSPACE_CLOSED");
      const current = fs.lstatSync(file), opened = fs.fstatSync(fd);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || current.dev !== identity.dev || current.ino !== identity.ino
        || opened.dev !== identity.dev || opened.ino !== identity.ino
        || opened.size !== size || current.size !== size) fail("PREDICTION_SNAPSHOT_SPOOL_CHANGED");
      const bytes = Buffer.allocUnsafe(descriptor.bytes);
      let read = 0;
      while (read < bytes.length) {
        const n = fs.readSync(fd, bytes, read, bytes.length - read, descriptor.offset + read);
        if (!n) fail("PREDICTION_SNAPSHOT_SPOOL_TRUNCATED");
        read += n;
      }
      if (sha(bytes) !== descriptor.sha256) fail("PREDICTION_SNAPSHOT_SPOOL_HASH");
      return deserialize(bytes);
    },
    put(value, metadata = {}) {
      if (closed) fail("PREDICTION_SNAPSHOT_WORKSPACE_CLOSED");
      // Ephemeral same-process codec retains explicit undefined properties,
      // insertion order, array holes and non-finite numbers through later
      // merges. JSON round-tripping here would erase those before the original
      // output serializer gets to apply its own JSON.stringify semantics.
      if (Buffer.byteLength(JSON.stringify(value)) > ITEM_BYTES) fail("PREDICTION_SNAPSHOT_SPOOL_LIMIT");
      const bytes = serialize(value);
      if (bytes.length > ITEM_BYTES || size + bytes.length > FILE_BYTES) fail("PREDICTION_SNAPSHOT_SPOOL_LIMIT");
      account(metadata);
      const descriptor = { offset: size, bytes: bytes.length, sha256: sha(bytes), ...metadata };
      let written = 0;
      while (written < bytes.length) {
        const n = fs.writeSync(fd, bytes, written, bytes.length - written, size + written);
        if (!n) fail("PREDICTION_SNAPSHOT_SPOOL_WRITE");
        written += n;
      }
      size += bytes.length;
      return descriptor;
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
      // Only this newly created private scratch tree. Originals and custody
      // .pending files are outside this directory and are never removed here.
      if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith("football-sync-snapshots-")) {
        fail("PREDICTION_SNAPSHOT_SCRATCH_PATH");
      }
      fs.rmSync(directory, { recursive: true });
    },
  };
  const makeMap = metadata => {
    const descriptors = new Map();
    return {
      descriptors,
      get: key => descriptors.has(key) ? owner.read(descriptors.get(key)) : undefined,
      has: key => descriptors.has(key),
      set(key, value) {
        if (!descriptors.has(key) && descriptors.size >= MAX_ITEMS) fail("PREDICTION_SNAPSHOT_ITEM_LIMIT");
        descriptors.set(key, owner.put(value, metadata(value)));
        return this;
      },
      values: () => new Sequence(owner, [...descriptors.values()]),
    };
  };
  const rowMap = makeMap(rowMetadata);
  const records = makeMap(record => ({ referenceHash: record.contentHash }));
  const entries = [], present = new Set();
  const acceptRecord = record => {
    if (Date.parse(record.recordedAt) >= cutoff) records.set(record.contentHash, record);
  };
  const workspace = {
    rowMap,
    history: { rows: [], updatedAt: null },
    retain(observationKeys, { maxRows, maxRowsPerMatch }) {
      const ordered = [...rowMap.descriptors.entries()]
        .filter(([key, row]) => !observationKeys.get(row.captureKey) || observationKeys.get(row.captureKey) === key)
        .map(([, row], index) => ({ row, index }))
        .sort((a, b) => a.row.firstTime - b.row.firstTime || a.index - b.index);
      const byMatch = new Map();
      for (const [order, entry] of ordered.entries()) {
        const key = entry.row.retentionKey;
        if (!key) continue;
        const kept = byMatch.get(key) || [];
        kept.push({ row: entry.row, order });
        if (kept.length > Math.max(1, Number(maxRowsPerMatch))) kept.shift();
        byMatch.set(key, kept);
      }
      return new Sequence(owner, [...byMatch.values()].flat().sort((a, b) => a.order - b.order)
        .slice(-Math.max(1, Number(maxRows))).map(entry => entry.row));
    },
    finishReferences(matches, companionStoreDir) {
      for (const match of matches || []) {
        const record = match?.predictionMeta?.publicReferenceDecision;
        if (record) acceptRecord(record);
      }
      const retained = makeMap(entry => ({ referenceHash: entry.referenceHash, entryHash: digest(entry) }));
      const acceptEntry = entry => {
        const record = records.get(entry?.referenceHash);
        if (!record) return;
        if (!verifyPublicReferenceEvidence(entry, record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID");
        const previous = retained.descriptors.get(entry.referenceHash), entryHash = digest(entry);
        if (previous && previous.entryHash !== entryHash) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_CONFLICT");
        // Same Map order and final value as the original collector.
        retained.set(entry.referenceHash, entry);
      };
      for (const descriptor of entries) acceptEntry(owner.read(descriptor));
      for (const match of matches || []) {
        const entry = require("../src/services/publicReferenceDecision.cjs").pendingPublicReferenceEvidence(match);
        if (entry) { present.add(entry.referenceHash); acceptEntry(entry); }
      }
      if (companionStoreDir) for (const match of matches || []) {
        const record = match?.predictionMeta?.publicReferenceDecision;
        if (!record?.evidenceBinding || present.has(record.contentHash)) continue;
        const original = require("./publicReferenceCompanionStore.cjs").readOriginalCompanion(companionStoreDir, record);
        if (original) { present.add(record.contentHash); acceptEntry(original.entry); }
      }
      for (const record of records.values()) {
        if (record.evidenceBinding && !retained.has(record.contentHash)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
      }
      workspace.getOriginalPair = hash => ({ record: records.get(hash), entry: retained.get(hash) });
      return { publicReferenceDecisions: records.values(), publicReferenceEvidence: retained.values() };
    },
    attach(payload) { payloads.set(payload, workspace); return payload; },
    close: owner.close,
  };
  try {
    const source = [path.join(publicDir, "data", "prediction-snapshots.json"), path.join(publicDir, "prediction-snapshots.json")]
      .find(filePath => fs.existsSync(filePath));
    if (!source) return workspace;
    const first = streamJsonObjectArrays(source, {
      keys: ["rows", "observations", "publicReferenceDecisions", "publicReferenceEvidence"],
      onItem(key, value, index) {
        if (index >= MAX_ITEMS) fail("PREDICTION_SNAPSHOT_ITEM_LIMIT");
        if (key === "rows") acceptHistoryRow(rowMap, value);
        else if (key === "publicReferenceDecisions") acceptRecord(value);
        else if (key === "publicReferenceEvidence") {
          const descriptor = owner.put(value, { referenceHash: value?.referenceHash });
          entries.push(descriptor); present.add(value?.referenceHash);
        }
      },
    });
    if (!first.fields.includes("rows")) fail("PREDICTION_SNAPSHOT_INVALID");
    // Second complete strict/hash pass binds the scalar metadata to the same
    // original bytes. No output, custody import or publication uses a prefix.
    const metadata = readSelectedJsonObjectFile({ filePath: source, expectedBytes: first.bytes,
      expectedSha256: first.sha256, keys: ["updatedAt"], maxSelectedChars: 64 * 1024 }).value;
    workspace.history.updatedAt = metadata.updatedAt || null;
    return workspace;
  } catch (cause) {
    owner.close();
    const error = new Error(`existing prediction snapshots cannot be read; refusing to replace history: ${cause.message}`);
    error.code = cause.code || "PREDICTION_SNAPSHOT_READ_FAILED";
    throw error;
  }
}

function sourceRows(rows, key, metadataKey = "sourceKey") {
  const state = arrays.get(rows);
  if (!state) return null;
  return state.descriptors.filter(descriptor => descriptor[metadataKey] === key).map(descriptor => state.owner.read(descriptor));
}
function workspaceFor(payload) { return payloads.get(payload); }
function closePayload(payload) { payloads.get(payload)?.close(); }
module.exports = { openWorkspace, isSequence, sourceRows, workspaceFor, closePayload };
