import {
  parseRecommendationComboRow,
  parseRecommendationSingleRow,
  parseRecommendationSummary,
  type ComboRow,
  type SingleRow,
  type Settlement,
  type Summary,
} from './recommendationCenterView';

export type ReviewKind = 'single' | 'two' | 'three';
export type ReviewMarket = 'ALL' | 'HAD' | 'HHAD' | 'MIXED';
export type ReviewState = 'ALL' | 'WON' | 'LOST' | 'PENDING' | 'VOID' | 'DISPUTED';
export interface ReviewFilters {
  kind: ReviewKind;
  market: ReviewMarket;
  date: string;
  version: string;
  state: ReviewState;
  q: string;
  page: number;
  pageSize: number;
}
export interface ReviewPage {
  version: 'recommendation-review-page-v1';
  updatedAt: string;
  filters: ReviewFilters;
  rows: Array<ReviewedSingleRow | ReviewedComboRow>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  summary: {
    all: Summary;
    filtered: Summary;
    windows: { last7: Summary; last30: Summary };
    byDate: unknown;
    byMarket: unknown;
    byVersion: unknown;
  };
  versions: Array<{ key: string; label: string; count: number }>;
}
export interface ReviewSelection {
  selectedMarket: Exclude<ReviewMarket, 'ALL'>;
  selectedSettlement: Settlement | null;
  selectedOdds: number | null;
  oddsState: 'available' | 'missing';
  versionKey: string;
  versionLabel: string;
}
export type ReviewedSingleRow = SingleRow & ReviewSelection;
export type ReviewedComboRow = ComboRow & ReviewSelection;

const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review response');
  return value as Record<string, unknown>;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid review count');
  return value as number;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid review text');
  return value;
};
const date = (value: unknown): string => {
  const input = text(value);
  if (input && (!/^\d{4}-\d{2}-\d{2}$/.test(input) || new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) !== input)) throw new Error('Invalid review date');
  return input;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid review rows');
  return value;
};

export function parseRecommendationReviewPage(value: unknown): ReviewPage {
  const root = obj(value);
  if (root.ok !== true || root.version !== 'recommendation-review-page-v1') throw new Error('Unsupported review page');
  const rawFilters = obj(root.filters);
  const kind = rawFilters.kind;
  const market = rawFilters.market;
  const state = rawFilters.state;
  if (!['single', 'two', 'three'].includes(String(kind)) || !['ALL', 'HAD', 'HHAD', 'MIXED'].includes(String(market)) || !['ALL', 'WON', 'LOST', 'PENDING', 'VOID', 'DISPUTED'].includes(String(state))) throw new Error('Invalid review filters');
  const filters: ReviewFilters = {
    kind: kind as ReviewKind,
    market: market as ReviewMarket,
    date: date(rawFilters.date),
    version: text(rawFilters.version),
    state: state as ReviewState,
    q: text(rawFilters.q),
    page: count(rawFilters.page),
    pageSize: count(rawFilters.pageSize),
  };
  if (filters.page < 1 || filters.pageSize < 1 || filters.pageSize > 100) throw new Error('Invalid review pagination');
  const page = count(root.page), pageSize = count(root.pageSize), pageCount = count(root.pageCount), total = count(root.total);
  if (page !== filters.page || pageSize !== filters.pageSize || page < 1 || pageSize < 1 || pageSize > 100 || pageCount !== Math.ceil(total / pageSize)) throw new Error('Inconsistent review pagination');
  const rows = array(root.rows).map(raw => {
    const row = obj(raw);
    const parsed = kind === 'single' ? parseRecommendationSingleRow(row) : parseRecommendationComboRow(row);
    const selectedMarket = row.selectedMarket;
    if (!['HAD', 'HHAD', 'MIXED'].includes(String(selectedMarket)) || (kind === 'single' && selectedMarket === 'MIXED')) throw new Error('Invalid selected market');
    const selectedSettlement = kind === 'single'
      ? selectedMarket === 'HHAD' ? (parsed as SingleRow).handicapSettlement ?? null : (parsed as SingleRow).settlement
      : (parsed as ComboRow).settlement;
    if (selectedSettlement?.state !== (row.selectedSettlement == null ? null : obj(row.selectedSettlement).state)) throw new Error('Selected result mismatch');
    const selectedOdds = row.selectedOdds == null ? null : row.selectedOdds;
    if (selectedOdds !== null && (typeof selectedOdds !== 'number' || !Number.isFinite(selectedOdds) || selectedOdds <= 1)) throw new Error('Invalid selected odds');
    if (row.oddsState !== (selectedOdds === null ? 'missing' : 'available')) throw new Error('Invalid odds state');
    const versionKey = text(row.versionKey);
    if (!/^[a-f0-9]{64}$/.test(versionKey)) throw new Error('Invalid version key');
    return { ...parsed, selectedMarket: selectedMarket as ReviewSelection['selectedMarket'], selectedSettlement, selectedOdds, oddsState: row.oddsState, versionKey, versionLabel: text(row.versionLabel) } as ReviewedSingleRow | ReviewedComboRow;
  });
  if (rows.length > pageSize || (total === 0 && rows.length > 0)) throw new Error('Invalid review page length');
  const summary = obj(root.summary), windows = obj(summary.windows), versions = array(root.versions).map(item => {
    const v = obj(item);
    return { key: text(v.key), label: text(v.label), count: count(v.count) };
  });
  const updatedAt = text(root.updatedAt);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid review timestamp');
  return {
    version: 'recommendation-review-page-v1', updatedAt, filters, rows, total, page, pageSize, pageCount,
    summary: {
      all: parseRecommendationSummary(summary.all),
      filtered: parseRecommendationSummary(summary.filtered),
      windows: { last7: parseRecommendationSummary(windows.last7), last30: parseRecommendationSummary(windows.last30) },
      byDate: summary.byDate, byMarket: summary.byMarket, byVersion: summary.byVersion,
    },
    versions,
  };
}
