import React from 'react';
import { Calendar, ShieldAlert, Trophy } from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getOfficialMatchOdds, getPredictionTipDisplay, getPredictionValueLabel, isPredictionOfficialResultPoolAvailable } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import type { Match, PredictionDetail } from '../services/mockData';
import { isOfficialRecommendationEligible } from '../services/officialRecommendationEligibility';
import {
  isLiveRecommendationEligible,
  isLiveRecommendationWindowOpen,
  liveRecommendationCutoffIso
} from '../services/liveRecommendationEligibility';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { getVisiblePredictions } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import {
  selectOnSaleAnalysisReference,
  type AnalysisReferenceSource
} from '../services/analysisReferenceSelection';
import {
  formatCalibratedModelProbability,
  formatEvidenceScore,
  getEvidenceScore,
  isFormalPresentationAllowed
} from '../services/predictionPresentation';
import { evaluateBenchmarkSelection } from '../services/benchmarkSelectionPolicy.cjs';
import '../styles/best-tips.css';

interface BestTipsProps {
  onSelectMatch: (matchId: string) => void;
}

type TipCard = {
  match: Match;
  prediction: PredictionDetail;
  pickLabel: string;
  rankScore: number;
  publicationTrack?: 'formal' | 'live';
  benchmarkQualified: boolean;
};

type ObservationCard = TipCard & {
  blockers: string[];
  evidenceScore: number | null;
  displayOdds: number | null;
  referenceSource: AnalysisReferenceSource;
  sourceUpdatedAt: string | null;
  saleClosed: boolean;
};

type Language = 'zh' | 'en';

const isOutcomeTipCode = (tipCode: string | undefined) => tipCode === '1' || tipCode === 'X' || tipCode === '2';

const getCleanPickLabel = (prediction: PredictionDetail, language: Language) => {
  if (isOutcomeTipCode(prediction.tipCode)) {
    if (prediction.oddsPoolCode === 'HHAD') {
      if (language === 'zh') return prediction.tipCode === '1' ? '让胜' : prediction.tipCode === 'X' ? '让平' : '让负';
      return prediction.tipCode === '1' ? 'HHAD home' : prediction.tipCode === 'X' ? 'HHAD draw' : 'HHAD away';
    }
    if (language === 'zh') return prediction.tipCode === '1' ? '主胜' : prediction.tipCode === 'X' ? '平局' : '客胜';
    return prediction.tipCode === '1' ? 'Home win' : prediction.tipCode === 'X' ? 'Draw' : 'Away win';
  }
  return getPredictionTipDisplay(prediction, language);
};

const formatKickoffTime = (kickoffTime: string, language: Language) => (
  new Date(kickoffTime).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  })
);

