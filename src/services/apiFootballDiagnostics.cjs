"use strict";
const { strictInstant } = require("./strictInstant.cjs");
const VERSION = "api-football-collector-diagnostics-v1";
const KEYS = ["injuries", "lineups", "apiFootballOdds"];
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const id = value => (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  || (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) ? String(value) : null;
const allowed = (value, values, fallback) => values.includes(value) ? value : fallback;
const states = ["not-received", "clock-rejected", "receipt-recorded", "legacy-unverified"];
const sourceStates = ["missing", "recorded", "invalid", "after-receipt", "unverified"];

// Public, bounded diagnostics only. No private errors, queries, keys, raw
// provider payloads or outcome direction enter this projection.
function compactApiFootballDiagnostics(signals) {
  if (!object(signals)) return null;
  const api = object(signals.apiFootball);
  const prior = object(signals.apiFootballDiagnostics);
  if (!api && prior?.version === VERSION && prior.scope === "collector-only-not-frozen-decision") {
    return {
      version: VERSION, scope: "collector-only-not-frozen-decision", provider: "api-football",
      fixtureId: id(prior.fixtureId), checkedAt: strictInstant(prior.checkedAt),
      mappingStatus: prior.mappingStatus === "recorded" && (!id(prior.fixtureId) || !strictInstant(prior.checkedAt))
        ? "unverified" : allowed(prior.mappingStatus, ["recorded", "unverified", "conflicting"], "unverified"),
      features: KEYS.map(key => {
        const row = Array.isArray(prior.features) ? prior.features.find(item => object(item)?.key === key) : null;
        const receipt = strictInstant(row?.receivedAt);
        const state = allowed(row?.state, states, "not-received");
        return { key, state: state === "receipt-recorded" && !receipt ? "legacy-unverified" : state,
          receivedAt: receipt, sourceUpdatedAt: strictInstant(row?.sourceUpdatedAt),
          sourceTimeStatus: allowed(row?.sourceTimeStatus, sourceStates, "unverified") };
      }),
    };
  }
  if (!api) return null;
  const fixtureId = id(api.fixtureId), checkedAt = strictInstant(api.lastCheckedAt);
  const blockers = Array.isArray(api.verificationBlockers) ? api.verificationBlockers.slice(0, 20) : [];
  const rejections = Array.isArray(api.temporalRejections) ? api.temporalRejections.slice(0, 12) : [];
  return {
    version: VERSION, scope: "collector-only-not-frozen-decision", provider: "api-football", fixtureId, checkedAt,
    mappingStatus: blockers.some(value => typeof value === "string" && /conflict|reversed/.test(value))
      ? "conflicting" : api.mappingVerified === true && fixtureId && checkedAt ? "recorded" : "unverified",
    features: KEYS.map(key => {
      const piece = object(key === "apiFootballOdds" ? signals.bookmakerOdds?.apiFootball : signals[key]);
      const ours = piece && typeof piece.source === "string" && /^api-football(?::|$)/i.test(piece.source);
      const rejected = rejections.includes(`${key}:clock-evidence-not-verifiable`);
      if (!ours) return { key, state: rejected ? "clock-rejected" : "not-received", receivedAt: null,
        sourceUpdatedAt: null, sourceTimeStatus: "missing" };
      const receivedAt = strictInstant(piece.observedAt), sourceUpdatedAt = strictInstant(piece.sourceUpdatedAt);
      const cutoff = strictInstant(piece.temporalEligibility?.cutoff);
      const v2 = piece.clockEvidence?.version === "api-football-clock-evidence-v2";
      const sourceTimeStatus = !v2 ? "unverified" : piece.sourceUpdatedAt == null ? "missing"
        : !sourceUpdatedAt ? "invalid" : receivedAt && Date.parse(sourceUpdatedAt) > Date.parse(receivedAt) ? "after-receipt" : "recorded";
      const timeConsistent = v2 && receivedAt && cutoff && Date.parse(receivedAt) <= Date.parse(cutoff)
        && piece.temporalEligibility?.eligible === true && piece.temporalEligibility.fetchedAt === receivedAt
        && piece.provenance?.fetchedAt === receivedAt && piece.provenance?.sourceUpdatedAt === piece.sourceUpdatedAt
        && piece.clockEvidence.sourceTimeStatus === sourceTimeStatus
        && !["invalid", "after-receipt"].includes(sourceTimeStatus);
      return { key, state: rejected ? "clock-rejected" : !v2 ? "legacy-unverified" : timeConsistent ? "receipt-recorded" : "clock-rejected",
        receivedAt, sourceUpdatedAt, sourceTimeStatus };
    }),
  };
}
module.exports = { compactApiFootballDiagnostics };
