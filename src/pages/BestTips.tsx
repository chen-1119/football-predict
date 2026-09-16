import React from 'react';
import { Calendar, ShieldAlert, Trophy } from 'lucide-react';
import { DailyFeaturedCombos } from '../components/predictions/DailyFeaturedCombos';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getPredictionValueLabel } from '../services/bettingDisplay';
import { getFormalRecommendationPrediction, getLiveRecommendationPrediction, getOfficialRecommendationOdds } from '../services/displayRecommendation';
import { getTeamById } from '../services/entities';
import type { Match, PredictionDetail } from '../services/mockData';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { selectOnSaleAnalysisReference } from '../services/analysisReferenceSelection';
import { formatCalibratedModelProbability, formatEvidenceScore, getEvidenceScore, isFormalPresentationAllowed } from '../services/predictionPresentation';
import '../styles/best-tips.css';

interface BestTipsProps { onSelectMatch: (matchId: string) => void }
type Language = 'zh' | 'en';
type PickCard = { match: Match; prediction: PredictionDetail; track: 'formal' | 'live'; evidence: number };
type ObservationCard = { match: Match; prediction: PredictionDetail; odds: number | null; evidence: number | null; source: string };
const formatKickoff = (value: string, language: Language) => new Date(value).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
});
const sourceLabel = (source: string, language: Language) => source.startsWith('official') ? (language === 'zh' ? '官方市场参考' : 'Official market reference')
  : source.startsWith('five-hundred') ? (language === 'zh' ? '500 市场参考' : '500.com market reference') : (language === 'zh' ? '模型参考' : 'Model reference');

