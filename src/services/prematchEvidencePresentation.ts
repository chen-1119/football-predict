export type PrematchPlayer = { name: string; side?: 'home' | 'away'; reason?: string; position?: string; expectedReturn?: string; jersey?: string };
export type PrematchSection = {
  status: string; observedAt: string | null; lastAttemptAt: string | null; previousValue: boolean;
  missingReason?: string | null;
  data: { players?: PrematchPlayer[]; teams?: Array<{ side: 'home' | 'away'; formation: string; coach?: string; starters: PrematchPlayer[]; substitutes: PrematchPlayer[] }> } | null;
};
export type PrematchEvidenceState = 'loading' | 'not-collected' | 'source-empty' | 'stale' | 'previous' | 'reference' | 'unverified' | 'unavailable';

/** Display-only states. A returned envelope or saved payload is not proof of
 * fresh collection, model adoption, confirmed availability or formal eligibility. */
export function prematchEvidenceState(section: PrematchSection | undefined, responseStatus?: string): PrematchEvidenceState {
  if (responseStatus === undefined) return 'loading';
  if (section?.status === 'stale' || responseStatus === 'stale') return 'stale';
  if (section?.data) {
    if (section.previousValue) return 'previous';
    if (section.status !== 'available' || !section.observedAt || !Number.isFinite(Date.parse(section.observedAt))) return 'unverified';
    return 'reference';
  }
  if (section?.status === 'source_empty') return 'source-empty';
  if (section && ['missing', 'not-due', 'not-collected', 'not_collected'].includes(section.status)) return 'not-collected';
  if (['missing', 'not-collected', 'not_collected'].includes(responseStatus)) return 'not-collected';
  return 'unavailable';
}

export function prematchEvidenceLabel(state: PrematchEvidenceState, language: 'zh' | 'en'): string {
  const labels: Record<PrematchEvidenceState, [string, string]> = {
    loading: ['正在读取资料', 'Loading data'],
    'not-collected': ['尚未采集到资料', 'Not collected'],
    'source-empty': ['来源暂无可展示资料', 'No displayable source records'],
    stale: ['资料已过期 · 仅供参考', 'Stale data · reference only'],
    previous: ['上次记录 · 本轮未更新', 'Previous record · not updated this check'],
    reference: ['已采集 · 仅供参考', 'Collected · reference only'],
    unverified: ['资料状态待核验', 'Evidence status unverified'],
    unavailable: ['资料暂不可用', 'Data unavailable'],
  };
  return labels[state][language === 'zh' ? 0 : 1];
}

/** The API has no explicit injury-free attestation. Empty/missing rows must not
 * become a real-world zero, including a team absent from a partial list. */
export function prematchRecordCount(section: PrematchSection | undefined, kind: 'injuries' | 'lineup', side?: 'home' | 'away'): number | null {
  const rows = kind === 'injuries' ? section?.data?.players : section?.data?.teams;
  if (!Array.isArray(rows)) return null;
  const count = side ? rows.filter(row => row.side === side).length : rows.length;
  return count > 0 ? count : null;
}
