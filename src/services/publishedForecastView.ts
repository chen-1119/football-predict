export type Outcome = '1' | 'X' | '2';
export interface PublishedForecastRow {
  forecast: { id: string; matchId: string; sourceMatchId: string; businessDate: string; homeTeamName: string; awayTeamName: string;
    matchNo: string | null; tipCode: Outcome; odds: number; probabilities: Record<Outcome, number>; modelProbability: number;
    publishedAt: string; kickoffTime: string; cutoffTime: string; modelValidation: 'unvalidated'; quoteObservedAt: string;
    market: 'HAD'; statisticsTrack: 'published-forecast'; publicationStatus: 'PUBLISHED'; recordHash: string };
  settlement: { state: 'WON' | 'LOST' | 'VOID' | 'DISPUTED'; score: string | null; actual: Outcome | null } | null;
}
export interface ForecastSummary { published: number; settled: number; won: number; lost: number; pending: number; void: number; disputed: number; hitRate: number | null; brier: number | null; logLoss: number | null }
export interface PublishedForecastPayload { version: string; updatedAt: string; businessDate: string; current: PublishedForecastRow[]; history: PublishedForecastRow[]; summary: ForecastSummary }
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid publication object'); return v as Record<string, unknown>; };
const str = (v: unknown): string => { if (typeof v !== 'string' || !v.trim()) throw new Error('Missing publication field'); return v; };
const num = (v: unknown): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid publication number'); return v; };
const timestamp = (v: unknown): string => { const s = str(v); if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid publication timestamp'); return s; };
const code = (v: unknown): Outcome => { if (v !== '1' && v !== 'X' && v !== '2') throw new Error('Invalid published direction'); return v; };
function parseRow(value: unknown): PublishedForecastRow {
  const row = obj(value), f = obj(row.forecast), p = obj(f.probabilities);
  if (f.statisticsTrack !== 'published-forecast' || f.market !== 'HAD' || f.modelValidation !== 'unvalidated' || f.publicationStatus !== 'PUBLISHED') throw new Error('Unexpected recommendation track');
  const probs = { '1': num(p['1']), X: num(p.X), '2': num(p['2']) };
  if (Object.values(probs).some(n => n < 0 || n > 1) || Math.abs(probs['1'] + probs.X + probs['2'] - 1) > 1e-6) throw new Error('Invalid probability vector');
  const tipCode = code(f.tipCode), odds = num(f.odds), modelProbability = num(f.modelProbability);
  if (odds <= 1 || Math.abs(probs[tipCode] - modelProbability) > 1e-6 || Object.values(probs).some(n => n > modelProbability + 1e-9)) throw new Error('Published direction mismatch');
  const publishedAt = timestamp(f.publishedAt), kickoffTime = timestamp(f.kickoffTime), cutoffTime = timestamp(f.cutoffTime);
  if (Date.parse(publishedAt) >= Math.min(Date.parse(kickoffTime), Date.parse(cutoffTime))) throw new Error('Post-cutoff publication');
  const recordHash = str(f.recordHash); if (!/^[a-f0-9]{64}$/.test(recordHash)) throw new Error('Missing publication hash');
  let settlement: PublishedForecastRow['settlement'] = null;
  if (row.settlement != null) {
    const s = obj(row.settlement);
    if (!['WON','LOST','VOID','DISPUTED'].includes(String(s.state))) throw new Error('Invalid result state');
    const state = s.state as NonNullable<PublishedForecastRow['settlement']>['state'];
    const actual = s.actual == null ? null : code(s.actual), score = s.score == null ? null : str(s.score);
    if (['WON','LOST'].includes(state) && (!actual || !score || (actual === tipCode) !== (state === 'WON'))) throw new Error('Result disagrees with frozen direction');
    settlement = { state, actual, score };
  }
  return { forecast: { id: str(f.id), matchId: str(f.matchId), sourceMatchId: str(f.sourceMatchId), businessDate: str(f.businessDate),
    homeTeamName: str(f.homeTeamName), awayTeamName: str(f.awayTeamName), matchNo: f.matchNo == null ? null : str(f.matchNo),
    tipCode, odds, probabilities: probs, modelProbability, publishedAt, kickoffTime, cutoffTime, quoteObservedAt: timestamp(f.quoteObservedAt),
    recordHash, market: 'HAD', modelValidation: 'unvalidated', publicationStatus: 'PUBLISHED', statisticsTrack: 'published-forecast' }, settlement };
}
export function parsePublishedForecasts(value: unknown): PublishedForecastPayload {
  const x = obj(value);
  if (x.version !== 'published-forecast-public-v1' || !Array.isArray(x.current) || !Array.isArray(x.history)) throw new Error('Invalid published forecast response');
  const current = x.current.map(parseRow), history = x.history.map(parseRow);
  for (const rows of [current, history]) if (new Set(rows.map(r => r.forecast.id)).size !== rows.length) throw new Error('Duplicate publication');
  const s = obj(x.summary), count = (key: string) => { const n = num(s[key]); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid publication count'); return n; };
  const summary: ForecastSummary = { published: count('published'), settled: count('settled'), won: count('won'), lost: count('lost'), pending: count('pending'), void: count('void'), disputed: count('disputed'), hitRate: null, brier: s.brier == null ? null : num(s.brier), logLoss: s.logLoss == null ? null : num(s.logLoss) };
  if (summary.won + summary.lost !== summary.settled || summary.settled + summary.pending + summary.void + summary.disputed !== summary.published) throw new Error('Inconsistent publication statistics');
  summary.hitRate = summary.settled ? summary.won / summary.settled : null;
  return { version: str(x.version), updatedAt: timestamp(x.updatedAt), businessDate: str(x.businessDate), current, history, summary };
