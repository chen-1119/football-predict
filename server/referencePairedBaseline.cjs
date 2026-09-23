"use strict";
const VERSION = "reference-paired-baseline-v1";
const POLICY = "signed-frozen-reference-pair-v1";
const FIELDS = ["settledReferenceEvents", "paired", "excluded", "publishedWon", "baselineWon", "tiedBaselineOdds", "bothWon", "publicOnly", "baselineOnly", "bothLost"];
const identity = c => JSON.stringify([c.date, c.market, c.versionKey]);
const empty = () => Object.fromEntries(FIELDS.map(k => [k,0]));
const envelope = (summary, cells) => ({ version: VERSION, policyVersion: POLICY,
  scope: "server-complete-reference-history", generatedAt: summary.generatedAt,
  recommendationCoverage: null, promotionEligible: false, parameterRevisionVerified: false,
  sourceBoundary: "trusted-collector-signed-commitment-raw-response-not-rehashed",
  resultBoundary: "existing-application-trusted-final-not-independent-result-attestation",
  tieOrder: ["1","X","2"], cells });

// summary must already pass the original complete-history and version/market
// partition contract. Only count cells are public; never expose private proofs,
// prices, source URLs, per-match decisions, keys or full feature/model objects.
function compactReferencePairedBaseline(value, summary) {
  if (!value || value.version !== VERSION || value.policyVersion !== POLICY
    || value.scope !== "server-complete-reference-history" || value.generatedAt !== summary.generatedAt
    || value.recommendationCoverage !== null || value.promotionEligible !== false || value.parameterRevisionVerified !== false
    || value.sourceBoundary !== "trusted-collector-signed-commitment-raw-response-not-rehashed"
    || value.resultBoundary !== "existing-application-trusted-final-not-independent-result-attestation"
    || JSON.stringify(value.tieOrder) !== JSON.stringify(["1","X","2"])
    || !Array.isArray(value.cells) || value.cells.length > 20000 || !summary.versionBreakdown || !summary.marketBreakdown) return null;
  const expected = new Map();
  for (const group of [...summary.versionBreakdown.groups, summary.versionBreakdown.unknown]) {
    for (const market of ["HAD","HHAD","UNKNOWN"]) {
      for (const row of group.marketBreakdown[market].daily) {
        if (row.settled > 0) expected.set(identity({date:row.date,market,versionKey:group.key}),row);
      }
    }
  }
  const cells = [], seen = new Set();
  for (const c of value.cells) {
    if (!c || typeof c !== "object" || Array.isArray(c)
      || Object.keys(c).sort().join("|") !== ["date","market","versionKey",...FIELDS].sort().join("|")
      || !FIELDS.every(k => Number.isSafeInteger(c[k]) && c[k] >= 0)) return null;
    const key = identity(c), target = expected.get(key);
    if (!target || seen.has(key) || c.settledReferenceEvents !== target.settled
      || c.paired + c.excluded !== c.settledReferenceEvents || c.publishedWon > target.won
      || c.paired - c.publishedWon > target.lost || c.baselineWon > c.paired || c.tiedBaselineOdds > c.paired
      || c.bothWon + c.publicOnly !== c.publishedWon || c.bothWon + c.baselineOnly !== c.baselineWon
      || c.bothWon + c.publicOnly + c.baselineOnly + c.bothLost !== c.paired
      || ((c.market === "UNKNOWN" || c.versionKey === "UNKNOWN") && c.paired !== 0)) return null;
    seen.add(key); cells.push({date:c.date,market:c.market,versionKey:c.versionKey,...Object.fromEntries(FIELDS.map(k=>[k,c[k]]))});
  }
  if (seen.size !== expected.size || cells.reduce((n,c)=>n+c.settledReferenceEvents,0) !== summary.cumulative.settled) return null;
  return envelope(summary,cells.sort((a,b)=>identity(a).localeCompare(identity(b))));
}

