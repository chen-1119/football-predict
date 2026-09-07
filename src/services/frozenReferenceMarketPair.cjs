"use strict";

const { attestPublicReferenceDecision } = require("./publicReferenceDecision.cjs");
const { digest, verifyPublicReferenceEvidence } = require("./publicReferenceEvidence.cjs");
const { resolveFrozenReviewVersion } = require("./frozenReviewVersion.cjs");
const { isStrictMarketSourceProvenance, normalizeMarketSourceProvenance } = require("./marketSourceProvenance.cjs");
const { isTrustedOfficialFinal } = require("./matchLifecycle.cjs");
const VERSION = "frozen-reference-market-pair-v1";
const CODES = ["1", "X", "2"];
const clock = value => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === value.slice(0, 10);
const odds = value => value && CODES.every((code, i) => typeof value[["odds1", "oddsX", "odds2"][i]] === "number"
  && Number.isFinite(value[["odds1", "oddsX", "odds2"][i]]) && value[["odds1", "oddsX", "odds2"][i]] > 1)
  ? Object.fromEntries(CODES.map((code, i) => [code, value[["odds1", "oddsX", "odds2"][i]]])) : null;
const reject = (reason, detail = []) => ({ version: VERSION, eligible: false, reason, detail: [...new Set(detail)].sort() });

/** Recheck the original ledger entry, exact frozen selection, signed extraction
 * and pre-decision clocks. This is a private paired HIT diagnostic, not source
 * independence, raw response rehash, probability calibration, or admission.
 * Never use mutable top-level odds/model inputs to fill missing old evidence.
 */
function auditFrozenDecisionMarket({ match, record, entry, trustRegistry = null } = {}) {
  if (!record || !attestPublicReferenceDecision(record, match)) return reject("original-public-record-missing-or-invalid");
  if (!verifyPublicReferenceEvidence(entry, record)) return reject("original-public-evidence-missing-or-invalid");
  const row = record.prediction, trace = record.evidenceBinding;
  const e = entry.evidence, feature = e.featureSnapshot;
  if (feature.sourceMatchId !== record.sourceMatchId || !clock(feature.kickoffTime)
    || Date.parse(feature.kickoffTime) !== Date.parse(record.kickoffTime)) return reject("frozen-feature-event-mismatch");
  const pool = row.oddsPoolCode, market = feature.market?.[pool === "HAD" ? "had" : "hhad"];
  if (!market) return reject("frozen-market-missing");
  const frozenOdds = odds(market.odds);
  if (!frozenOdds) return reject("frozen-market-odds-invalid");
  const line = pool === "HAD" ? 0 : Number(market.handicapLine);
  if (pool === "HHAD" && (market.handicapLine == null || market.handicapLine === "" || !Number.isSafeInteger(line))) return reject("frozen-market-line-invalid");
  if ((pool === "HHAD" && line !== Number(row.handicapLine)) || frozenOdds[row.tipCode] !== row.odds) return reject("frozen-selection-quote-mismatch");
  const raw = market.provenance;
  if (!raw) return reject("frozen-market-provenance-missing");
  const provenance = normalizeMarketSourceProvenance(raw, { trustRegistry });
  if (!isStrictMarketSourceProvenance(raw, { trustRegistry })) return reject("frozen-market-provenance-invalid", provenance?.strict?.blockers);
  if (market.provenanceHash !== provenance.hash || provenance.market.sourceMatchId !== record.sourceMatchId
    || provenance.market.poolCode !== pool || (pool === "HHAD" && Number(provenance.extraction.handicapLine) !== line)
    || CODES.some(code => provenance.extraction.odds?.[code] !== frozenOdds[code])) return reject("signed-extraction-quote-mismatch");
  const times = [provenance.timing.requestedAt, provenance.timing.providerObservedAt, provenance.timing.receivedAt,
    market.observedAt, market.receivedAt, feature.capturedAt, record.decisionAt, record.recordedAt, record.cutoffTime, record.kickoffTime];
  if (!times.every(clock)) return reject("frozen-market-clock-invalid");
  if (Date.parse(market.observedAt) !== Date.parse(provenance.timing.providerObservedAt)
    || Date.parse(market.receivedAt) !== Date.parse(provenance.timing.receivedAt)) return reject("frozen-market-clock-binding-mismatch");
  const received = Date.parse(market.receivedAt), observed = Date.parse(market.observedAt), captured = Date.parse(feature.capturedAt);
  if (observed > received || received > captured || captured > Date.parse(record.decisionAt)
    || Date.parse(record.decisionAt) > Date.parse(record.recordedAt)
    || Date.parse(record.recordedAt) >= Date.parse(record.cutoffTime) || Date.parse(record.cutoffTime) > Date.parse(record.kickoffTime)) return reject("frozen-market-not-available-at-decision");
  const inverse = CODES.map(code => 1 / frozenOdds[code]), total = inverse.reduce((n, p) => n + p, 0);
  const probabilities = Object.fromEntries(CODES.map((code, i) => [code, inverse[i] / total]));
  const maximum = Math.max(...inverse), tied = CODES.filter((code, i) => inverse[i] === maximum);
  // Fixed before outcomes: 1, X, 2 for exact equal odds. Report ties separately.
  const baselineCode = tied[0];
  const body = { version: "frozen-decision-market-audit-v1", referenceHash: record.contentHash, evidenceHash: entry.evidenceHash,
    featureHash: trace.featureHash, modelHash: trace.modelHash, modelVersion: trace.modelVersion, policyVersion: trace.policyVersion,
    market: pool, line, decisionAt: record.decisionAt, receivedAt: market.receivedAt, observedAt: market.observedAt,
    provenanceHash: provenance.hash, collectorKeyId: provenance.strict.collectorAttestationKeyId,
    quote: frozenOdds, probabilities, publicCode: row.tipCode, baselineCode, tie: tied.length > 1 };
  return { ...body, eligible: true, contentHash: digest(body), reason: null,
    trustBoundary: "trusted-collector-signed-commitment-raw-response-not-rehashed" };
}

