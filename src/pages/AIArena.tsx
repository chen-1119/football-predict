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
import {
  arenaPickLabel,
  buildBigFiveSurvivalArena,
  fetchPublishedBigFiveSurvivalArena,
} from '../services/aiArena';
import type { BigFiveSurvivalArena } from '../services/aiArena';
import '../styles/ai-arena.css';

const pct = (value: number) => `${Math.round(value * 100)}%`;

export const AIArena: React.FC = () => {
  const { matchId } = useParams();
  const { language, matches, accessSession } = useApp();
  const decodedMatchId = matchId ? decodeURIComponent(matchId) : '';
  const localArena = React.useMemo(() => buildBigFiveSurvivalArena(matches), [matches]);
  const [published, setPublished] = React.useState<{ token: string; arena: BigFiveSurvivalArena } | null>(null);
  const publishedArena = accessSession?.token && published?.token === accessSession.token
    ? published.arena : null;
  React.useEffect(() => {
    if (!accessSession?.token) return undefined;
    const controller = new AbortController();
    const load = async () => {
      for (const delayMs of [0, 500, 1500]) {
        if (delayMs) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        if (controller.signal.aborted) return;
        try {
          const payload = await fetchPublishedBigFiveSurvivalArena(accessSession.token, controller.signal);
          if (!controller.signal.aborted) setPublished(payload ? { token: accessSession.token, arena: payload } : null);
          return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) setPublished(null);
    };
    void load();
    return () => controller.abort();
  }, [accessSession?.token, matches]);
  // A forming server pool intentionally omits unlocked submissions. Once at
  // least two qualified fixtures are available, the server locks the current
  // pool without later backfill and its immutable snapshot is authoritative.
  const arena = publishedArena?.state === 'LOCKED' ? publishedArena : localArena;

  if (!decodedMatchId) {
    return (
      <article className="ai-arena-page survival-page">
        <header className="survival-hero">
          <div className="survival-hero-copy">
            <span className="survival-kicker"><Swords size={16} aria-hidden="true" /> Big Five Strategy Lab</span>
            <h1>{language === 'zh' ? '五大联赛策略模拟场' : 'Big Five Strategy Lab'}</h1>
            <p>{language === 'zh'
              ? '六套本地规则策略在同一周、同一批五大联赛和同一官方赔率快照上模拟竞技：每场给出概率方向，虚拟积分按证据质量与风险规则自动分配，也可以全部为 0。'
              : 'Six local rule-based profiles share one weekly Big Five pool and official odds snapshot. Each produces probabilities and allocates virtual points under explicit evidence and risk rules, including zero.'}</p>
            <div className="survival-hero-badges">
              <span><BrainCircuit size={14} /> {language === 'zh' ? '6 套本地策略' : '6 local profiles'}</span>
              <span><ShieldCheck size={14} /> {language === 'zh' ? '非外部大模型调用' : 'No external model calls'}</span>
              <span><Target size={14} /> {arena.availableMatches}/10 {language === 'zh' ? '场' : 'matches'}</span>
              <span><Coins size={14} /> 10,000 {language === 'zh' ? '初始积分' : 'starting points'}</span>
              <span><LockKeyhole size={14} /> {language === 'zh' ? '一次提交后锁定' : 'One locked submission'}</span>
              {arena.state && <span><ShieldCheck size={14} /> {arena.state}</span>}
            </div>
          </div>
          <div className="survival-stage-card">
            <span>{language === 'zh' ? '本周挑战池' : 'Weekly pool'}</span>
            <strong>{arena.availableMatches}<small>/10</small></strong>
            <p>{arena.state === 'LOCKED'
              ? (arena.complete
                ? (language === 'zh' ? '五大联赛各 2 场，挑战池已锁定开赛' : 'Two per league; the round is locked and active')
                : (language === 'zh' ? '当前合格赛程已锁定开赛；缺口不补，保证同场公平' : 'Current qualified fixtures are locked; no later backfill'))
              : (language === 'zh' ? '优先等待凑满 10 场；周五仍不足时，至少 2 场即可锁定开赛' : 'Prefer ten fixtures; from Friday, at least two can lock the round')}</p>
          </div>
        </header>

        <section className="survival-principles" aria-label={language === 'zh' ? '竞技规则摘要' : 'Competition rule summary'}>
          <article><Target size={20} /><div><strong>{language === 'zh' ? '全场预测' : 'Forecast all'}</strong><span>{language === 'zh' ? '每套策略对本周全部入选比赛给出 1X2 概率、方向、比分和三条规则化理由。' : 'Each profile submits 1X2 probabilities, a pick, scoreline, and three rule-derived reasons for every selected match.'}</span></div></article>
          <article><Coins size={20} /><div><strong>{language === 'zh' ? '自主积分' : 'Autonomous staking'}</strong><span>{language === 'zh' ? '使用分数凯利、数据质量、反方风险与资金区间动态计算；不为凑固定场数强行投入。' : 'Fractional Kelly, data quality, adversarial risk, and balance zones set each stake; no fixed count is forced.'}</span></div></article>
          <article><Trophy size={20} /><div><strong>{language === 'zh' ? '三榜合一' : 'Three rankings'}</strong><span>{language === 'zh' ? '财富榜、Brier 预测榜和最大回撤风险榜共同决定阶段成绩。' : 'Wealth, Brier accuracy, and maximum drawdown combine into the stage result.'}</span></div></article>
        </section>

        <div className="survival-disclosure"><ShieldCheck size={17} /><p>{language === 'zh'
          ? '这是本地策略规则模拟，不是 GPT、Gemini、DeepSeek、Kimi、豆包或 Qwen 的实时 API 对战。六套策略统一读取同一份不可变赛前快照，系统只按可信官方赛果自动结算；虚拟积分受资金风险上限保护，结果不计入正式模型命中率。'
          : 'This is a local rule-strategy simulation, not a live API contest between external AI providers. All profiles read the same immutable pre-match snapshot, only trusted official results can settle scores, and arena outcomes stay outside formal model metrics.'}</p></div>

        {arena.integrity?.immutable && (
          <div className="survival-integrity" role="status">
            <LockKeyhole size={16} />
            <span>{language === 'zh' ? '本周提交已锁定' : 'Weekly submissions locked'}</span>
            <code>{arena.submissionRootHash?.slice(0, 16)}</code>
            <small>{arena.lockedAt ? new Date(arena.lockedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false, timeZone: 'Asia/Shanghai' }) : ''}</small>
          </div>
        )}

        <AIArenaPreview matches={matches} arena={arena} />

        {Boolean(arena.evidenceStandings?.length) && (
          <section className="survival-evidence-ranking">
            <div className="survival-section-heading">
              <div><span><BrainCircuit size={15} /> {language === 'zh' ? '赛后复盘' : 'Post-match review'}</span><h2>{language === 'zh' ? '证据模块 Brier 排行' : 'Evidence-module Brier ranking'}</h2></div>
              <small>{language === 'zh' ? '越低越好；命中率仅作辅助' : 'Lower is better; hit rate is secondary'}</small>
            </div>
            <div className="survival-evidence-ranking-grid">
              {arena.evidenceStandings!.map((row, index) => (
                <article key={row.id}>
                  <b>#{index + 1}</b>
                  <span>{language === 'zh' ? row.nameZh : row.nameEn}</span>
                  <strong>Brier {row.brierScore?.toFixed(3) ?? '—'}</strong>
                  <small>{row.hits}/{row.settled} · {row.hitRate === null ? '—' : `${Math.round(row.hitRate * 100)}%`}</small>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="survival-rules-panel">
          <div className="survival-section-heading">
            <div><span><Gauge size={15} /> {language === 'zh' ? '完整赛制' : 'Full format'}</span><h2>{language === 'zh' ? '月度生存规则' : 'Monthly survival rules'}</h2></div>
          </div>
          <div className="survival-rule-grid">
            <div><strong>10,000</strong><span>{language === 'zh' ? '每月重置的初始虚拟积分' : 'virtual points reset each month'}</span></div>
            <div><strong>0–22%</strong><span>{language === 'zh' ? '每周风险预算由策略参数和当前积分动态决定，允许 0 投入' : 'weekly risk budget varies by profile parameters and balance; zero is allowed'}</span></div>
            <div><strong>&lt; 3,000</strong><span>{language === 'zh' ? '黄区压缩周风险与单场风险，不再使用固定注额' : 'yellow zone reduces weekly and single-fixture risk without fixed stakes'}</span></div>
            <div><strong>&lt; 1,500</strong><span>{language === 'zh' ? '红区停止新增积分投入，但继续输出每场推荐并记录质量' : 'red zone stops new point stakes while every forecast and quality record continues'}</span></div>
            <div><strong>0</strong><span>{language === 'zh' ? '破产后仍预测，但停止投资至下月' : 'bankrupt: keep forecasting, stop staking until reset'}</span></div>
            <div><strong>12 + 8 + 5</strong><span>{language === 'zh' ? '财富榜、Brier 榜与风控奖励合并阶段积分' : 'wealth, Brier and risk rewards form the stage score'}</span></div>
          </div>
        </section>
      </article>
    );
  }

  const selected = arena.matches.find((row) => (
    row.match.id === decodedMatchId || row.match.sourceMatchId === decodedMatchId
  ));
  if (!selected) {
    return (
      <section className="ai-arena-page survival-not-found">
        <Bot size={36} aria-hidden="true" />
        <h1>{language === 'zh' ? '该比赛不在本周策略模拟池' : 'This match is not in the weekly strategy pool'}</h1>
        <p>{language === 'zh'
          ? '只有本周五大联赛、未开赛、官方 HAD SP 与模型概率均完整的比赛才会入池，每个联赛最多两场。'
          : 'The pool accepts only this week’s unplayed Big Five fixtures with complete official HAD SP and model probabilities, capped at two per league.'}</p>
        <Link to="/ai-arena"><ArrowLeft size={16} /> {language === 'zh' ? '返回策略模拟场' : 'Back to strategy lab'}</Link>
      </section>
    );
  }

  const decisionAudit = selected.forecasts.find((forecast) => forecast.decisionAudit)?.decisionAudit;

  return (
    <article className="ai-arena-page survival-detail">
      <Link className="survival-back" to="/ai-arena"><ArrowLeft size={16} /> {language === 'zh' ? '返回策略模拟场' : 'Back to strategy lab'}</Link>
      <header className="survival-detail-hero">
        <div>
          <span className="survival-kicker">{language === 'zh' ? selected.league.nameZh : selected.league.nameEn} · {selected.dateKey}</span>
          <h1>{selected.match.homeTeamName} <em>VS</em> {selected.match.awayTeamName}</h1>
          <p>{new Date(selected.match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false, timeZone: 'Asia/Shanghai' })}</p>
        </div>
        <span className="survival-lock"><LockKeyhole size={15} /> {language === 'zh' ? '同一赛前快照' : 'Same pre-match snapshot'}</span>
        {selected.settlement?.status === 'SETTLED' && (
          <strong className="survival-detail-result">
            {selected.settlement.scoreHome}-{selected.settlement.scoreAway} · {arenaPickLabel(selected.settlement.outcome!, language)}
          </strong>
        )}
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

      {decisionAudit && (
        <section className="survival-evidence-panel" aria-label={language === 'zh' ? '证据模块链路' : 'Evidence module chain'}>
          <div className="survival-section-heading">
            <div>
              <span><ShieldCheck size={15} /> {language === 'zh' ? '可审计决策链' : 'Auditable decision chain'}</span>
              <h2>{language === 'zh' ? 'A1–A7 证据模块与最终裁决' : 'A1–A7 evidence modules and final decision'}</h2>
            </div>
            <small>{language === 'zh' ? `数据完整度 ${Math.round(decisionAudit.dataQuality * 100)}%` : `Data quality ${Math.round(decisionAudit.dataQuality * 100)}%`}</small>
          </div>
          <div className="survival-evidence-summary">
            <span>{language === 'zh' ? '平局结构' : 'Draw structure'} <b>{decisionAudit.drawSignalScore}/100</b></span>
            <span>{language === 'zh' ? '反方风险' : 'Adversarial risk'} <b>{decisionAudit.adversarialRiskScore}/100</b></span>
            <span>{language === 'zh' ? '总裁判方向' : 'Chief-judge pick'} <b>{arenaPickLabel(decisionAudit.judge.finalPick, language)}</b></span>
            <span>{language === 'zh' ? '反方是否改判' : 'Review changed pick'} <b>{decisionAudit.judge.changedByAdversarialReview ? (language === 'zh' ? '是' : 'Yes') : (language === 'zh' ? '否' : 'No')}</b></span>
          </div>
          <div className="survival-evidence-grid">
            {decisionAudit.evidenceAgents.map((evidence) => (
              <article key={evidence.id} className={!evidence.available ? 'is-unavailable' : ''}>
                <header><strong>{language === 'zh' ? evidence.nameZh : evidence.nameEn}</strong><b>{evidence.available ? arenaPickLabel(evidence.pick, language) : (language === 'zh' ? '中立' : 'Neutral')}</b></header>
                <p>{language === 'zh' ? evidence.reasonZh : evidence.nameEn}</p>
                <small>{language === 'zh' ? '证据强度' : 'Evidence'} {evidence.confidence}/100</small>
              </article>
            ))}
          </div>
          <p className="survival-evidence-note">{language === 'zh'
            ? '平局结构分是相对信号，不是平局概率；情报未通过来源与时效校验时保持中立，不允许编造伤停或新闻。'
            : 'The draw-structure score is not a draw probability. Intelligence remains neutral unless source and freshness checks pass.'}</p>
        </section>
      )}

      <section className="survival-analysis-grid" aria-label={language === 'zh' ? '六套策略分析' : 'Six profile analyses'}>
        {arena.agents.map((agent) => {
          const forecast = agent.forecasts.find((row) => row.matchId === selected.match.id)!;
          const settledDelta = selected.settlement?.status === 'SETTLED' && forecast.investment
            ? (forecast.pick === selected.settlement.outcome
              ? forecast.stake * (selected.odds[forecast.pick] - 1)
              : -forecast.stake)
            : null;
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
                <span>{language === 'zh' ? '推荐层级' : 'Tier'} <b>{forecast.recommendationTier === 'HIGH_EVIDENCE' ? (language === 'zh' ? '高证据' : 'High evidence') : forecast.recommendationTier === 'LOW_CONFIDENCE' ? (language === 'zh' ? '低置信' : 'Low confidence') : (language === 'zh' ? '参考' : 'Reference')}</b></span>
                <span>{language === 'zh' ? '比分' : 'Score'} <b>{forecast.projectedScore}</b></span>
                <span>EV <b>{forecast.expectedValue >= 0 ? '+' : ''}{(forecast.expectedValue * 100).toFixed(1)}%</b></span>
                {selected.settlement?.status === 'SETTLED' && <span>{language === 'zh' ? '赛果' : 'Result'} <b>{forecast.pick === selected.settlement.outcome ? '✓' : '×'}</b></span>}
                {settledDelta !== null && <span>{language === 'zh' ? '盈亏' : 'P/L'} <b>{settledDelta >= 0 ? '+' : ''}{settledDelta.toFixed(0)}</b></span>}
              </div>
              <div className="survival-mini-probabilities">
                {(['1', 'X', '2'] as const).map((code) => <span key={code}>{arenaPickLabel(code, language)} <b>{pct(forecast.probabilities[code])}</b></span>)}
              </div>
              <ol>{(language === 'zh' ? forecast.reasonsZh : forecast.reasonsEn).map((reason) => <li key={reason}>{reason}</li>)}</ol>
              <footer>{(language === 'zh' ? forecast.stakeReasonZh : forecast.stakeReasonEn)
                || (forecast.investment
                  ? (language === 'zh' ? `已分配 ${forecast.stake} 积分` : `${forecast.stake} points allocated`)
                  : (language === 'zh' ? '给出推荐，本场积分为 0' : 'Recommendation submitted; stake is zero'))}</footer>
            </article>
          );
        })}
      </section>

      <div className="survival-disclosure"><ShieldCheck size={17} /><p>{language === 'zh'
        ? '六套本地规则策略读取同一份不可变赛前数据；这里没有调用或冒充任何外部大模型 API。赛后仅由系统读取可信官方赛果并自动写入结算，策略无权改写比分。'
        : 'All six local rule profiles read the same immutable pre-match data; no external model API is called or impersonated. Only the trusted result worker may write settlements.'}</p></div>
    </article>
  );
};
