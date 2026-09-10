"use strict";

// Community-source research receipts only. This module has no model, warehouse,
// official result publisher, entity registry or production recommendation imports.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { sourceUrl, inspectSource, fetchSourceBytes, LEAGUES } = require("./auditOpenFootballCurrentSeason.cjs");

const VERSION = "openfootball-local-observation-v1";
const MAX_RAW_BYTES = 256 * 1024 * 1024;
const MAX_DATABASE_BYTES = 384 * 1024 * 1024;
const MAX_OBSERVATIONS = 20000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const hashObject = value => digest(JSON.stringify(value));
const canonicalClock = value => {
  if (!strictInstant(value)) throw new Error("Invalid observation clock");
  return new Date(value).toISOString();
};

function openStore(storeDir) {
  const { DatabaseSync } = require("node:sqlite");
  if (typeof storeDir !== "string" || !path.isAbsolute(storeDir)) throw new Error("Explicit absolute observation directory required");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(storeDir).isDirectory() || fs.lstatSync(storeDir).isSymbolicLink()) throw new Error("Unsafe observation directory");
  const directory = fs.realpathSync(storeDir);
  const file = path.join(directory, "observations.sqlite");
  const existed = fs.existsSync(file);
  if (existed) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DATABASE_BYTES) throw new Error("Unsafe or oversized observation database");
  }
  const disk = fs.statfsSync(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(MIN_FREE_BYTES)) throw new Error("Insufficient observation disk reserve");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (existed) {
      const schema = db.prepare("SELECT value FROM observation_meta WHERE key='schema'").get();
      if (schema?.value !== VERSION) throw new Error("Unknown observation database schema");
    } else {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE observation_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE source_contents(
          source_url TEXT NOT NULL, content_hash TEXT NOT NULL, raw BLOB NOT NULL,
          first_received_at TEXT NOT NULL, first_receipt_hash TEXT NOT NULL,
          PRIMARY KEY(source_url, content_hash));
        CREATE TABLE observations(
          sequence INTEGER PRIMARY KEY, source_url TEXT NOT NULL, content_hash TEXT NOT NULL,
          received_at TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL UNIQUE,
          FOREIGN KEY(source_url,content_hash) REFERENCES source_contents(source_url,content_hash));
        CREATE INDEX observations_source ON observations(source_url, sequence);
      `);
      db.prepare("INSERT INTO observation_meta VALUES('schema',?)").run(VERSION);
      db.exec("COMMIT;");
      fs.chmodSync(file, 0o600);
    }
    db.exec("PRAGMA synchronous=FULL;");
    return db;
  } catch (error) { db.close(); throw error; }
}

function verifyReceipt(row) {
  if (!row) return null;
  const receipt = JSON.parse(row.receipt_json);
  if (hashObject(receipt) !== row.receipt_hash || receipt.version !== VERSION
    || receipt.scope !== "local-complete-response-only" || receipt.sourceVerified !== false
    || receipt.productionEligible !== false || receipt.sequence !== row.sequence
    || receipt.sourceUrl !== row.source_url || receipt.contentSha256 !== row.content_hash
    || receipt.receivedAt !== row.received_at
    || canonicalClock(receipt.receivedAt) !== receipt.receivedAt
    || canonicalClock(receipt.requestStartedAt) !== receipt.requestStartedAt
    || canonicalClock(receipt.firstObservedAt) !== receipt.firstObservedAt
    || receipt.requestStartedAt > receipt.receivedAt || receipt.firstObservedAt > receipt.receivedAt
    || receipt.sourceUrl !== sourceUrl(receipt.season, receipt.league)
    || receipt.entityMappingStatus !== "unverified" || receipt.officialSettlementAllowed !== false
    || receipt.upstreamPublishedAt !== null) throw new Error("Observation receipt integrity failed");
  return receipt;
}

const buildObservationReceipt = ({ sequence, url, league, season, contentHash, rawBytes, started, received,
  firstObservedAt, previousReceiptHash, firstReceiptHash, candidateRows }) => ({
  version: VERSION, scope: "local-complete-response-only", sequence,
  sourceUrl: url, league, season, contentSha256: contentHash, bytes: rawBytes,
  requestStartedAt: started, receivedAt: received, firstObservedAt,
  previousReceiptHash, previousContentReceiptHash: firstReceiptHash, candidateRows,
  sourceVerified: false, entityMappingStatus: "unverified", productionEligible: false,
  upstreamPublishedAt: null, officialSettlementAllowed: false,
});

function recordSourceObservation({ storeDir, season, league, raw, requestStartedAt, receivedAt }) {
  const started = canonicalClock(requestStartedAt), received = canonicalClock(receivedAt);
  if (received < started) throw new Error("Response receipt precedes request");
  const inspected = inspectSource(raw, { season, league, receivedAt: received });
  const url = sourceUrl(season, league), contentHash = digest(raw);
  const db = openStore(storeDir);
  try {
    db.exec("BEGIN IMMEDIATE;");
    // Refuse to extend a damaged older chain, not only a damaged latest row.
    // This is a bounded research ledger, never a hot match-publication path.
    auditDatabase(db);
    const previousRow = db.prepare("SELECT * FROM observations ORDER BY sequence DESC LIMIT 1").get();
    const previous = verifyReceipt(previousRow);
    if (previous && received < previous.receivedAt) throw new Error("Observation clock moved backwards");
    const sequence = (previous?.sequence || 0) + 1;
    if (sequence > MAX_OBSERVATIONS) throw new Error("Observation capacity reached; retain evidence and stop");
    const existing = db.prepare("SELECT * FROM source_contents WHERE source_url=? AND content_hash=?").get(url, contentHash);
    let firstObservedAt = received, firstReceiptHash = null;
    if (existing) {
      if (!Buffer.from(existing.raw).equals(raw)) throw new Error("Stored source content integrity failed");
      const firstRow = db.prepare("SELECT * FROM observations WHERE receipt_hash=?").get(existing.first_receipt_hash);
      const first = verifyReceipt(firstRow);
      if (!first || first.sourceUrl !== url || first.contentSha256 !== contentHash
        || first.receivedAt !== existing.first_received_at || first.receivedAt > received) throw new Error("Stored first observation is invalid");
      firstObservedAt = first.receivedAt; firstReceiptHash = existing.first_receipt_hash;
    } else {
      const bytes = db.prepare("SELECT coalesce(sum(length(raw)),0) bytes FROM source_contents").get().bytes;
      if (bytes + raw.length > MAX_RAW_BYTES) throw new Error("Source content capacity reached; retain evidence and stop");
    }
    const receipt = buildObservationReceipt({ sequence, url, league, season, contentHash, rawBytes: raw.length,
      started, received, firstObservedAt, previousReceiptHash: previousRow?.receipt_hash || null,
      firstReceiptHash, candidateRows: inspected.candidateRows });
    const receiptHash = hashObject(receipt);
    if (!existing) db.prepare("INSERT INTO source_contents VALUES(?,?,?,?,?)")
      .run(url, contentHash, raw, received, receiptHash);
    db.prepare("INSERT INTO observations VALUES(?,?,?,?,?,?)")
      .run(sequence, url, contentHash, received, JSON.stringify(receipt), receiptHash);
    db.exec("COMMIT;");
    return { ...receipt, receiptHash, reusedContent: Boolean(existing), sourceContentsWritten: existing ? 0 : 1,
      productionAdmittedRows: 0, latestResultDate: inspected.latestResultDate };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch { /* Original failure remains authoritative. */ }
    throw error;
  } finally { db.close(); }
}

function createObservationAudit({ count, contents }) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(contents.n) || contents.n < 0
      || !Number.isSafeInteger(contents.bytes) || contents.bytes < 0) throw new Error("Invalid observation audit counts");
    if (count > MAX_OBSERVATIONS) throw new Error("Observation audit capacity exceeded");
    if (contents.bytes > MAX_RAW_BYTES) throw new Error("Content audit capacity exceeded");
    let previousHash = null, previousAt = null, expectedSequence = 1;
    const firstByContent = new Map();
    const verifiedContents = new Set();
    let verifiedBytes = 0;
    return { receipt(row) {
      const receipt = verifyReceipt(row);
      if (receipt.sequence !== expectedSequence++ || receipt.previousReceiptHash !== previousHash
        || (previousAt && receipt.receivedAt < previousAt)) throw new Error("Observation chain discontinuity");
      const key = JSON.stringify([receipt.sourceUrl, receipt.contentSha256]);
      const first = firstByContent.get(key);
      if (first) {
        if (receipt.firstObservedAt !== first.receivedAt || receipt.previousContentReceiptHash !== first.hash) throw new Error("First observation was rewritten");
      } else {
        if (receipt.firstObservedAt !== receipt.receivedAt || receipt.previousContentReceiptHash !== null) throw new Error("Missing first content receipt");
        firstByContent.set(key, { ...receipt, hash: row.receipt_hash });
      }
      previousHash = row.receipt_hash; previousAt = receipt.receivedAt;
    }, content(row) {
      const key = JSON.stringify([row.source_url, row.content_hash]);
      if (verifiedContents.has(key)) throw new Error("Duplicate source content");
      const first = firstByContent.get(key);
      const raw = Buffer.from(row.raw);
      if (!first || digest(raw) !== row.content_hash || first.bytes !== raw.length
        || first.hash !== row.first_receipt_hash || first.receivedAt !== row.first_received_at) throw new Error("Source content binding failed");
      const inspected = inspectSource(raw, { season: first.season, league: first.league, receivedAt: first.receivedAt });
      if (inspected.candidateRows !== first.candidateRows) throw new Error("Source parse binding failed");
      verifiedContents.add(key); verifiedBytes += raw.length;
    }, finish() {
    if (firstByContent.size !== contents.n || verifiedContents.size !== contents.n) throw new Error("Unreferenced source content");
    if (expectedSequence - 1 !== count || verifiedBytes !== contents.bytes) throw new Error("Observation audit count mismatch");
    return { ok: true, version: VERSION, observations: count, sourceContents: contents.n,
      rawBytes: contents.bytes, lastReceiptHash: previousHash, latestReceivedAt: previousAt,
      sourceVerified: false, productionAdmittedRows: 0, writes: 0 };
    } };
}

function auditDatabase(db) {
  if (db.prepare("SELECT value FROM observation_meta WHERE key='schema'").get()?.value !== VERSION) throw new Error("Unknown observation schema");
  const audit = createObservationAudit({ count: db.prepare("SELECT count(*) n FROM observations").get().n,
    contents: db.prepare("SELECT count(*) n,coalesce(sum(length(raw)),0) bytes FROM source_contents").get() });
  for (const row of db.prepare("SELECT * FROM observations ORDER BY sequence").iterate()) audit.receipt(row);
  for (const row of db.prepare("SELECT * FROM source_contents").iterate()) audit.content(row);
  return audit.finish();
}

function readAuditedObservationStore(storeDir, read) {
  const { DatabaseSync } = require("node:sqlite");
  if (typeof storeDir !== "string" || !path.isAbsolute(storeDir)) throw new Error("Explicit absolute observation directory required");
  const file = path.join(fs.realpathSync(storeDir), "observations.sqlite");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DATABASE_BYTES) throw new Error("Unsafe observation database");
  const db = new DatabaseSync(file, { readOnly: true });
  let deferredClose = false;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;");
    const audit = auditDatabase(db);
    const report = read ? read(db, audit) : audit;
    if (report && typeof report.then === "function") {
      deferredClose = true;
      return Promise.resolve(report).then(value => { db.exec("COMMIT;"); return value; }).finally(() => db.close());
    }
    db.exec("COMMIT;");
    return report;
  } finally { if (!deferredClose) db.close(); }
}

const auditObservationStore = storeDir => readAuditedObservationStore(storeDir);

async function collectSeasonObservations({ storeDir, season, fetchImpl = fetch, clock, record = recordSourceObservation }) {
  // Validate configuration before making any request. Explicit storage means a
  // plain audit can never silently become production ingestion.
  if (typeof storeDir !== "string" || !path.isAbsolute(storeDir)) throw new Error("Explicit absolute observation directory required");
  for (const league of Object.keys(LEAGUES)) sourceUrl(season, league);
  const sources = [];
  for (const league of Object.keys(LEAGUES)) {
    try {
      const response = await fetchSourceBytes(season, league, fetchImpl, clock);
      const receipt = await record({ storeDir, season, league, ...response });
      sources.push({ ok: true, league, receipt });
    } catch (error) {
      sources.push({ ok: false, league, error: error.message });
    }
  }
  return { version: "openfootball-observation-collection-v1", ok: sources.every(s => s.ok),
    season, sources, providerRequests: sources.length, productionAdmittedRows: 0,
    officialResultWrites: 0, predictionWrites: 0, researchReceiptStoreOnly: true };
}

if (require.main === module) {
  const [season, storeDir, ...rest] = process.argv.slice(2);
  if (!season || !storeDir || rest.length) {
    console.error("Usage: node scripts/openFootballObservationStore.cjs YYYY-YY <absolute-private-research-directory>");
    process.exitCode = 1;
  } else collectSeasonObservations({ storeDir, season }).then(report => {
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { VERSION, MAX_RAW_BYTES, MAX_OBSERVATIONS, recordSourceObservation, collectSeasonObservations, auditObservationStore, readAuditedObservationStore,
  canonicalClock, digest, hashObject, verifyReceipt, buildObservationReceipt, createObservationAudit };
