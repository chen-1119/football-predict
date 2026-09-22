import type { Match } from './mockData';
import type { RecommendationCenterData, SingleRow, Outcome } from './recommendationCenterView';

const sourceId = (value: unknown) => String(value || '').replace(/^sporttery_/, '');
const name = (value: unknown) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();

/** Match pages consume the same published record as the recommendation center.
 * An id alone is insufficient: a rescheduled or reused fixture must not inherit
 * a previous event's pick. Combo legs never replace the latest single record. */
export function publishedMatchRecommendation(data: RecommendationCenterData | null, match: Match): SingleRow | null {
  if (!data) return null;
  const event = Date.parse(match.kickoffTime || '');
  if (!Number.isFinite(event)) return null;
  const matches = (row: SingleRow) => {
    const d = row.decision;
    return sourceId(d.sourceMatchId) === sourceId(match.sourceMatchId || match.id)
      && Date.parse(d.eventVersion) === event && Date.parse(d.kickoffTime) === event
      && Boolean(match.homeTeamName && match.awayTeamName)
      && name(d.homeTeamName) === name(match.homeTeamName) && name(d.awayTeamName) === name(match.awayTeamName);
  };
  // Current is authoritative, just as on /best. Review is only its historical
  // counterpart; an old review row must not override a current publication.
  const rows = data.current.filter(matches);
  const candidates = rows.length ? rows : data.review.singles.filter(matches);
  return [...candidates].sort((a,b) => Date.parse(b.decision.publishedAt)-Date.parse(a.decision.publishedAt)
    || b.decision.decisionId.localeCompare(a.decision.decisionId))[0] || null;
}

export function usesPublishedRecommendation(match: Match, row: SingleRow | null, now = Date.now()): boolean {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0,10);
  return Boolean(row) || match.status === 'SCHEDULED' || match.status === 'LIVE'
    || Boolean(match.businessDate && match.businessDate >= today);
}

export function publishedPickLabel(code: Outcome, language: 'zh'|'en', handicap = false): string {
  return (handicap
    ? (language === 'zh' ? { '1':'让胜', X:'让平', '2':'让负' } : { '1':'Handicap home', X:'Handicap draw', '2':'Handicap away' })
    : (language === 'zh' ? { '1':'主胜', X:'平局', '2':'客胜' } : { '1':'Home', X:'Draw', '2':'Away' }))[code];
}

export function publishedResultLabel(row: SingleRow | null, language: 'zh'|'en'): string {
  if (!row) return language === 'zh' ? '待发布' : 'Awaiting publication';
  return (language === 'zh' ? { PENDING:'待赛果', WON:'命中', LOST:'未命中', VOID:'无效', DISPUTED:'赛果待核' }
    : { PENDING:'Pending', WON:'Won', LOST:'Lost', VOID:'Void', DISPUTED:'Disputed' })[row.settlement.state];
}
