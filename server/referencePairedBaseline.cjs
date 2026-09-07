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
  const groups = new Map();
  for (const row of audit.rows) {
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
    expectedSha256: hash.digest("hex"), keys: ["publicReferenceDecisions", "publicReferenceEvidence"], maxSelectedChars: 64 * 1024 * 1024 }).value;
}
module.exports = { VERSION, POLICY, FIELDS, compactReferencePairedBaseline, buildReferencePerformanceWithPairs, readReferenceSnapshotFile };
