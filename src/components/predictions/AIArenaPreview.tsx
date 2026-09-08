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
import type { BigFiveSurvivalArena } from '../../services/aiArena';
import '../../styles/ai-arena.css';

interface AIArenaPreviewProps {
  matches: Match[];
  arena?: BigFiveSurvivalArena;
}

const dateLabel = (dateKey: string, language: 'zh' | 'en') => new Date(`${dateKey}T12:00:00+08:00`)
  .toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'Asia/Shanghai',
  });

export const AIArenaPreview: React.FC<AIArenaPreviewProps> = ({ matches, arena: publishedArena }) => {
  const { language } = useApp();
  const localArena = React.useMemo(() => buildBigFiveSurvivalArena(matches), [matches]);
  const arena = publishedArena || localArena;
  const [activeDate, setActiveDate] = React.useState<string>('all');
  const visibleMatches = activeDate === 'all'
    ? arena.matches
    : arena.matches.filter((row) => row.dateKey === activeDate);
  const scoreboardAgents = [...arena.agents].sort((left, right) => (
    (right.stageScore ?? 0) - (left.stageScore ?? 0)
    || right.balance - left.balance
    || 0
  ));
  const awardRows = arena.awards ? [
    { label: language === 'zh' ? '月冠军' : 'Month champion', award: arena.awards.monthChampion, digits: 0 },
    { label: language === 'zh' ? '财富王' : 'Wealth king', award: arena.awards.wealthKing, digits: 0 },
    { label: language === 'zh' ? '最准策略' : 'Accuracy king', award: arena.awards.accuracyKing, digits: 4 },
    { label: language === 'zh' ? '风控王' : 'Risk king', award: arena.awards.riskKing, digits: 4 },
    { label: language === 'zh' ? '爆冷王' : 'Upset king', award: arena.awards.upsetKing, digits: 2 },
    { label: language === 'zh' ? '莽夫奖' : 'Boldest', award: arena.awards.reckless, digits: 0 },
  ] : [];

  // Bounded adjustment before commit: do not paint an empty stale-date frame
  // and then schedule a second update from an effect.
  if (activeDate !== 'all' && !arena.dates.includes(activeDate)) setActiveDate('all');

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
            <h2 id="survival-ranking-title">{language === 'zh' ? '六套本地策略同场模拟' : 'Six-profile simulation'}</h2>
          </div>
          <small><LockKeyhole size={14} /> {language === 'zh' ? '赛前提交后锁定' : 'Locked after cutoff'}</small>
        </div>
        <div className="survival-ranking-table" role="table">
          <div className="survival-ranking-row is-head" role="row">
            <span>{language === 'zh' ? '策略' : 'Profile'}</span>
            <span>{language === 'zh' ? '积分/保留' : 'Points/Reserve'}</span>
            <span>{language === 'zh' ? '自主投入' : 'Auto stake'}</span>
            <span>{language === 'zh' ? '战绩/ROI' : 'Record/ROI'}</span>
            <span>Brier</span>
            <span>{language === 'zh' ? '最大回撤' : 'Max drawdown'}</span>
            <span>{language === 'zh' ? '状态' : 'Status'}</span>
          </div>
          {scoreboardAgents.map((agent, index) => (
            <div className="survival-ranking-row" role="row" key={agent.id}>
              <span className="survival-agent-name"><i style={{ background: agent.color }} /> <b>#{index + 1}</b> {agent.name}</span>
              <strong>{agent.balance.toLocaleString()}<small> / {(agent.reservedBalance ?? Math.max(0, agent.balance - agent.totalStake)).toLocaleString()}</small></strong>
              <span>{agent.investedMatches} {language === 'zh' ? '场' : 'matches'} · {agent.totalStake}</span>
              <span>{agent.won || 0}-{agent.lost || 0} · {agent.roi === null || agent.roi === undefined ? '—' : `${(agent.roi * 100).toFixed(1)}%`}</span>
              <span>{agent.brierScore === null
                ? (language === 'zh' ? '等待结算' : 'Pending')
                : <>{agent.brierScore.toFixed(4)}{agent.stageScore !== null && <small> · {agent.stageScore}分</small>}</>}</span>
              <span>{(agent.maxDrawdown * 100).toFixed(1)}%</span>
              <span className={`survival-status is-${agent.status.toLowerCase()}`}>{arenaStatusLabel(agent.status, language)}</span>
            </div>
          ))}
        </div>
      </section>

      {(arena.awards || arena.seasonStandings?.some((row) => row.stages > 0)) && (
        <section className="survival-season-panel" aria-label={language === 'zh' ? '月度奖项与赛季总榜' : 'Monthly awards and season table'}>
          <div className="survival-section-heading">
            <div>
              <span><Trophy size={15} /> {language === 'zh' ? '阶段荣誉' : 'Stage honors'}</span>
              <h2>{language === 'zh' ? '月度奖项与赛季总榜' : 'Monthly awards and season standings'}</h2>
            </div>
          </div>
          {arena.awards && (
            <div className="survival-awards">
              {awardRows.map(({ label, award, digits }) => award && (
                <article key={label}><span>{label}</span><strong>{award.agentName}</strong><small>{Number(award.value).toFixed(digits)}</small></article>
              ))}
            </div>
          )}
          <div className="survival-season-table">
            {(arena.seasonStandings || []).filter((row) => row.stages > 0).map((row) => (
              <div key={row.agentId}>
                <b>#{row.rank}</b><i style={{ background: row.color }} /><strong>{row.agentName}</strong>
                <span>{row.seasonPoints} {language === 'zh' ? '赛季分' : 'pts'}</span>
                <small>{row.stages} {language === 'zh' ? '阶段' : 'stages'} · Brier {row.averageBrier?.toFixed(4) || '—'}</small>
              </div>
            ))}
          </div>
        </section>
      )}

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
                  {row.settlement && (
                    <span className={`survival-settlement is-${row.settlement.status.toLowerCase()}`}>
                      {row.settlement.status === 'VOID'
                        ? (language === 'zh' ? '延期/作废' : 'Void')
                        : `${row.settlement.scoreHome}-${row.settlement.scoreAway} · ${arenaPickLabel(row.settlement.outcome!, language)}`}
                    </span>
                  )}
                </header>
                <div className="survival-agent-picks">
                  {row.forecasts.map((forecast) => (
                    <div key={forecast.agentId} className={forecast.investment ? 'is-invested' : ''}>
                      <span><i style={{ background: forecast.color }} /> {forecast.agentName}</span>
                      <strong>{arenaPickLabel(forecast.pick, language)}</strong>
                      <small>{'★'.repeat(forecast.confidence)}{'☆'.repeat(5 - forecast.confidence)}</small>
                      <u className={`survival-tier is-${(forecast.recommendationTier || 'REFERENCE').toLowerCase()}`}>
                        {language === 'zh'
                          ? (forecast.recommendationTier === 'HIGH_EVIDENCE' ? '高证据' : forecast.recommendationTier === 'LOW_CONFIDENCE' ? '低置信' : '参考')
                          : (forecast.recommendationTier || 'REFERENCE').replace('_', ' ')}
                      </u>
                      <b className={forecast.investment ? '' : 'is-zero-stake'}><Coins size={12} /> {forecast.stake || 0}</b>
                      {row.settlement?.status === 'SETTLED' && (
                        <em className={forecast.pick === row.settlement.outcome ? 'is-hit' : 'is-miss'}>
                          {forecast.pick === row.settlement.outcome ? '✓' : '×'}
                        </em>
                      )}
                    </div>
                  ))}
                </div>
                <Link to={`/ai-arena/${encodeURIComponent(row.match.id)}`}>
                  {language === 'zh' ? '查看六套策略完整分析' : 'Open six-profile analysis'} <ArrowRight size={15} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>

      {(arena.standings?.some((row) => (row.balanceHistory?.length || 0) > 1) || (arena.flopBoard?.length || 0) > 0) && (
        <section className="survival-review" aria-label={language === 'zh' ? '赛后结算与复盘' : 'Settlement review'}>
          <div className="survival-section-heading">
            <div>
              <span><Trophy size={15} /> {language === 'zh' ? '赛后结算' : 'Post-match settlement'}</span>
              <h2>{language === 'zh' ? '积分曲线与策略失误榜' : 'Balance curves and profile misses'}</h2>
            </div>
            <small><ShieldCheck size={14} /> {language === 'zh' ? '仅使用锁定赔率与正式赛果' : 'Locked odds and official results only'}</small>
          </div>
          <div className="survival-review-grid">
            <div className="survival-balance-history">
              {(arena.standings || []).map((agent) => {
                const history = agent.balanceHistory || [];
                const width = 220;
                const height = 54;
                const values = history.map((row) => row.balance);
                const min = Math.min(...values, 0);
                const max = Math.max(...values, 10_000);
                const range = Math.max(1, max - min);
                const points = history.map((row, index) => {
                  const x = history.length <= 1 ? 0 : (index / (history.length - 1)) * width;
                  const y = height - ((row.balance - min) / range) * height;
                  return `${x.toFixed(1)},${y.toFixed(1)}`;
                }).join(' ');
                return (
                  <div key={agent.id}>
                    <span><i style={{ background: agent.color }} /> {agent.name}</span>
                    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${agent.name} balance history`}>
                      <polyline points={points} fill="none" stroke={agent.color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <strong>{agent.balance.toLocaleString()}</strong>
                  </div>
                );
              })}
            </div>
            <div className="survival-flop-board">
              <h3>{language === 'zh' ? '策略失误榜' : 'Profile miss board'}</h3>
              {(arena.flopBoard || []).length ? (arena.flopBoard || []).map((row) => (
                <article key={`${row.agentId}-${row.matchId}`}>
                  <strong>{row.agentName}</strong>
                  <span>{row.match}</span>
                  <small>{arenaPickLabel(row.pick, language)} → {arenaPickLabel(row.actual, language)}</small>
                  <b>{row.loss > 0 ? `-${row.loss}` : (language === 'zh' ? '未投资' : 'No stake')}</b>
                </article>
              )) : <p>{language === 'zh' ? '暂无正式结算的误判。' : 'No settled misses yet.'}</p>}
            </div>
          </div>
        </section>
      )}
    </>
  );
};