function buildReferencePerformanceWithPairs({ matches, snapshotPayload, trustRegistry, generatedAt, startDate } = {}) {
  const { buildReferenceReviewPerformance, compactReferenceReviewPerformance } = require("./reviewPerformanceSummary.cjs");
  const { buildPublicReferenceArchive } = require("./publicReferenceArchive.cjs");
  const { buildPublicReferencePairAudit } = require("../scripts/auditPublicReferencePairs.cjs");
  const summary = compactReferenceReviewPerformance(buildReferenceReviewPerformance({matches,generatedAt,startDate}));
  if (!summary) throw new Error("Complete reference history failed validation before pairing");
  const audit = buildPublicReferencePairAudit({ matches, archive:buildPublicReferenceArchive(snapshotPayload), trustRegistry, generatedAt, startDate });
  return composeReferencePerformance(summary, audit.rows);
}
function composeReferencePerformance(summary, rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = identity(row), c = groups.get(key) || {date:row.date,market:row.market,versionKey:row.versionKey,...empty()};
    c.settledReferenceEvents++;
    if (!row.eligible) c.excluded++;
    else {
      const p = row.pair; c.paired++; c.publishedWon += Number(p.publishedWon); c.baselineWon += Number(p.baselineWon); c.tiedBaselineOdds += Number(p.tie);
      c[p.publishedWon ? p.baselineWon ? "bothWon" : "publicOnly" : p.baselineWon ? "baselineOnly" : "bothLost"]++;
    }
    groups.set(key,c);
  }
  const pairedBaseline = compactReferencePairedBaseline(envelope(summary,[...groups.values()]),summary);
  if (!pairedBaseline) throw new Error("Paired public baseline does not reconcile to original complete history");
  return {...summary,pairedBaseline};
}

