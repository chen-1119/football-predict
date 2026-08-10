import React from 'react';
import { ArrowLeft, Bot, Coins, ShieldCheck, Target } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { arenaPickLabel, buildDailyArenaSelection, todayShanghaiDateKey } from '../services/aiArena';
import '../styles/ai-arena.css';

const pct = (value: number) => `${Math.round(value * 100)}%`;

export const AIArena: React.FC = () => {
  const { matchId } = useParams();
  const { language, matches } = useApp();
  const decodedMatchId = matchId ? decodeURIComponent(matchId) : '';
  const selectedMatch = matches.find((match) => match.id === decodedMatchId);
  const dateKey = selectedMatch?.businessDate || selectedMatch?.matchDate || todayShanghaiDateKey();
  const dailySelection = React.useMemo(
    () => buildDailyArenaSelection(matches, String(dateKey).slice(0, 10)),
    [dateKey, matches],
  );
  const selection = dailySelection?.match.id === decodedMatchId ? dailySelection : null;

  if (!selection) {
    return (
      <section className="ai-arena-page ai-arena-page--empty">
        <Bot size={34} aria-hidden="true" />
        <h1>{language === 'zh' ? '该比赛当前不满足 AI 单关条件' : 'This match is not eligible for the AI arena'}</h1>
        <p>{language === 'zh'
          ? '必须同时满足：官方单关、HAD 已开售、当前事件 SP 有效、模型概率完整且尚未开赛。'
          : 'It requires a confirmed single, open official HAD, current-event SP, complete probabilities, and a future kickoff.'}</p>
        <Link to="/predictions"><ArrowLeft size={16} aria-hidden="true" /> {language === 'zh' ? '返回今日分析' : 'Back to Today Analysis'}</Link>
      </section>
    );
  }

  return (
    <article className="ai-arena-page">
      <Link className="ai-arena-back" to="/predictions"><ArrowLeft size={16} aria-hidden="true" /> {language === 'zh' ? '返回今日分析' : 'Back'}</Link>

      <header className="ai-arena-page__hero">
        <div>
          <span className="ai-arena-kicker"><Target size={15} aria-hidden="true" /> AI Single Match Arena</span>
          <h1>{selection.match.homeTeamName} <em>VS</em> {selection.match.awayTeamName}</h1>
          <p>{selection.match.leagueName || selection.match.leagueShortName} · {new Date(selection.match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}</p>
        </div>
        <div className="ai-arena-score is-large"><span>AI Score</span><strong>{selection.aiScore}</strong><small>/ 100</small></div>
      </header>

      <section className="ai-arena-detail-grid">
        <div className="ai-arena-detail-card">
          <h2>{language === 'zh' ? '模型基础概率' : 'Base model probabilities'}</h2>
          {(['1', 'X', '2'] as const).map((code) => (
            <div className="ai-arena-detail-probability" key={code}>
              <span>{arenaPickLabel(code, language)}</span>
              <i><u style={{ width: pct(selection.probabilities[code]) }} /></i>
              <strong>{pct(selection.probabilities[code])}</strong>
              <small>SP {selection.odds[code].toFixed(2)}</small>
            </div>
          ))}
        </div>
        <div className="ai-arena-detail-card ai-arena-detail-summary">
          <h2>{language === 'zh' ? '今日共识' : 'Daily consensus'}</h2>
          <strong>{selection.consensus.votes}/{selection.consensus.total}</strong>
          <span>{arenaPickLabel(selection.consensus.code, language)}</span>
          <p>{language === 'zh' ? `模型参考比分：${selection.projectedScore || '待补充'}` : `Model scoreline: ${selection.projectedScore || 'pending'}`}</p>
        </div>
      </section>

      <section className="ai-arena-roles" aria-labelledby="ai-arena-roles-title">
        <div className="ai-arena-section-title">
          <div><h2 id="ai-arena-roles-title">{language === 'zh' ? '6 个策略角色今日对比' : 'Six strategy roles today'}</h2><p>{language === 'zh' ? '同一套赛前数据，不同决策和仓位规则。' : 'The same pre-match evidence with different decision and staking rules.'}</p></div>
          <span><ShieldCheck size={14} aria-hidden="true" /> {language === 'zh' ? '模拟积分，不冒充外部 AI 实调' : 'Simulated points, not external AI calls'}</span>
        </div>
        <div className="ai-arena-role-grid">
          {selection.analysts.map((row, index) => (
            <article key={row.id} className={`ai-arena-role-card is-${row.risk}`}>
              <header><span>#{index + 1}</span><div><h3>{language === 'zh' ? row.nameZh : row.nameEn}</h3><small>{language === 'zh' ? row.styleZh : row.styleEn}</small></div></header>
              <div className="ai-arena-role-pick"><span>{language === 'zh' ? '选择' : 'Pick'}</span><strong>{arenaPickLabel(row.pick, language)}</strong><b>{pct(row.probability)}</b></div>
              <div className="ai-arena-role-metrics">
                <span><Target size={14} /> {language === 'zh' ? '信心' : 'Confidence'} <b>{row.confidence}</b></span>
                <span><Coins size={14} /> {language === 'zh' ? '模拟仓位' : 'Sim stake'} <b>{row.stake}</b></span>
              </div>
              <ul>{(language === 'zh' ? row.reasonsZh : row.reasonsEn).map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section className="ai-arena-rules">
        <h2>{language === 'zh' ? '基础版积分规则' : 'Preview scoring rules'}</h2>
        <div><strong>10,000</strong><span>{language === 'zh' ? '每个角色初始模拟积分' : 'starting simulated points per role'}</span></div>
        <div><strong>SP</strong><span>{language === 'zh' ? '命中按官方 HAD SP 结算，失败扣除仓位' : 'settled with official HAD SP; a miss loses the stake'}</span></div>
        <div><strong>0</strong><span>{language === 'zh' ? '当前不写入正式命中率或模型晋级样本' : 'formal hit-rate or promotion samples in this preview'}</span></div>
      </section>
    </article>
  );
};

