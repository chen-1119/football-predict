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
const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && strictInstant(`${value}T00:00:00Z`) ? value : null;

function buildFixtureAccessDiagnostic(access, requestedDate, checkedAt, refreshMinutes = 120) {
  if (!object(access)) return null;
  const date = day(requestedDate), checked = strictInstant(checkedAt), recorded = strictInstant(access.updatedAt);
  const from = day(access.allowedFrom), to = day(access.allowedTo);
  const ttlValid = Number.isFinite(refreshMinutes) && refreshMinutes >= 30 && refreshMinutes <= 1440;
  const clocksValid = checked && recorded && Date.parse(recorded) <= Date.parse(checked) && ttlValid;
  const rangeValid = from && to && from <= to;
  const state = !date || !clocksValid ? "invalid-record"
    : Date.parse(checked) - Date.parse(recorded) > refreshMinutes * 60000 ? "stale-record"
      : access.suspended === true ? "account-restricted"
        : !rangeValid ? "invalid-record"
          : date < from || date > to ? "outside-recorded-window" : "within-recorded-window";
  return { version: "api-football-fixture-access-diagnostic-v1", state,
    requestedDate: date, allowedFrom: from, allowedTo: to, checkedAt: checked,
    restrictionRecordedAt: recorded, refreshMinutes: ttlValid ? refreshMinutes : null,
    suspended: access.suspended === true };
}
function compactFixtureAccess(value) {
  if (!object(value) || value.version !== "api-football-fixture-access-diagnostic-v1") return null;
  // Recompute state from bounded fields; never trust a supplied 'allowed' or
  // 'restricted' label, raw provider error, or missing observation clock.
  return buildFixtureAccessDiagnostic({ updatedAt: value.restrictionRecordedAt, allowedFrom: value.allowedFrom,
    allowedTo: value.allowedTo, suspended: value.suspended }, value.requestedDate, value.checkedAt, value.refreshMinutes);
}

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
      fixtureAccess: compactFixtureAccess(prior.fixtureAccess),
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
    fixtureAccess: compactFixtureAccess(api.fixtureAccess),
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
module.exports = { compactApiFootballDiagnostics, buildFixtureAccessDiagnostic };
