"use strict";

const FORMAL_REVIEW_PERFORMANCE_VERSION = "formal-review-performance-v1";
const REFERENCE_REVIEW_PERFORMANCE_VERSION = "reference-review-performance-v1";
const FORMAL_REVIEW_PERFORMANCE_START_DATE = "2026-08-16";
const REVIEW_IDENTITY_VERSION = "review-event-identity-v2";

const asText = (value) => typeof value === "string" ? value.trim() : "";
const validDate = (value) => {
  const date = asText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const ms = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : "";
};

const businessDateForMatch = (match) => {
  const explicit = match?.businessDate ?? match?.matchDate ?? match?.kickoffDate;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return validDate(asText(explicit).slice(0, 10));
  }
  const kickoffMs = Date.parse(asText(match?.kickoffTime));
  if (!Number.isFinite(kickoffMs)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(kickoffMs));
};

// Never stringify malformed legacy identities to "[object Object]" or merge
// unrelated provider IDs by stripping an arbitrary prefix. Only the known
// Sporttery / fivehundred numeric aliases are equivalent to their positive
// official source ID only when both suffixes agree with that explicit ID.
const identityPart = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  const text = asText(value);
  if (!text || text.length > 160 || /^(?:null|undefined|nan|infinity|true|false)$/i.test(text)) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(text)) return "";
  if (/^\d+$/.test(text) && !/^[1-9]\d*$/.test(text)) return "";
  if (/^[0-9]/.test(text) && Number.isFinite(Number(text)) && !/^[1-9]\d*$/.test(text)) return "";
  if (/^(?:sporttery|fivehundred)_\d+$/.test(text) && !/^(?:sporttery|fivehundred)_[1-9]\d*$/.test(text)) return "";
  return text;
};
const officialSourceId = (value) => /^[1-9]\d*$/.test(value)
  ? value
  : /^(?:sporttery|fivehundred)_([1-9]\d*)$/.exec(value)?.[1] || "";

const matchIdentity = (match) => {
  const date = businessDateForMatch(match);
  if (!date) return "";
  const hasSource = match?.sourceMatchId !== undefined && match?.sourceMatchId !== null && match?.sourceMatchId !== "";
  const source = hasSource ? identityPart(match.sourceMatchId) : "";
  const id = identityPart(match?.id);
  if ((hasSource && !source) || (!source && !id)) return "";
  const sourceNumber = officialSourceId(source);
  const idNumber = officialSourceId(id);
  if (sourceNumber && idNumber && sourceNumber !== idNumber) return "";
  if (sourceNumber && id && !idNumber) return JSON.stringify(["scoped-source", id, sourceNumber, date]);
  const canonical = sourceNumber || (!source && idNumber);
  return JSON.stringify([canonical ? "sporttery" : source ? "source" : "id", canonical || source || id, date]);
};

const eventBinding = (match) => {
  const knownTimes = new Set([match?.kickoffTime, match?.eventVersion, match?.postMatchReview?.eventVersion]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => Date.parse(value))
    .filter(Number.isFinite));
  return { knownEventTime: [...knownTimes][0] ?? null, conflict: knownTimes.size > 1 };
};

const settlementForTrack = (match, track) => {
  const review = match?.postMatchReview?.predictionReview;
  const candidates = (Array.isArray(review?.rows) ? review.rows : []).filter((row) => (
    row?.marketType === "BEST"
    && row?.performanceTrack === track
    && row?.recommendationAction === (track === "formal" ? "recommend" : "reference")
    && row?.reviewRole === (track === "formal" ? "main" : "reference")
  ));
  if (!candidates.length) return null;
  if (match?.resultDisposition === "VOID" || candidates.some((row) => row.resultStatus === "VOID")) return { conflict: true };
  const rows = candidates.filter((row) => ["WON", "LOST"].includes(row.resultStatus));
  if (!rows.length) return null;
  const fingerprints = new Set(rows.map((row) => JSON.stringify([
    row.resultStatus, row.oddsPoolCode ?? null, row.tipCode ?? null,
    row.handicapLine === undefined || row.handicapLine === null || row.handicapLine === ""
      ? null : String(row.handicapLine),
  ])));
  // More than one frozen BEST selection is ambiguous; never select the first
  // win or loss simply because array ordering changed.
  if (fingerprints.size !== 1) return { conflict: true };
  const status = rows[0].resultStatus;
  if (track === "formal" && review.formalBestStatus !== status) return { conflict: true };
  return { status, fingerprint: [...fingerprints][0] };
};

const formalBestSettlement = (match) => settlementForTrack(match, "formal")?.status || null;
const referenceBestSettlement = (match) => settlementForTrack(match, "reference")?.status || null;
const emptyBucket = (date) => ({ date, won: 0, lost: 0, settled: 0, hitRate: null });
const finalizeBucket = (bucket) => ({
  ...bucket, hitRate: bucket.settled > 0 ? bucket.won / bucket.settled : null,
});
const policyFor = (track) => ({
  denominator: "one frozen " + track + " BEST recommendation per officially settled match",
  includedStatuses: ["WON", "LOST"],
  excludedTracks: track === "formal"
    ? ["reference", "live-model", "shadow", "post-match-reconstructed"]
    : ["formal", "live-model", "shadow", "shadow-provisional", "post-match-reconstructed"],
  immutableRecommendationRequired: true,
  sourceScope: "server-complete-history",
  unit: "match-best",
  identityVersion: REVIEW_IDENTITY_VERSION,
  conflictingEvents: "excluded-fail-closed",
});

