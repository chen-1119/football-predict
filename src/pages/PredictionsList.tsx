import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { 
  countries, 
  leagues, 
  teams, 
  getDateStringOffset 
} from '../services/mockData';
import type { Match, PredictionDetail } from '../services/mockData';
import { Lock, SlidersHorizontal, Calendar, Sparkles } from 'lucide-react';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
}

export const PredictionsList: React.FC<PredictionsListProps> = ({ onSelectMatch }) => {
  const { language, isPremium, togglePremium, matches } = useApp();
  
  // 日期范围
  const yesterdayStr = getDateStringOffset(-1);
  const todayStr = getDateStringOffset(0);
  const tomorrowStr = getDateStringOffset(1);
  const dayAfterTomorrowStr = getDateStringOffset(2);

  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  
  // 排序状态
  const [sortBy, setSortBy] = useState<string>('time'); // 'time', 'trust', 'odds'
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // 1. 过滤 & 分类数据
  const filteredMatches = useMemo(() => {
    return matches.filter(m => {
      // 日期过滤：使用自然日期 (北京时间 YYYY-MM-DD)，使用更直观的开赛日期分类
      const matchDay = m.kickoffTime.split('T')[0];
      if (matchDay !== selectedDate) return false;

      // 国家过滤 (多选)
      if (selectedCountries.length > 0 && !selectedCountries.includes(m.countryId)) {
        return false;
      }

      return true;
    });
  }, [selectedDate, selectedCountries, matches]);

  // 对过滤后的数据进行排序
  const sortedMatches = useMemo(() => {
    const sorted = [...filteredMatches];
    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'time') {
        comparison = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      } else if (sortBy === 'trust') {
        // 取得各自的最佳预测可信度
        const aBest = a.predictions.find(p => p.marketType === 'BEST')?.trustScore || 0;
        const bBest = b.predictions.find(p => p.marketType === 'BEST')?.trustScore || 0;
        comparison = aBest - bBest;
      } else if (sortBy === 'odds') {
        const aBestOdds = a.predictions.find(p => p.marketType === 'BEST')?.odds || 0;
        const bBestOdds = b.predictions.find(p => p.marketType === 'BEST')?.odds || 0;
        comparison = aBestOdds - bBestOdds;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredMatches, sortBy, sortOrder]);

  // 按联赛 + 国家对比赛分组
  const groupedMatches = useMemo(() => {
    const groups: { [key: string]: { league: any; country: any; matches: Match[] } } = {};
    
    sortedMatches.forEach(m => {
      const key = `${m.countryId}_${m.leagueId}`;
      if (!groups[key]) {
        const leagueObj = leagues.find(l => l.id === m.leagueId);
        const countryObj = countries.find(c => c.id === m.countryId);
        groups[key] = {
          league: leagueObj,
          country: countryObj,
          matches: []
        };
      }
      groups[key].matches.push(m);
    });

    return Object.values(groups);
  }, [sortedMatches]);

  // 国家过滤勾选切换
  const handleCountryToggle = (countryId: string) => {
    if (selectedCountries.includes(countryId)) {
      setSelectedCountries(selectedCountries.filter(id => id !== countryId));
    } else {
      setSelectedCountries([...selectedCountries, countryId]);
    }
  };

  const handleResetFilters = () => {
    setSelectedCountries([]);
    setSortBy('time');
    setSortOrder('asc');
  };

  // 词条翻译
  const translations = {
    premiumNotice: {
      zh: '您当前使用的是免费版本。部分活跃的 AI 高级稳胆、大小球和GG预测已锁定。升级到 PRO 会员即可解锁全站 100% 数据！',
      en: 'You are currently on Free Mode. Advanced AI Best Tips, Goals, and GG Predictions are locked. Upgrade to PRO to unlock all data!'
    },
    upgradeBtn: { zh: '立即升级 PRO', en: 'Upgrade to PRO' },
    filterTitle: { zh: '国家/联赛筛选', en: 'Filter by Countries' },
    allCountries: { zh: '全部国家', en: 'All Countries' },
    sortTitle: { zh: '排序与过滤', en: 'Sort & Filters' },
    time: { zh: '时间', en: 'Time' },
    trust: { zh: '可信度', en: 'Trust' },
    odds: { zh: '赔率', en: 'Odds' },
    reset: { zh: '重置筛选', en: 'Reset' },
    noMatches: { zh: '今天没有已排程的比赛预测。', en: 'No scheduled matches found for this day.' },
    yesterday: { zh: '昨天', en: 'Yesterday' },
    today: { zh: '今天', en: 'Today' },
    tomorrow: { zh: '明天', en: 'Tomorrow' },
    finished: { zh: '已结束', en: 'Finished' },
    details: { zh: '详情', en: 'Details' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  // 辅助渲染预测格子
  const renderPredictionCell = (match: Match, marketType: '1X2' | 'GOALS' | 'GG_NG' | 'BEST') => {
    const isFinished = match.status === 'FINISHED';
    const pred = match.predictions.find((p: PredictionDetail) => p.marketType === marketType);

    if (!pred) return '-';

    // 免费锁定逻辑：如果是活跃比赛，且是 PREMIUM 预测，且用户不是 VIP，则锁定
    const isLocked = !isFinished && pred.visibilityStatus === 'PREMIUM' && !isPremium;

    if (isLocked) {
      return (
        <div 
          onClick={(e) => {
            e.stopPropagation();
            togglePremium(); // 点击锁一键升级
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem',
            color: 'hsl(var(--premium))', cursor: 'pointer', background: 'hsl(var(--premium) / 0.1)',
            padding: '0.35rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: '600',
            border: '1px solid hsl(var(--premium) / 0.2)'
          }}
          title={language === 'zh' ? '点击模拟升级解锁' : 'Click to unlock'}
        >
          <Lock size={12} />
          <span>PRO</span>
        </div>
      );
    }

    // 已结束比赛，显示是否命中
    const showResult = isFinished && pred.resultStatus === 'WON';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem' }}>
        <span style={{ 
          fontSize: '0.825rem', 
          fontWeight: '700', 
          color: showResult ? 'hsl(var(--primary))' : 'hsl(var(--text-primary))',
          textAlign: 'center'
        }}>
          {pred.tipCode}
        </span>
        <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>
          @{pred.odds.toFixed(2)}
        </span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 1. 顶部统计与订阅横幅 */}
      {!isPremium && (
        <div className="card premium-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', maxWidth: '800px' }}>
            <div style={{ backgroundColor: 'hsl(var(--premium) / 0.15)', color: 'hsl(var(--premium))', padding: '0.5rem', borderRadius: '10px' }}>
              <Sparkles size={20} />
            </div>
            <p style={{ fontSize: '0.875rem', color: 'hsl(var(--text-primary))', lineHeight: '1.5' }}>
              {t('premiumNotice')}
            </p>
          </div>
          <button onClick={togglePremium} className="btn btn-premium" style={{ whiteSpace: 'nowrap' }}>
            {t('upgradeBtn')}
          </button>
        </div>
      )}

      {/* 顶部统计卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ fontSize: '2rem' }}>📊</div>
          <div>
            <div style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>昨日命中率 (Yesterday accuracy)</div>
            <div style={{ fontSize: '1.5rem', fontWeight: '800', color: 'hsl(var(--primary))' }}>82.3%</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ fontSize: '2rem' }}>⚽</div>
          <div>
            <div style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>今日预测场次 (Total Predictions)</div>
            <div style={{ fontSize: '1.5rem', fontWeight: '800', color: 'hsl(var(--accent))' }}>18 场 (Matches)</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ fontSize: '2rem' }}>🏆</div>
          <div>
            <div style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>累计红单 (Total Hits)</div>
            <div style={{ fontSize: '1.5rem', fontWeight: '800', color: 'hsl(var(--primary))' }}>4,923+</div>
          </div>
        </div>
      </div>

      {/* 2. 日期横向切换器 */}
      <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
        {[
          { label: t('yesterday'), date: yesterdayStr },
          { label: t('today'), date: todayStr },
          { label: t('tomorrow'), date: tomorrowStr },
          { label: getDateStringOffset(2), date: dayAfterTomorrowStr }
        ].map((d, index) => (
          <button
            key={index}
            onClick={() => setSelectedDate(d.date)}
            className="btn"
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '12px',
              backgroundColor: selectedDate === d.date ? 'hsl(var(--primary))' : 'hsl(var(--bg-card))',
              color: selectedDate === d.date ? '#000' : 'hsl(var(--text-primary))',
              border: '1px solid hsl(var(--border))',
              minWidth: '120px'
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>{d.label}</span>
              <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>{d.date}</span>
            </div>
          </button>
        ))}
      </div>

      {/* 3. 过滤器与排序器 */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '1.25rem' }}>
        
        {/* 国家多选 */}
        <div>
          <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-secondary))', display: 'block', marginBottom: '0.75rem', fontWeight: '600' }}>
            {t('filterTitle')}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              onClick={() => setSelectedCountries([])}
              className="btn btn-secondary"
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                borderRadius: '8px',
                backgroundColor: selectedCountries.length === 0 ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                borderColor: selectedCountries.length === 0 ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                color: selectedCountries.length === 0 ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))'
              }}
            >
              {t('allCountries')}
            </button>
            {countries.map(c => {
              const isSelected = selectedCountries.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => handleCountryToggle(c.id)}
                  className="btn btn-secondary"
                  style={{
                    padding: '0.35rem 0.75rem',
                    fontSize: '0.8rem',
                    borderRadius: '8px',
                    backgroundColor: isSelected ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                    borderColor: isSelected ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                    color: isSelected ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))',
                    display: 'flex', alignItems: 'center', gap: '0.25rem'
                  }}
                >
                  <span>{c.flag}</span>
                  <span>{c.name[language]}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 排序器 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', borderTop: '1px solid hsl(var(--border))', paddingTop: '1rem' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <SlidersHorizontal size={16} style={{ color: 'hsl(var(--text-secondary))' }} />
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-secondary))', fontWeight: '600' }}>
              {t('sortTitle')}:
            </span>
            <div style={{ display: 'flex', gap: '0.25rem', backgroundColor: 'hsl(var(--bg))', padding: '0.25rem', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}>
              {['time', 'trust', 'odds'].map(s => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className="btn"
                  style={{
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.75rem',
                    borderRadius: '6px',
                    backgroundColor: sortBy === s ? 'hsl(var(--border))' : 'transparent',
                    color: sortBy === s ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))',
                  }}
                >
                  {t(s as any)}
                </button>
              ))}
            </div>

            {/* 升序/降序 */}
            <button
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: '6px' }}
            >
              {sortOrder === 'asc' ? '▲' : '▼'}
            </button>
          </div>

          <button onClick={handleResetFilters} className="btn btn-secondary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', borderRadius: '8px' }}>
            {t('reset')}
          </button>
        </div>

      </div>

      {/* 4. 比赛预测分组列表 */}
      {groupedMatches.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'hsl(var(--text-secondary))' }}>
          <Calendar size={40} style={{ marginBottom: '1rem', color: 'hsl(var(--border))' }} />
          <p>{t('noMatches')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {groupedMatches.map((group, gIdx) => (
            <div key={gIdx} className="card" style={{ padding: '0', overflow: 'hidden' }}>
              
              {/* 分组头部：国旗、国家、联赛名称 */}
              <div style={{
                backgroundColor: 'hsl(var(--bg-card-hover))',
                padding: '0.75rem 1.25rem',
                borderBottom: '1px solid hsl(var(--border))',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontWeight: '700',
                fontSize: '0.875rem'
              }}>
                <span>{group.country?.flag}</span>
                <span style={{ color: 'hsl(var(--text-secondary))' }}>{group.country?.name[language]}</span>
                <span style={{ color: 'hsl(var(--text-muted))' }}>/</span>
                <span style={{ color: 'hsl(var(--primary))' }}>{group.league?.name[language]}</span>
              </div>

              {/* 比赛表格 */}
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th style={{ width: '120px' }}>时间 / 状态</th>
                    <th>交战双方</th>
                    <th style={{ textAlign: 'center', width: '80px' }}>1X2 赔率</th>
                    <th style={{ textAlign: 'center', width: '80px' }}>1X2 Tip</th>
                    <th style={{ textAlign: 'center', width: '80px' }}>Goals Tip</th>
                    <th style={{ textAlign: 'center', width: '80px' }}>GG Tip</th>
                    <th style={{ textAlign: 'center', width: '90px' }}>Best Tip</th>
                    <th style={{ textAlign: 'center', width: '90px' }}>Trust 可信度</th>
                    <th style={{ width: '80px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {group.matches.map((match) => {
                    const homeTeam = teams.find(t => t.id === match.homeTeamId)!;
                    const awayTeam = teams.find(t => t.id === match.awayTeamId)!;
                    const isLive = match.status === 'LIVE';
                    const isFinished = match.status === 'FINISHED';
                    const formattedTime = new Date(match.kickoffTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
                    
                    // 获取该比赛的最佳推荐可信度
                    const bestTrust = match.predictions.find(p => p.marketType === 'BEST')?.trustScore || 0;

                    return (
                      <tr 
                        key={match.id} 
                        onClick={() => onSelectMatch(match.id)}
                        style={{ cursor: 'pointer', transition: 'background-color 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'hsl(var(--bg-card-hover) / 0.5)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                      >
                        {/* 状态/时间 */}
                        <td data-label="状态/时间">
                          {isLive ? (
                            <span className="badge badge-live">LIVE {match.scoreHome}:{match.scoreAway}</span>
                          ) : isFinished ? (
                            <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                              {t('finished')} ({match.scoreHome}:{match.scoreAway})
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))', fontWeight: '500' }}>
                              {formattedTime}
                            </span>
                          )}
                        </td>

                        {/* 对阵队伍 */}
                        <td data-label="对阵双方">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: homeTeam.color }} />
                              <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>{homeTeam.name[language]}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: awayTeam.color }} />
                              <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>{awayTeam.name[language]}</span>
                            </div>
                          </div>
                        </td>

                        {/* 1X2 赔率 */}
                        <td data-label="1X2 赔率" style={{ textAlign: 'center' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'hsl(var(--text-secondary))' }}>
                            <span>1: {match.odds.odds1.toFixed(2)}</span>
                            <span>X: {match.odds.oddsX.toFixed(2)}</span>
                            <span>2: {match.odds.odds2.toFixed(2)}</span>
                          </div>
                        </td>

                        {/* 1X2 Tip */}
                        <td data-label="1X2 Tip" style={{ textAlign: 'center' }}>
                          {renderPredictionCell(match, '1X2')}
                        </td>

                        {/* Goals Tip */}
                        <td data-label="Goals Tip" style={{ textAlign: 'center' }}>
                          {renderPredictionCell(match, 'GOALS')}
                        </td>

                        {/* GG Tip */}
                        <td data-label="GG Tip" style={{ textAlign: 'center' }}>
                          {renderPredictionCell(match, 'GG_NG')}
                        </td>

                        {/* Best Tip */}
                        <td data-label="Best Tip" style={{ textAlign: 'center' }}>
                          {renderPredictionCell(match, 'BEST')}
                        </td>

                        {/* Trust 可信度 */}
                        <td data-label="可信度" style={{ textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
                            <span style={{ 
                              fontSize: '0.85rem', 
                              fontWeight: '800', 
                              color: bestTrust >= 80 ? 'hsl(var(--primary))' : (bestTrust >= 65 ? 'hsl(var(--accent))' : 'hsl(var(--text-secondary))')
                            }}>
                              {bestTrust}%
                            </span>
                            {/* 进度条 */}
                            <div style={{ width: '40px', height: '3px', backgroundColor: 'hsl(var(--border))', borderRadius: '2px', marginTop: '0.2rem', overflow: 'hidden' }}>
                              <div style={{ 
                                width: `${bestTrust}%`, 
                                height: '100%', 
                                backgroundColor: bestTrust >= 80 ? 'hsl(var(--primary))' : (bestTrust >= 65 ? 'hsl(var(--accent))' : 'hsl(var(--text-secondary))')
                              }} />
                            </div>
                          </div>
                        </td>

                        {/* 详情入口 */}
                        <td style={{ textAlign: 'right' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem', borderRadius: '6px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectMatch(match.id);
                            }}
                          >
                            {t('details')}
                          </button>
                        </td>

                      </tr>
                    );
                  })}
                </tbody>
              </table>

            </div>
          ))}
        </div>
      )}

    </div>
  );
};
