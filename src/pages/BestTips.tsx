import React from 'react';
import { Calendar, ShieldAlert, Trophy } from 'lucide-react';
import { DailyFeaturedCombos } from '../components/predictions/DailyFeaturedCombos';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getPredictionValueLabel } from '../services/bettingDisplay';
import {
  getFormalRecommendationPrediction,
  getLiveRecommendationPrediction,
  getOfficialRecommendationOdds,
} from '../services/displayRecommendation';
import { getTeamById } from '../services/entities';
import type { Match, PredictionDetail } from '../services/mockData';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { selectOnSaleAnalysisReference } from '../services/analysisReferenceSelection';
import {
  formatCalibratedModelProbability,
  formatEvidenceScore,
  getEvidenceScore,
  isFormalPresentationAllowed,
} from '../services/predictionPresentation';
import '../styles/best-tips.css';

interface BestTipsProps {
  onSelectMatch: (matchId: string) => void;
}

type Language = 'zh' | 'en';

type PickCard = {
  match: Match;
  prediction: PredictionDetail;
  track: 'formal' | 'live';
  evidence: number;
};

type ObservationCard = {
  match: Match;
  prediction: PredictionDetail;
  odds: number | null;
  evidence: number | null;
  source: string;
};

const formatKickoff = (value: string, language: Language) => new Date(value).toLocaleTimeString(
  language === 'zh' ? 'zh-CN' : 'en-US',
  { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }
);

const pickLabel = (prediction: PredictionDetail, language: Language) => (
  getPredictionTipDisplay(prediction, language, true)
);

const scoreFor = (prediction: PredictionDetail) => getEvidenceScore(prediction) ?? 0;

const sourceLabel = (source: string, language: Language) => {
  if (source.startsWith('official')) return language === 'zh' ? '官方市场参考' : 'Official market reference';
  if (source.startsWith('five-hundred')) return language === 'zh' ? '500 市场参考' : '500.com market reference';
  if (source.startsWith('model')) return language === 'zh' ? '模型参考' : 'Model reference';
  return language === 'zh' ? '赛前参考' : 'Pre-match reference';
};

