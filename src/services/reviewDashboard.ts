import type { ReviewPerformanceBucket, ReviewPerformanceSummary } from './reviewPerformanceTypes';

export type ReviewTrack = 'formal' | 'reference';
export type ReviewWindow = 'version' | '7d' | '30d' | 'all';
export type ReviewMarket = 'HAD' | 'HHAD' | 'BEST';
export type ReviewCounts = { won: number; lost: number; settled: number; hitRate: number | null };
export type ReviewWindowResult = {
  state: 'ready' | 'pending' | 'version-unavailable' | 'market-unavailable';
  counts: ReviewCounts | null;
  from: string | null;
  through: string | null;
  partial: boolean;
};

/** A market partition must reconcile both totals AND each day across all pools.
 * The UNKNOWN bucket stays in BEST but is never reassigned to HAD/HHAD.
 */
export const selectReviewMarketWindow = (
  summary: ReviewPerformanceSummary | null | undefined, track: ReviewTrack, window: ReviewWindow, market: ReviewMarket,
): ReviewWindowResult => {
  const root = selectReviewWindow(summary, track, 'all');
  if (root.state !== 'ready' || !summary) return root;
  if (market === 'BEST') return selectReviewWindow(summary, track, window);
  const missing: ReviewWindowResult = { state: 'market-unavailable', counts: null, from: null, through: root.through, partial: false };
  const partition = summary.marketBreakdown;
  const markets = ['HAD', 'HHAD', 'UNKNOWN'] as const;
  if (!partition || partition.version !== 'review-best-market-v1'
    || Object.keys(partition).sort().join(',') !== ['HAD', 'HHAD', 'UNKNOWN', 'version'].sort().join(',')) return missing;
  const groups = markets.map((key) => ({ ...summary, cumulative: partition[key]?.cumulative, daily: partition[key]?.daily }));
  const totals = groups.map((group) => selectReviewWindow(group, track, 'all'));
  if (totals.some((group) => group.state !== 'ready')) return missing;
  if ((['won', 'lost', 'settled'] as const).some((key) => totals.reduce((sum, group) => sum + group.counts![key], 0) !== root.counts![key])) return missing;
  const days = groups.map((group) => new Map(group.daily!.map((row) => [row.date!, row])));
  const rootDates = new Set(summary.daily!.map((row) => row.date!));
  if (days.some((group) => [...group.keys()].some((date) => !rootDates.has(date)))) return missing;
  if (summary.daily!.some((row) => (['won', 'lost', 'settled'] as const).some((key) => days.reduce((sum, group) => sum + (group.get(row.date!)?.[key] || 0), 0) !== row[key]))) return missing;
  return selectReviewWindow(groups[market === 'HAD' ? 0 : 1], track, window);
};

const dateKey = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export const reviewCounts = (value: ReviewPerformanceBucket | null | undefined): ReviewCounts | null => {
  const { won, lost, settled } = value || {};
  if (![won, lost, settled].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    || won! + lost! !== settled) return null;
  return { won: won!, lost: lost!, settled: settled!, hitRate: settled! > 0 ? won! / settled! : null };
};

export const reviewShanghaiDate = (value: string | null | undefined): string | null => {
  // Reject timezone-less clocks: statistics must not depend on the browser's zone.
  if (!value || !/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

/** Aggregate the complete, reconciled server ledger, never the paginated match list.
 * Windows end on the summary's Shanghai publication day, not the user's clock.
 * v1 has no attested version partition or paired market ledger; neither is inferred.
 */
export const selectReviewWindow = (
  summary: ReviewPerformanceSummary | null | undefined, track: ReviewTrack, window: ReviewWindow,
): ReviewWindowResult => {
  const pending: ReviewWindowResult = { state: 'pending', counts: null, from: null, through: null, partial: false };
  if (!summary || summary.version !== `${track}-review-performance-v1`
    || summary.policy?.sourceScope !== 'server-complete-history' || summary.policy?.unit !== 'match-best'
    || summary.timezone !== 'Asia/Shanghai' || !dateKey(summary.startDate) || !Array.isArray(summary.daily)) return pending;
  const through = reviewShanghaiDate(summary.generatedAt);
  const cumulative = reviewCounts(summary.cumulative);
  if (!through || !cumulative || summary.startDate > through) return pending;
  const seen = new Set<string>();
  const totals = { won: 0, lost: 0, settled: 0 };
  for (const row of summary.daily) {
    const counts = reviewCounts(row);
    if (!counts || !dateKey(row.date) || row.date < summary.startDate || row.date > through || seen.has(row.date)) return pending;
    seen.add(row.date);
    for (const key of ['won', 'lost', 'settled'] as const) totals[key] += counts[key];
  }
  if ((['won', 'lost', 'settled'] as const).some((key) => totals[key] !== cumulative[key])) return pending;
  if (window === 'version') return { ...pending, state: 'version-unavailable', through };
  if (window === 'all') return { state: 'ready', counts: cumulative, from: summary.startDate, through, partial: false };
  const days = window === '7d' ? 7 : 30;
  const requestedFrom = new Date(Date.parse(`${through}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const from = summary.startDate > requestedFrom ? summary.startDate : requestedFrom;
  const counts = summary.daily.filter((row) => row.date! >= from).reduce<{ won: number; lost: number; settled: number }>((sum, row) => ({
    won: sum.won + row.won!, lost: sum.lost + row.lost!, settled: sum.settled + row.settled!,
  }), { won: 0, lost: 0, settled: 0 });
  return { state: 'ready', counts: reviewCounts(counts), from, through, partial: from !== requestedFrom };
};
