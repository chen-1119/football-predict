export type ComboSize = 2 | 3;

export interface ComboLegView {
  matchId: string;
  sourceMatchId: string;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  matchNo?: string | null;
  kickoffTime?: string | null;
  cutoffTime?: string | null;
  market: 'HAD' | 'HHAD';
  tipCode: '1' | 'X' | '2';
  handicapLine?: number | string | null;
  odds: number;
  modelProbability?: number | null;
  marketProbability?: number | null;
  blendedProbability?: number | null;
  robustProbability?: number | null;
  marketDisagreement?: number | null;
  qualityScore?: number | null;
  quoteSource?: string | null;
  quoteObservedAt?: string | null;
}

export interface ComboSettlementResult {
  sourceMatchId: string;
  result: 'PENDING' | 'WON' | 'LOST' | 'VOID';
  finalScore?: string | null;
}

export interface ComboRowView {
  id?: string;
  businessDate?: string;
  size: ComboSize;
  totalOdds: number;
  rawTotalOdds?: number;
  averageQualityScore?: number | null;
  averageMarketDisagreement?: number | null;
  freezeAt?: string | null;
  frozenAt?: string | null;
  generatedAt?: string | null;
  statisticsTrack?: string | null;
  selectionPolicy?: string | null;
  legs: ComboLegView[];
  settlement?: {
    status?: 'PENDING' | 'WON' | 'LOST' | 'VOID';
    settledAt?: string | null;
    results?: ComboSettlementResult[];
  } | null;
}

export interface ComboStatsView {
  published: number;
  settled: number;
  won: number;
  lost: number;
  void?: number;
  hitRate: number | null;
}

export interface DailyComboLedgerView {
  updatedAt?: string | null;
  businessDate?: string | null;
  publishable?: boolean;
  candidateCount?: number;
  selectionPolicy?: string | null;
  previewStatus?: string | null;
  previews: ComboRowView[];
  today: ComboRowView[];
  statistics?: {
    two?: ComboStatsView;
    three?: ComboStatsView;
  } | null;
  independentStatistics?: {
    two?: ComboStatsView;
    three?: ComboStatsView;
  } | null;
  policy?: Record<string, unknown> | null;
}

const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isIsoLike = (value: unknown) => {
  if (value === null || value === undefined || value === '') return true;
  return Number.isFinite(Date.parse(String(value)));
};

const isComboLeg = (value: unknown): value is ComboLegView => {
  if (!value || typeof value !== 'object') return false;
  const leg = value as ComboLegView;
  return Boolean(
    leg.matchId
    && leg.sourceMatchId
    && (leg.market === 'HAD' || leg.market === 'HHAD')
    && (leg.tipCode === '1' || leg.tipCode === 'X' || leg.tipCode === '2')
    && finiteNumber(leg.odds) !== null
    && Number(leg.odds) > 1
    && isIsoLike(leg.kickoffTime)
    && isIsoLike(leg.cutoffTime)
    && isIsoLike(leg.quoteObservedAt)
  );
};

export const isComboRow = (value: unknown): value is ComboRowView => {
  if (!value || typeof value !== 'object') return false;
  const row = value as ComboRowView;
  if (row.size !== 2 && row.size !== 3) return false;
  if (!Array.isArray(row.legs) || row.legs.length !== row.size || !row.legs.every(isComboLeg)) return false;
  const totalOdds = finiteNumber(row.totalOdds);
  return totalOdds !== null
    && totalOdds > 1
    && isIsoLike(row.freezeAt)
    && isIsoLike(row.frozenAt)
    && isIsoLike(row.generatedAt);
};

const normalizeRows = (value: unknown) => {
  if (!Array.isArray(value) || !value.every(isComboRow)) throw new Error('Invalid combo rows');
  return value;
};

export function parseDailyComboLedger(value: unknown): DailyComboLedgerView {
  if (!value || typeof value !== 'object') throw new Error('Invalid combo response');
  const payload = value as Partial<DailyComboLedgerView> & { ok?: boolean };
  if (payload.ok === false) throw new Error('Combo API returned an error');
  const previews = normalizeRows(payload.previews ?? []);
  const today = normalizeRows(payload.today ?? []);
  return {
    ...payload,
    previews,
    today,
    candidateCount: Math.max(0, Number(payload.candidateCount || 0)),
  } as DailyComboLedgerView;
}

export const shanghaiBusinessDate = (now: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(now));

export function visibleComboForSize(
  ledger: DailyComboLedgerView | null,
  size: ComboSize,
  now: number,
  readFailed = false,
): ComboRowView | null {
  if (!ledger || ledger.businessDate !== shanghaiBusinessDate(now)) return null;
  const frozen = ledger.today.find((row) => row.size === size && Boolean(row.frozenAt));
  if (frozen) return frozen;
  if (readFailed || ledger.publishable !== true) return null;
  const updatedAt = Date.parse(ledger.updatedAt || '');
  if (!Number.isFinite(updatedAt) || now < updatedAt || now - updatedAt >= 10 * 60_000) return null;
  const preview = ledger.previews.find((row) => row.size === size);
  if (!preview) return null;
  const active = preview.legs.every((leg) => {
    const kickoff = Date.parse(leg.kickoffTime || '');
    const cutoff = Date.parse(leg.cutoffTime || '');
    return Number.isFinite(kickoff) && Number.isFinite(cutoff) && now < Math.min(kickoff, cutoff);
  });
  return active ? preview : null;
}
