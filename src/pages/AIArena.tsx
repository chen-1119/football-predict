import React from 'react';
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Coins,
  Gauge,
  LockKeyhole,
  ShieldCheck,
  Swords,
  Target,
  Trophy,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { AIArenaPreview } from '../components/predictions/AIArenaPreview';
import { useApp } from '../context/AppContextCore';
import { arenaPickLabel, buildBigFiveSurvivalArena } from '../services/aiArena';
import '../styles/ai-arena.css';

const pct = (value: number) => `${Math.round(value * 100)}%`;

export const AIArena: React.FC = () => {
  const { matchId } = useParams();
  const { language, matches } = useApp();
  const decodedMatchId = matchId ? decodeURIComponent(matchId) : '';
  const arena = React.useMemo(() => buildBigFiveSurvivalArena(matches), [matches]);

  if (!decodedMatchId) {
    return (
      <article className="ai-arena-page survival-page">
        <header className="survival-hero">
          <div className="survival-hero-copy">
            <span className="survival-kicker"><Swords size={16} aria-hidden="true" /> AI Big Five Survival</span>
            <h1>{language === 'zh' ? 'AI 五大联赛生存战' : 'AI Big Five Survival'}</h1>
            <p>{language === 'zh'
              ? '六个 AI 策略在同一周、同一批五大联赛和同一官方赔率快照上竞技：每场都预测，只选三场投入虚拟积分。'
              : 'Six AI strategies compete on the same weekly Big Five pool and official odds snapshot: every match gets a forecast, while only three receive virtual stakes.'}</p>
            <div className="survival-hero-badges">
              <span><BrainCircuit size={14} /> 6 AI</span>
              <span><Target size={14} /> {arena.availableMatches}/10 {language === 'zh' ? '场' : 'matches'}</span>
              <span><Coins size={14} /> 10,000 {language === 'zh' ? '初始积分' : 'starting points'}</span>
              <span><LockKeyhole size={14} /> {language === 'zh' ? '一次提交后锁定' : 'One locked submission'}</span>
            </div>
          </div>
          <div className="survival-stage-card">
            <span>{language === 'zh' ? '本周挑战池' : 'Weekly pool'}</span>
            <strong>{arena.availableMatches}<small>/10</small></strong>
            <p>{arena.complete
              ? (language === 'zh' ? '五大联赛各 2 场，挑战池已锁定' : 'Two per league; pool ready to lock')
              : (language === 'zh' ? '未凑齐时保持透明，不用其他赛事补位' : 'Shortfalls remain visible; no filler fixtures')}</p>
          </div>
        </header>

        <section className="survival-principles" aria-label={language === 'zh' ? '竞技规则摘要' : 'Competition rule summary'}>
          <article><Target size={20} /><div><strong>{language === 'zh' ? '全场预测' : 'Forecast all'}</strong><span>{language === 'zh' ? '每个 AI 对本周全部入选比赛给出 1X2 概率、方向、比分和三条理由。' : 'Each AI submits 1X2 probabilities, a pick, scoreline, and three reasons for every selected match.'}</span></div></article>
          <article><Coins size={20} /><div><strong>{language === 'zh' ? '三场投资' : 'Three investments'}</strong><span>{language === 'zh' ? '每周总投入 1500–2500；单场 300–1200；SP 大于 3.5 时最多 500。' : 'Weekly stake 1500–2500; 300–1200 per match; odds above 3.5 are capped at 500.'}</span></div></article>
          <article><Trophy size={20} /><div><strong>{language === 'zh' ? '三榜合一' : 'Three rankings'}</strong><span>{language === 'zh' ? '财富榜、Brier 预测榜和最大回撤风险榜共同决定阶段成绩。' : 'Wealth, Brier accuracy, and maximum drawdown combine into the stage result.'}</span></div></article>
        </section>

        <div className="survival-disclosure"><ShieldCheck size={17} /><p>{language === 'zh'
          ? '当前为策略模拟基础版：六个名称代表固定决策人格，尚未声称已调用对应外部大模型。虚拟积分不可充值、提现或作为跟投注建议；数据不计入正式模型命中率。'
          : 'This is a strategy-simulation foundation. Names represent fixed decision profiles and do not claim live calls to external models. Virtual points cannot be purchased, cashed out, or treated as betting advice, and results are excluded from formal model metrics.'}</p></div>

        <AIArenaPreview matches={matches} />

        <section className="survival-rules-panel">
          <div className="survival-section-heading">
            <div><span><Gauge size={15} /> {language === 'zh' ? '完整赛制' : 'Full format'}</span><h2>{language === 'zh' ? '月度生存规则' : 'Monthly survival rules'}</h2></div>
          </div>
          <div className="survival-rule-grid">
            <div><strong>10,000</strong><span>{language === 'zh' ? '每月重置的初始虚拟积分' : 'virtual points reset each month'}</span></div>
            <div><strong>&lt; 3,000</strong><span>{language === 'zh' ? '进入黄区，提示仓位风险' : 'yellow zone risk warning'}</span></div>
            <div><strong>&lt; 1,500</strong><span>{language === 'zh' ? '进入红区，接近淘汰' : 'red zone near elimination'}</span></div>
            <div><strong>0</strong><span>{language === 'zh' ? '破产后仍预测，但停止投资至下月' : 'bankrupt: keep forecasting, stop staking until reset'}</span></div>
          </div>
        </section>
      </article>
    );
  }

  const selected = arena.matches.find((row) => row.match.id === decodedMatchId);
  if (!selected) {
    return (
      <section className="ai-arena-page survival-not-found">
        <Bot size={36} aria-hidden="true" />
        <h1>{language === 'zh' ? '该比赛不在本周生存战挑战池' : 'This match is not in the weekly survival pool'}</h1>
        <p>{language === 'zh'
          ? '只有本周五大联赛、未开赛、官方 HAD SP 与模型概率均完整的比赛才会入池，每个联赛最多两场。'
          : 'The pool accepts only this week’s unplayed Big Five fixtures with complete official HAD SP and model probabilities, capped at two per league.'}</p>
        <Link to="/ai-arena"><ArrowLeft size={16} /> {language === 'zh' ? '返回生存战' : 'Back to survival arena'}</Link>
      </section>
    );
  }

  return (
    <article className="ai-arena-page survival-detail">
      <Link className="survival-back" to="/ai-arena"><ArrowLeft size={16} /> {language === 'zh' ? '返回 AI 生存战' : 'Back to AI survival'}</Link>
      <header className="survival-detail-hero">
        <div>
          <span className="survival-kicker">{language === 'zh' ? selected.league.nameZh : selected.league.nameEn} · {selected.dateKey}</span>
          <h1>{selected.match.homeTeamName} <em>VS</em> {selected.match.awayTeamName}</h1>
          <p>{new Date(selected.match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false, timeZone: 'Asia/Shanghai' })}</p>
        </div>
        <span className="survival-lock"><LockKeyhole size={15} /> {language === 'zh' ? '同一赛前快照' : 'Same pre-match snapshot'}</span>
      </header>

      <section className="survival-baseline">
        <div className="survival-section-heading">
          <div><span><BrainCircuit size={15} /> {language === 'zh' ? '统一数据底座' : 'Shared data baseline'}</span><h2>{language === 'zh' ? '基础模型与官方 HAD SP' : 'Base model and official HAD SP'}</h2></div>
        </div>
        <div className="survival-probability-grid">
          {(['1', 'X', '2'] as const).map((code) => (
            <div key={code}>
              <span>{arenaPickLabel(code, language)}</span>
              <strong>{pct(selected.baseProbabilities[code])}</strong>
              <i><u style={{ width: pct(selected.baseProbabilities[code]) }} /></i>
              <small>SP {selected.odds[code].toFixed(2)} · {language === 'zh' ? '市场' : 'market'} {pct(selected.marketProbabilities[code])}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="survival-analysis-grid" aria-label={language === 'zh' ? '六AI分析' : 'Six AI analyses'}>
        {arena.agents.map((agent) => {
          const forecast = agent.forecasts.find((row) => row.matchId === selected.match.id)!;
          return (
            <article className={`survival-analysis-card is-${agent.style}`} key={agent.id}>
              <header>
                <i style={{ background: agent.color }} />
                <div><h2>{agent.name}</h2><span>{language === 'zh' ? agent.styleZh : agent.styleEn}</span></div>
                {forecast.investment && <b><Coins size={13} /> {forecast.stake}</b>}
              </header>
              <div className="survival-analysis-pick">
                <span>{language === 'zh' ? '主方向' : 'Main pick'}</span>
                <strong>{arenaPickLabel(forecast.pick, language)}</strong>
                <small>{pct(forecast.probabilities[forecast.pick])}</small>
              </div>
              <div className="survival-analysis-meta">
                <span>{language === 'zh' ? '信心' : 'Confidence'} <b>{'★'.repeat(forecast.confidence)}{'☆'.repeat(5 - forecast.confidence)}</b></span>
                <span>{language === 'zh' ? '比分' : 'Score'} <b>{forecast.projectedScore}</b></span>
                <span>EV <b>{forecast.expectedValue >= 0 ? '+' : ''}{(forecast.expectedValue * 100).toFixed(1)}%</b></span>
              </div>
              <div className="survival-mini-probabilities">
                {(['1', 'X', '2'] as const).map((code) => <span key={code}>{arenaPickLabel(code, language)} <b>{pct(forecast.probabilities[code])}</b></span>)}
              </div>
              <ol>{(language === 'zh' ? forecast.reasonsZh : forecast.reasonsEn).map((reason) => <li key={reason}>{reason}</li>)}</ol>
              <footer>{forecast.investment
                ? (language === 'zh' ? '本周三场投资之一' : 'One of this week’s three investments')
                : (language === 'zh' ? '给出预测，但本周不投入' : 'Forecast submitted; no weekly stake')}</footer>
            </article>
          );
        })}
      </section>

      <div className="survival-disclosure"><ShieldCheck size={17} /><p>{language === 'zh'
        ? '六个观点来自同一足球数据底座上的固定策略模拟，不冒充外部 AI 实时调用；后续接入真实模型时仍必须统一截止时间、输入数据和不可变提交。'
        : 'All six views are fixed strategy simulations over the same football data. They do not impersonate live external-model calls; future live integrations must keep one cutoff, identical inputs, and immutable submissions.'}</p></div>
    </article>
  );
};
