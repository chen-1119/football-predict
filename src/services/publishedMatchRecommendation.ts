import type { Match, OutcomeProbability } from './mockData';
import type { RecommendationCenterData, SingleRow, Outcome, Decision } from './recommendationCenterView';

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

function uniquePosteriorLeader(probabilities: OutcomeProbability | null | undefined): Outcome | null {
  if (!probabilities) return null;
  const values: Array<[Outcome, number]> = [
    ['1', probabilities.home], ['X', probabilities.draw], ['2', probabilities.away]
  ];
  if (values.some(([, value]) => !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, [, value]) => sum + value, 0);
  if (!(Math.abs(total - 1) <= .02 || Math.abs(total - 100) <= 2)) return null;
  values.sort((left, right) => right[1] - left[1]);
  return values[0][1] - values[1][1] > 1e-9 ? values[0][0] : null;
}

function matchesFrozenProbabilities(final: OutcomeProbability | null | undefined, frozen: Decision['probabilities']): boolean {
  if (!final || !frozen) return false;
  const pairs: Array<[number, number]> = [[final.home, frozen['1']], [final.draw, frozen.X], [final.away, frozen['2']]];
  if (pairs.some(([model, published]) => !Number.isFinite(model) || !Number.isFinite(published)
    || model < 0 || published < 0 || published > 1)) return false;
  const modelTotal = final.home + final.draw + final.away;
  const scale = Math.abs(modelTotal - 100) <= 2 ? 100 : Math.abs(modelTotal - 1) <= .02 ? 1 : null;
  if (!scale || Math.abs(frozen['1'] + frozen.X + frozen['2'] - 1) > .02) return false;
  // The public record may round each percentage to a tenth of a point.
  return pairs.every(([model, published]) => Math.abs(model / scale - published) <= .002);
}

/** Compare an aligned supplemental model output with the immutable HAD record.
 * Time, event and frozen final probabilities must agree, but there is no
 * posterior content hash proving that the published decision adopted it. */
export function publishedPosteriorDisagreement(match: Match, decision: Decision | null): {
  published: Outcome; research: Outcome;
} | null {
  const model = match.probabilityModel;
  if (!decision || !model?.generatedAt || decision.matchId !== match.id
    || sourceId(match.sourceMatchId || match.id) !== sourceId(decision.sourceMatchId)) return null;
  const event = Date.parse(match.kickoffTime);
  const publishedEvent = Date.parse(decision.eventVersion);
  const modelTime = Date.parse(model.generatedAt);
  const publishedModelTime = Date.parse(decision.modelGeneratedAt);
  if (![event, publishedEvent, modelTime, publishedModelTime].every(Number.isFinite)
    || event !== publishedEvent || modelTime !== publishedModelTime
    || !matchesFrozenProbabilities(model.oneXTwo?.final, decision.probabilities)) return null;
  const research = uniquePosteriorLeader(model.oneXTwo?.unifiedPosterior);
  return research && research !== decision.tipCode
    ? { published: decision.tipCode, research }
    : null;
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