export const BestTips: React.FC<BestTipsProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const formalPresentationAllowed = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode
  );
  const comboEnabled = formalPresentationAllowed
    && dataSync.currentRefreshHealthy === true
    && dataSync.dataChannel !== 'retained'
    && dataSync.serviceTransitioning !== true;

  const pickCards = React.useMemo<PickCard[]>(() => matches
    .filter((match) => match.status === 'SCHEDULED' && Date.parse(match.kickoffTime) > now)
    .map((match): PickCard | null => {
      const formal = formalPresentationAllowed && isBeforeMatchSaleCutoff(match, now)
        ? getFormalRecommendationPrediction(match)
        : undefined;
      const live = formal ? undefined : getLiveRecommendationPrediction(match);
      const prediction = formal || live;
      if (!prediction) return null;
      const officialOdds = getOfficialRecommendationOdds(match, prediction);
      const displayPrediction = officialOdds > 1 ? { ...prediction, odds: officialOdds } : prediction;
      return {
        match,
        prediction: displayPrediction,
        track: formal ? 'formal' : 'live',
        evidence: scoreFor(displayPrediction),
      };
    })
    .filter((card): card is PickCard => Boolean(card))
    .sort((left, right) => right.evidence - left.evidence || Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime)),
  [formalPresentationAllowed, matches, now]);

  const publishedIds = React.useMemo(() => new Set(pickCards.map((card) => card.match.id)), [pickCards]);

  const observationCards = React.useMemo<ObservationCard[]>(() => matches
    .filter((match) => match.status === 'SCHEDULED' && Date.parse(match.kickoffTime) > now && !publishedIds.has(match.id))
    .map((match): ObservationCard | null => {
      const reference = selectOnSaleAnalysisReference(match, { allowModelOnly: false, now });
      if (!reference) return null;
      return {
        match,
        prediction: reference.prediction,
        odds: reference.displayOdds,
        evidence: getEvidenceScore(reference.prediction),
        source: reference.source,
      };
    })
    .filter((card): card is ObservationCard => Boolean(card))
    .sort((left, right) => (right.evidence ?? 0) - (left.evidence ?? 0) || Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime))
    .slice(0, 12),
  [matches, now, publishedIds]);

  const isInitialLoading = Boolean(dataSync.currentLoading && !dataSync.currentLoaded);
  const hasInitialLoadError = Boolean(dataSync.error && !dataSync.currentLoaded);

  return (
    <section className="best-pool-v4" aria-labelledby="formal-pool-title">
      <header className="best-pool-v4__header">
        <div>
          <span className="best-pool-v4__eyebrow">{language === 'zh' ? '赛前精选 · 强证据优先' : 'Pre-match selection · Strong evidence first'}</span>
          <h1 id="formal-pool-title">{language === 'zh' ? '精选推荐与组合' : 'Featured Picks & Combos'}</h1>
          <p>{language === 'zh'
            ? '正式推荐先经过历史弱区降温、实时数据与多因素证据门槛；组合只从正式池二次筛选，不用参考方向凑数。'
            : 'Formal picks pass historical cooling, live-data and multi-factor evidence gates first; combos are selected only from that formal pool.'}</p>
        </div>
        <div className={`best-pool-v4__metric ${pickCards.length ? 'is-formal' : 'is-empty'}`}>
          <span>{language === 'zh' ? '正式/实时' : 'Published'}</span>
          <strong>{pickCards.length}</strong>
        </div>
      </header>

      <DailyFeaturedCombos
        matches={matches}
        language={language}
        enabled={comboEnabled}
        onSelectMatch={onSelectMatch}
      />

      {isInitialLoading ? (
        <div className="best-pool-v4__state" role="status">
          <span className="best-pool-v4__loader" aria-hidden="true" />
          <div><strong>{language === 'zh' ? '正在同步推荐池' : 'Loading pick pool'}</strong><p>{language === 'zh' ? '读取当前赛程、官方赔率和最新推荐门槛。' : 'Reading fixtures, official odds and current promotion gates.'}</p></div>
        </div>
      ) : hasInitialLoadError ? (
        <div className="best-pool-v4__state is-error" role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div><strong>{language === 'zh' ? '当前数据暂不可用' : 'Current data unavailable'}</strong><p>{language === 'zh' ? '不会使用旧页面状态生成新的正式推荐。' : 'No new formal pick is generated from stale page state.'}</p></div>
        </div>
      ) : (
        <>
          <section className="best-pool-section" aria-label={language === 'zh' ? '正式赛前推荐' : 'Formal pre-match picks'}>
            <header className="best-pool-section__header">
              <div><h2>{language === 'zh' ? '正式赛前方向' : 'Formal Pre-match Picks'}</h2><p>{language === 'zh' ? '高 SP、HHAD 和市场背离场次使用更严格门槛。' : 'Higher-SP, HHAD and market-conflict lanes use stricter gates.'}</p></div>
              <span>{pickCards.length}</span>
            </header>
            {pickCards.length ? (
              <div className="best-pool-v4__rows is-formal-list">
                {pickCards.map(({ match, prediction, track, evidence }) => {
                  const home = getTeamById(match.homeTeamId);
                  const away = getTeamById(match.awayTeamId);
                  const modelProbability = formatCalibratedModelProbability(match, prediction);
                  return (
                    <article key={`${match.id}-${track}`} className="best-pool-v4__row is-formal">
                      <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{track === 'formal' ? (language === 'zh' ? '正式' : 'Formal') : (language === 'zh' ? '实时' : 'Live')}</span></div>
                      <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
                      <div className="best-pool-v4__pick"><span>{getPredictionValueLabel(prediction, language)}</span><strong>{pickLabel(prediction, language)}</strong><small>@{Number(prediction.odds || 0).toFixed(2)} · {language === 'zh' ? '证据' : 'Evidence'} {formatEvidenceScore(prediction)}{modelProbability ? ` · ${modelProbability}` : ''}</small></div>
                      <div className="best-pool-v4__reason"><span>{language === 'zh' ? '质量状态' : 'Quality'}</span><p>{language === 'zh' ? `证据评分 ${evidence.toFixed(0)}，已通过当前正式发布门槛。` : `Evidence ${evidence.toFixed(0)}, passed the current formal publication gate.`}</p></div>
                      <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action is-formal"><Trophy size={14} aria-hidden="true" />{language === 'zh' ? '查看分析' : 'Analyze'}</button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="best-pool-v4__none"><Calendar size={18} aria-hidden="true" /><p>{language === 'zh' ? '当前没有通过新质量门槛的正式方向，不降低门槛补位。' : 'No pick currently clears the stricter quality gate.'}</p></div>
            )}
          </section>

          {observationCards.length > 0 && (
            <details className="best-pool-v4__observations">
              <summary><span>{language === 'zh' ? `观察候选 ${observationCards.length}` : `${observationCards.length} observation candidates`}</span><small>{language === 'zh' ? '不计正式命中率' : 'Excluded from formal stats'}</small></summary>
              <div className="best-pool-v4__rows">
                {observationCards.map(({ match, prediction, odds, evidence, source }) => {
                  const home = getTeamById(match.homeTeamId);
                  const away = getTeamById(match.awayTeamId);
                  return (
                    <article key={`reference-${match.id}`} className="best-pool-v4__row is-observation">
                      <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{language === 'zh' ? '观察' : 'Observe'}</span></div>
                      <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
                      <div className="best-pool-v4__pick"><span>{sourceLabel(source, language)}</span><strong>{pickLabel(prediction, language)}</strong><small>{odds && odds > 1 ? `@${odds.toFixed(2)} · ` : ''}{language === 'zh' ? '证据' : 'Evidence'} {evidence === null ? '--' : evidence.toFixed(0)}</small></div>
                      <div className="best-pool-v4__blockers"><span>{language === 'zh' ? '状态' : 'Status'}</span><p>{language === 'zh' ? '保留用于观察和独立复盘，不进入每日精选组合。' : 'Retained for observation and separate review; excluded from daily featured combos.'}</p></div>
                      <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action">{language === 'zh' ? '查看分析' : 'Analyze'}</button>
                    </article>
                  );
                })}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
};