const buildReviewPerformance = ({
  matches = [], startDate = FORMAL_REVIEW_PERFORMANCE_START_DATE,
  generatedAt = new Date().toISOString(),
} = {}, track) => {
  const normalizedStartDate = validDate(startDate) || FORMAL_REVIEW_PERFORMANCE_START_DATE;
  const events = new Map();
  const excluded = { beforeStart: 0, invalidDate: 0, invalidIdentity: 0, duplicateEvent: 0, conflictingEvent: 0 };
  const missingKey = track === "formal" ? "withoutFrozenFormalSettlement" : "withoutFrozenReferenceSettlement";
  excluded[missingKey] = 0;
  for (const match of Array.isArray(matches) ? matches : []) {
    const date = businessDateForMatch(match);
    if (!date) { excluded.invalidDate += 1; continue; }
    if (date < normalizedStartDate) { excluded.beforeStart += 1; continue; }
    const settlement = settlementForTrack(match, track);
    if (!settlement) { excluded[missingKey] += 1; continue; }
    const identity = matchIdentity(match);
    if (!identity) { excluded.invalidIdentity += 1; continue; }
    const binding = eventBinding(match);
    const incoming = { ...settlement, ...binding, conflict: settlement.conflict || binding.conflict, date };
    const previous = events.get(identity);
    if (previous) {
      excluded.duplicateEvent += 1;
      if (incoming.conflict || incoming.fingerprint !== previous.fingerprint
        || (previous.knownEventTime !== null && binding.knownEventTime !== null
          && previous.knownEventTime !== binding.knownEventTime)) previous.conflict = true;
      if (previous.knownEventTime === null) previous.knownEventTime = binding.knownEventTime;
    } else events.set(identity, incoming);
  }
  const byDate = new Map();
  for (const event of events.values()) {
    if (event.conflict) { excluded.conflictingEvent += 1; continue; }
    const bucket = byDate.get(event.date) || emptyBucket(event.date);
    bucket.settled += 1;
    if (event.status === "WON") bucket.won += 1;
    else bucket.lost += 1;
    byDate.set(event.date, bucket);
  }
  const daily = [...byDate.values()].map(finalizeBucket).sort((a, b) => a.date.localeCompare(b.date));
  const cumulative = finalizeBucket(daily.reduce((total, row) => ({
    date: null, won: total.won + row.won, lost: total.lost + row.lost,
    settled: total.settled + row.settled, hitRate: null,
  }), emptyBucket(null)));
  return {
    version: track === "formal" ? FORMAL_REVIEW_PERFORMANCE_VERSION : REFERENCE_REVIEW_PERFORMANCE_VERSION,
    generatedAt, startDate: normalizedStartDate, timezone: "Asia/Shanghai",
    cumulative, daily, exclusions: excluded, policy: policyFor(track),
  };
};

const buildFormalReviewPerformance = (options) => buildReviewPerformance(options, "formal");
const buildReferenceReviewPerformance = (options) => buildReviewPerformance(options, "reference");

const compactReviewPerformance = (value, track) => {
  const version = track === "formal" ? FORMAL_REVIEW_PERFORMANCE_VERSION : REFERENCE_REVIEW_PERFORMANCE_VERSION;
  if (value?.version !== version) return null;
  if (track === "reference" && (value.policy?.sourceScope !== "server-complete-history"
    || value.policy?.identityVersion !== REVIEW_IDENTITY_VERSION || value.policy?.unit !== "match-best")) return null;
  const startDate = validDate(value.startDate);
  if (!startDate || !Array.isArray(value.daily)) return null;
  const compactBucket = (bucket, includeDate = false) => {
    const { won, lost, settled } = bucket || {};
    if (![won, lost, settled].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    if (won + lost !== settled) return null;
    const date = includeDate ? validDate(bucket?.date) : undefined;
    if (includeDate && (!date || date < startDate)) return null;
    return { ...(includeDate ? { date } : {}), won, lost, settled, hitRate: settled > 0 ? won / settled : null };
  };
  const cumulative = compactBucket(value.cumulative);
  const daily = value.daily.map((row) => compactBucket(row, true));
  if (!cumulative || daily.some((row) => !row)) return null;
  if (new Set(daily.map((row) => row.date)).size !== daily.length) return null;
  if (["won", "lost", "settled"].some((key) => daily.reduce((sum, row) => sum + row[key], 0) !== cumulative[key])) return null;
  return {
    version, generatedAt: value.generatedAt || null, startDate, timezone: "Asia/Shanghai",
    cumulative, daily: daily.sort((a, b) => a.date.localeCompare(b.date)),
    exclusions: Object.fromEntries(Object.entries(value.exclusions || {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 0)),
    policy: { ...policyFor(track), identityVersion: value.policy?.identityVersion || "legacy-review-event-identity-v1" },
  };
};

const compactFormalReviewPerformance = (value) => compactReviewPerformance(value, "formal");
const compactReferenceReviewPerformance = (value) => compactReviewPerformance(value, "reference");

module.exports = {
  FORMAL_REVIEW_PERFORMANCE_START_DATE, FORMAL_REVIEW_PERFORMANCE_VERSION,
  REFERENCE_REVIEW_PERFORMANCE_VERSION, REVIEW_IDENTITY_VERSION,
  buildFormalReviewPerformance, buildReferenceReviewPerformance, businessDateForMatch,
  compactFormalReviewPerformance, compactReferenceReviewPerformance,
  formalBestSettlement, referenceBestSettlement, matchIdentity,
};
