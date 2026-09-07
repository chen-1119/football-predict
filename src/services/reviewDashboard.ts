import type { ReviewPerformanceBucket, ReviewPerformanceSummary } from './reviewPerformanceTypes';

export type ReviewTrack = 'formal' | 'reference';
export type ReviewWindow = 'version' | '7d' | '30d' | 'all';
export type ReviewMarket = 'HAD' | 'HHAD' | 'BEST';
export type ReviewCounts = { won: number; lost: number; settled: number; hitRate: number | null };
export type ReviewExclusionRow = { key: string; zh: string; en: string; unit: 'record' | 'event'; value: number | null };

/** These counters audit the complete input, including pre-start rows. They are
 * NOT a selected-window/market denominator and mix record and event units. */
export const selectReviewExclusions = (summary: ReviewPerformanceSummary | null | undefined, track: ReviewTrack) => {
  const definitions: Array<Omit<ReviewExclusionRow, 'value'>> = [
    { key: 'beforeStart', zh: '早于统计起点', en: 'Before statistics start', unit: 'record' },
    { key: 'invalidDate', zh: '业务日期无效', en: 'Invalid business date', unit: 'record' },
    { key: 'invalidIdentity', zh: '赛事身份无效', en: 'Invalid event identity', unit: 'record' },
    { key: 'duplicateEvent', zh: '重复记录去重', en: 'Duplicate records', unit: 'record' },
    { key: 'conflictingEvent', zh: '冲突赛事排除', en: 'Conflicting events', unit: 'event' },
    { key: track === 'formal' ? 'withoutFrozenFormalSettlement' : 'withoutFrozenReferenceSettlement',
      zh: track === 'formal' ? '无可计入的冻结正式结算' : '无可计入的冻结参考结算',
      en: track === 'formal' ? 'Without eligible frozen formal settlement' : 'Without eligible frozen reference settlement', unit: 'record' },
  ];
  const raw = summary?.exclusions;
  const available = selectReviewWindow(summary, track, 'all').state === 'ready'
    && !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const rows = definitions.map(row => {
    const n = available && Object.hasOwn(raw, row.key) ? raw[row.key] : undefined;
    return { ...row, value: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null };
  });
  const keys = new Set(definitions.map(row => row.key));
  const unknownFields = available ? Object.keys(raw).filter(key => !keys.has(key)).length : 0;
  return { available, complete: available && unknownFields === 0 && rows.every(row => row.value !== null), rows, unknownFields };
};
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

/** Frozen version labels, not attested parameter revisions. Reconcile the whole
 * partition (including UNKNOWN), each market, and each calendar day first. */
export const selectReviewVersions = (summary: ReviewPerformanceSummary | null | undefined, track: ReviewTrack) => {
  const missing = { available: false as const, groups: [], unknown: null };
  if (!summary || selectReviewMarketWindow(summary, track, 'all', 'HAD').state !== 'ready') return missing;
  const partition = summary.versionBreakdown;
  if (partition?.version !== 'review-frozen-version-labels-v1' || partition.scope !== 'frozen-labels-not-model-revision'
    || !Array.isArray(partition.groups) || partition.groups.length > 1024 || partition.unknown?.key !== 'UNKNOWN'
    || partition.unknown.modelVersion !== undefined || partition.unknown.policyVersion !== undefined) return missing;
  const groups = partition.groups;
  if (groups.some(group => !group || !/^[a-f0-9]{64}$/.test(group.key || '') || ![group.modelVersion, group.policyVersion].every(v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 240 && [...v].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)))
    || new Set(groups.map(group => group.key)).size !== groups.length
    || new Set(groups.map(group => JSON.stringify([group.modelVersion, group.policyVersion]))).size !== groups.length) return missing;
  const all = [...groups, partition.unknown].map(group => ({ ...summary, ...group }));
  if (all.some(group => selectReviewMarketWindow(group, track, 'all', 'HAD').state !== 'ready')) return missing;
  for (const market of ['BEST', 'HAD', 'HHAD', 'UNKNOWN'] as const) {
    const root = market === 'BEST' ? summary : summary.marketBreakdown![market]!;
    const parts = all.map(group => market === 'BEST' ? group : group.marketBreakdown![market]!);
    const rootDates = new Set(root.daily!.map(row => row.date));
    const dates = parts.map(group => new Map(group.daily!.map(row => [row.date, row])));
    if ((['won', 'lost', 'settled'] as const).some(key => parts.reduce((n, group) => n + group.cumulative![key]!, 0) !== root.cumulative![key])
      || dates.some(group => [...group.keys()].some(date => !rootDates.has(date)))
      || root.daily!.some(row => (['won', 'lost', 'settled'] as const).some(key => dates.reduce((n, group) => n + (group.get(row.date)?.[key] || 0), 0) !== row[key]))) return missing;
  }
  return { available: true as const, groups, unknown: partition.unknown };
};

export const selectReviewVersionWindow = (summary: ReviewPerformanceSummary | null | undefined, track: ReviewTrack, market: ReviewMarket, key: string) => {
  const versions = selectReviewVersions(summary, track);
  const group = key === 'UNKNOWN' ? versions.unknown : versions.groups.find(group => group.key === key);
  if (!versions.available || !group || !summary) return { state: 'version-unavailable' as const, counts: null, from: null, through: null, partial: false };
  return selectReviewMarketWindow({ ...summary, ...group }, track, 'all', market);
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

/** Descriptive Wilson score interval under an independent, common-probability
 * Bernoulli assumption. Not a paired improvement test, date-cluster adjustment,
 * forecast, or model admission gate. Use only reconciled selected-window counts.
 * Formula: https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm
 */
export const reviewWilsonInterval = (value: ReviewPerformanceBucket | null | undefined) => {
  const counts = reviewCounts(value);
  if (!counts || counts.settled === 0) return null;
  const n = counts.settled, p = counts.won / n, z = 1.959963984540054;
  const z2 = z * z, denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return { method: 'wilson-score-95-descriptive' as const, sampleSize: n,
    lower: counts.won === 0 ? 0 : Math.max(0, centre - margin),
    upper: counts.lost === 0 ? 1 : Math.min(1, centre + margin) };
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