const formatAuditTime = (value: string | null | undefined, language: Language) => {
  const millis = Date.parse(value || '');
  if (!Number.isFinite(millis)) return '--';
  return new Date(millis).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const getOfficialPredictionOdds = (match: Match, prediction: PredictionDetail) => {
  if (!isOutcomeTipCode(prediction.tipCode)) return 0;
  const official = getOfficialMatchOdds(match);
  const odds = prediction.oddsPoolCode === 'HHAD' ? official.hhad?.odds : official.had?.odds;
  const value = prediction.tipCode === '1' ? odds?.odds1 : prediction.tipCode === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
};

const getOfficialPredictionHandicapLine = (match: Match, prediction: PredictionDetail) => (
  prediction.oddsPoolCode === 'HHAD' ? getOfficialMatchOdds(match).hhad?.handicap : 0
);

const getCandidatePrediction = (match: Match) => {
  return getVisiblePredictions(match)
    .map((prediction) => ({
      prediction,
      officialOdds: getOfficialPredictionOdds(match, prediction)
    }))
    .filter(({ prediction, officialOdds }) => (
      isPredictionOfficialResultPoolAvailable(match, prediction)
      && isOfficialRecommendationEligible(
        prediction,
        officialOdds,
        getOfficialPredictionHandicapLine(match, prediction)
      )
    ))
    .sort((a, b) => (b.prediction.trustScore || 0) - (a.prediction.trustScore || 0))
    .map(({ prediction, officialOdds }) => ({ ...prediction, odds: officialOdds }))[0];
};

const getLiveCandidatePrediction = (match: Match, now = Date.now()) => {
  if (!isLiveRecommendationWindowOpen(match, now)) return undefined;
  return getVisiblePredictions(match)
    .map((prediction) => ({
      prediction,
      officialOdds: getOfficialPredictionOdds(match, prediction)
    }))
    .filter(({ prediction, officialOdds }) => (
      prediction.marketType === 'BEST'
      && isPredictionOfficialResultPoolAvailable(match, prediction)
      && isLiveRecommendationEligible(
        prediction,
        officialOdds,
        getOfficialPredictionHandicapLine(match, prediction),
        match
      )
    ))
    .sort((a, b) => Number(b.prediction.multiFactorEvidence?.evidenceScore || 0)
      - Number(a.prediction.multiFactorEvidence?.evidenceScore || 0))
    .map(({ prediction, officialOdds }) => ({ ...prediction, odds: officialOdds }))[0];
};

const observationBlockerLabels: Record<string, { zh: string; en: string }> = {
  'upstream-multi-factor-gate-not-passed': { zh: '上游多因素门槛未通过', en: 'Upstream multi-factor gate did not pass' },
  'model-risk-not-promotable': { zh: '模型风险状态暂不可发布', en: 'Model risk state is not publishable' },
  'insufficient-data-quality': { zh: '赛前数据质量不足', en: 'Pre-match data quality is insufficient' },
  'too-many-severe-data-gaps': { zh: '关键数据缺口过多', en: 'Too many critical data gaps' },
  'had-hhad-conflict': { zh: '胜平负与让球盘方向冲突', en: 'HAD and HHAD directions conflict' },
  'candidate-risk-too-high': { zh: '候选方向风险过高', en: 'Candidate risk is too high' },
  'evidence-score-below-threshold': { zh: '多因素证据分未达门槛', en: 'Evidence score is below threshold' },
  'negative-expected-value': { zh: '期望价值未通过', en: 'Expected value did not pass' },
  'too-many-risk-tags': { zh: '风险标签过多', en: 'Too many risk flags' },
  'market-implied-probability-contradiction': { zh: '模型方向与市场概率矛盾', en: 'Model direction conflicts with market probability' },
  'low-sp-without-model-edge': { zh: '低 SP 方向没有足够模型优势', en: 'Low-SP side lacks enough model edge' },
  'low-sp-without-value': { zh: '低 SP 方向没有足够价值', en: 'Low-SP side lacks enough value' },
  'model-probability-too-low': { zh: '模型概率未达门槛', en: 'Model probability is below threshold' }
};

const getObservationBlockers = (
  prediction: PredictionDetail,
  language: Language
) => {
  const blockerCodes = prediction.multiFactorEvidence?.blockers || [];
  const labels = blockerCodes.map((code) => (
    observationBlockerLabels[code]?.[language]
    || (language === 'zh' ? `门槛未通过：${code}` : `Gate not passed: ${code}`)
  ));

  if (labels.length > 0) return labels.slice(0, 3);
  if (!prediction.multiFactorEvidence) {
    return [language === 'zh' ? '多因素证据链尚未完成' : 'Multi-factor evidence is incomplete'];
  }
  if (prediction.recommendationAction !== 'recommend') {
    return [language === 'zh' ? '当前归入数据推荐并独立统计' : 'Currently tracked as a separate data pick'];
  }
  return [language === 'zh' ? '未通过正式推荐发布门槛' : 'Formal publication gate did not pass'];
};

const isLowEvidenceMarketSource = (source: AnalysisReferenceSource) => (
  source === 'official-low-evidence-market'
  || source === 'five-hundred-low-evidence-market'
);

const getObservationMetric = (card: ObservationCard, language: Language) => {
  const oddsPrefix = card.displayOdds && card.displayOdds > 1
    ? `@${card.displayOdds.toFixed(2)} · `
    : '';

  if (isLowEvidenceMarketSource(card.referenceSource)) {
    const probability = Number(card.prediction.trustScore || 0);
    const probabilityLabel = probability > 0 ? `${probability.toFixed(0)}%` : '--';
    return language === 'zh'
      ? `${oddsPrefix}市场去水概率 ${probabilityLabel} · 证据等级低`
      : `${oddsPrefix}De-vigged market probability ${probabilityLabel} · Low evidence`;
  }

  const evidenceLabel = card.evidenceScore === null
    ? '--'
    : `${card.evidenceScore.toFixed(0)}/100`;
  return language === 'zh'
    ? `${oddsPrefix}证据评分 ${evidenceLabel}`
    : `${oddsPrefix}Evidence score ${evidenceLabel}`;
};

export const BestTips: React.FC<BestTipsProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const [now, setNow] = React.useState(() => Date.now());
  const formalPresentationAllowed = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode
  );

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const tipCards = React.useMemo<TipCard[]>(() => {
    return matches
      .filter((match) => {
        return match.status === 'SCHEDULED'
          && (isBeforeMatchSaleCutoff(match, now) || isLiveRecommendationWindowOpen(match, now));
      })
      .map((match): TipCard | null => {
        const formalPrediction = formalPresentationAllowed && isBeforeMatchSaleCutoff(match, now)
          ? getCandidatePrediction(match)
          : undefined;
        const prediction = formalPrediction || getLiveCandidatePrediction(match, now);
        if (!prediction) return null;
        const pickLabel = getCleanPickLabel(prediction, language);
        const benchmarkQualified = evaluateBenchmarkSelection(prediction).qualified;
        const kickoffAt = Date.parse(match.kickoffTime);
        const timeScore = Number.isFinite(kickoffAt) ? Math.max(0, 100 - Math.floor((kickoffAt - now) / 36e5)) : 0;
        return {
          match,
          prediction,
          pickLabel,
          publicationTrack: formalPrediction ? 'formal' : 'live',
          benchmarkQualified,
          rankScore: (benchmarkQualified ? 1000 : 0)
            + Number(prediction.multiFactorEvidence?.evidenceScore || 0) * 4
            + (prediction.trustScore || 0) * 2
            + timeScore
        };
      })
      .filter((card): card is TipCard => Boolean(card))
      .sort((a, b) => {
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime);
      });
  }, [formalPresentationAllowed, language, matches, now]);

  const observationCards = React.useMemo<ObservationCard[]>(() => {
    const publishedMatchIds = new Set(tipCards.map((card) => card.match.id));

    return matches
      .filter((match) => {
        return match.status === 'SCHEDULED'
          && Date.parse(match.kickoffTime) > now
          && !publishedMatchIds.has(match.id);
      })
      .map((match) => {
        const reference = selectOnSaleAnalysisReference(match, { allowModelOnly: false, now });
        if (!reference) return null;
        const prediction = reference.prediction;
        const kickoffAt = Date.parse(match.kickoffTime);
        const timeScore = Number.isFinite(kickoffAt) ? Math.max(0, 100 - Math.floor((kickoffAt - now) / 36e5)) : 0;
        const evidenceScore = getEvidenceScore(prediction);
        const benchmarkQualified = evaluateBenchmarkSelection(prediction).qualified;
        const saleClosed = !isBeforeMatchSaleCutoff(match, now);
        const sourceBlocker = saleClosed
          ? (language === 'zh'
            ? '售卖已截止；仅保留截止前锁定数据，不可执行'
            : 'Sales are closed; this locked pre-cutoff snapshot is retained for review only and is not executable')
          : reference.source === 'official-calibrated-market'
          ? (language === 'zh' ? '官方去水市场数据推荐；模型尚未通过正式晋级' : 'Official de-vigged market data pick; model promotion is pending')
          : reference.source === 'official-market-consensus'
            ? (language === 'zh' ? '官方去水市场首位达到数据推荐门槛；独立复盘' : 'Official de-vigged market leader passed the data-pick gate and is reviewed separately')
          : reference.source === 'five-hundred-market'
            ? (language === 'zh' ? '500 非官方去水市场数据推荐；独立复盘' : '500.com non-official market data pick; reviewed separately')
          : reference.source === 'official-low-evidence-market'
            ? (language === 'zh' ? '官方 HAD 概率首位低置信推荐；风险较高并独立复盘' : 'Official HAD probability leader, low-confidence pick with separate review')
          : reference.source === 'model-low-evidence'
            ? (language === 'zh' ? '\u65e0\u5728\u552e SP\uff0c\u4fdd\u7559\u8d5b\u524d\u6a21\u578b\u4f4e\u7f6e\u4fe1\u6570\u636e\u63a8\u8350\u5e76\u72ec\u7acb\u590d\u76d8' : 'No on-sale SP; retain the low-confidence pre-match model data pick for separate review')
          : reference.source === 'five-hundred-low-evidence-market'
            ? (language === 'zh' ? '500 HAD 概率首位低置信推荐；风险较高并独立复盘' : '500.com HAD probability leader, low-confidence pick with separate review')
            : null;
        return {
          match,
          prediction,
          pickLabel: getCleanPickLabel(prediction, language),
          blockers: [
            ...(sourceBlocker ? [sourceBlocker] : []),
            ...(!formalPresentationAllowed && !sourceBlocker
              ? [language === 'zh' ? '模型或数据源风险状态暂不可发布' : 'Model or source risk state is not publishable']
              : []),
            ...getObservationBlockers(prediction, language)
          ].slice(0, 3),
          evidenceScore,
          displayOdds: reference.displayOdds,
          referenceSource: reference.source,
          sourceUpdatedAt: reference.sourceUpdatedAt,
          saleClosed,
          benchmarkQualified,
          rankScore: (benchmarkQualified ? 1000 : 0) + reference.rankScore * 4 + timeScore
        };
      })
      .filter((card): card is ObservationCard => Boolean(card))
      .sort((a, b) => {
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime);
      });
  }, [formalPresentationAllowed, language, matches, now, tipCards]);

  const featuredMatchIds = React.useMemo(() => new Set(
    [...tipCards, ...observationCards]
      .slice(0, 3)
      .map((card) => card.match.id)
  ), [observationCards, tipCards]);

  const translations = {
    title: { zh: '赛前推荐', en: 'Pre-match Picks' },
    subtitle: {
      zh: '优先展示通过正式门槛的推荐；未开售或缺少官方 SP 的比赛明确显示待开售，不给出方向。',
      en: 'Prioritizes formally qualified picks; matches without official SP on sale are clearly marked unavailable and receive no direction.'
    },
    confidence: { zh: '证据评分', en: 'Evidence Score' },
    odds: { zh: '赔率', en: 'Odds' },
    kickoff: { zh: '开赛', en: 'Kickoff' },
    viewDetail: { zh: '查看分析', en: 'Analyze' },
    noTips: {
      zh: '当前没有可展示的赛前推荐，数据同步完成后会自动更新。',
      en: 'No pre-match recommendation is available yet. The page will update after sync.'
    },
    noFormalTips: { zh: '暂无可发布推荐', en: 'No publishable picks' },
    loading: { zh: '正在同步正式推荐池', en: 'Loading the formal-pick pool' },
    loadingNote: { zh: '正在读取当前赛程、官方赔率与发布门槛。', en: 'Reading current fixtures, official odds and publication gates.' },
    loadError: { zh: '当前数据加载失败', en: 'Current data failed to load' },
    loadErrorNote: { zh: '尚未取得可信的当前快照，请稍后重试；这里不会把加载失败显示成“暂无推荐”。', en: 'No trusted current snapshot is available yet. Try again shortly; a load failure is not shown as an empty pick pool.' },
    observationIntro: {
      zh: '页面展示全部合格推荐，并标出重点 3 场；未进入正式统计的数据推荐会注明来源与原因。',
      en: 'All qualified picks remain visible, with three featured picks; data picks outside formal statistics show their source and reason.'
    },
    observation: { zh: '数据推荐', en: 'Data pick' },
    notFormal: { zh: '独立统计', en: 'Separate stats' },
    blockers: { zh: '推荐依据', en: 'Pick basis' },
    evidence: { zh: '证据评分', en: 'Evidence score' },
    pick: { zh: '推荐', en: 'Pick' },
    pickCount: { zh: '推荐', en: 'Picks' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const isInitialLoading = Boolean(dataSync.currentLoading && !dataSync.currentLoaded);
  const hasInitialLoadError = Boolean(dataSync.error && !dataSync.currentLoaded);

  return (
    <section className="best-pool-v4" aria-labelledby="formal-pool-title">
      <header className="best-pool-v4__header">
        <div>
          <span className="best-pool-v4__eyebrow">
            {language === 'zh' ? '全部赛前推荐 · 重点 3 场' : 'All pre-match picks · Top 3 featured'}
          </span>
          <h1 id="formal-pool-title">{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <div className={`best-pool-v4__metric ${tipCards.length + observationCards.length > 0 ? 'is-formal' : 'is-empty'}`}>
          <span>{t('pickCount')}</span>
          <strong>{tipCards.length + observationCards.length}</strong>
        </div>
      </header>

      {isInitialLoading ? (
        <div className="best-pool-v4__state" role="status" aria-live="polite" aria-atomic="true">
          <span className="best-pool-v4__loader" aria-hidden="true" />
          <div><strong>{t('loading')}</strong><p>{t('loadingNote')}</p></div>
        </div>
      ) : hasInitialLoadError ? (
        <div className="best-pool-v4__state is-error" role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div><strong>{t('loadError')}</strong><p>{t('loadErrorNote')}</p></div>
        </div>
      ) : tipCards.length === 0 && observationCards.length === 0 ? (
        <div className="best-pool-v4__empty">
          <div className="best-pool-v4__empty-summary" role="status">
            <ShieldAlert size={19} aria-hidden="true" />
            <div><strong>{t('noFormalTips')}</strong><p>{t('observationIntro')}</p></div>
          </div>

          {observationCards.length > 0 ? (
            <section className="best-pool-v4__observations" aria-label={language === 'zh' ? '今日数据推荐' : 'Today data picks'}>
              <header>
                <span>{language === 'zh' ? `${observationCards.length} 场数据推荐` : `${observationCards.length} data picks`}</span>
                <small>{t('notFormal')}</small>
              </header>
              <div className="best-pool-v4__rows">
                {observationCards.map((card) => {
                  const { match, prediction, pickLabel, benchmarkQualified } = card;
                  const homeTeam = getTeamById(match.homeTeamId);
                  const awayTeam = getTeamById(match.awayTeamId);
                  const formattedTime = formatKickoffTime(match.kickoffTime, language);
                  const isFeatured = featuredMatchIds.has(match.id);
                  return (
                    <article
                      key={`observation-${match.id}-${prediction.marketType}-${prediction.tipCode}-${prediction.oddsPoolCode || 'pool'}`}
                      className="best-pool-v4__row is-observation"
                    >
                      <div className="best-pool-v4__time"><strong>{formattedTime}</strong><span>{benchmarkQualified
                        ? (language === 'zh' ? '对标精选候选 · 影子' : 'Benchmark candidate · Shadow')
                        : isFeatured
                          ? (language === 'zh' ? '重点 · 数据推荐' : 'Featured · Data pick')
                          : t('observation')}</span></div>
                      <div className="best-pool-v4__teams">
                        <span><TeamBadge team={homeTeam} size="sm" />{homeTeam.name[language]}</span>
                        <span><TeamBadge team={awayTeam} size="sm" />{awayTeam.name[language]}</span>
                      </div>
                      <div className="best-pool-v4__pick">
                        <span>{getPredictionValueLabel(prediction, language)}</span>
                        <strong>{pickLabel}</strong>
                        <small>{getObservationMetric(card, language)}</small>
                      </div>
                      <div className="best-pool-v4__blockers">
                        <span>{t('blockers')}</span>
                        <p>{card.blockers.join(' · ')}</p>
                      </div>
                      <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action">
                        {t('viewDetail')}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="best-pool-v4__none"><Calendar size={18} aria-hidden="true" /><p>{t('noTips')}</p></div>
          )}
        </div>
      ) : (
        <div className="best-pool-v4__rows is-formal-list">
          {tipCards.map((card) => {
            const { match, prediction, pickLabel, publicationTrack, benchmarkQualified } = card;
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const publicCopy = buildPublicRecommendationCopy(match, prediction, language, { pickLabel });
            const evidenceScore = formatEvidenceScore(prediction);
            const modelProbability = formatCalibratedModelProbability(match, prediction);
            const formattedTime = formatKickoffTime(match.kickoffTime, language);
            const dataAsOf = formatAuditTime(
              match.predictionMeta?.lockedAt || match.predictionMeta?.generatedAt || match.oddsUpdatedAt,
              language
            );
            const cutoffAt = formatAuditTime(liveRecommendationCutoffIso(match) || undefined, language);
            const isFeatured = featuredMatchIds.has(match.id);
            return (
              <article
                key={`${match.id}-${prediction.marketType}-${prediction.tipCode}-${prediction.oddsPoolCode || 'pool'}`}
                className="best-pool-v4__row is-formal"
              >
                <div className="best-pool-v4__time"><strong>{formattedTime}</strong><span>{t('kickoff')}</span></div>
                <div className="best-pool-v4__teams">
                  <span><TeamBadge team={homeTeam} size="sm" />{homeTeam.name[language]}</span>
                  <span><TeamBadge team={awayTeam} size="sm" />{awayTeam.name[language]}</span>
                </div>
                <div className="best-pool-v4__pick">
                  <span>{benchmarkQualified
                    ? (language === 'zh' ? '对标精选候选 · 影子 · ' : 'Benchmark candidate · Shadow · ')
                    : isFeatured
                      ? (language === 'zh' ? '重点 · ' : 'Featured · ')
                      : ''}{publicationTrack === 'formal'
                    ? (language === 'zh' ? '正式推荐' : 'Formal pick')
                    : (language === 'zh' ? '实时推荐' : 'Live pick')} · {getPredictionValueLabel(prediction, language)}</span>
                  <strong>{pickLabel}</strong>
                  <small>@{prediction.odds.toFixed(2)} · {t('confidence')} {evidenceScore}{modelProbability ? ` · ${modelProbability}` : ''}</small>
                  <small className="best-pool-v4__governance">
                    {language === 'zh'
                      ? `数据 ${dataAsOf} · 截止 ${cutoffAt} · ${publicationTrack === 'formal' ? '计入正式命中率' : '不计入正式命中率'}`
                      : `Data ${dataAsOf} · Cutoff ${cutoffAt} · ${publicationTrack === 'formal' ? 'Included in formal record' : 'Excluded from formal record'}`}
                  </small>
                </div>
                <div className="best-pool-v4__reason"><span>{language === 'zh' ? '主要依据' : 'Primary evidence'}</span><p>{publicCopy.reasons[0]}</p>{publicationTrack === 'live' && <small>{language === 'zh' ? '实时推荐单独归档，不计入正式命中率。' : 'Live picks are archived separately and excluded from the formal hit rate.'}</small>}{prediction.liveRecommendation?.dataCoverageWarning && <small>{language === 'zh' ? '辅助数据覆盖偏低，仅按强市场核心证据发布。' : 'Auxiliary data coverage is low; published on strong market-core evidence only.'}</small>}</div>
                <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action is-formal">
                  <Trophy size={14} aria-hidden="true" />{t('viewDetail')}
                </button>
              </article>
            );
          })}
          {observationCards.map((card) => {
            const { match, prediction, pickLabel } = card;
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const formattedTime = formatKickoffTime(match.kickoffTime, language);
            const dataAsOf = formatAuditTime(
              card.sourceUpdatedAt
                || match.predictionMeta?.lockedAt
                || match.predictionMeta?.generatedAt
                || match.oddsUpdatedAt,
              language
            );
            const cutoffAt = formatAuditTime(liveRecommendationCutoffIso(match) || undefined, language);
            const isFeatured = featuredMatchIds.has(match.id);
            const cardStateLabel = card.saleClosed
              ? (language === 'zh' ? '截止前锁定 · 不可执行' : 'Locked pre-cutoff · Not executable')
              : getPredictionValueLabel(prediction, language);
            const cardTierLabel = card.saleClosed
              ? (language === 'zh' ? '已锁定数据推荐' : 'Locked data pick')
              : (isFeatured
                ? (language === 'zh' ? '重点 · 数据推荐' : 'Featured · Data pick')
                : t('observation'));
            const sourceLabel = card.referenceSource === 'official-calibrated-market'
              ? (language === 'zh' ? '官方市场校准' : 'Official market calibration')
              : card.referenceSource === 'official-market-consensus'
                ? (language === 'zh' ? '官方市场数据推荐' : 'Official market data pick')
              : card.referenceSource === 'five-hundred-market'
                ? (language === 'zh' ? '500 去水数据' : '500.com de-vigged data')
              : card.referenceSource === 'official-low-evidence-market'
                ? (language === 'zh' ? '官方低置信推荐' : 'Official low-confidence pick')
              : card.referenceSource === 'model-low-evidence'
                ? (language === 'zh' ? '\u6a21\u578b\u4f4e\u7f6e\u4fe1\u63a8\u8350' : 'Model low-confidence pick')
              : card.referenceSource === 'five-hundred-low-evidence-market'
                ? (language === 'zh' ? '500低置信推荐' : '500.com low-confidence pick')
                : (language === 'zh' ? '模型多因素' : 'Model multi-factor');
            return (
              <article
                key={`reference-${match.id}-${prediction.marketType}-${prediction.tipCode}-${prediction.oddsPoolCode || 'pool'}`}
                className="best-pool-v4__row is-observation"
              >
                <div className="best-pool-v4__time"><strong>{formattedTime}</strong><span>{cardTierLabel}</span></div>
                <div className="best-pool-v4__teams">
                  <span><TeamBadge team={homeTeam} size="sm" />{homeTeam.name[language]}</span>
                  <span><TeamBadge team={awayTeam} size="sm" />{awayTeam.name[language]}</span>
                </div>
                <div className="best-pool-v4__pick">
                  <span>{sourceLabel} · {cardStateLabel}</span>
                  <strong>{pickLabel}</strong>
                  <small>{getObservationMetric(card, language)}</small>
                  <small className="best-pool-v4__governance">
                    {language === 'zh'
                      ? `数据 ${dataAsOf} · 截止 ${cutoffAt} · 不计入正式命中率 · ${card.saleClosed ? '不可执行' : '仅数据参考'}`
                      : `Data ${dataAsOf} · Cutoff ${cutoffAt} · Excluded from formal record · ${card.saleClosed ? 'Not executable' : 'Data reference only'}`}
                  </small>
                </div>
                <div className="best-pool-v4__blockers">
                  <span>{t('blockers')}</span>
                  <p>{card.blockers.join(' · ')}</p>
                </div>
                <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action">
                  {t('viewDetail')}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
