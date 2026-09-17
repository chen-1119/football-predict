import { parsePublishedForecasts, type PublishedForecastPayload } from './publishedForecastView';
export type ComboSize = 2 | 3;
export interface ComboLegView {
  matchId: string; sourceMatchId: string;
  homeTeamId?: string | null; awayTeamId?: string | null;
  homeTeamName?: string | null; awayTeamName?: string | null; matchNo?: string | null;
  kickoffTime?: string | null; cutoffTime?: string | null;
  market: 'HAD' | 'HHAD'; tipCode: '1' | 'X' | '2'; handicapLine?: number | string | null;
  odds: number; modelProbability?: number | null; marketProbability?: number | null;
  blendedProbability?: number | null; robustProbability?: number | null;
  marketDisagreement?: number | null; qualityScore?: number | null;
  quoteSource?: string | null; quoteObservedAt?: string | null;
}
export interface ComboSettlementResult { sourceMatchId: string; result: 'PENDING' | 'WON' | 'LOST' | 'VOID'; finalScore?: string | null }
export interface ComboRowView {
  id?: string; businessDate?: string; size: ComboSize; totalOdds: number; rawTotalOdds?: number;
  averageQualityScore?: number | null; averageMarketDisagreement?: number | null;
  freezeAt?: string | null; frozenAt?: string | null; generatedAt?: string | null;
  statisticsTrack?: string | null; selectionPolicy?: string | null; legs: ComboLegView[];
  settlement?: { status?: 'PENDING' | 'WON' | 'LOST' | 'VOID'; settledAt?: string | null; results?: ComboSettlementResult[] } | null;
}
export interface ComboStatsView { published: number; settled: number; won: number; lost: number; void?: number; hitRate: number | null }
export interface DailyComboLedgerView {
  publishedForecasts?: PublishedForecastPayload;
  updatedAt?: string | null; businessDate?: string | null; publishable?: boolean; candidateCount?: number;
  selectionPolicy?: string | null; previewStatus?: string | null; previews: ComboRowView[]; today: ComboRowView[];
  statistics?: { two?: ComboStatsView; three?: ComboStatsView } | null;
  independentStatistics?: { two?: ComboStatsView; three?: ComboStatsView } | null;
  policy?: Record<string, unknown> | null;
}
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid combo object');
  return value as RecordValue;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid numeric field');
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) throw new Error('Invalid numeric field');
  const n = Number(value); if (!Number.isFinite(n)) throw new Error('Invalid numeric field'); return n;
}
function optionalNumber(value: unknown, low: number, high: number): number | null | undefined {
  if (value === undefined || value === null) return value;
  const n = numeric(value); if (n < low || n > high) throw new Error('Numeric field outside range'); return n;
}
function text(value: unknown, required = false): string | null | undefined {
  if ((value === null || value === undefined) && !required) return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid text field'); return value;
}
function instant(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return value === '' ? null : value;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid combo timestamp'); return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid business date');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Invalid business date'); return value;
}
function leg(value: unknown): ComboLegView {
  const x = object(value), odds = numeric(x.odds);
  if (odds <= 1 || typeof x.market !== 'string' || !['HAD', 'HHAD'].includes(x.market) || typeof x.tipCode !== 'string' || !['1', 'X', '2'].includes(x.tipCode)) throw new Error('Invalid combo selection');
  const result: ComboLegView = { matchId: text(x.matchId, true)!, sourceMatchId: text(x.sourceMatchId, true)!, market: x.market as ComboLegView['market'], tipCode: x.tipCode as ComboLegView['tipCode'], odds };
  for (const key of ['homeTeamId', 'awayTeamId', 'homeTeamName', 'awayTeamName', 'matchNo', 'quoteSource'] as const) result[key] = text(x[key]);
  for (const key of ['kickoffTime', 'cutoffTime', 'quoteObservedAt'] as const) result[key] = instant(x[key]);
  for (const key of ['modelProbability', 'marketProbability', 'blendedProbability', 'robustProbability', 'marketDisagreement'] as const) result[key] = optionalNumber(x[key], 0, 1);
  result.qualityScore = optionalNumber(x.qualityScore, 0, 100);
  result.handicapLine = x.handicapLine === undefined || x.handicapLine === null ? x.handicapLine : numeric(x.handicapLine);
  if (x.market === 'HHAD' && !Number.isInteger(result.handicapLine)) throw new Error('Missing or invalid HHAD line');
  if (x.market === 'HAD' && result.handicapLine != null && result.handicapLine !== 0) throw new Error('HAD must have zero handicap');
  return result;
}
function row(value: unknown): ComboRowView {
  const x = object(value);
  if ((x.size !== 2 && x.size !== 3) || !Array.isArray(x.legs) || x.legs.length !== x.size) throw new Error('Invalid combo row');
  const legs = x.legs.map(leg);
  if (new Set(legs.map((l) => l.sourceMatchId)).size !== legs.length) throw new Error('Duplicate match in combo');
  const totalOdds = numeric(x.totalOdds);
  const product = legs.reduce((p, l) => p * l.odds, 1);
  if (totalOdds <= 1 || Math.abs(totalOdds - product) > 0.010001) throw new Error('Combo total does not match legs');
  const result: ComboRowView = { size: x.size, totalOdds, legs };
  for (const key of ['freezeAt', 'frozenAt', 'generatedAt'] as const) result[key] = instant(x[key]);
  for (const key of ['id', 'statisticsTrack', 'selectionPolicy'] as const) { const v = text(x[key]); if (v != null) result[key] = v; }
  if (x.businessDate != null) result.businessDate = date(x.businessDate);
  if (x.rawTotalOdds != null) { result.rawTotalOdds = numeric(x.rawTotalOdds); if (Math.abs(result.rawTotalOdds - product) > 0.000001) throw new Error('Raw SP total mismatch'); }
  result.averageQualityScore = optionalNumber(x.averageQualityScore, 0, 100);
  result.averageMarketDisagreement = optionalNumber(x.averageMarketDisagreement, 0, 1);
  if (x.settlement != null) {
    const s = object(x.settlement);
    if (s.status != null && (typeof s.status !== 'string' || !['WON', 'LOST', 'PENDING', 'VOID'].includes(s.status))) throw new Error('Invalid settlement');
    const results = s.results == null ? undefined : (() => {
      if (!Array.isArray(s.results)) throw new Error('Invalid settlement results');
      return s.results.map((item): ComboSettlementResult => {
        const r = object(item), sourceMatchId = text(r.sourceMatchId, true)!;
        if (!legs.some((l) => l.sourceMatchId === sourceMatchId) || typeof r.result !== 'string' || !['WON', 'LOST', 'PENDING', 'VOID'].includes(r.result)) throw new Error('Invalid settlement leg');
        return { sourceMatchId, result: r.result as ComboSettlementResult['result'], finalScore: text(r.finalScore) };
      });
    })();
    if (results && new Set(results.map((r) => r.sourceMatchId)).size !== results.length) throw new Error('Duplicate settlement leg');
    result.settlement = { status: s.status as NonNullable<ComboRowView['settlement']>['status'], settledAt: instant(s.settledAt), results };
  }
  return result;
}
export function isComboRow(value: unknown): value is ComboRowView {
  try {
    // A type guard must not accept numeric strings without converting them.
    const x = object(value); row(x);
    const optionalNumeric = (o: RecordValue, keys: string[]) => keys.every((key) => o[key] == null || typeof o[key] === 'number');
    return typeof x.totalOdds === 'number'
      && optionalNumeric(x, ['rawTotalOdds', 'averageQualityScore', 'averageMarketDisagreement'])
      && (x.legs as RecordValue[]).every((l) => typeof l.odds === 'number'
        && optionalNumeric(l, ['modelProbability', 'marketProbability', 'blendedProbability', 'robustProbability', 'marketDisagreement', 'qualityScore']));
  } catch { return false; }
}
function stats(value: unknown): ComboStatsView {
  const x = object(value);
  const count = (v: unknown) => { const n = numeric(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid result count'); return n; };
  const r: ComboStatsView = { published: count(x.published), settled: count(x.settled), won: count(x.won), lost: count(x.lost), hitRate: null };
  if (x.void != null) r.void = count(x.void);
  if (r.won + r.lost !== r.settled || r.settled + (r.void || 0) > r.published) throw new Error('Inconsistent result counts');
  // Derive from the audited counts instead of trusting a mismatched rate field.
  r.hitRate = r.settled ? r.won / r.settled : null;
  return r;
}
export function parseDailyComboLedger(value: unknown): DailyComboLedgerView {
  const x = object(value);
  if (x.ok === false || !Array.isArray(x.previews) || !Array.isArray(x.today)) throw new Error('Invalid combo response');
  if (typeof x.publishable !== 'boolean') throw new Error('Invalid combo readiness');
  const updatedAt = instant(x.updatedAt); if (!updatedAt) throw new Error('Missing ledger clock');
  const result: DailyComboLedgerView = { updatedAt, businessDate: date(x.businessDate), publishable: x.publishable, previews: x.previews.map(row), today: x.today.map(row) };
  for (const key of ['previews', 'today'] as const) if (new Set(result[key].map((r) => r.size)).size !== result[key].length) throw new Error('Duplicate combo size');
  if (x.candidateCount != null) { const n = numeric(x.candidateCount); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid candidate count'); result.candidateCount = n; }
  result.selectionPolicy = text(x.selectionPolicy); result.previewStatus = text(x.previewStatus);
  for (const key of ['statistics', 'independentStatistics'] as const) {
    if (x[key] == null) continue; const group = object(x[key]);
    result[key] = { two: group.two == null ? undefined : stats(group.two), three: group.three == null ? undefined : stats(group.three) };
  }
  result.policy = x.policy == null ? null : object(x.policy);
  if (x.publishedForecasts != null) result.publishedForecasts = parsePublishedForecasts(x.publishedForecasts);
  return result;
}
export const shanghaiBusinessDate = (now: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(now));
export function visibleComboForSize(ledger: DailyComboLedgerView | null, size: ComboSize, now: number, readFailed = false): ComboRowView | null {
  if (!ledger || !Number.isFinite(now) || ledger.businessDate !== shanghaiBusinessDate(now)) return null;
  const frozen = ledger.today.find((r) => r.size === size && r.businessDate === ledger.businessDate && Boolean(r.frozenAt));
  if (frozen) return frozen;
  if (readFailed || ledger.publishable !== true) return null;
  const stamp = Date.parse(ledger.updatedAt || '');
  if (!Number.isFinite(stamp) || now < stamp || now - stamp >= 10 * 60000) return null;
  const preview = ledger.previews.find((r) => r.size === size);
  return preview && preview.legs.every((l) => {
    const kickoff = Date.parse(l.kickoffTime || ''), cutoff = Date.parse(l.cutoffTime || '');
    return Number.isFinite(kickoff) && Number.isFinite(cutoff) && now < Math.min(kickoff, cutoff);
  }) ? preview : null;
}
