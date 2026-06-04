import React, { useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { PredictionDetail } from '../services/mockData';
import { getMarketLabel, getPredictionTipDisplay, getSportteryOddsRows } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { ArrowLeft, Lock, Trophy } from 'lucide-react';

interface MatchDetailProps {
  matchId: string;
  onBack: () => void;
}

export const MatchDetail: React.FC<MatchDetailProps> = ({ matchId, onBack }) => {
  const { language, isPremium, togglePremium, matches } = useApp();
  const [activeTab, setActiveTab] = useState<'predictions' | 'stats' | 'form' | 'h2h' | 'standings'>('predictions');

  // 获取比赛详情
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return (
      <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
        <p>{language === 'zh' ? '比赛不存在' : 'Match not found'}</p>
        <button onClick={onBack} className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ArrowLeft size={16} /> {language === 'zh' ? '返回列表' : 'Back'}
        </button>
      </div>
    );
  }

  const homeTeam = getTeamById(match.homeTeamId);
  const awayTeam = getTeamById(match.awayTeamId);
  const league = getLeagueById(match.leagueId);
  const country = getCountryById(match.countryId);
  
  const isFinished = match.status === 'FINISHED';
  const isLive = match.status === 'LIVE';
  
  const formattedDate = new Date(match.kickoffTime).toLocaleDateString(undefined, { 
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const translations = {
    backBtn: { zh: '返回列表', en: 'Back' },
    predictionsTab: { zh: 'AI 预测推荐', en: 'Predictions' },
    statsTab: { zh: '数据统计', en: 'Match Stats' },
    formTab: { zh: '近期战绩', en: 'Form & Streaks' },
    h2hTab: { zh: '交锋历史', en: 'Head-to-Head' },
    standingsTab: { zh: '联赛积分榜', en: 'Standings' },
    market: { zh: '推荐市场', en: 'Market' },
    tip: { zh: '推荐选项', en: 'Tip' },
    odds: { zh: 'SP', en: 'Odds' },
    trust: { zh: '可信度', en: 'Confidence' },
    analysis: { zh: '模型深度解析', en: 'AI Analysis' },
    scorePrediction: { zh: 'AI 比分推演', en: 'AI Score Prediction' },
    teamValue: { zh: '阵容估值', en: 'Squad Value' },
    kickoff: { zh: '开赛时间', en: 'Kickoff' },
    lockedText: { zh: '此高阶 AI 预测数据仅对高级会员公开。一键模拟升级以解锁。', en: 'This advanced AI prediction is for Premium members only. Click to simulate unlock.' },
    unlockBtn: { zh: '解锁所有预测', en: 'Unlock All Data' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  // 渲染预测详细行
  const renderPredictionBlock = (pred: PredictionDetail) => {
    // 免费版对活跃比赛的高级推荐锁定
    const isLocked = !isFinished && pred.visibilityStatus === 'PREMIUM' && !isPremium;

    return (
      <div 
        key={pred.marketType}
        className="card" 
        style={{ 
          position: 'relative', 
          backgroundColor: 'hsl(var(--bg))', 
          borderColor: isLocked ? 'hsl(var(--premium) / 0.3)' : 'hsl(var(--border))',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflow: 'hidden'
        }}
      >
        {isLocked && (
          <div className="lock-overlay">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', padding: '1rem', textAlign: 'center' }}>
              <Lock size={20} style={{ color: 'hsl(var(--premium))' }} />
              <span style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))', fontWeight: '500', maxWidth: '300px' }}>
                {t('lockedText')}
              </span>
              <button 
                onClick={togglePremium} 
                className="btn btn-premium" 
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
              >
                {t('unlockBtn')}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', filter: isLocked ? 'blur(3px)' : 'none' }}>
          <div>
            <span style={{ 
              fontSize: '0.75rem', 
              color: 'hsl(var(--text-secondary))', 
              textTransform: 'uppercase', 
              fontWeight: '700', 
              letterSpacing: '0.5px' 
            }}>
              {getMarketLabel(pred.marketType, language)}
            </span>
            <h4 style={{ fontSize: '1.1rem', fontWeight: '800', color: pred.marketType === 'BEST' ? 'hsl(var(--primary))' : 'hsl(var(--text-primary))', marginTop: '0.2rem' }}>
              {getPredictionTipDisplay(pred, language)}
            </h4>
          </div>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('odds')}</span>
              <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--accent))' }}>@{pred.odds.toFixed(2)}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('trust')}</span>
              <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--primary))' }}>{pred.trustScore}%</span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem', filter: isLocked ? 'blur(3px)' : 'none' }}>
          <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block', marginBottom: '0.25rem', fontWeight: '600' }}>
            {t('analysis')}
          </span>
          <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.6' }}>
            {pred.explanation[language]}
          </p>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 1. 面包屑与返回 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))' }}>
          {language === 'zh' ? '首页' : 'Home'} / {country.name[language]} / {league.name[language]} / {homeTeam.shortName[language]} vs {awayTeam.shortName[language]}
        </div>
        <button onClick={onBack} className="btn btn-secondary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <ArrowLeft size={16} />
          <span>{t('backBtn')}</span>
        </button>
      </div>

      {/* 2. 比赛详情头部看板 */}
      <div className="card" style={{ 
        background: 'linear-gradient(135deg, hsl(var(--bg-card)) 0%, hsl(var(--bg-card-hover)) 100%)',
        display: 'flex', 
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
        gap: '1.5rem'
      }}>
        
        {/* 联赛与时间 */}
        <div>
          <span style={{ fontSize: '0.8rem', color: 'hsl(var(--primary))', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px' }}>
            {league.name[language]}
          </span>
          <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', marginTop: '0.25rem' }}>
            {formattedDate}
          </div>
        </div>

        {/* 球队比分对阵大面板 */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-around', 
          alignItems: 'center', 
          width: '100%', 
          maxWidth: '700px',
          flexWrap: 'wrap',
          gap: '1.5rem'
        }}>
          {/* 主队 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={homeTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {homeTeam.name[language]}
            </h3>
            <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
              {t('teamValue')}: {homeTeam.value}
            </span>
          </div>

          {/* 比分 / 状态 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            {isFinished ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--primary))' }}>
                  {match.scoreHome} - {match.scoreAway}
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh' ? '已结束' : 'Finished'}
                </span>
              </div>
            ) : isLive ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--danger))' }}>
                  {match.scoreHome} - {match.scoreAway}
                </div>
                <span className="badge badge-live">LIVE</span>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                  {language === 'zh' ? '未开赛' : 'Scheduled'}
                </span>
              </div>
            )}
          </div>

          {/* 客队 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={awayTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {awayTeam.name[language]}
            </h3>
            <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
              {t('teamValue')}: {awayTeam.value}
            </span>
          </div>

        </div>

        {/* 底部 SP 展示 */}
        <div style={{ 
          borderTop: '1px solid hsl(var(--border))', 
          width: '100%', 
          paddingTop: '1rem',
          display: 'flex',
          justifyContent: 'center',
          gap: '2rem',
          fontSize: '0.875rem'
        }}>
          {getSportteryOddsRows(match.odds, language).map((row) => (
            <div key={row.label}>
              {row.label} <span style={{ color: 'hsl(var(--text-muted))' }}>{row.hint}</span>:{' '}
              <span style={{ fontWeight: '700', color: 'hsl(var(--accent))' }}>{row.value.toFixed(2)}</span>
            </div>
          ))}
          {match.oddsSource && (
            <div style={{ color: 'hsl(var(--success))', fontWeight: 700 }}>
              {language === 'zh' ? '官方HAD' : 'Official HAD'}
              {match.oddsUpdatedAt ? ` · ${match.oddsUpdatedAt}` : ''}
            </div>
          )}
        </div>

      </div>

      {/* 3. 导航 Tabs */}
      <div className="tabs-container">
        <button className={`tab-btn ${activeTab === 'predictions' ? 'active' : ''}`} onClick={() => setActiveTab('predictions')}>{t('predictionsTab')}</button>
        <button className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>{t('statsTab')}</button>
        <button className={`tab-btn ${activeTab === 'form' ? 'active' : ''}`} onClick={() => setActiveTab('form')}>{t('formTab')}</button>
        <button className={`tab-btn ${activeTab === 'h2h' ? 'active' : ''}`} onClick={() => setActiveTab('h2h')}>{t('h2hTab')}</button>
        <button className={`tab-btn ${activeTab === 'standings' ? 'active' : ''}`} onClick={() => setActiveTab('standings')}>{t('standingsTab')}</button>
      </div>

      {/* 4. Tab 内容区域 */}
      <div>
        
        {/* Tab 1: AI 推荐 */}
        {activeTab === 'predictions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* 比分推演卡片 */}
            <div className="card" style={{ 
              background: 'linear-gradient(135deg, hsl(var(--primary) / 0.05) 0%, transparent 100%)',
              borderColor: 'hsl(var(--primary) / 0.2)',
              position: 'relative',
              overflow: 'hidden'
            }}>
              {!isPremium && !isFinished && (
                <div className="lock-overlay">
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', textAlign: 'center' }}>
                    <Lock size={16} style={{ color: 'hsl(var(--premium))' }} />
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-secondary))' }}>
                      {language === 'zh' ? '比分预测属高级会员独享' : 'Score prediction is locked'}
                    </span>
                  </div>
                </div>
              )}
              <h4 style={{ fontSize: '0.9rem', color: 'hsl(var(--primary))', textTransform: 'uppercase', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Trophy size={16} />
                {t('scorePrediction')}
              </h4>
              <div style={{ fontSize: '2.5rem', fontWeight: '900', fontFamily: 'var(--font-title)', margin: '0.75rem 0', filter: (!isPremium && !isFinished) ? 'blur(4px)' : 'none' }}>
                {/* 模拟生成的比分 */}
                {isFinished ? `${match.scoreHome} - ${match.scoreAway}` : '2 - 1'}
              </div>
              <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', filter: (!isPremium && !isFinished) ? 'blur(4px)' : 'none' }}>
                {language === 'zh' 
                  ? '模型结合双方 xG 演进曲线、防守反击效率得出本场最可能之最终比分。'
                  : 'Derived from xG progression models and tactical defensive transitions.'}
              </p>
            </div>

            {/* 预测列表 */}
            {match.predictions.map(pred => renderPredictionBlock(pred))}

          </div>
        )}

        {/* Tab 2: 统计数据 */}
        {activeTab === 'stats' && match.stats && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {language === 'zh' ? 'AI 数值预测 vs 场均实力' : 'AI Performance Forecast'}
            </h3>
            
            {/* 进度条统计 */}
            {[
              { label: 'xG (期望进球)', home: match.stats.xG.home, away: match.stats.xG.away, unit: '' },
              { label: '控球率 (Possession)', home: match.stats.possession.home, away: match.stats.possession.away, unit: '%' },
              { label: '射门数 (Shots)', home: match.stats.shots.home, away: match.stats.shots.away, unit: '' },
              { label: '射正数 (Shots on Target)', home: match.stats.shotsOnTarget.home, away: match.stats.shotsOnTarget.away, unit: '' },
              { label: '角球 (Corners)', home: match.stats.corners.home, away: match.stats.corners.away, unit: '' },
              { label: '黄牌 (Yellow Cards)', home: match.stats.yellowCards.home, away: match.stats.yellowCards.away, unit: '' },
            ].map((stat, idx) => {
              const total = stat.home + stat.away;
              const homePct = total === 0 ? 50 : Math.round((stat.home / total) * 100);
              const awayPct = 100 - homePct;

              return (
                <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: '500' }}>
                    <span>{stat.home}{stat.unit}</span>
                    <span style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>{stat.label}</span>
                    <span>{stat.away}{stat.unit}</span>
                  </div>
                  {/* 双向进度条 */}
                  <div style={{ display: 'flex', width: '100%', height: '8px', backgroundColor: 'hsl(var(--border))', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${homePct}%`, backgroundColor: homeTeam.color, transition: 'width 0.3s' }} />
                    <div style={{ width: `${awayPct}%`, backgroundColor: awayTeam.color, transition: 'width 0.3s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Tab 3: 近期战绩 */}
        {activeTab === 'form' && match.recentForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* 近10场概览 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
              {/* 主队 10 场统计 */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '700' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: homeTeam.color }} />
                  {homeTeam.shortName[language]} {language === 'zh' ? '近10场表现' : 'Last 10 Form'}
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', textAlign: 'center' }}>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>胜 - 平 - 负</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem', color: 'hsl(var(--primary))' }}>
                      {match.recentForm.home.statsLast10.wins} - {match.recentForm.home.statsLast10.draws} - {match.recentForm.home.statsLast10.losses}
                    </span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>大 2.5 球率</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem' }}>{match.recentForm.home.statsLast10.over2_5}%</span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>双方进球率</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem' }}>{match.recentForm.home.statsLast10.bothToScore}%</span>
                  </div>
                </div>
              </div>

              {/* 客队 10 场统计 */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '700' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: awayTeam.color }} />
                  {awayTeam.shortName[language]} {language === 'zh' ? '近10场表现' : 'Last 10 Form'}
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', textAlign: 'center' }}>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>胜 - 平 - 负</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem', color: 'hsl(var(--primary))' }}>
                      {match.recentForm.away.statsLast10.wins} - {match.recentForm.away.statsLast10.draws} - {match.recentForm.away.statsLast10.losses}
                    </span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>大 2.5 球率</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem' }}>{match.recentForm.away.statsLast10.over2_5}%</span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.5rem', borderRadius: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>双方进球率</span>
                    <span style={{ fontWeight: '700', fontSize: '1rem' }}>{match.recentForm.away.statsLast10.bothToScore}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 双方历史近期战绩明细 */}
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h4 style={{ fontWeight: '700' }}>{language === 'zh' ? '近期交手比赛结果' : 'Recent Matches Record'}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
                {/* 主队 */}
                <div>
                  <h5 style={{ fontSize: '0.85rem', color: 'hsl(var(--text-secondary))', marginBottom: '0.5rem' }}>{homeTeam.shortName[language]}</h5>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {match.recentForm.home.recentMatches.map((m, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', backgroundColor: 'hsl(var(--bg))', padding: '0.5rem 0.75rem', borderRadius: '8px' }}>
                        <span>{m.isHome ? 'H' : 'A'} vs {m.opponentName[language]}</span>
                        <span style={{ fontWeight: '700', color: m.ourScore > m.oppScore ? 'hsl(var(--primary))' : (m.ourScore === m.oppScore ? 'hsl(var(--text-secondary))' : 'hsl(var(--danger))') }}>
                          {m.ourScore} - {m.oppScore}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 客队 */}
                <div>
                  <h5 style={{ fontSize: '0.85rem', color: 'hsl(var(--text-secondary))', marginBottom: '0.5rem' }}>{awayTeam.shortName[language]}</h5>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {match.recentForm.away.recentMatches.map((m, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', backgroundColor: 'hsl(var(--bg))', padding: '0.5rem 0.75rem', borderRadius: '8px' }}>
                        <span>{m.isHome ? 'H' : 'A'} vs {m.opponentName[language]}</span>
                        <span style={{ fontWeight: '700', color: m.ourScore > m.oppScore ? 'hsl(var(--primary))' : (m.ourScore === m.oppScore ? 'hsl(var(--text-secondary))' : 'hsl(var(--danger))') }}>
                          {m.ourScore} - {m.oppScore}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* Tab 4: 交锋历史 */}
        {activeTab === 'h2h' && match.h2h && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {language === 'zh' ? '历史对阵记录' : 'Head-to-Head History'}
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {match.h2h.map((rec, idx) => {
                const isHomeH = rec.homeTeamId === homeTeam.id;
                const hName = isHomeH ? homeTeam.shortName[language] : awayTeam.shortName[language];
                const aName = isHomeH ? awayTeam.shortName[language] : homeTeam.shortName[language];

                return (
                  <div 
                    key={idx}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: 'hsl(var(--bg))',
                      padding: '0.75rem 1rem',
                      borderRadius: '10px',
                      border: '1px solid hsl(var(--border))',
                      fontSize: '0.85rem'
                    }}
                  >
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>{rec.date}</span>
                    <span style={{ color: 'hsl(var(--primary))', fontSize: '0.75rem', fontWeight: '600' }}>{rec.competition[language]}</span>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: '600' }}>
                      <span>{hName}</span>
                      <span style={{ 
                        backgroundColor: 'hsl(var(--border))', 
                        padding: '0.15rem 0.5rem', 
                        borderRadius: '4px',
                        fontFamily: 'var(--font-title)'
                      }}>
                        {rec.homeScore} - {rec.awayScore}
                      </span>
                      <span>{aName}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab 5: 积分榜 */}
        {activeTab === 'standings' && match.standings && (
          <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
            <div style={{ padding: '1rem', backgroundColor: 'hsl(var(--bg-card-hover))', borderBottom: '1px solid hsl(var(--border))', fontWeight: '700' }}>
              {league.name[language]} - {language === 'zh' ? '最新排名' : 'Standings Table'}
            </div>
            
            <table className="responsive-table">
              <thead>
                <tr>
                  <th style={{ width: '60px', textAlign: 'center' }}>排名</th>
                  <th>球队</th>
                  <th style={{ textAlign: 'center' }}>已赛</th>
                  <th style={{ textAlign: 'center' }}>胜</th>
                  <th style={{ textAlign: 'center' }}>平</th>
                  <th style={{ textAlign: 'center' }}>负</th>
                  <th style={{ textAlign: 'center' }}>进/失球</th>
                  <th style={{ textAlign: 'center', fontWeight: '700' }}>积分</th>
                </tr>
              </thead>
              <tbody>
                {match.standings.map((row) => {
                  const teamObj = getTeamById(row.teamId);
                  const isCurrentMatchTeam = teamObj.id === homeTeam.id || teamObj.id === awayTeam.id;

                  return (
                    <tr 
                      key={row.position}
                      style={{ 
                        backgroundColor: isCurrentMatchTeam ? 'hsl(var(--primary) / 0.08)' : 'transparent',
                        fontWeight: isCurrentMatchTeam ? '700' : 'normal'
                      }}
                    >
                      <td data-label="排名" style={{ textAlign: 'center' }}>
                        <span style={{ 
                          display: 'inline-flex', width: '22px', height: '22px', borderRadius: '50%',
                          backgroundColor: row.position <= 3 ? 'hsl(var(--primary) / 0.15)' : 'transparent',
                          color: row.position <= 3 ? 'hsl(var(--primary))' : 'hsl(var(--text-secondary))',
                          alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: '700'
                        }}>
                          {row.position}
                        </span>
                      </td>
                      <td data-label="球队">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: teamObj.color }} />
                          <span>{teamObj.name[language]}</span>
                        </div>
                      </td>
                      <td data-label="已赛" style={{ textAlign: 'center' }}>{row.played}</td>
                      <td data-label="胜" style={{ textAlign: 'center', color: 'hsl(var(--primary))' }}>{row.wins}</td>
                      <td data-label="平" style={{ textAlign: 'center' }}>{row.draws}</td>
                      <td data-label="负" style={{ textAlign: 'center', color: 'hsl(var(--danger))' }}>{row.losses}</td>
                      <td data-label="得失球" style={{ textAlign: 'center', color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>
                        {row.goalsFor}:{row.goalsAgainst}
                      </td>
                      <td data-label="积分" style={{ textAlign: 'center', fontWeight: '800', color: 'hsl(var(--primary))' }}>{row.points}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      </div>

    </div>
  );
};
