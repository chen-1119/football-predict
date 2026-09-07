"use strict";
const { createHash } = require("node:crypto");

const VERSION = "public-reference-archive-v2";
const { collectPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
const SOURCE_ID = "public-reference-decisions:current";

// Preserve the independent, already-recorded public reference ledger. It must
// not be folded into candidate snapshots or reconstructed from current picks.
const buildPublicReferenceArchive = (snapshot) => {
  if (!Array.isArray(snapshot?.publicReferenceDecisions)) return null;
  const rows = snapshot.publicReferenceDecisions;
  const evidence = collectPublicReferenceEvidence(rows, snapshot.publicReferenceEvidence);
  const lastRecordedTime = rows.reduce((latest, row) => {
    const time = Date.parse(row?.recordedAt || "");
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, -Infinity);
  return {
    version: VERSION,
    source: "sporttery:public-reference-decisions",
    sourceUpdatedAt: snapshot.updatedAt || null,
    contentHash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    rows,
    evidence,
    evidenceContentHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    lastRecordedAt: Number.isFinite(lastRecordedTime) ? new Date(lastRecordedTime).toISOString() : null,
    retentionDays: snapshot.retentionDays ?? null,
  };
};

const validReferenceHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const MAX_AUDIT_BYTES = 32 * 1024 * 1024;
// Admin-only reads resolve the stored revision, never today's recomputed pick.
const resolvePublicReferenceEvidence = (archive, referenceHash) => {
  if (!validReferenceHash(referenceHash)) return { ok: false, reason: "invalid-reference-hash" };
  if (!archive) return { ok: false, reason: "archive-unavailable" };
  const { digest, verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
  const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
  if (![VERSION, "public-reference-archive-v1"].includes(archive.version) || !Array.isArray(archive.rows)
    || digest(archive.rows) !== archive.contentHash) return { ok: false, reason: "archive-integrity-invalid" };
  const records = archive.rows.filter((row) => row?.contentHash === referenceHash);
  if (!records.length) return { ok: false, reason: "reference-not-found" };
  if (records.length !== 1 || !attestPublicReferenceDecision(records[0], records[0])) {
    return { ok: false, reason: "reference-integrity-invalid" };
  }
  const record = records[0];
  if (!record.evidenceBinding) return { ok: false, reason: "evidence-not-recorded", referenceHash };
  if (!Array.isArray(archive.evidence) || digest(archive.evidence) !== archive.evidenceContentHash) {
    return { ok: false, reason: "evidence-integrity-invalid" };
  }
  const entries = archive.evidence.filter((entry) => entry?.referenceHash === referenceHash);
  if (entries.length !== 1 || !verifyPublicReferenceEvidence(entries[0], record)) {
    return { ok: false, reason: "evidence-integrity-invalid" };
  }
  return { ok: true, referenceHash, record, evidence: entries[0].evidence,
    note: "Content binding only; not independent source attestation or model admission." };
};

const INDEX_VERSION = "public-reference-index-v1";
const INDEX_ID = "public-reference-index:current";
const INDEX_PREFIX = "public-reference-index:row:";
const MAX_INDEX_BYTES = 16 * 1024;
const { digest } = require("../src/services/publicReferenceEvidence.cjs");
const branchHash = (left, right) => digest({ version: INDEX_VERSION, left, right });
const leafHash = (record, entry) => digest({ version: INDEX_VERSION, record, entry });
const indexRowId = hash => {
  if (!validReferenceHash(hash)) throw new Error("INVALID_REFERENCE_INDEX_HASH");
  return `${INDEX_PREFIX}${hash}`;
};

// Build once in the projection transaction. A request then needs only the
// small manifest and one PK-addressed record, plus O(log n) membership hashes.
function buildPublicReferenceIndex(archive) {
  if (!archive) return null;
  if (archive.version !== VERSION || !Array.isArray(archive.rows) || digest(archive.rows) !== archive.contentHash
    || !Array.isArray(archive.evidence) || digest(archive.evidence) !== archive.evidenceContentHash) throw new Error("REFERENCE_INDEX_ARCHIVE_INVALID");
  const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
  const { verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
  const evidence = new Map();
  for (const entry of archive.evidence) {
    if (evidence.has(entry.referenceHash)) throw new Error("REFERENCE_INDEX_DUPLICATE_EVIDENCE");
    evidence.set(entry.referenceHash, entry);
  }
  const keys = new Set();
  const rows = [...archive.rows].sort((a, b) => String(a.contentHash).localeCompare(String(b.contentHash))).map(record => {
    if (!validReferenceHash(record.contentHash) || keys.has(record.contentHash) || !attestPublicReferenceDecision(record, record)) throw new Error("REFERENCE_INDEX_RECORD_INVALID");
    keys.add(record.contentHash);
    const entry = evidence.get(record.contentHash) || null;
    if (record.evidenceBinding && !verifyPublicReferenceEvidence(entry, record)) throw new Error("REFERENCE_INDEX_EVIDENCE_INVALID");
    if (!record.evidenceBinding && entry) throw new Error("REFERENCE_INDEX_UNBOUND_EVIDENCE");
    return { record, entry };
  });
  if ([...evidence.keys()].some(hash => !keys.has(hash))) throw new Error("REFERENCE_INDEX_ORPHAN_EVIDENCE");
  const levels = [rows.map(row => leafHash(row.record, row.entry))];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1), next = [];
    for (let i = 0; i < previous.length; i += 2) next.push(branchHash(previous[i], previous[i + 1] || previous[i]));
    levels.push(next);
  }
  const body = { version: INDEX_VERSION, rowCount: rows.length, rootHash: levels.at(-1)[0] || digest([]),
    archiveVersion: archive.version, archiveContentHash: archive.contentHash, evidenceContentHash: archive.evidenceContentHash };
  const manifest = { ...body, contentHash: digest(body) };
  const shards = rows.map((row, index) => {
    const proof = []; let position = index;
    for (let level = 0; level < levels.length - 1; level++) {
      proof.push(levels[level][position ^ 1] || levels[level][position]);
      position = Math.floor(position / 2);
    }
    return { id: indexRowId(row.record.contentHash), payload: { version: INDEX_VERSION, manifestHash: manifest.contentHash, index, proof, ...row } };
  });
  return { manifest, shards };
}

function resolveIndexedPublicReferenceEvidence(manifest, shard, referenceHash) {
  if (!validReferenceHash(referenceHash)) return { ok: false, reason: "invalid-reference-hash" };
  if (!manifest) return { ok: false, reason: "archive-unavailable" };
  const { contentHash, ...body } = manifest;
  if (manifest.version !== INDEX_VERSION || manifest.archiveVersion !== VERSION || digest(body) !== contentHash
    || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 0 || !validReferenceHash(manifest.rootHash)
    || !validReferenceHash(manifest.archiveContentHash) || !validReferenceHash(manifest.evidenceContentHash)) return { ok: false, reason: "archive-integrity-invalid" };
  if (!shard) return { ok: false, reason: "reference-not-found" };
  if (shard.version !== INDEX_VERSION || shard.manifestHash !== contentHash || shard.record?.contentHash !== referenceHash
    || !Number.isSafeInteger(shard.index) || shard.index < 0 || shard.index >= manifest.rowCount
    || !Array.isArray(shard.proof) || shard.proof.length !== Math.ceil(Math.log2(manifest.rowCount))) return { ok: false, reason: "reference-integrity-invalid" };
  let hash = leafHash(shard.record, shard.entry), index = shard.index, width = manifest.rowCount;
  for (const sibling of shard.proof) {
    if (!validReferenceHash(sibling) || ((index ^ 1) >= width && sibling !== hash)) return { ok: false, reason: "reference-integrity-invalid" };
    hash = index % 2 ? branchHash(sibling, hash) : branchHash(hash, sibling);
    index = Math.floor(index / 2); width = Math.ceil(width / 2);
  }
  if (hash !== manifest.rootHash) return { ok: false, reason: "reference-integrity-invalid" };
  const record = shard.record;
  const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
  const { verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
  if (!attestPublicReferenceDecision(record, record)) return { ok: false, reason: "reference-integrity-invalid" };
  if (!record.evidenceBinding) return { ok: false, reason: "evidence-not-recorded", referenceHash };
  if (!verifyPublicReferenceEvidence(shard.entry, record)) return { ok: false, reason: "evidence-integrity-invalid" };
  return { ok: true, referenceHash, record, evidence: shard.entry.evidence,
    note: "Content binding only; not independent source attestation or model admission." };
}

module.exports = { VERSION, SOURCE_ID, MAX_AUDIT_BYTES, validReferenceHash, buildPublicReferenceArchive, resolvePublicReferenceEvidence,
  INDEX_VERSION, INDEX_ID, INDEX_PREFIX, MAX_INDEX_BYTES, indexRowId, buildPublicReferenceIndex, resolveIndexedPublicReferenceEvidence };
