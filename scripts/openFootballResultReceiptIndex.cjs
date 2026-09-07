"use strict";

// Explicit read-only research replay. Local reception is not official result
// attestation, entity approval, kickoff evidence or admission to a model.
const crypto = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { inspectSource } = require("./auditOpenFootballCurrentSeason.cjs");
const { readAuditedObservationStore } = require("./openFootballObservationStore.cjs");
const VERSION = "openfootball-result-receipt-index-v1";
const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
const MAX_REVISIONS = 50000;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function buildResultReceiptIndex({ storeDir, asOf }) {
  if (!strictInstant(asOf)) throw new Error("Explicit valid as-of clock required");
  const cutoff = new Date(asOf).toISOString();
  return readAuditedObservationStore(storeDir, (db, audit) => {
    const events = new Map(), lastBySource = new Map();
    let replayBytes = 0, receiptCount = 0, revisionCount = 0, replayHead = null;
    const contentQuery = db.prepare("SELECT raw FROM source_contents WHERE source_url=? AND content_hash=?");
    for (const stored of db.prepare("SELECT * FROM observations WHERE received_at<=? ORDER BY sequence").iterate(cutoff)) {
      const receipt = JSON.parse(stored.receipt_json);
      const raw = Buffer.from(contentQuery.get(stored.source_url, stored.content_hash).raw);
      replayBytes += raw.length;
      if (replayBytes > MAX_REPLAY_BYTES) throw new Error("Result receipt replay capacity exceeded; retain source evidence");
      // Crucially use THIS receipt's real clock, never content.firstObservedAt
      // or the query's later cutoff to reclassify early future/same-day scores.
      const source = inspectSource(raw, { season: receipt.season, league: receipt.league, receivedAt: receipt.receivedAt });
      if (source.candidateRows !== receipt.candidateRows) throw new Error("Receipt candidate count failed replay");
      const present = new Set();
      for (const candidate of source.candidates) {
        const key = candidate.sourceEventId;
        present.add(key);
        let event = events.get(key);
        if (!event) {
          event = { sourceEventId: key, sourceUrl: receipt.sourceUrl, league: receipt.league, season: receipt.season,
            date: candidate.date, homeTeamRaw: candidate.homeTeamRaw, awayTeamRaw: candidate.awayTeamRaw,
            firstQualifyingReceiptAt: receipt.receivedAt, revisions: new Map() };
          events.set(key, event);
        }
        // Non-score upstream metadata changes do not create a different result;
        // every selected observation still binds the exact raw row and file.
        const revisionKey = hash([key, candidate.scoreHome, candidate.scoreAway]);
        let revision = event.revisions.get(revisionKey);
        const proof = { receiptHash: stored.receipt_hash, sequence: stored.sequence,
          contentSha256: stored.content_hash, rawRowSha256: candidate.rawRowSha256, receivedAt: receipt.receivedAt };
        if (!revision) {
          if (++revisionCount > MAX_REVISIONS) throw new Error("Result revision capacity exceeded; retain source evidence");
          revision = { resultRevisionId: revisionKey, scoreHome: candidate.scoreHome, scoreAway: candidate.scoreAway,
            firstQualifyingReceiptAt: receipt.receivedAt, firstReceipt: proof, lastReceipt: proof, observations: 0 };
          event.revisions.set(revisionKey, revision);
        }
        revision.lastReceipt = proof;
        revision.observations++;
      }
      lastBySource.set(receipt.sourceUrl, { present, receivedAt: receipt.receivedAt, receiptHash: stored.receipt_hash });
      replayHead = stored.receipt_hash;
      receiptCount++;
    }
    const rows = [...events.values()].sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId)).map(event => {
      const latest = lastBySource.get(event.sourceUrl);
      const revisions = [...event.revisions.values()];
      const latestSourceContainsCandidate = latest.present.has(event.sourceEventId);
      const conflicts = revisions.length > 1;
      return { ...event, revisions, latestSourceContainsCandidate,
        latestSourceReceivedAt: latest.receivedAt, latestSourceReceiptHash: latest.receiptHash,
        researchStatus: conflicts ? "conflicting-results" : latestSourceContainsCandidate ? "observed-unverified" : "withdrawn-or-quarantined",
        resultObservedAt: !conflicts && latestSourceContainsCandidate ? event.firstQualifyingReceiptAt : null,
        sourceVerified: false, entityMappingStatus: "unverified", kickoff: null, upstreamPublishedAt: null,
        productionEligible: false, officialSettlementAllowed: false };
    });
    const body = { version: VERSION, scope: "local-research-result-receipts-only", asOf: cutoff,
      replayHead, replayedReceipts: receiptCount, rows,
      counts: { events: rows.length, revisions: revisionCount,
        observedUnverified: rows.filter(r => r.researchStatus === "observed-unverified").length,
        conflicting: rows.filter(r => r.researchStatus === "conflicting-results").length,
        withdrawnOrQuarantined: rows.filter(r => r.researchStatus === "withdrawn-or-quarantined").length },
      productionAdmittedRows: 0, predictionWrites: 0, officialResultWrites: 0 };
    // Full-store audit can see later receipts; it is deliberately outside the
    // as-of index digest. Appending future data cannot change a past index.
    return { ...body, indexHash: hash(body), storeAudit: audit, replayBytes, writes: 0, providerRequests: 0 };
  });
}

if (require.main === module) {
  const [storeDir, asOf, ...rest] = process.argv.slice(2);
  try {
    if (!storeDir || !asOf || rest.length) throw new Error("Usage: node scripts/openFootballResultReceiptIndex.cjs <absolute-private-directory> <as-of-ISO>");
    console.log(JSON.stringify(buildResultReceiptIndex({ storeDir, asOf }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { VERSION, MAX_REPLAY_BYTES, MAX_REVISIONS, buildResultReceiptIndex };
