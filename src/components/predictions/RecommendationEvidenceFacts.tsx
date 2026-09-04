import type { Match, PredictionDetail } from '../../services/mockData';
import {
  formatCalibrationSample,
  formatEvidenceCompleteness,
  formatFreshnessQuality,
  formatMarketConsistency,
  getPublishedRecommendationEvidenceBreakdown,
} from '../../services/predictionPresentation';
import '../../styles/recommendation-evidence.css';

interface RecommendationEvidenceFactsProps {
  match: Match;
  prediction?: PredictionDetail | null;
  language: 'zh' | 'en';
  className?: string;
}

const joinClassNames = (...names: Array<string | false | null | undefined>) => (
  names.filter(Boolean).join(' ')
);

type FreshnessClockKind = 'observed-at' | 'source-updated-at' | 'as-of' | 'unavailable';

const resolveFreshnessClock = (
  breakdown: ReturnType<typeof getPublishedRecommendationEvidenceBreakdown>
): { kind: FreshnessClockKind; value: string | null } => {
  if (breakdown.freshnessObservedAt) {
    return { kind: 'observed-at', value: breakdown.freshnessObservedAt };
  }
  if (breakdown.freshnessSourceUpdatedAt) {
    return { kind: 'source-updated-at', value: breakdown.freshnessSourceUpdatedAt };
  }
  if (breakdown.freshnessAsOf) {
    return { kind: 'as-of', value: breakdown.freshnessAsOf };
  }
  return { kind: 'unavailable', value: null };
};

const formatFreshnessClock = (
  clock: { kind: FreshnessClockKind; value: string | null },
  language: 'zh' | 'en'
) => {
  const value = clock.value;
  const observedAt = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(observedAt)) {
    return language === 'zh' ? '观测时间未知' : 'Observation time unknown';
  }
  const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(observedAt);
  const prefix = clock.kind === 'observed-at'
    ? (language === 'zh' ? '观测' : 'Observed')
    : clock.kind === 'source-updated-at'
      ? (language === 'zh' ? '源更新' : 'Source updated')
      : (language === 'zh' ? '截至' : 'As of');
  return `${prefix} ${formatted}`;
};

export function RecommendationEvidenceFacts({
  match,
  prediction,
  language,
  className,
}: RecommendationEvidenceFactsProps) {
  const breakdown = getPublishedRecommendationEvidenceBreakdown(match, prediction);
  const modelProbability = breakdown.modelProbability === null
    ? '--'
    : `${Math.round(breakdown.modelProbability)}%`;
  const evidenceCompleteness = formatEvidenceCompleteness(breakdown, '--');
  const marketConsistency = formatMarketConsistency(breakdown, language, '--');
  const freshnessQuality = formatFreshnessQuality(breakdown, '--');
  const calibrationSample = formatCalibrationSample(breakdown, '--');
  const freshnessClock = resolveFreshnessClock(breakdown);
  const freshnessObservedLabel = formatFreshnessClock(freshnessClock, language);

  return (
    <section
      className={joinClassNames('recommendation-evidence-facts', className)}
      data-testid="recommendation-evidence-breakdown"
      data-market-consistency={breakdown.marketConsistency}
      aria-label={language === 'zh' ? '推荐置信度四维事实' : 'Four-dimension confidence facts'}
    >
      <dl className="recommendation-evidence-facts__grid">
        <div className={breakdown.modelProbability === null ? 'is-unavailable' : ''}>
          <dt>{language === 'zh' ? '模型概率' : 'Model probability'}</dt>
          <dd>{modelProbability}</dd>
        </div>
        <div className={breakdown.evidenceCompleteness === null ? 'is-unavailable' : ''}>
          <dt>{language === 'zh' ? '证据完整度' : 'Evidence completeness'}</dt>
          <dd>{evidenceCompleteness}</dd>
        </div>
        <div className={`is-market-${breakdown.marketConsistency}`}>
          <dt>{language === 'zh' ? '市场一致性' : 'Market consistency'}</dt>
          <dd>{marketConsistency}</dd>
        </div>
        <div className={breakdown.freshnessQuality === null ? 'is-unavailable' : ''}>
          <dt>{language === 'zh' ? '数据时效' : 'Data freshness'}</dt>
          <dd>
            <span>{freshnessQuality}</span>
            <small data-freshness-clock={freshnessClock.kind}>{freshnessObservedLabel}</small>
          </dd>
        </div>
      </dl>
      <p className="recommendation-evidence-facts__sample">
        <span>{language === 'zh' ? '校准样本' : 'Calibration sample'}</span>
        <strong>{calibrationSample}</strong>
      </p>
    </section>
  );
}