function auditFrozenReferenceMarket({ match, record, entry, trustRegistry = null, auditAt } = {}) {
  const rows = match?.postMatchReview?.predictionReview?.rows;
  const best = (Array.isArray(rows) ? rows : []).filter(row => row?.marketType === "BEST"
    && row.performanceTrack === "reference" && row.reviewRole === "reference" && row.recommendationAction === "reference"
    && ["WON", "LOST"].includes(row.resultStatus));
  if (!best.length) return reject("frozen-reference-settlement-missing");
  const traces = best.map(row => resolveFrozenReviewVersion(match, row));
  if (traces.some(trace => !trace)) return reject("frozen-reference-version-untraced");
  if (traces.some(trace => trace.contentHash !== traces[0].contentHash)
    || best.some(row => row.resultStatus !== best[0].resultStatus)) return reject("frozen-reference-selection-conflict");
  if (!record || record.contentHash !== traces[0].referenceHash) return reject("original-public-record-missing-or-invalid");
  const market = auditFrozenDecisionMarket({ match, record, entry, trustRegistry });
  if (!market.eligible) return market;
  if (!isTrustedOfficialFinal(match) || match.resultDisposition === "VOID"
    || ![match.scoreHome, match.scoreAway].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return reject("trusted-final-score-missing");
  if (!clock(auditAt) || Date.parse(auditAt) < Date.parse(record.kickoffTime)) return reject("audit-before-kickoff-or-invalid");
  // Integer Sporttery HHAD only. Other handicap settlement rules need their own contract.
  const difference = match.scoreHome + market.line - match.scoreAway;
  const actual = difference > 0 ? "1" : difference < 0 ? "2" : "X";
  const publishedWon = market.publicCode === actual;
  if (publishedWon !== (best[0].resultStatus === "WON")) return reject("frozen-settlement-score-conflict");
  const { eligible, contentHash, reason, trustBoundary, ...quote } = market;
  const body = { ...quote, version: VERSION, marketAuditHash: contentHash,
    actual, publishedWon, baselineWon: market.baselineCode === actual };
  return { ...body, eligible: true, contentHash: digest(body), reason: null, trustBoundary };
}
module.exports = { VERSION, auditFrozenDecisionMarket, auditFrozenReferenceMarket, isFrozenPairClock: clock };
