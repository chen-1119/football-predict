import type { Match, PredictionDetail } from './mockData';
import { getArchivedPreMatchPrediction } from './archivedPreMatchPrediction';

export interface ProvisionalArchivedOutcome {
  prediction: PredictionDetail;
  scoreHome: number;
  scoreAway: number;
  scoreText: string;
  resultStatus: 'WON' | 'LOST';
  observedAt?: string;
  provider: string;
}

const resultCode = (home: number, away: number): '1' | 'X' | '2' => (
  home > away ? '1' : home < away ? '2' : 'X'
);

const handicapResultCode = (
  home: number,
  away: number,
  handicapLine: string | undefined
): '1' | 'X' | '2' | null => {
  const line = Number(handicapLine);
  if (!Number.isFinite(line)) return null;
  return resultCode(home + line, away);
};

export const getProvisionalArchivedOutcome = (
  match: Match,
  now = Date.now()
): ProvisionalArchivedOutcome | null => {
  const evidence = match.provisionalResult;
  const scoreHome = Number(evidence?.scoreHome);
  const scoreAway = Number(evidence?.scoreAway);
  if (
    evidence?.status !== 'PROVISIONAL_RESULT_OBSERVED'
    || evidence.official !== false
    || evidence.trusted !== false
    || evidence.promotionEligible !== false
    || evidence.statisticsTrack !== 'shadow-provisional'
    || !Number.isInteger(scoreHome)
    || !Number.isInteger(scoreAway)
    || scoreHome < 0
    || scoreAway < 0
  ) return null;

  const kickoff = String(match.kickoffTime || '');
  if (evidence.eventVersion && kickoff && evidence.eventVersion !== kickoff) return null;

  const prediction = getArchivedPreMatchPrediction(match, now);
  if (!prediction) return null;
  const actualCode = prediction.oddsPoolCode === 'HHAD'
    ? handicapResultCode(scoreHome, scoreAway, prediction.handicapLine || match.handicapLine)
    : resultCode(scoreHome, scoreAway);
  if (!actualCode) return null;

  return {
    prediction,
    scoreHome,
    scoreAway,
    scoreText: `${scoreHome}:${scoreAway}`,
    resultStatus: prediction.tipCode === actualCode ? 'WON' : 'LOST',
    observedAt: evidence.latestObservedAt || evidence.observedAt,
    provider: evidence.provider || 'external'
  };
};
