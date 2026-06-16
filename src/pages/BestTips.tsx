import React from 'react';
import { Calendar, Trophy } from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getPredictionValueLabel, getResolvedMatchOdds } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import { isActionableRecommendation } from '../services/matchSignal';
import type { Match, PredictionDetail } from '../services/mockData';
import { getVisiblePredictions } from '../services/predictionVisibility';

interface BestTipsProps {
  onSelectMatch: (matchId: string) => void;
}

type TipTier = 'pick' | 'reference';

type TipCard = {
  match: Match;
  prediction: PredictionDetail;
  tier: TipTier;
  rankScore: number;
};

const FUTURE_GRACE_MS = 2 * 60 * 60 * 1000;

const marketPriority = (prediction: PredictionDetail) => {
  if (prediction.marketType === 'BEST') return 0;
  if (prediction.oddsPoolCode === 'HHAD') return 1;
  if (prediction.marketType === '1X2') return 2;
  return 3;
};

const isOutcomeTipCode = (tipCode: string | undefined) => tipCode === '1' || tipCode === 'X' || tipCode === '2';

const isPredictionPoolAvailable = (match: Match, prediction: PredictionDetail) => {
  const resolvedOdds = getResolvedMatchOdds(match);
  const hasHad = Boolean(resolvedOdds.had?.odds);
  const hasHhad = Boolean(resolvedOdds.hhad?.odds);

  if (prediction.oddsPoolCode === 'HHAD') return hasHhad;
  if (!hasHad && hasHhad) return false;
  return hasHad || !hasHhad;
};

const getCandidatePrediction = (match: Match) => {
  const visible = getVisiblePredictions(match).filter((prediction) => (
    prediction.tipCode !== 'WATCH'
    && isOutcomeTipCode(prediction.tipCode)
    && (prediction.marketType === 'BEST' || prediction.marketType === '1X2')
    && isPredictionPoolAvailable(match, prediction)
  ));
  return visible.sort((a, b) => {
    const priorityDiff = marketPriority(a) - marketPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return (b.trustScore || 0) - (a.trustScore || 0);
  })[0];
};

