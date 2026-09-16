import React from 'react';
import { Layers3, ShieldCheck, Sparkles } from 'lucide-react';
import type { Match } from '../../services/mockData';
import { getTeamById } from '../../services/entities';
import { getPredictionTipDisplay } from '../../services/bettingDisplay';
import { buildDailyFeaturedPlans, type DailyFeaturedPlan } from '../../services/dailyFeaturedPlans';

interface DailyFeaturedPlansProps {
  matches: Match[];
  language: 'zh' | 'en';
  now?: number;
  onSelectMatch: (matchId: string) => void;
}

const PlanCard = ({
  plan,
  language,
  onSelectMatch
}: {
  plan: DailyFeaturedPlan;
  language: 'zh' | 'en';
  onSelectMatch: (matchId: string) => void;
}) => {
  const title = plan.kind === 'TWO'
    ? (language === 'zh' ? '精选 2 场' : 'Featured 2')
    : (language === 'zh' ? '精选 3 场' : 'Featured 3');
  const Icon = plan.kind === 'TWO' ? ShieldCheck : Layers3;

  return (
    <article className={`featured-plan-card ${plan.status === 'available' ? 'is-available' : 'is-unavailable'}`}>
      <header className="featured-plan-card__header">
        <div>
          <span className="featured-plan-card__kicker"><Icon size={14} aria-hidden="true" />{title}</span>
          <strong>{language === 'zh'
            ? `总 SP ≥ ${plan.minimumCombinedSp.toFixed(2)}`
            : `Combined SP ≥ ${plan.minimumCombinedSp.toFixed(2)}`}</strong>
        </div>
        <span className="featured-plan-card__sp">
          {plan.combinedSp ? plan.combinedSp.toFixed(2) : '--'}
        </span>
      </header>

      {plan.status === 'available' ? (
        <>
          <div className="featured-plan-card__metrics">
            <span>{language === 'zh' ? '平均证据' : 'Avg evidence'} <b>{plan.averageEvidenceScore?.toFixed(0) ?? '--'}</b></span>
            <span>{language === 'zh' ? '场次' : 'Picks'} <b>{plan.selectionCount}</b></span>
          </div>
          <div className="featured-plan-card__selections">
            {plan.selections.map(({ match, prediction }, index) => {
              const home = getTeamById(match.homeTeamId);
              const away = getTeamById(match.awayTeamId);
              return (
                <button key={`${match.id}-${prediction.tipCode}`} type="button" onClick={() => onSelectMatch(match.id)}>
                  <span className="featured-plan-card__index">{index + 1}</span>
                  <span className="featured-plan-card__match">
                    <strong>{home.shortName[language]} vs {away.shortName[language]}</strong>
                    <small>{getPredictionTipDisplay(prediction, language, true)} · SP {prediction.odds.toFixed(2)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="featured-plan-card__empty">
          <Sparkles size={17} aria-hidden="true" />
          <p>{language === 'zh'
            ? '当前正式方向不足或总 SP 未达到门槛，本档不强行输出。'
            : 'The qualified pool or combined SP is insufficient, so no plan is forced.'}</p>
        </div>
      )}
    </article>
  );
};

export const DailyFeaturedPlans: React.FC<DailyFeaturedPlansProps> = ({ matches, language, now, onSelectMatch }) => {
  const plans = React.useMemo(
    () => buildDailyFeaturedPlans(matches, { now }),
    [matches, now]
  );

  return (
    <section className="featured-plans" aria-label={language === 'zh' ? '每日精选组合分析' : 'Daily featured analysis plans'}>
      <header className="featured-plans__header">
        <div>
          <span>{language === 'zh' ? 'PRECISION PICKS' : 'PRECISION PICKS'}</span>
          <h2>{language === 'zh' ? '每日精选组合分析' : 'Daily featured analysis'}</h2>
          <p>{language === 'zh'
            ? '只使用通过精度优先正式门槛的赛前方向；不满足质量与总 SP 要求时保持空缺。'
            : 'Uses only precision-qualified formal pre-match directions; no plan is forced below the quality or SP floor.'}</p>
        </div>
        <strong>{plans.businessDate}</strong>
      </header>
      <div className="featured-plans__grid">
        <PlanCard plan={plans.two} language={language} onSelectMatch={onSelectMatch} />
        <PlanCard plan={plans.three} language={language} onSelectMatch={onSelectMatch} />
      </div>
    </section>
  );
};
