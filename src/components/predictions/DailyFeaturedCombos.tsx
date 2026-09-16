import React from 'react';
import { Layers3, ShieldCheck } from 'lucide-react';
import type { Match } from '../../services/mockData';
import { buildDailyFeaturedCombos, type FeaturedCombo } from '../../services/dailyFeaturedCombos';
import { getTeamById } from '../../services/entities';
import { getPredictionTipDisplay } from '../../services/bettingDisplay';
import '../../styles/recommendation-quality.css';

type Language = 'zh' | 'en';

interface DailyFeaturedCombosProps {
  matches: Match[];
  language: Language;
  enabled: boolean;
  onSelectMatch: (matchId: string) => void;
}

const ComboCard: React.FC<{
  combo: FeaturedCombo;
  language: Language;
  onSelectMatch: (matchId: string) => void;
}> = ({ combo, language, onSelectMatch }) => (
  <article className={`daily-combo-card ${combo.status === 'ready' ? 'is-ready' : 'is-empty'}`}>
    <header className="daily-combo-card__header">
      <div>
        <span>{language === 'zh' ? `${combo.size} 场精选分析` : `${combo.size}-match featured analysis`}</span>
        <small>{language === 'zh' ? `总 SP ≥ ${combo.minimumTotalOdds.toFixed(2)}` : `Total SP ≥ ${combo.minimumTotalOdds.toFixed(2)}`}</small>
      </div>
      <strong>{combo.status === 'ready' ? `@${combo.totalOdds.toFixed(2)}` : '--'}</strong>
    </header>
    {combo.status === 'ready' ? (
      <>
        <div className="daily-combo-card__legs">
          {combo.legs.map((leg, index) => {
            const home = getTeamById(leg.match.homeTeamId);
            const away = getTeamById(leg.match.awayTeamId);
            return (
              <button key={`${combo.size}-${leg.match.id}`} type="button" className="daily-combo-leg" onClick={() => onSelectMatch(leg.match.id)}>
                <span className="daily-combo-leg__index">{index + 1}</span>
                <span className="daily-combo-leg__match">
                  <strong>{home.shortName[language]} vs {away.shortName[language]}</strong>
                  <small>{getPredictionTipDisplay(leg.prediction, language, true)}</small>
                </span>
                <span className="daily-combo-leg__odds">@{leg.odds.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
        <footer className="daily-combo-card__footer">
          <span>{language === 'zh' ? '平均证据评分' : 'Avg evidence'}</span>
          <strong>{combo.averageEvidenceScore.toFixed(1)}</strong>
        </footer>
      </>
    ) : (
      <div className="daily-combo-card__empty">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>{language === 'zh' ? '当前没有同时满足质量门槛和总 SP 下限的组合，不强行凑单。' : 'No combination currently clears both the quality gate and SP floor.'}</p>
      </div>
    )}
  </article>
);

export const DailyFeaturedCombos: React.FC<DailyFeaturedCombosProps> = ({ matches, language, enabled, onSelectMatch }) => {
  const combos = React.useMemo(() => enabled ? buildDailyFeaturedCombos(matches) : null, [enabled, matches]);
  return (
    <section className="daily-combo-board" aria-label={language === 'zh' ? '每日精选分析组合' : 'Daily featured analysis combinations'}>
      <header className="daily-combo-board__header">
        <div>
          <span className="daily-combo-board__icon"><Layers3 size={17} aria-hidden="true" /></span>
          <div>
            <h2>{language === 'zh' ? '每日精选组合' : 'Daily Featured Combos'}</h2>
            <p>{language === 'zh' ? '只使用当前正式赛前方向；优先证据强、总 SP 刚过门槛的组合。' : 'Uses current formal pre-match picks only, preferring strong evidence and totals just above the required floor.'}</p>
          </div>
        </div>
        <span className="daily-combo-board__rule">{language === 'zh' ? '2场 ≥2.50 · 3场 ≥5.00' : '2-leg ≥2.50 · 3-leg ≥5.00'}</span>
      </header>
      {!enabled || !combos ? (
        <div className="daily-combo-board__disabled">{language === 'zh' ? '正式推荐池尚未达到可发布状态，精选组合保持暂停。' : 'The formal recommendation pool is not publishable yet; featured combinations remain paused.'}</div>
      ) : (
        <div className="daily-combo-board__grid">
          <ComboCard combo={combos.two} language={language} onSelectMatch={onSelectMatch} />
          <ComboCard combo={combos.three} language={language} onSelectMatch={onSelectMatch} />
        </div>
      )}
    </section>
  );
};