export const BestTips: React.FC<BestTipsProps> = ({ onSelectMatch }) => {
  const { language, matches } = useApp();

  const tipCards = React.useMemo<TipCard[]>(() => {
    const now = Date.now();
    return matches
      .filter((match) => {
        const kickoffAt = Date.parse(match.kickoffTime);
        return match.status === 'SCHEDULED' && (!Number.isFinite(kickoffAt) || kickoffAt >= now - FUTURE_GRACE_MS);
      })
      .map((match) => {
        const prediction = getCandidatePrediction(match);
        if (!prediction) return null;
        const tier: TipTier = isActionableRecommendation(match) ? 'pick' : 'reference';
        const kickoffAt = Date.parse(match.kickoffTime);
        const timeScore = Number.isFinite(kickoffAt) ? Math.max(0, 100 - Math.floor((kickoffAt - now) / 36e5)) : 0;
        return {
          match,
          prediction,
          tier,
          rankScore: (tier === 'pick' ? 1000 : 0) + (prediction.trustScore || 0) * 3 - marketPriority(prediction) * 20 + timeScore
        };
      })
      .filter((card): card is TipCard => Boolean(card))
      .sort((a, b) => {
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime);
      });
  }, [matches]);

  const pickCount = tipCards.filter((card) => card.tier === 'pick').length;
  const referenceCount = tipCards.length - pickCount;

  const translations = {
    title: { zh: '今日参考推荐', en: 'Today Reference Picks' },
    subtitle: {
      zh: '强推优先展示；没有强推时，自动降级展示可参考方向，页面不再留空。',
      en: 'Strong picks come first; when none qualify, reference recommendations are still shown.'
    },
    confidence: { zh: '模型可信', en: 'Model Trust' },
    odds: { zh: 'SP', en: 'Odds' },
    kickoff: { zh: '开赛', en: 'Kickoff' },
    viewDetail: { zh: '查看分析', en: 'Analyze' },
    noTips: {
      zh: '当前没有可展示的赛前推荐，数据同步完成后会自动更新。',
      en: 'No pre-match recommendation is available yet. The page will update after sync.'
    },
    pick: { zh: '推荐', en: 'Pick' },
    reference: { zh: '参考', en: 'Reference' },
    pickCount: { zh: '推荐', en: 'Picks' },
    referenceCount: { zh: '参考', en: 'References' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  const getBestCardNote = (card: TipCard) => {
    const riskCount = card.prediction.riskTags?.length || 0;
    if (card.tier === 'pick') {
      return language === 'zh'
        ? '模型、SP 和风险门槛通过，作为优先推荐展示。'
        : 'Model, SP, and risk gates passed; shown as a priority pick.';
    }

    return language === 'zh'
      ? `模型有方向，作为次级参考展示${riskCount ? `；风险标签 ${riskCount} 个` : ''}。`
      : `The model has a direction, shown as a secondary reference${riskCount ? ` with ${riskCount} risk tags` : ''}.`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '720px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h2>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.95rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
        <div className="best-pool-summary">
          <span>
            {t('pickCount')}
            <strong>{pickCount}</strong>
          </span>
          <span>
            {t('referenceCount')}
            <strong>{referenceCount}</strong>
          </span>
        </div>
      </div>

      {tipCards.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem', color: 'hsl(var(--text-secondary))' }}>
          <Calendar size={40} style={{ marginBottom: '1rem', color: 'hsl(var(--border))' }} />
          <p>{t('noTips')}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '2rem' }}>
          {tipCards.map((card) => {
            const { match, prediction } = card;
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const hasDisplayOdds = Number.isFinite(prediction.odds) && prediction.odds > 0;
            const formattedTime = new Date(match.kickoffTime).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            });

            return (
              <div
                key={`${match.id}-${prediction.marketType}-${prediction.tipCode}-${prediction.oddsPoolCode || 'pool'}`}
                className="card premium-card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1.5rem',
                  padding: '2rem',
                  borderColor: card.tier === 'pick' ? 'hsl(var(--primary) / 0.42)' : 'hsl(var(--accent) / 0.36)'
                }}
              >
                <div style={{ display: 'flex', justifySelf: 'stretch', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <TeamBadge team={homeTeam} size="sm" />
                      <span style={{ fontWeight: '800', fontSize: '1.1rem' }}>{homeTeam.name[language]}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <TeamBadge team={awayTeam} size="sm" />
                      <span style={{ fontWeight: '800', fontSize: '1.1rem' }}>{awayTeam.name[language]}</span>
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>
                    <div>{t('kickoff')}</div>
                    <div style={{ fontWeight: '700', color: 'hsl(var(--text-primary))', marginTop: '0.2rem' }}>{formattedTime}</div>
                  </div>
                </div>

                <div
                  style={{
                    backgroundColor: card.tier === 'pick' ? 'hsl(var(--primary) / 0.06)' : 'hsl(var(--accent) / 0.06)',
                    border: `1px solid ${card.tier === 'pick' ? 'hsl(var(--primary) / 0.22)' : 'hsl(var(--accent) / 0.22)'}`,
                    borderRadius: '12px',
                    padding: '1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                    <div>
                      <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-secondary))', textTransform: 'uppercase', fontWeight: '700' }}>
                        {card.tier === 'pick' ? t('pick') : t('reference')} · {getPredictionValueLabel(prediction, language)}
                      </span>
                      <h4 style={{ fontSize: '1.25rem', fontWeight: '900', color: 'hsl(var(--primary))', marginTop: '0.1rem' }}>
                        {getPredictionTipDisplay(prediction, language)}
                      </h4>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>{t('odds')}</span>
                      <div style={{ fontSize: '1.3rem', fontWeight: '900', color: 'hsl(var(--accent))' }}>
                        {hasDisplayOdds ? `@${prediction.odds.toFixed(2)}` : (language === 'zh' ? '参考' : 'Ref')}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
                    <div style={{ position: 'relative', width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="48" height="48" viewBox="0 0 36 36" style={{ transform: 'rotate(-90deg)' }}>
                        <path
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke="hsl(var(--border))"
                          strokeWidth="3.5"
                        />
                        <path
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke={card.tier === 'pick' ? 'hsl(var(--primary))' : 'hsl(var(--accent))'}
                          strokeDasharray={`${prediction.trustScore || 0}, 100`}
                          strokeWidth="3.5"
                        />
                      </svg>
                      <span style={{ position: 'absolute', fontSize: '0.75rem', fontWeight: '800' }}>{prediction.trustScore || 0}%</span>
                    </div>

                    <div>
                      <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('confidence')}</span>
                      <span style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', fontWeight: '500' }}>
                        {getBestCardNote(card)}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => onSelectMatch(match.id)}
                  className="btn btn-secondary"
                  style={{ width: '100%', marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                >
                  <Trophy size={14} style={{ color: 'hsl(var(--primary))' }} />
                  <span>{t('viewDetail')}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
