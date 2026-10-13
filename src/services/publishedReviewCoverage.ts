/** Read-only display contract. The server owns raw-record replay and result provenance. */
export type PublishedReviewTrack = 'manual' | 'trained' | 'legacy';
export interface PublishedReviewCounts {
  publishedRecords: number; distinctEvents: number; settled: number; won: number; lost: number;
  pending: number; unknown: number; void: number; disputed: number; hitRate: number | null;
  scoreEligible: number; scoreTop1: number; scoreTop2: number;
}
export interface PublishedReviewCohort extends PublishedReviewCounts {
  markets: { HAD: PublishedReviewCounts; HHAD: PublishedReviewCounts };
  days: Array<PublishedReviewCounts & { businessDate: string }>;
}
export interface PublishedReviewCoverage {
  version: 'published-review-coverage-v1'; asOf: string; complete: boolean;
  overall: {
    distinctEvents: number; selectedTrackRecords: number; sourceRecords: number;
    supersededRecords: number; crossTrackDuplicateEvents: number; hitRate: null; definition: string;
  };
  tracks: Record<PublishedReviewTrack, PublishedReviewCohort>;
  rejected: Array<{ track: PublishedReviewTrack; index: number; reason: string }>;
  identityConflicts: string[]; selectionConflicts: string[];
}

const TRACKS: PublishedReviewTrack[] = ['manual', 'trained', 'legacy'];
const fields = ['publishedRecords', 'distinctEvents', 'settled', 'won', 'lost', 'pending',
  'unknown', 'void', 'disputed', 'scoreEligible', 'scoreTop1', 'scoreTop2'] as const;
const fail = (): never => { throw new Error('Invalid published review coverage'); };
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const count = (v: unknown): number => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : fail();
const text = (v: unknown): string => typeof v === 'string' && v.length > 0 && v.length <= 1024 ? v : fail();
const list = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 100000 ? v : fail();
const date = (v: unknown): string => {
  const s = text(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + 'T00:00:00Z'))
    || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) return fail();
  return s;
};
function counts(value: unknown): PublishedReviewCounts {
  const v = object(value);
  const c = Object.fromEntries(fields.map(k => [k, count(v[k])])) as unknown as PublishedReviewCounts;
  if (c.distinctEvents !== c.publishedRecords || c.settled !== c.won + c.lost
    || c.publishedRecords !== c.settled + c.pending + c.unknown + c.void + c.disputed
    || c.scoreEligible > c.settled || c.scoreTop1 > c.scoreTop2 || c.scoreTop2 > c.scoreEligible) return fail();
  if (c.settled === 0) { if (v.hitRate !== null) return fail(); c.hitRate = null; }
  else {
    if (typeof v.hitRate !== 'number' || !Number.isFinite(v.hitRate)
      || Math.abs(v.hitRate - c.won / c.settled) > 1e-9) return fail();
    c.hitRate = v.hitRate;
  }
  return c;
}
function cohort(value: unknown): PublishedReviewCohort {
  const v = object(value), total = counts(v), m = object(v.markets);
  const markets = { HAD: counts(m.HAD), HHAD: counts(m.HHAD) };
  const days = list(v.days).map(value => { const row = object(value); return { ...counts(row), businessDate: date(row.businessDate) }; });
  if (new Set(days.map(d => d.businessDate)).size !== days.length) return fail();
  for (const field of fields) {
    if (markets.HAD[field] + markets.HHAD[field] !== total[field]
      || days.reduce((sum, row) => sum + row[field], 0) !== total[field]) return fail();
  }
  return { ...total, markets, days };
}
export function parsePublishedReviewCoverage(value: unknown): PublishedReviewCoverage {
  const v = object(value), o = object(v.overall), t = object(v.tracks);
  if (v.version !== 'published-review-coverage-v1' || typeof v.complete !== 'boolean' || o.hitRate !== null) return fail();
  const asOf = text(v.asOf);
  if (!Number.isFinite(Date.parse(asOf))) return fail();
  const tracks = { manual: cohort(t.manual), trained: cohort(t.trained), legacy: cohort(t.legacy) };
  const overall = {
    distinctEvents: count(o.distinctEvents), selectedTrackRecords: count(o.selectedTrackRecords),
    sourceRecords: count(o.sourceRecords), supersededRecords: count(o.supersededRecords),
    crossTrackDuplicateEvents: count(o.crossTrackDuplicateEvents), hitRate: null, definition: text(o.definition),
  };
  const total = TRACKS.reduce((sum, track) => sum + tracks[track].publishedRecords, 0);
  const extra = total - overall.distinctEvents;
  if (total !== overall.selectedTrackRecords || overall.sourceRecords !== total + overall.supersededRecords
    || overall.distinctEvents > total || Math.max(...TRACKS.map(track => tracks[track].distinctEvents)) > overall.distinctEvents
    || overall.crossTrackDuplicateEvents > overall.distinctEvents || overall.crossTrackDuplicateEvents > extra
    || extra > overall.crossTrackDuplicateEvents * 2) return fail();
  const rejected = list(v.rejected).map(value => {
    const row = object(value);
    if (!TRACKS.includes(row.track as PublishedReviewTrack)) return fail();
    return { track: row.track as PublishedReviewTrack, index: count(row.index), reason: text(row.reason) };
  });
  const identityConflicts = list(v.identityConflicts).map(text), selectionConflicts = list(v.selectionConflicts).map(text);
  if (v.complete && (rejected.length || identityConflicts.length || selectionConflicts.length)) return fail();
  return { version: 'published-review-coverage-v1', asOf, complete: v.complete, overall, tracks,
    rejected, identityConflicts, selectionConflicts };
}

/** A missing day is zero only when the caller has a complete, verified response. */
export function coverageDay(data: PublishedReviewCoverage, track: PublishedReviewTrack, businessDate: string): PublishedReviewCounts | undefined {
  const row = data.tracks[track].days.find(d => d.businessDate === businessDate);
  const observedDay = new Date(Date.parse(data.asOf) + 8 * 3600000).toISOString().slice(0, 10);
  if (row || !data.complete || businessDate > observedDay) return row;
  return { publishedRecords: 0, distinctEvents: 0, settled: 0, won: 0, lost: 0, pending: 0,
    unknown: 0, void: 0, disputed: 0, hitRate: null, scoreEligible: 0, scoreTop1: 0, scoreTop2: 0 };
}
