import React from 'react';
import { useApp } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { getPredictionTipDisplay } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { Lock, Trophy, Calendar } from 'lucide-react';

interface BestTipsProps {
  onSelectMatch: (matchId: string) => void;
}

export const BestTips: React.FC<BestTipsProps> = ({ onSelectMatch }) => {
  const { language, isPremium, togglePremium, matches } = useApp();

  // 筛选出所有今天和明天的比赛中的 BEST 推荐
  const activeBestMatches = React.useMemo(() => {
    return matches.filter((m: Match) => {
      const isFinished = m.status === 'FINISHED';
      if (isFinished) return false; // 精选页主要展示活跃的未开始比赛
      return m.predictions.some(p => p.marketType === 'BEST');
    });
  }, [matches]);

  const translations = {
    title: { zh: '高可信精选 VIP 推荐', en: 'Daily Best VIP Tips' },
    subtitle: { 
      zh: '由高维度数学预测模型每日精选，仅挑选可信度 80% 以上的最稳赛事推荐。历史长期盈利率标杆。', 
      en: 'Selected daily by our multi-layered mathematical models, featuring only 80%+ confidence choices.' 
    },
    lockedNotice: {
      zh: '高可信精选推荐为 PRO 订阅专享。升级即可全天候解锁全部模型首选、高阶比分推演和进球数据预测。',
      en: 'Daily Best Tips are locked for Free users. Upgrade to PRO to reveal all high-confidence model selections.'
    },
    unlockBtn: { zh: '模拟升级 PRO 立即解锁', en: 'Simulate Pro to Unlock' },
    confidence: { zh: '模型信赖度', en: 'Model Confidence' },
    odds: { zh: '首选SP', en: 'Primary Odds' },
    kickoff: { zh: '开赛', en: 'Kickoff' },
    viewDetail: { zh: '查看深度数据统计', en: 'Analyze Match Stats' },
    noTips: { zh: '今日暂无高可信推荐发布。请稍后再试。', en: 'No VIP tips published yet for today. Check back later.' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 头部介绍 */}
      <div style={{ textAlign: 'center', maxWidth: '700px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h2>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
      </div>

      {/* 精选卡片列表 */}
      {activeBestMatches.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem', color: 'hsl(var(--text-secondary))' }}>
          <Calendar size={40} style={{ marginBottom: '1rem', color: 'hsl(var(--border))' }} />
          <p>{t('noTips')}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '2rem' }}>
          {activeBestMatches.map((match) => {
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const bestPred = match.predictions.find(p => p.marketType === 'BEST')!;
            
            const isLocked = !isPremium;
            const formattedTime = new Date(match.kickoffTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

            return (
              <div 
                key={match.id} 
                className="card premium-card"
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: '1.5rem', 
                  padding: '2rem',
                  borderColor: isLocked ? 'hsl(var(--premium) / 0.4)' : 'hsl(var(--primary) / 0.4)'
                }}
              >
                
                {/* 顶部对阵 */}
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

                  {/* 开赛时间 */}
                  <div style={{ textAlign: 'right', fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>
                    <div>{t('kickoff')}</div>
                    <div style={{ fontWeight: '700', color: 'hsl(var(--text-primary))', marginTop: '0.2rem' }}>{formattedTime}</div>
                  </div>
                </div>

                {/* 锁定提示 overlay / 预测结果 */}
                {isLocked ? (
                  <div style={{ 
                    backgroundColor: 'hsl(var(--bg))', 
                    border: '1px solid hsl(var(--premium) / 0.2)', 
                    borderRadius: '12px', 
                    padding: '1.5rem',
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.75rem',
                    position: 'relative'
                  }}>
                    <Lock size={24} style={{ color: 'hsl(var(--premium))' }} />
                    <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.5', maxWidth: '280px' }}>
                      {t('lockedNotice')}
                    </p>
                    <button onClick={togglePremium} className="btn btn-premium" style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}>
                      {t('unlockBtn')}
                    </button>
                  </div>
                ) : (
                  /* 解锁后的黄金显示区 */
                  <div style={{ 
                    backgroundColor: 'hsl(var(--primary) / 0.05)', 
                    border: '1px solid hsl(var(--primary) / 0.2)', 
                    borderRadius: '12px', 
                    padding: '1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem'
                  }}>
                    
                    {/* 首选推荐和 SP */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-secondary))', textTransform: 'uppercase', fontWeight: '700' }}>⭐️ {t('title')}</span>
                        <h4 style={{ fontSize: '1.25rem', fontWeight: '900', color: 'hsl(var(--primary))', marginTop: '0.1rem' }}>
                          {getPredictionTipDisplay(bestPred, language)}
                        </h4>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>{t('odds')}</span>
                        <div style={{ fontSize: '1.3rem', fontWeight: '900', color: 'hsl(var(--accent))' }}>@{bestPred.odds.toFixed(2)}</div>
                      </div>
                    </div>

                    {/* 可信度仪表盘 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
                      
                      {/* 圆环进度条模拟 */}
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
                            strokeDasharray={`${bestPred.trustScore}, 100`}
                            strokeWidth="3.5"
                          />
                        </svg>
                        <span style={{ position: 'absolute', fontSize: '0.75rem', fontWeight: '800' }}>{bestPred.trustScore}%</span>
                      </div>

                      <div>
                        <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('confidence')}</span>
                        <span style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', fontWeight: '500' }}>
                          数学期望概率极高，适合单场大仓或串关胆码。
                        </span>
                      </div>

                    </div>

                  </div>
                )}

                {/* 底部详情跳转 */}
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
