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

type Language = 'zh' | 'en';
interface BestTipsProps { onSelectMatch: (matchId: string) => void }
type PickCard = { match: Match; prediction: PredictionDetail; track: 'formal' | 'live'; evidence: number };
type ObservationCard = { match: Match; prediction: PredictionDetail; odds: number | null; evidence: number | null; source: string };

const formatKickoff = (value: string, language: Language) => new Date(value).toLocaleTimeString(
  language === 'zh' ? 'zh-CN' : 'en-US',
  { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' },
);
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

  // This gate controls only formal single-pick presentation. Daily combinations
  // are produced independently on the server from current model+market inputs.
  const singlePickPresentationAllowed = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode,
  );
  const singlePickLiveDataReady = singlePickPresentationAllowed
    && dataSync.currentRefreshHealthy === true
    && dataSync.dataChannel !== 'retained'
    && dataSync.serviceTransitioning !== true;

  const pickCards = React.useMemo<PickCard[]>(() => matches
    .filter((match) => match.status === 'SCHEDULED' && Date.parse(match.kickoffTime) > now)
    .map((match): PickCard | null => {
      const formal = singlePickLiveDataReady && isBeforeMatchSaleCutoff(match, now)
        ? getFormalRecommendationPrediction(match)
        : undefined;
      const live = formal || !singlePickLiveDataReady ? undefined : getLiveRecommendationPrediction(match);
      const prediction = formal || live;
      if (!prediction) return null;
      const officialOdds = getOfficialRecommendationOdds(match, prediction);
      const displayPrediction = officialOdds > 1 ? { ...prediction, odds: officialOdds } : prediction;
      return {
        match,
        prediction: displayPrediction,
        track: formal ? 'formal' : 'live',
        evidence: getEvidenceScore(displayPrediction) ?? 0,
      };
    })
    .filter((card): card is PickCard => Boolean(card))
    .sort((left, right) => right.evidence - left.evidence || Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime)),
  [matches, now, singlePickLiveDataReady]);

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
    .slice(0, 16),
  [matches, now, publishedIds]);

  const zh = language === 'zh';
  const isInitialLoading = Boolean(dataSync.currentLoading && !dataSync.currentLoaded);
  const hasInitialLoadError = Boolean(dataSync.error && !dataSync.currentLoaded);

  return (
    <section className="best-pool-v4" aria-labelledby="formal-pool-title">
      <header className="best-pool-v4__header">
        <div>
          <span className="best-pool-v4__eyebrow">{zh ? '串关独立分析 · 单场资格分离' : 'Independent combos · Separate single-pick gate'}</span>
          <h1 id="formal-pool-title">{zh ? '每日串关与赛前分析' : 'Daily Combos & Pre-match Analysis'}</h1>
          <p>{zh
            ? '2串1/3串1直接综合当天模型概率与竞彩去水概率，不等待单场进入“正式推荐”；正式单场仍按原资格单独统计。'
            : 'Daily combos blend model and de-vigged Sporttery probabilities directly; formal single picks keep their separate eligibility and record.'}</p>
        </div>
        <div className="best-pool-v4__metric">
          <span>{zh ? '当前场次' : 'Current'}</span>
          <strong>{dataSync.currentCount}</strong>
        </div>
      </header>

      <DailyFeaturedCombos language={language} onSelectMatch={onSelectMatch} />

      {isInitialLoading ? (
        <div className="best-pool-v4__state" role="status">
          <span className="best-pool-v4__loader" aria-hidden="true" />
          <div><strong>{zh ? '正在同步赛前分析' : 'Loading analysis'}</strong><p>{zh ? '组合区使用独立服务状态，单场列表正在读取当前赛程。' : 'The combo board has its own server state while the match list loads.'}</p></div>
        </div>
      ) : hasInitialLoadError ? (
        <div className="best-pool-v4__state is-error" role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div><strong>{zh ? '单场列表暂不可用' : 'Match list unavailable'}</strong><p>{zh ? '组合区不会因为单场正式资格为零而被隐藏。' : 'The combo board is not hidden by an empty formal single-pick pool.'}</p></div>
        </div>
      ) : (
        <>
          <section className="best-pool-section" aria-label={zh ? '正式赛前方向' : 'Formal pre-match picks'}>
            <header className="best-pool-section__header">
              <div><h2>{zh ? '正式 / 实时单场' : 'Formal / Live Single Picks'}</h2><p>{zh ? '这里只展示单场正式资格；不再作为串关的前置条件。' : 'This section shows single-pick promotion only; it no longer gates combos.'}</p></div>
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
                      <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{track === 'formal' ? (zh ? '正式' : 'Formal') : (zh ? '实时' : 'Live')}</span></div>
                      <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
                      <div className="best-pool-v4__pick"><span>{getPredictionValueLabel(prediction, language)}</span><strong>{getPredictionTipDisplay(prediction, language, true)}</strong><small>@{Number(prediction.odds || 0).toFixed(2)} · {zh ? '证据' : 'Evidence'} {formatEvidenceScore(prediction)}{modelProbability ? ` · ${modelProbability}` : ''}</small></div>
                      <div className="best-pool-v4__reason"><span>{zh ? '单场状态' : 'Single-pick status'}</span><p>{zh ? `证据评分 ${evidence.toFixed(0)}，已通过当前${track === 'formal' ? '正式' : '实时'}单场门槛。` : `Evidence ${evidence.toFixed(0)}, passed the current single-pick gate.`}</p></div>
                      <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action is-formal"><Trophy size={14} aria-hidden="true" />{zh ? '查看分析' : 'Analyze'}</button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="best-pool-v4__none"><Calendar size={18} aria-hidden="true" /><p>{zh ? '当前没有正式单场；上方独立串关仍会按当天比赛数据计算。' : 'No formal single pick now; independent combos above still calculate from current match data.'}</p></div>
            )}
          </section>

          {observationCards.length > 0 && (
            <details className="best-pool-v4__observations">
              <summary><span>{zh ? `赛前参考 ${observationCards.length}` : `${observationCards.length} pre-match references`}</span><small>{zh ? '单场不计正式命中率' : 'Excluded from formal single-pick stats'}</small></summary>
              <div className="best-pool-v4__rows">
                {observationCards.map(({ match, prediction, odds, evidence, source }) => {
                  const home = getTeamById(match.homeTeamId);
                  const away = getTeamById(match.awayTeamId);
                  return (
                    <article key={`reference-${match.id}`} className="best-pool-v4__row is-observation">
                      <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{zh ? '参考' : 'Reference'}</span></div>
                      <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
                      <div className="best-pool-v4__pick"><span>{sourceLabel(source, language)}</span><strong>{getPredictionTipDisplay(prediction, language, true)}</strong><small>{odds && odds > 1 ? `@${odds.toFixed(2)} · ` : ''}{zh ? '证据' : 'Evidence'} {evidence === null ? '--' : evidence.toFixed(0)}</small></div>
                      <div className="best-pool-v4__blockers"><span>{zh ? '用途' : 'Use'}</span><p>{zh ? '保留用于单场观察；是否进入串关由上方独立模型+市场算法重新计算。' : 'Retained for single-match observation; combo inclusion is recalculated independently above.'}</p></div>
                      <button type="button" onClick={() => onSelectMatch(match.id)} className="best-pool-v4__action">{zh ? '查看分析' : 'Analyze'}</button>
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
