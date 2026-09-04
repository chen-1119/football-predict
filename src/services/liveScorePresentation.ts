import type { Language } from '../context/AppContextCore';
import type { Match } from './mockData';

export type LiveScoreFreshness = 'fresh' | 'delayed' | 'stale' | 'unknown';

export interface LiveScorePresentation {
  active: boolean;
  hasScore: boolean;
  scoreText: string;
  phaseLabel: string;
  clockLabel: string;
  updatedLabel: string;
  sourceLabel: string;
  freshness: LiveScoreFreshness;
  observedAt: string | null;
  ageSeconds: number | null;
}

const LIVE_PHASES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);

const finiteNonNegativeInteger = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
};

const validIso = (...values: Array<unknown>): string | null => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && Number.isFinite(Date.parse(text))) return text;
  }
  return null;
};

const formatObservedTime = (iso: string | null, language: Language) => {
  if (!iso) return language === 'zh' ? '更新时间未知' : 'Update time unknown';
  return new Date(iso).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const phaseLabel = (phase: string, language: Language, inferredOnly = false) => {
  if (inferredOnly) return language === 'zh' ? '状态待确认' : 'Status unverified';
  const normalized = phase.toUpperCase();
  if (normalized === 'HT') return language === 'zh' ? '中场' : 'Half-time';
  if (normalized === 'ET') return language === 'zh' ? '加时' : 'Extra time';
  if (normalized === 'P') return language === 'zh' ? '点球' : 'Penalties';
  if (normalized === 'SUSP' || normalized === 'INT') return language === 'zh' ? '比赛暂停' : 'Suspended';
  return language === 'zh' ? '进行中' : 'Live';
};

/**
 * Produces a display-only live score. It never changes match settlement fields,
 * recommendation snapshots, or official result provenance.
 */
export const buildLiveScorePresentation = (
  match: Match,
  language: Language,
  nowMs = Date.now()
): LiveScorePresentation => {
  const observation = match.liveScore;
  const explicitPhase = String(observation?.phase || observation?.statusCode || '').trim().toUpperCase();
  const active = match.status === 'LIVE' || LIVE_PHASES.has(explicitPhase);
  const hasTrustedLiveObservation = Boolean(
    observation
    && observation.trusted === true
    && observation.settlementEligible === false
    && (explicitPhase
      || observation.minute !== null
      || observation.scoreHome !== undefined
      || observation.scoreAway !== undefined)
  );
  const nestedHome = finiteNonNegativeInteger(observation?.scoreHome);
  const nestedAway = finiteNonNegativeInteger(observation?.scoreAway);
  // Backward compatibility for already published live rows. These values are
  // presentation-only while status is LIVE and are never promoted to a final.
  const legacyHome = match.status === 'LIVE' ? finiteNonNegativeInteger(match.scoreHome) : null;
  const legacyAway = match.status === 'LIVE' ? finiteNonNegativeInteger(match.scoreAway) : null;
  const home = nestedHome ?? legacyHome;
  const away = nestedAway ?? legacyAway;
  const hasScore = active && home !== null && away !== null;
  const observedAt = validIso(
    observation?.observedAt,
    observation?.receivedAt,
    match.sourceObservedAt,
    match.firstInPlayObservedAt
  );
  const observedMs = Date.parse(observedAt || '');
  const ageSeconds = Number.isFinite(observedMs)
    ? Math.max(0, Math.floor((nowMs - observedMs) / 1000))
    : null;
  const freshness: LiveScoreFreshness = ageSeconds === null
    ? 'unknown'
    : ageSeconds <= 90
      ? 'fresh'
      : ageSeconds <= 180
        ? 'delayed'
        : 'stale';
  const explicitMinute = finiteNonNegativeInteger(observation?.minute);
  const clockLabel = explicitMinute !== null
    ? `${Math.min(120, explicitMinute)}′`
    : explicitPhase === 'HT'
      ? (language === 'zh' ? '中场' : 'HT')
      : active && !hasTrustedLiveObservation
        ? (language === 'zh' ? '状态待确认' : 'Status unverified')
        : '';
  const provider = String(observation?.provider || observation?.source || '').trim();
  const sourceLabel = hasTrustedLiveObservation && provider
    ? provider
    : language === 'zh'
      ? '赛程时间推算（非实时）'
      : 'Schedule-time inference (not live)';
  const freshnessLabel = freshness === 'fresh'
    ? (language === 'zh' ? '实时' : 'live')
    : freshness === 'delayed'
      ? (language === 'zh' ? '稍有延迟' : 'slightly delayed')
      : freshness === 'stale'
        ? (language === 'zh' ? '更新延迟' : 'delayed')
        : (language === 'zh' ? '待确认' : 'unverified');

  return {
    active,
    hasScore,
    scoreText: hasScore ? `${home}:${away}` : '--:--',
    phaseLabel: phaseLabel(explicitPhase, language, active && !hasTrustedLiveObservation),
    clockLabel,
    updatedLabel: hasTrustedLiveObservation
      ? `${formatObservedTime(observedAt, language)} · ${freshnessLabel}`
      : (language === 'zh' ? '未收到可信实时观测' : 'No trusted live observation'),
    sourceLabel,
    freshness,
    observedAt,
    ageSeconds
  };
};