// Same complete-ledger checks and per-copy pairing as the in-memory path, but
// release each large feature/model evidence object immediately after auditing.
function buildReferencePerformanceFromSnapshotFile({matches,filePath,trustRegistry,generatedAt,startDate}={}) {
  const fs=require('node:fs');
  try { fs.lstatSync(filePath); } catch(error) { if(error.code==='ENOENT') return buildReferencePerformanceWithPairs({matches,snapshotPayload:{},trustRegistry,generatedAt,startDate}); throw error; }
  const {streamJsonObjectArrays}=require('./streamedJsonObjectArrays.cjs');
  const {attestPublicReferenceDecision}=require('../src/services/publicReferenceDecision.cjs');
  const {digest,verifyPublicReferenceEvidence}=require('../src/services/publicReferenceEvidence.cjs');
  const {auditFrozenReferenceMarket,isFrozenPairClock}=require('../src/services/frozenReferenceMarketPair.cjs');
  const {buildReferenceReviewPerformance,compactReferenceReviewPerformance,matchIdentity,businessDateForMatch}=require('./reviewPerformanceSummary.cjs');
  if(!Array.isArray(matches)||!isFrozenPairClock(generatedAt))throw new Error('Explicit complete history and audit clock required');
  const summary=compactReferenceReviewPerformance(buildReferenceReviewPerformance({matches,generatedAt,startDate}));
  if(!summary)throw new Error('Complete reference history failed validation before pairing');
  const records=new Map();let recordChars=0;
  const first=streamJsonObjectArrays(filePath,{keys:['publicReferenceDecisions'],allowNonArrays:true,onItem:(_key,record)=>{
    if(!record||typeof record.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(record.contentHash)||records.has(record.contentHash)||!attestPublicReferenceDecision(record,record))throw new Error('REFERENCE_INDEX_RECORD_INVALID');
    recordChars+=JSON.stringify(record).length;
    if(recordChars>32*1024*1024||records.size>=100000)throw new Error('REFERENCE_DECISION_INDEX_LIMIT');
    records.set(record.contentHash,record);
  }});
  const byEvent=new Map(),byReference=new Map(),results=new Map();
  const referenceHash=match=>match?.postMatchReview?.predictionReview?.rows?.find(row=>row.marketType==='BEST'&&row.performanceTrack==='reference')?.frozenVersion?.referenceHash;
  for(const match of matches){const identity=matchIdentity(match);if(identity){const copies=byEvent.get(identity)||[];copies.push(match);byEvent.set(identity,copies);}const hash=referenceHash(match),copies=byReference.get(hash)||[];copies.push(match);byReference.set(hash,copies);}
  const seenEvidence=new Map();
  streamJsonObjectArrays(filePath,{keys:['publicReferenceEvidence'],allowNonArrays:true,expectedBytes:first.bytes,expectedSha256:first.sha256,onItem:(_key,entry)=>{
    const record=records.get(entry?.referenceHash);if(!record)return; // Original retention ignores raw orphan entries.
    if(!verifyPublicReferenceEvidence(entry,record))throw new Error('PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID');
    const entryHash=digest(entry),previous=seenEvidence.get(entry.referenceHash);
    if(previous&&previous!==entryHash)throw new Error('PUBLIC_REFERENCE_EVIDENCE_BINDING_CONFLICT');
    if(previous)return;
    seenEvidence.set(entry.referenceHash,entryHash);
    for(const match of byReference.get(entry.referenceHash)||[])results.set(match,auditFrozenReferenceMarket({match,record,entry,trustRegistry,auditAt:generatedAt}));
  }});
  // Never publish partial totals if an unrelated bound record has lost evidence.
  for(const record of records.values())if(record.evidenceBinding&&!seenEvidence.has(record.contentHash))throw new Error('PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING');
  const rows=[];
  for(const copies of byEvent.values()){
    const cohort=buildReferenceReviewPerformance({matches:copies,generatedAt,startDate});if(!cohort.cumulative.settled)continue;
    const audits=copies.map(match=>results.get(match)||auditFrozenReferenceMarket({match,record:records.get(referenceHash(match)),trustRegistry,auditAt:generatedAt}));
    const eligible=audits.every(audit=>audit.eligible)&&new Set(audits.filter(audit=>audit.eligible).map(audit=>audit.contentHash)).size<=1;
    const market=['HAD','HHAD','UNKNOWN'].find(pool=>cohort.marketBreakdown[pool].cumulative.settled===1);
    const versionKey=cohort.versionBreakdown.groups.length===1?cohort.versionBreakdown.groups[0].key:'UNKNOWN';
    rows.push({date:businessDateForMatch(copies[0]),market,versionKey,eligible,...(eligible?{pair:audits[0]}:{})});
  }
  if(rows.length!==summary.cumulative.settled)throw new Error('Paired cohort does not reconcile to complete reference history');
  return composeReferencePerformance(summary,rows);
}
// The slow-result reconciliation runs after the main sync and must regenerate
// pairs from the original ledger too. Stream the unrelated, very large candidate
// array instead of retaining it alongside the complete historical match list.
function readReferenceSnapshotFile(filePath) {
  const fs = require("node:fs"), crypto = require("node:crypto");
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 * 1024) throw new Error("Reference snapshot is not a bounded regular file");
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(filePath, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Reference snapshot changed before hashing");
    let bytes, total = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += bytes;
      if (total > stat.size) throw new Error("Reference snapshot grew during bounded hashing");
      hash.update(buffer.subarray(0, bytes));
    }
    if (total !== stat.size) throw new Error("Reference snapshot shrank during hashing");
  }
  finally { fs.closeSync(fd); }
  return require("./selectedJsonObjectFile.cjs").readSelectedJsonObjectFile({ filePath, expectedBytes: stat.size,
    // The verified live reference ledger exceeds 64 MiB even after removing
    // formatting whitespace. Use the reader's bounded 128 MiB admission limit;
    // unrelated candidate data is still streamed and never materialized.
    expectedSha256: hash.digest("hex"), keys: ["publicReferenceDecisions", "publicReferenceEvidence"], maxSelectedChars: 128 * 1024 * 1024 }).value;
}
module.exports = { VERSION, POLICY, FIELDS, compactReferencePairedBaseline, buildReferencePerformanceWithPairs, buildReferencePerformanceFromSnapshotFile, readReferenceSnapshotFile };
