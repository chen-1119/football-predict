import type { Match, PredictionDetail } from './mockData';
import { getLeagueById } from './entities';
import { getFormalRecommendationPrediction } from './displayRecommendation';

export const WORLD_CUP_START_DATE = '2026-06-11';
export const WORLD_CUP_FINAL_DATE = '2026-07-19';

const WORLD_CUP_COMPETITION_PATTERN = /\u4e16\u754c\u676f|FIFA\s*World\s*Cup|World\s*Cup/i;
const WORLD_CUP_EXCLUDE_PATTERN = /\u4e16\u9884|\u9884\u9009|\u8d44\u683c|\u5916\u56f4\u8d5b|\u53cb\u8c0a|\u56fd\u9645\u8d5b|\u56fd\u5bb6\u8054\u8d5b|qualification|qualifier|qualifying|friendly|international friendly|nations league/i;
const WORLD_CUP_START_MS = Date.parse(`${WORLD_CUP_START_DATE}T00:00:00-12:00`);
const WORLD_CUP_END_MS = Date.parse(`${WORLD_CUP_FINAL_DATE}T23:59:59+14:00`);

export type WorldCupPhase = 'upcoming' | 'live' | 'finished';

export function getBestPrediction(match: Match): PredictionDetail | undefined {
  return getFormalRecommendationPrediction(match);
}

export function getAnalysisReferencePrediction(match: Match): PredictionDetail | undefined {
  return match.predictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && prediction.tipCode !== 'WATCH'
  )) || match.predictions.find((prediction) => (
    prediction.marketType === '1X2'
    && prediction.tipCode !== 'WATCH'
  ));
}

const getMatchTrust = (match: Match) => getBestPrediction(match)?.trustScore || 0;

const isWithinWorldCupWindow = (kickoffTime?: string): boolean => {
  if (!kickoffTime) return false;
  const time = Date.parse(kickoffTime);
  return Number.isFinite(time) && time >= WORLD_CUP_START_MS && time <= WORLD_CUP_END_MS;
};

export function isWorldCupRelevantMatch(match: Match): boolean {
  const league = getLeagueById(match.leagueId);
  const fields = [
    match.leagueId,
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.leagueShortNameEn,
    match.externalSignals?.leagueName,
    league.name.zh,
    league.name.en,
    league.shortName.zh,
    league.shortName.en
  ].filter(Boolean);
  const text = fields.join(' ');
  const hasExplicitWorldCupField = fields.some((value) => {
    const normalized = String(value || '').trim();
    return normalized === '\u4e16\u754c\u676f'
      || /^\u4e16\u754c\u676f\s+/i.test(normalized)
      || /^FIFA\s+World\s+Cup$/i.test(normalized)
      || /^World\s+Cup(\s+|$)/i.test(normalized);
  });

  return WORLD_CUP_COMPETITION_PATTERN.test(text)
    && (hasExplicitWorldCupField || !WORLD_CUP_EXCLUDE_PATTERN.test(text))
    && isWithinWorldCupWindow(match.kickoffTime);
}

export function getWorldCupWatchMatches(matches: Match[], max = 6): Match[] {
  return matches
    .filter((match) => match.status !== 'FINISHED' && match.status !== 'PENDING_RESULT')
    .filter(isWorldCupRelevantMatch)
    .sort((a, b) => {
      const timeDiff = Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime);
      return timeDiff || getMatchTrust(b) - getMatchTrust(a);
    })
    .slice(0, max);
}

export function getDaysUntilWorldCup(now = new Date()): number {
  return Math.max(0, Math.ceil((WORLD_CUP_START_MS - now.getTime()) / 86_400_000));
}

export function getWorldCupPhase(now = new Date()): WorldCupPhase {
  if (now.getTime() < WORLD_CUP_START_MS) return 'upcoming';
  if (now.getTime() <= WORLD_CUP_END_MS) return 'live';
  return 'finished';
}
