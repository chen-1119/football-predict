import React from 'react';
import { Calendar, Trophy } from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getPredictionValueLabel, isPredictionOfficialResultPoolAvailable } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import type { Match, PredictionDetail } from '../services/mockData';
import { getVisiblePredictions } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { getDisplayRecommendation } from '../services/displayRecommendation';

interface BestTipsProps {
  onSelectMatch: (matchId: string) => void;
}

type TipCard = {
  match: Match;
  prediction: PredictionDetail;
  pickLabel: string;
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
  return isPredictionOfficialResultPoolAvailable(match, prediction);
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
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const tipCards = React.useMemo<TipCard[]>(() => {
    return matches
      .filter((match) => {
        const kickoffAt = Date.parse(match.kickoffTime);
        return match.status === 'SCHEDULED' && (!Number.isFinite(kickoffAt) || kickoffAt >= now - FUTURE_GRACE_MS);
      })
      .map((match) => {
        const displayRecommendation = getDisplayRecommendation(match, language);
        const prediction = displayRecommendation?.prediction || getCandidatePrediction(match);
        if (!prediction) return null;
        const pickLabel = displayRecommendation?.label || getPredictionTipDisplay(prediction, language);
        const kickoffAt = Date.parse(match.kickoffTime);
        const timeScore = Number.isFinite(kickoffAt) ? Math.max(0, 100 - Math.floor((kickoffAt - now) / 36e5)) : 0;
        return {
          match,
          prediction,
          pickLabel,
          rankScore: (prediction.trustScore || 0) * 3 - marketPriority(prediction) * 20 + timeScore
        };
      })
      .filter((card): card is TipCard => Boolean(card))
      .sort((a, b) => {
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime);
      });
  }, [language, matches, now]);

  const translations = {
    title: { zh: '今日推荐', en: 'Today Picks' },
    subtitle: {
      zh: '只展示官方已开售玩法的推荐；胜平负未开售时，不会显示主胜/平/客胜。',
      en: 'Only on-sale official markets are shown. If 1X2 is not on sale, no home/draw/away pick is displayed.'
    },
    confidence: { zh: '推荐强度', en: 'Pick Strength' },
    odds: { zh: '赔率', en: 'Odds' },
    kickoff: { zh: '开赛', en: 'Kickoff' },
    viewDetail: { zh: '查看分析', en: 'Analyze' },
    noTips: {
      zh: '当前没有可展示的赛前推荐，数据同步完成后会自动更新。',
      en: 'No pre-match recommendation is available yet. The page will update after sync.'
    },
    pick: { zh: '推荐', en: 'Pick' },
    pickCount: { zh: '推荐', en: 'Picks' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

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
            <strong>{tipCards.length}</strong>
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
            const { match, prediction, pickLabel } = card;
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const hasDisplayOdds = Number.isFinite(prediction.odds) && prediction.odds > 0;
            const publicCopy = buildPublicRecommendationCopy(match, prediction, language, {
              pickLabel
            });
            const strengthValue = language === 'zh'
              ? publicCopy.strengthLabel.replace(/^推荐强度\s*/, '')
              : publicCopy.strengthLabel.replace(/^Strength\s*/, '');
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
                  borderColor: 'hsl(var(--primary) / 0.42)'
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
                    backgroundColor: 'hsl(var(--primary) / 0.06)',
                    border: '1px solid hsl(var(--primary) / 0.22)',
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
                        {t('pick')} · {getPredictionValueLabel(prediction, language)}
                      </span>
                      <h4 style={{ fontSize: '1.25rem', fontWeight: '900', color: 'hsl(var(--primary))', marginTop: '0.1rem' }}>
                        {pickLabel}
                      </h4>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>{t('odds')}</span>
                      <div style={{ fontSize: '1.3rem', fontWeight: '900', color: 'hsl(var(--accent))' }}>
                        {hasDisplayOdds ? `@${prediction.odds.toFixed(2)}` : (language === 'zh' ? '待开售' : 'Odds pending')}
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
                          stroke="hsl(var(--primary))"
                          strokeDasharray={`${prediction.trustScore || 0}, 100`}
                          strokeWidth="3.5"
                        />
                      </svg>
                      <span style={{ position: 'absolute', fontSize: '0.7rem', fontWeight: '800' }}>{strengthValue}</span>
                    </div>

                    <div>
                      <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('confidence')}</span>
                      <span style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', fontWeight: '500' }}>
                        {publicCopy.reasons[0]}
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
