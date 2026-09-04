"use strict";

const FORMAL_REVIEW_PERFORMANCE_VERSION = "formal-review-performance-v1";
const FORMAL_REVIEW_PERFORMANCE_START_DATE = "2026-08-16";

const asText = (value) => String(value || "").trim();

const businessDateForMatch = (match) => {
  const explicit = asText(match?.businessDate || match?.matchDate || match?.kickoffDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  if (!Number.isFinite(kickoffMs)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(kickoffMs));
};

const formalBestSettlement = (match) => {
  const review = match?.postMatchReview;
  const rows = Array.isArray(review?.predictionReview?.rows)
    ? review.predictionReview.rows
    : [];
  const formalRow = rows.find((row) => (
    row?.marketType === "BEST"
    && row?.performanceTrack === "formal"
    && row?.recommendationAction === "recommend"
    && row?.reviewRole === "main"
    && ["WON", "LOST"].includes(row?.resultStatus)
  ));
  if (!formalRow) return null;
  const summaryStatus = review?.predictionReview?.formalBestStatus;
  if (!["WON", "LOST"].includes(summaryStatus) || summaryStatus !== formalRow.resultStatus) return null;
  return formalRow.resultStatus;
};

const matchIdentity = (match) => {
  const sourceId = asText(match?.sourceMatchId || match?.id).replace(/^sporttery_/, "");
  const eventDate = businessDateForMatch(match);
  return sourceId && eventDate ? `${sourceId}:${eventDate}` : "";
};

const emptyBucket = (date) => ({ date, won: 0, lost: 0, settled: 0, hitRate: null });

const finalizeBucket = (bucket) => ({
  ...bucket,
  hitRate: bucket.settled > 0 ? bucket.won / bucket.settled : null,
});

const buildFormalReviewPerformance = ({
  matches = [],
  startDate = FORMAL_REVIEW_PERFORMANCE_START_DATE,
  generatedAt = new Date().toISOString(),
} = {}) => {
  const normalizedStartDate = /^\d{4}-\d{2}-\d{2}$/.test(asText(startDate))
    ? asText(startDate)
    : FORMAL_REVIEW_PERFORMANCE_START_DATE;
  const byDate = new Map();
  const seen = new Set();
  let excludedBeforeStart = 0;
  let excludedWithoutFrozenFormalSettlement = 0;
  let excludedDuplicate = 0;

  for (const match of Array.isArray(matches) ? matches : []) {
    const date = businessDateForMatch(match);
    if (!date || date < normalizedStartDate) {
      excludedBeforeStart += 1;
      continue;
    }
    const status = formalBestSettlement(match);
    if (!status) {
      excludedWithoutFrozenFormalSettlement += 1;
      continue;
    }
    const identity = matchIdentity(match);
    if (!identity || seen.has(identity)) {
      excludedDuplicate += 1;
      continue;
    }
    seen.add(identity);
    const bucket = byDate.get(date) || emptyBucket(date);
    bucket.settled += 1;
    if (status === "WON") bucket.won += 1;
    else bucket.lost += 1;
    byDate.set(date, bucket);
  }

  const daily = Array.from(byDate.values())
    .map(finalizeBucket)
    .sort((left, right) => left.date.localeCompare(right.date));
  const cumulative = finalizeBucket(daily.reduce((total, bucket) => ({
    date: null,
    won: total.won + bucket.won,
    lost: total.lost + bucket.lost,
    settled: total.settled + bucket.settled,
    hitRate: null,
  }), { date: null, won: 0, lost: 0, settled: 0, hitRate: null }));

  return {
    version: FORMAL_REVIEW_PERFORMANCE_VERSION,
    generatedAt,
    startDate: normalizedStartDate,
    timezone: "Asia/Shanghai",
    cumulative,
    daily,
    exclusions: {
      beforeStart: excludedBeforeStart,
      withoutFrozenFormalSettlement: excludedWithoutFrozenFormalSettlement,
      duplicateEvent: excludedDuplicate,
    },
    policy: {
      denominator: "one frozen formal BEST recommendation per officially settled match",
      includedStatuses: ["WON", "LOST"],
      excludedTracks: ["reference", "live-model", "shadow", "post-match-reconstructed"],
      immutableRecommendationRequired: true,
    },
  };
};

const compactFormalReviewPerformance = (value) => {
  if (value?.version !== FORMAL_REVIEW_PERFORMANCE_VERSION) return null;
  const compactBucket = (bucket, includeDate = false) => {
    const won = Math.max(0, Number(bucket?.won || 0));
    const lost = Math.max(0, Number(bucket?.lost || 0));
    const settled = Math.max(0, Number(bucket?.settled || 0));
    if (!Number.isInteger(won) || !Number.isInteger(lost) || !Number.isInteger(settled)) return null;
    if (won + lost !== settled) return null;
    const date = includeDate && /^\d{4}-\d{2}-\d{2}$/.test(asText(bucket?.date))
      ? asText(bucket.date)
      : undefined;
    if (includeDate && !date) return null;
    return {
      ...(includeDate ? { date } : {}),
      won,
      lost,
      settled,
      hitRate: settled > 0 ? won / settled : null,
    };
  };
  const cumulative = compactBucket(value.cumulative);
  if (!cumulative) return null;
  const daily = (Array.isArray(value.daily) ? value.daily : [])
    .map((row) => compactBucket(row, true))
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (daily.reduce((sum, row) => sum + row.settled, 0) !== cumulative.settled) return null;
  return {
    version: FORMAL_REVIEW_PERFORMANCE_VERSION,
    generatedAt: value.generatedAt || null,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(asText(value.startDate))
      ? asText(value.startDate)
      : FORMAL_REVIEW_PERFORMANCE_START_DATE,
    timezone: "Asia/Shanghai",
    cumulative,
    daily,
    policy: {
      denominator: "one frozen formal BEST recommendation per officially settled match",
      includedStatuses: ["WON", "LOST"],
      immutableRecommendationRequired: true,
    },
  };
};

module.exports = {
  FORMAL_REVIEW_PERFORMANCE_START_DATE,
  FORMAL_REVIEW_PERFORMANCE_VERSION,
  buildFormalReviewPerformance,
  businessDateForMatch,
  compactFormalReviewPerformance,
  formalBestSettlement,
};
