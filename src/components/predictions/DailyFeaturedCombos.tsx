import React from 'react';
import { Layers3, ShieldCheck } from 'lucide-react';
import type { Match } from '../../services/mockData';
import { buildDailyFeaturedCombos, type FeaturedCombo } from '../../services/dailyFeaturedCombos';
import { getTeamById } from '../../services/entities';
import { getPredictionTipDisplay } from '../../services/bettingDisplay';
import '../../styles/recommendation-quality.css';

type Language = 'zh' | 'en';
type ComboStats = { published: number; settled: number; won: number; lost: number; hitRate: number | null };
type FrozenCombo = { id: string; businessDate: string; size: 2 | 3; totalOdds: number; settlement?: { status?: 'PENDING' | 'WON' | 'LOST' } };
type ComboLedgerPublic = { updatedAt?: string; today?: FrozenCombo[]; statistics?: { two?: ComboStats; three?: ComboStats } };

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

const formatRate = (stats: ComboStats | undefined, language: Language) => {
  if (!stats || stats.settled === 0 || stats.hitRate === null) return language === 'zh' ? '待积累' : 'Pending';
  return `${(stats.hitRate * 100).toFixed(1)}%`;
};

export const DailyFeaturedCombos: React.FC<DailyFeaturedCombosProps> = ({ matches, language, enabled, onSelectMatch }) => {
  const combos = React.useMemo(() => enabled ? buildDailyFeaturedCombos(matches) : null, [enabled, matches]);
  const [ledger, setLedger] = React.useState<ComboLedgerPublic | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const base = import.meta.env.BASE_URL || '/';
        const response = await fetch(`${base}data/daily-featured-combos.json?v=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as ComboLedgerPublic;
        if (!cancelled) setLedger(payload);
      } catch {
        // Combo history is an auxiliary lane; live recommendations remain usable.
      }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const twoStats = ledger?.statistics?.two;
  const threeStats = ledger?.statistics?.three;
  const todaySettled = (ledger?.today || []).filter((entry) => ['WON', 'LOST'].includes(entry.settlement?.status || '')).length;

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
      <footer className="daily-combo-performance" aria-label={language === 'zh' ? '精选组合复盘统计' : 'Featured combo review statistics'}>
        <div><span>{language === 'zh' ? '2场组合累计' : '2-leg cumulative'}</span><strong>{formatRate(twoStats, language)}</strong><small>{twoStats ? `${twoStats.won}/${twoStats.settled}` : '--'}</small></div>
        <div><span>{language === 'zh' ? '3场组合累计' : '3-leg cumulative'}</span><strong>{formatRate(threeStats, language)}</strong><small>{threeStats ? `${threeStats.won}/${threeStats.settled}` : '--'}</small></div>
        <div><span>{language === 'zh' ? '今日已结算组合' : 'Settled today'}</span><strong>{todaySettled}</strong><small>{language === 'zh' ? '冻结后只结算，不改方向' : 'Frozen directions remain immutable'}</small></div>
      </footer>
    </section>
  );
};
