export type ComboSize = 2 | 3;
export interface ComboLeg {
  matchId: string; sourceMatchId: string; market: 'HAD' | 'HHAD'; tipCode: string;
  homeTeamName?: string; awayTeamName?: string; homeTeamId?: string; awayTeamId?: string;
  matchNo?: string | null; kickoffTime?: string; cutoffTime?: string;
  handicapLine?: number | string; odds: number; modelProbability?: number;
  quoteObservedAt?: string; quoteSource?: string;
}
export interface ComboRow {
  id?: string; businessDate?: string; size: ComboSize; totalOdds: number;
  rawTotalOdds?: number; legs: ComboLeg[]; frozenAt?: string; statisticsTrack?: string;
  settlement?: { status?: 'PENDING' | 'WON' | 'LOST' | 'VOID'; results?: Array<{ sourceMatchId: string; result: string; finalScore?: string | null }> };
}
export interface ComboStats { published: number; settled: number; won: number; lost: number; hitRate: number | null }
export interface ComboLedger {
  updatedAt?: string; businessDate?: string; previews?: ComboRow[]; today?: ComboRow[];
  publishable?: boolean; candidateCount?: number; selectionPolicy?: string;
  statistics?: { two?: ComboStats; three?: ComboStats };
  independentStatistics?: { two?: ComboStats; three?: ComboStats };
}
export const shanghaiDay = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export const isComboRow = (value: unknown): value is ComboRow => {
  if (!value || typeof value !== 'object') return false;
  const row = value as ComboRow;
  return [2, 3].includes(row.size) && Array.isArray(row.legs) && row.legs.length === row.size
    && typeof row.totalOdds === 'number' && Number.isFinite(row.totalOdds)
    && row.legs.every((leg) => leg && typeof leg.matchId === 'string' && ['1', 'X', '2'].includes(leg.tipCode)
      && ['HAD', 'HHAD'].includes(leg.market) && typeof leg.odds === 'number' && Number.isFinite(leg.odds) && leg.odds > 1);
};
export function parseComboLedger(value: unknown): ComboLedger {
  if (!value || typeof value !== 'object') throw new Error('Invalid combo response');
  const payload = value as ComboLedger;
  if (!Array.isArray(payload.today) || !Array.isArray(payload.previews)
    || !payload.today.every(isComboRow) || !payload.previews.every(isComboRow)) throw new Error('Invalid combo rows');
  return payload;
}
export function visibleCombo(ledger: ComboLedger | null, size: ComboSize, now: number, failed = false): ComboRow | null {
  if (!ledger || ledger.businessDate !== shanghaiDay(now)) return null;
  // Resolve each size independently; a frozen two-leg must not hide a three-leg preview.
  const frozen = ledger.today?.find((row) => row.size === size && row.businessDate === ledger.businessDate && Boolean(row.frozenAt));
  if (frozen) return frozen;
  const age = now - Date.parse(ledger.updatedAt || '');
  if (failed || !ledger.publishable || !Number.isFinite(age) || age < 0 || age >= 10 * 60000) return null;
  return ledger.previews?.find((row) => row.size === size && row.legs.every((leg) => {
    const kickoff = Date.parse(leg.kickoffTime || '');
    const cutoff = Date.parse(leg.cutoffTime || leg.kickoffTime || '');
    return Number.isFinite(kickoff) && Number.isFinite(cutoff) && now < Math.min(kickoff, cutoff);
  })) || null;
}
