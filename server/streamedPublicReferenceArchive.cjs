"use strict";
// Preserve the v2 archive and v1 index byte-for-byte without retaining the
// complete evidence graph or a ledger-sized JavaScript string.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { readGenerationSelectedObject } = require("./dataGenerationStore.cjs");
const { streamJsonObjectArrays } = require("./streamedJsonObjectArrays.cjs");
const { VERSION, SOURCE_ID, INDEX_VERSION, INDEX_ID, indexRowId, validReferenceHash } = require("./publicReferenceArchive.cjs");
const { digest, verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
const { createFileJsonPayload } = require("../scripts/postgresFileJsonPayload.cjs");
const MAX_ARCHIVE_BYTES = 768 * 1024 * 1024;
const MAX_ITEMS = 100000;
const MAX_ITEM_CHARS = 16 * 1024 * 1024;
const INLINE_BYTES = 1024 * 1024;
const fail = message => { const error = new Error(message); error.code = "POSTGRES_REFERENCE_ARCHIVE_LIMIT"; throw error; };
const newHash = () => crypto.createHash("sha256");
function buildStreamedPublicReferenceArchive(context, options = {}) {
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const inlineBytes = options.inlineBytes ?? INLINE_BYTES;
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > MAX_ARCHIVE_BYTES
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS
    || !Number.isSafeInteger(inlineBytes) || inlineBytes < 0 || inlineBytes > INLINE_BYTES) fail("invalid streamed reference admission bound");
  const name = "prediction-snapshots.json";
  // Admit the path and immutable manifest before creating scratch files.
  const { value: metadata } = readGenerationSelectedObject(context, name, { keys: ["updatedAt", "retentionDays"], maxSelectedChars: 64 * 1024 });
  const input = path.join(context.generationDir, name), entry = context.manifest.files.find(item => item.path === name);
  const base = fs.realpathSync(options.tempDir || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, "football-pg-reference-"));
  let spoolFd = null, archiveFd = null, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    let closeError = null;
    for (const fd of [spoolFd, archiveFd]) if (fd !== null) { try { fs.closeSync(fd); } catch (error) { closeError ||= error; } }
    spoolFd = archiveFd = null;
    // Only the private directory created above is ever removed.
    if (path.dirname(directory) !== base || !path.basename(directory).startsWith("football-pg-reference-")) throw new Error("unsafe reference scratch cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
    if (closeError) throw closeError;
  };
  try {
    fs.chmodSync(directory, 0o700);
    spoolFd = fs.openSync(path.join(directory, "items.jsonl"), "wx+", 0o600);
    let spoolBytes = 0, itemCount = 0, lastRecordedTime = -Infinity;
    const records = [], byHash = new Map(), evidence = new Map();
    const rowHash = newHash().update("[");
    const writeAll = (fd, bytes) => { let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!written) throw new Error("reference scratch write stalled"); offset += written; } };
    const appendItem = value => {
      const bytes = Buffer.from(JSON.stringify(value));
      if (spoolBytes + bytes.length > maxArchiveBytes) fail("reference scratch exceeds bounded archive bytes");
      const item = { offset: spoolBytes, bytes: bytes.length, sha256: newHash().update(bytes).digest("hex") };
      writeAll(spoolFd, bytes); spoolBytes += bytes.length;
      return item;
    };
    const itemBytes = item => {
      if (closed) throw new Error("reference archive is closed");
      const bytes = Buffer.allocUnsafe(item.bytes); let read = 0;
      while (read < bytes.length) { const n = fs.readSync(spoolFd, bytes, read, bytes.length - read, item.offset + read); if (!n) throw new Error("reference scratch truncated"); read += n; }
      if (newHash().update(bytes).digest("hex") !== item.sha256) throw new Error("reference scratch integrity invalid");
      return bytes;
    };
    const itemValue = item => JSON.parse(itemBytes(item).toString("utf8"));
    const scan = (key, onItem) => streamJsonObjectArrays(input, { keys: [key], allowNonArrays: true,
      expectedBytes: entry.bytes, expectedSha256: entry.sha256, maxItemChars: MAX_ITEM_CHARS,
      onItem(_key, value) { if (++itemCount > maxItems) fail("reference item count exceeds bounded admission"); onItem(value); } });
    const result = scan("publicReferenceDecisions", record => {
      if (!validReferenceHash(record?.contentHash) || byHash.has(record.contentHash) || !attestPublicReferenceDecision(record, record)) throw new Error("REFERENCE_INDEX_RECORD_INVALID");
      const item = appendItem(record);
      rowHash.update(records.length ? "," : "").update(itemBytes(item));
      const descriptor = { ...item, hash: record.contentHash, bound: Boolean(record.evidenceBinding) };
      records.push(descriptor); byHash.set(record.contentHash, descriptor);
      const at = Date.parse(record.recordedAt || ""); if (Number.isFinite(at)) lastRecordedTime = Math.max(lastRecordedTime, at);
    });
    if (!result.fields.includes("publicReferenceDecisions")) {
      // The legacy two-field reader also validates duplicate/malformed evidence
      // fields when no archive exists. Absence must not bypass that check.
      scan("publicReferenceEvidence", () => {}); close(); return null;
    }
    const contentHash = rowHash.update("]").digest("hex");
    scan("publicReferenceEvidence", value => {
      const descriptor = byHash.get(value?.referenceHash);
      if (!descriptor) return; // Exact existing collectPublicReferenceEvidence retention semantics.
      const record = itemValue(descriptor);
      if (!verifyPublicReferenceEvidence(value, record)) throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID");
      const previous = evidence.get(value.referenceHash), encodedHash = digest(value);
      if (previous) {
        if (previous.sha256 !== encodedHash) throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_CONFLICT");
        return;
      }
      evidence.set(value.referenceHash, appendItem(value));
    });
    for (const record of records) if (record.bound && !evidence.has(record.hash)) throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
    const evidenceHash = newHash().update("["); let evidencePosition = 0;
    for (const item of evidence.values()) evidenceHash.update(evidencePosition++ ? "," : "").update(itemBytes(item));
    const evidenceContentHash = evidenceHash.update("]").digest("hex");
    const sortedRecords = [...records].sort((a, b) => a.hash.localeCompare(b.hash));
    const levels = [sortedRecords.map(item => digest({ version: INDEX_VERSION, record: itemValue(item), entry: evidence.has(item.hash) ? itemValue(evidence.get(item.hash)) : null }))];
    while (levels.at(-1).length > 1) {
      const previous = levels.at(-1), next = [];
      for (let i = 0; i < previous.length; i += 2) next.push(digest({ version: INDEX_VERSION, left: previous[i], right: previous[i + 1] || previous[i] }));
      levels.push(next);
    }
    const body = { version: INDEX_VERSION, rowCount: records.length, rootHash: levels.at(-1)[0] || digest([]),
      archiveVersion: VERSION, archiveContentHash: contentHash, evidenceContentHash };
    const manifest = { ...body, contentHash: digest(body) };
    const lastRecordedAt = Number.isFinite(lastRecordedTime) ? new Date(lastRecordedTime).toISOString() : null;
    const archivePath = path.join(directory, "archive.json");
    archiveFd = fs.openSync(archivePath, "wx", 0o600);
    let archiveBytes = 0; const archiveHash = newHash();
    const write = input => {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      if (archiveBytes + bytes.length > maxArchiveBytes) fail("reference archive exceeds bounded PostgreSQL JSON bytes");
      writeAll(archiveFd, bytes); archiveHash.update(bytes); archiveBytes += bytes.length;
    };
    write('{"version":' + JSON.stringify(VERSION) + ',"source":"sporttery:public-reference-decisions","sourceUpdatedAt":'
      + JSON.stringify(metadata.updatedAt || null) + ',"contentHash":' + JSON.stringify(contentHash) + ',"rows":[');
    for (let i = 0; i < records.length; i++) { if (i) write(","); write(itemBytes(records[i])); }
    write('],"evidence":['); let position = 0;
    for (const item of evidence.values()) { if (position++) write(","); write(itemBytes(item)); }
    write('],"evidenceContentHash":' + JSON.stringify(evidenceContentHash) + ',"lastRecordedAt":' + JSON.stringify(lastRecordedAt)
      + ',"retentionDays":' + JSON.stringify(metadata.retentionDays ?? null) + '}');
    fs.fsyncSync(archiveFd); fs.closeSync(archiveFd); archiveFd = null;
    const archiveSha256 = archiveHash.digest("hex");
    const ids = [SOURCE_ID, INDEX_ID, ...sortedRecords.map(item => indexRowId(item.hash))];
    return {
      ids, manifest, lastRecordedAt, archiveBytes, archiveSha256, directory, close,
      *rows() {
        if (closed) throw new Error("reference archive is closed");
        let archivePayload;
        if (archiveBytes <= inlineBytes) {
          const before = fs.lstatSync(archivePath);
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== archiveBytes) throw new Error("reference scratch integrity invalid");
          const fd = fs.openSync(archivePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            const bytes = Buffer.allocUnsafe(archiveBytes); let offset = 0;
            while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) throw new Error("reference scratch truncated"); offset += n; }
            const after = fs.fstatSync(fd), current = fs.lstatSync(archivePath);
            const same = value => value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.dev === before.dev
              && value.ino === before.ino && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
            if (!same(after) || !same(current) || newHash().update(bytes).digest("hex") !== archiveSha256) throw new Error("reference scratch integrity invalid");
            archivePayload = bytes.toString("utf8");
          } finally { fs.closeSync(fd); }
        } else archivePayload = createFileJsonPayload(archivePath, { bytes: archiveBytes, sha256: archiveSha256, maxBytes: maxArchiveBytes });
        yield { id: SOURCE_ID, source: "sporttery:public-reference-decisions", captured_at: lastRecordedAt,
          payload: archivePayload };
        yield { id: INDEX_ID, source: "sporttery:public-reference-index", captured_at: lastRecordedAt, payload: JSON.stringify(manifest) };
        for (let index = 0; index < sortedRecords.length; index++) {
          const item = sortedRecords[index], proof = []; let position = index;
          for (let level = 0; level < levels.length - 1; level++) { proof.push(levels[level][position ^ 1] || levels[level][position]); position = Math.floor(position / 2); }
          yield { id: indexRowId(item.hash), source: "sporttery:public-reference-index", captured_at: lastRecordedAt,
            payload: JSON.stringify({ version: INDEX_VERSION, manifestHash: manifest.contentHash, index, proof,
              record: itemValue(item), entry: evidence.has(item.hash) ? itemValue(evidence.get(item.hash)) : null }) };
        }
      },
    };
  } catch (error) { close(); throw error; }
}
module.exports = { buildStreamedPublicReferenceArchive, MAX_ARCHIVE_BYTES, MAX_ITEMS };