export const BestTips: React.FC<BestTipsProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const zh = language === 'zh';
  // These gates apply only to the formal single-pick section, never combos.
  const singlePickEnabled = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode,
  ) && dataSync.currentRefreshHealthy === true && dataSync.dataChannel !== 'retained' && dataSync.serviceTransitioning !== true;
  const pickCards = React.useMemo<PickCard[]>(() => matches
    .filter((match) => match.status === 'SCHEDULED' && Date.parse(match.kickoffTime) > now)
    .map((match): PickCard | null => {
      const formal = singlePickEnabled && isBeforeMatchSaleCutoff(match, now) ? getFormalRecommendationPrediction(match) : undefined;
      const live = formal || !singlePickEnabled ? undefined : getLiveRecommendationPrediction(match);
      const prediction = formal || live;
      if (!prediction) return null;
      const odds = getOfficialRecommendationOdds(match, prediction);
      const display = odds > 1 ? { ...prediction, odds } : prediction;
      return { match, prediction: display, track: formal ? 'formal' : 'live', evidence: getEvidenceScore(display) ?? 0 };
    }).filter((card): card is PickCard => Boolean(card))
    .sort((a, b) => b.evidence - a.evidence || Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime)), [singlePickEnabled, matches, now]);
  const publishedIds = React.useMemo(() => new Set(pickCards.map((card) => card.match.id)), [pickCards]);
  const observations = React.useMemo<ObservationCard[]>(() => matches
    .filter((match) => match.status === 'SCHEDULED' && Date.parse(match.kickoffTime) > now && !publishedIds.has(match.id))
    .map((match): ObservationCard | null => {
      const reference = selectOnSaleAnalysisReference(match, { allowModelOnly: false, now });
      return reference ? { match, prediction: reference.prediction, odds: reference.displayOdds, evidence: getEvidenceScore(reference.prediction), source: reference.source } : null;
    }).filter((card): card is ObservationCard => Boolean(card))
    .sort((a, b) => Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime)), [matches, now, publishedIds]);
  return <section className="best-pool-v4" aria-labelledby="formal-pool-title">
    <header className="best-pool-v4__header"><div>
      <span className="best-pool-v4__eyebrow">{zh ? '按当天场次独立筛选' : 'Independent daily match selection'}</span>
      <h1 id="formal-pool-title">{zh ? '串关与单场分析' : 'Combos & Match Analysis'}</h1>
      <p>{zh ? '串关直接使用赛前模型概率和在售竞彩 SP；单场“参考／正式”标签不再决定能否组串。' : 'Combos use pre-match probabilities and Sporttery SP directly, independently of single-pick promotion.'}</p>
    </div><div className="best-pool-v4__metric"><span>{zh ? '当前场次' : 'Current matches'}</span><strong>{dataSync.currentCount}</strong></div></header>
    <DailyFeaturedCombos matches={matches} language={language} onSelectMatch={onSelectMatch} />
    {dataSync.currentLoading && !dataSync.currentLoaded ? <div className="best-pool-v4__state" role="status">{zh ? '正在读取单场分析…' : 'Loading match analysis…'}</div>
      : dataSync.error && !dataSync.currentLoaded ? <div className="best-pool-v4__state is-error" role="alert"><ShieldAlert size={18} />{zh ? '单场数据正在重新连接。' : 'Reconnecting match data.'}</div> : <>
        <section className="best-pool-section" aria-label={zh ? '单场分析参考' : 'Match references'}>
          <header className="best-pool-section__header"><div><h2>{zh ? '按场次查看分析' : 'Analysis by Match'}</h2><p>{zh ? '参考场次可参加上方独立串关筛选；正式单场成绩另行统计。' : 'Reference matches can enter independent combo selection; formal single-pick records remain separate.'}</p></div><span>{observations.length}</span></header>
          <div className="best-pool-v4__rows">{observations.map(({ match, prediction, odds, evidence, source }) => {
            const home = getTeamById(match.homeTeamId), away = getTeamById(match.awayTeamId);
            return <article key={`reference-${match.id}`} className="best-pool-v4__row is-observation">
              <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{zh ? '单场参考' : 'Reference'}</span></div>
              <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
              <div className="best-pool-v4__pick"><span>{sourceLabel(source, language)}</span><strong>{getPredictionTipDisplay(prediction, language, true)}</strong><small>{odds && odds > 1 ? `@${odds.toFixed(2)} · ` : ''}{zh ? '证据' : 'Evidence'} {evidence === null ? '--' : evidence.toFixed(0)}</small></div>
              <div className="best-pool-v4__reason"><span>{zh ? '分析依据' : 'Analysis'}</span><p>{prediction.explanation?.[language] || (zh ? '查看比赛详情中的模型与市场数据。' : 'See the model and market data in match details.')}</p></div>
              <button type="button" className="best-pool-v4__action" onClick={() => onSelectMatch(match.id)}>{zh ? '查看分析' : 'Analyze'}</button>
            </article>;
          })}</div>
        </section>
        <details className="best-pool-v4__observations"><summary><span>{zh ? `正式 / 实时单场 ${pickCards.length}` : `Formal / live single picks ${pickCards.length}`}</span><small>{zh ? '与独立串关分开' : 'Separate from combos'}</small></summary>
          {pickCards.length ? <div className="best-pool-v4__rows">{pickCards.map(({ match, prediction, track }) => {
            const home = getTeamById(match.homeTeamId), away = getTeamById(match.awayTeamId);
            const probability = formatCalibratedModelProbability(match, prediction);
            return <article key={`${match.id}-${track}`} className="best-pool-v4__row is-formal">
              <div className="best-pool-v4__time"><strong>{formatKickoff(match.kickoffTime, language)}</strong><span>{track}</span></div>
              <div className="best-pool-v4__teams"><span><TeamBadge team={home} size="sm" />{home.name[language]}</span><span><TeamBadge team={away} size="sm" />{away.name[language]}</span></div>
              <div className="best-pool-v4__pick"><span>{getPredictionValueLabel(prediction, language)}</span><strong>{getPredictionTipDisplay(prediction, language, true)}</strong><small>@{Number(prediction.odds || 0).toFixed(2)} · {formatEvidenceScore(prediction)}{probability ? ` · ${probability}` : ''}</small></div>
              <div className="best-pool-v4__reason"><p>{zh ? '按原单场资格与冻结规则保留。' : 'Original single-pick eligibility and freeze policy retained.'}</p></div>
              <button type="button" className="best-pool-v4__action is-formal" onClick={() => onSelectMatch(match.id)}><Trophy size={14} />{zh ? '查看分析' : 'Analyze'}</button>
            </article>;
          })}</div> : <div className="best-pool-v4__none"><Calendar size={18} /><p>{zh ? '当前无正式单场记录，不影响上方独立串关。' : 'No formal single picks; independent combos remain available above.'}</p></div>}
        </details>
      </>}
  </section>;
};
