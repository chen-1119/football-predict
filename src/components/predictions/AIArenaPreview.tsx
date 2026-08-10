import React from 'react';
import { ArrowRight, Bot, CalendarDays, Coins, LockKeyhole, ShieldCheck, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContextCore';
import {
  arenaPickLabel,
  arenaStatusLabel,
  buildBigFiveSurvivalArena,
} from '../../services/aiArena';
import type { Match } from '../../services/mockData';
import '../../styles/ai-arena.css';

interface AIArenaPreviewProps {
  matches: Match[];
}

const dateLabel = (dateKey: string, language: 'zh' | 'en') => new Date(`${dateKey}T12:00:00+08:00`)
  .toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'Asia/Shanghai',
  });

export const AIArenaPreview: React.FC<AIArenaPreviewProps> = ({ matches }) => {
  const { language } = useApp();
  const arena = React.useMemo(() => buildBigFiveSurvivalArena(matches), [matches]);
  const [activeDate, setActiveDate] = React.useState<string>('all');
  const visibleMatches = activeDate === 'all'
    ? arena.matches
    : arena.matches.filter((row) => row.dateKey === activeDate);

  React.useEffect(() => {
    if (activeDate !== 'all' && !arena.dates.includes(activeDate)) setActiveDate('all');
  }, [activeDate, arena.dates]);

  return (
    <>
      <section className="survival-league-progress" aria-label={language === 'zh' ? '五大联赛入选进度' : 'Big Five selection progress'}>
        {arena.leagueSlots.map((league) => (
          <div key={league.code} className={league.count === league.target ? 'is-complete' : ''}>
            <span>{language === 'zh' ? league.nameZh : league.nameEn}</span>
            <strong>{league.count}/{league.target}</strong>
          </div>
        ))}
      </section>

      <section className="survival-scoreboard" aria-labelledby="survival-ranking-title">
        <div className="survival-section-heading">
          <div>
            <span><Trophy size={15} aria-hidden="true" /> {language === 'zh' ? '本月生存榜' : 'Monthly survival table'}</span>
            <h2 id="survival-ranking-title">{language === 'zh' ? '六 AI 同场竞技' : 'Six-AI competition'}</h2>
          </div>
          <small><LockKeyhole size={14} /> {language === 'zh' ? '赛前提交后锁定' : 'Locked after cutoff'}</small>
        </div>
        <div className="survival-ranking-table" role="table">
          <div className="survival-ranking-row is-head" role="row">
            <span>{language === 'zh' ? 'AI' : 'AI'}</span>
            <span>{language === 'zh' ? '积分' : 'Points'}</span>
            <span>{language === 'zh' ? '预测/Brier' : 'Forecast/Brier'}</span>
            <span>{language === 'zh' ? '最大回撤' : 'Max drawdown'}</span>
            <span>{language === 'zh' ? '本周投资' : 'Investments'}</span>
            <span>{language === 'zh' ? '状态' : 'Status'}</span>
          </div>
          {arena.agents.map((agent, index) => (
            <div className="survival-ranking-row" role="row" key={agent.id}>
              <span className="survival-agent-name"><i style={{ background: agent.color }} /> <b>#{index + 1}</b> {agent.name}</span>
              <strong>{agent.balance.toLocaleString()}</strong>
              <span>{agent.brierScore === null ? (language === 'zh' ? '等待结算' : 'Pending') : agent.brierScore.toFixed(4)}</span>
              <span>{agent.maxDrawdown.toFixed(0)}%</span>
              <span>{agent.investedMatches}/{Math.min(3, arena.availableMatches)} · {agent.totalStake}</span>
              <span className={`survival-status is-${agent.status.toLowerCase()}`}>{arenaStatusLabel(agent.status, language)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="survival-daily" aria-labelledby="survival-daily-title">
        <div className="survival-section-heading">
          <div>
            <span><CalendarDays size={15} aria-hidden="true" /> {arena.weekStart} — {arena.weekEnd}</span>
            <h2 id="survival-daily-title">{language === 'zh' ? '每日对比' : 'Daily comparison'}</h2>
          </div>
          <small><ShieldCheck size={14} /> {language === 'zh' ? '同一赔率快照、同一截止时间' : 'Same odds snapshot and cutoff'}</small>
        </div>

        <div className="survival-date-tabs" role="tablist" aria-label={language === 'zh' ? '按日期查看' : 'Filter by date'}>
          <button type="button" className={activeDate === 'all' ? 'is-active' : ''} onClick={() => setActiveDate('all')}>
            {language === 'zh' ? '本周全部' : 'All week'}
          </button>
          {arena.dates.map((dateKey) => (
            <button type="button" key={dateKey} className={activeDate === dateKey ? 'is-active' : ''} onClick={() => setActiveDate(dateKey)}>
              {dateLabel(dateKey, language)}
            </button>
          ))}
        </div>

        {!visibleMatches.length ? (
          <div className="survival-empty">
            <Bot size={30} aria-hidden="true" />
            <div>
              <strong>{language === 'zh' ? '本周暂未凑齐可验证的五大联赛比赛' : 'No verified Big Five pool is available this week'}</strong>
              <p>{language === 'zh'
                ? '只接收本周未开赛、官方 HAD SP 完整且模型概率完整的比赛；不会用杯赛、旧赔率或虚构场次补足 10 场。'
                : 'Only unplayed matches with complete official HAD SP and model probabilities are accepted. Cups, stale prices, and fabricated fixtures are never used as filler.'}</p>
            </div>
          </div>
        ) : (
          <div className="survival-match-list">
            {visibleMatches.map((row) => (
              <article className="survival-match-card" key={row.match.id}>
                <header>
                  <div>
                    <span>{language === 'zh' ? row.league.nameZh : row.league.nameEn} · {dateLabel(row.dateKey, language)}</span>
                    <h3>{row.match.homeTeamName} <em>VS</em> {row.match.awayTeamName}</h3>
                  </div>
                  <div className="survival-odds">
                    <span>主 {row.odds['1'].toFixed(2)}</span>
                    <span>平 {row.odds.X.toFixed(2)}</span>
                    <span>客 {row.odds['2'].toFixed(2)}</span>
                  </div>
                </header>
                <div className="survival-agent-picks">
                  {row.forecasts.map((forecast) => (
                    <div key={forecast.agentId} className={forecast.investment ? 'is-invested' : ''}>
                      <span><i style={{ background: forecast.color }} /> {forecast.agentName}</span>
                      <strong>{arenaPickLabel(forecast.pick, language)}</strong>
                      <small>{'★'.repeat(forecast.confidence)}{'☆'.repeat(5 - forecast.confidence)}</small>
                      {forecast.investment && <b><Coins size={12} /> {forecast.stake}</b>}
                    </div>
                  ))}
                </div>
                <Link to={`/ai-arena/${encodeURIComponent(row.match.id)}`}>
                  {language === 'zh' ? '查看六 AI 完整分析' : 'Open six-AI analysis'} <ArrowRight size={15} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
};
