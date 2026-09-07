import React, { useState } from 'react';
import type { ReviewPerformanceSummary } from '../../services/reviewPerformanceTypes';
import { selectReviewMarketWindow, selectReviewExclusions, reviewShanghaiDate, reviewWilsonInterval } from '../../services/reviewDashboard';
import type { ReviewWindow, ReviewMarket } from '../../services/reviewDashboard';
import './review.css';

type ShadowSummary = {
  candidateRevisionId?: string | null;
  evaluatedAt?: string | null;
  frozenAt?: string | null;
  state?: string;
  chainValid?: boolean;
  cohort?: { shadow?: { admitted?: number; settled?: number; pending?: number; invalid?: number } | null } | null;
};
type Props = {
  language: 'zh' | 'en';
  formal?: ReviewPerformanceSummary | null;
  reference?: ReviewPerformanceSummary | null;
  shadow?: ShadowSummary | null;
};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—';

export const ReviewEvidenceOverview: React.FC<Props> = ({ language, formal, reference, shadow }) => {
  const zh = language === 'zh';
  const [track, setTrack] = useState<'formal' | 'reference' | 'shadow'>('formal');
  const [window, setWindow] = useState<ReviewWindow>('all');
  const [market, setMarket] = useState<ReviewMarket>('HAD');
  const summary = track === 'formal' ? formal : reference;
  const result = selectReviewMarketWindow(summary, track === 'formal' ? 'formal' : 'reference', window, market);
  const verifiedPartition = selectReviewMarketWindow(summary, track === 'formal' ? 'formal' : 'reference', 'all', 'HAD').state === 'ready';
  const isShadow = track === 'shadow';
  const interval = !isShadow && result.state === 'ready' ? reviewWilsonInterval(result.counts) : null;
  const exclusions = selectReviewExclusions(summary, track === 'formal' ? 'formal' : 'reference');
  const labels = { formal: zh ? '正式推荐' : 'Formal picks', reference: zh ? '数据参考' : 'Data references', shadow: zh ? '研究影子' : 'Research shadow' };
  const windowLabels: Record<ReviewWindow, string> = { version: zh ? '本版本' : 'This version', '7d': zh ? '近 7 天' : '7 days', '30d': zh ? '近 30 天' : '30 days', all: zh ? '累计' : 'All time' };
  const clock = isShadow ? shadow?.evaluatedAt : summary?.generatedAt;
  const date = reviewShanghaiDate(clock);
  const updated = date && clock ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(clock)) : (zh ? '未提供' : 'Unavailable');
  const value = isShadow ? '—' : result.counts?.hitRate != null ? `${(result.counts.hitRate * 100).toFixed(1)}%` : '—';
  const status = isShadow ? (zh ? '独立观察，不替代正式推荐' : 'Independent observation, not formal picks')
    : result.state === 'version-unavailable' ? (zh ? '缺少可核验的版本分组' : 'Verified version partition unavailable')
      : result.state === 'market-unavailable' ? (zh ? '完整玩法分组待更新' : 'Complete market partition pending')
      : result.state !== 'ready' ? (zh ? '完整统计待更新' : 'Complete statistics pending')
        : result.counts?.settled === 0 ? (zh ? '本窗口无已结算样本' : 'No settled samples in this window')
          : (zh ? '真实结算，不代表未来表现' : 'Actual settlements, not future performance');
  return (
    <section className="review-overview" aria-label={zh ? '推荐证据与真实战绩' : 'Recommendation evidence and actual results'} data-review-overview="server-ledger-v1">
      <div className="review-overview-heading">
        <div><p className="review-eyebrow">{zh ? '证据与战绩' : 'EVIDENCE & RESULTS'}</p><h2>{zh ? '每一个数字，都有口径。' : 'Every number has a defined cohort.'}</h2></div>
        <span className="review-ledger-note">{zh ? '冻结记录 · 独立统计' : 'Frozen records · Separate ledgers'}</span>
      </div>
      <div className="review-track-switch" role="group" aria-label={zh ? '统计类别' : 'Result category'}>
        {(['formal', 'reference', 'shadow'] as const).map((key, index) => <button key={key} type="button" aria-pressed={track === key} onClick={() => setTrack(key)}>
          <span className="review-track-index">0{index + 1}</span><span>{labels[key]}</span><span className="review-track-description">{key === 'formal' ? (zh ? '面向用户的发布记录' : 'Published customer ledger') : key === 'reference' ? (zh ? '参考方向，单独复盘' : 'Reference-only settlements') : (zh ? '候选观察，不混入战绩' : 'Candidate-only observation')}</span>
        </button>)}
      </div>
      <div className="review-overview-controls">
        <span className="review-track-caption">{labels[track]}<small>{isShadow ? (zh ? '候选前瞻账本' : 'Prospective candidate ledger') : market === 'BEST' ? (zh ? 'BEST 综合口径 · 非 HAD 单玩法成绩' : 'Combined BEST ledger · Not HAD-only') : (zh ? `${market} 冻结 BEST · 独立玩法口径` : `${market} frozen BEST · Separate market cohort`)}</small></span>
        {!isShadow && <div className="review-window-switch" role="group" aria-label={zh ? '统计时间范围' : 'Statistics time window'}>{(['version', '7d', '30d', 'all'] as const).map((key) => <button key={key} type="button" aria-pressed={window === key} onClick={() => setWindow(key)}>{windowLabels[key]}</button>)}</div>}
      </div>
      {!isShadow && <div className="review-market-switch" role="group" aria-label={zh ? '统计玩法' : 'Statistics market'}>{(['HAD', 'HHAD', 'BEST'] as const).map((key) => <button type="button" key={key} aria-pressed={market === key} onClick={() => setMarket(key)}>{key === 'HAD' ? (zh ? 'HAD 胜平负' : 'HAD 1X2') : key === 'HHAD' ? (zh ? 'HHAD 让球' : 'HHAD handicap') : (zh ? 'BEST 总账' : 'BEST combined')}</button>)}</div>}
      {!isShadow && verifiedPartition && Number(summary?.marketBreakdown?.UNKNOWN?.cumulative?.settled) > 0 && <p className="review-unknown-market" data-review-unknown-market>{zh ? `全部历史中有 ${count(summary?.marketBreakdown?.UNKNOWN?.cumulative?.settled)} 场玩法未知，仅保留在 BEST 总账。` : `${count(summary?.marketBreakdown?.UNKNOWN?.cumulative?.settled)} all-time rows have unknown markets and remain only in combined BEST.`}</p>}
      <div className="review-metric-grid" aria-live="polite" aria-atomic="true">
        <article className="review-primary-metric"><h3>{zh ? '已结算命中率' : 'Settled hit rate'}</h3><strong data-review-overview-rate>{value}</strong><p>{status}</p>
          <span>{!isShadow && result.counts ? (zh ? `命中 ${count(result.counts.won)} / 已结算 ${count(result.counts.settled)}` : `Won ${count(result.counts.won)} / settled ${count(result.counts.settled)}`) : isShadow ? (zh ? `影子已结算 ${count(shadow?.cohort?.shadow?.settled)} · 命中数未提供` : `Shadow settled ${count(shadow?.cohort?.shadow?.settled)} · Wins unavailable`) : (zh ? '没有数据时不显示 0% 或 50%' : 'Missing data is not 0% or 50%')}</span>
          {interval && <details className="review-uncertainty" data-review-uncertainty>
            <summary>{zh ? '样本区间 · 95% Wilson' : 'Sample interval · 95% Wilson'}<span data-review-interval>{`${(interval.lower * 100).toFixed(1)}% – ${(interval.upper * 100).toFixed(1)}%`}</span><small>{zh ? '独立同概率假设 · 非未来预测' : 'Independent, common probability · Not a forecast'}</small></summary>
            <p>{zh ? '仅作样本不确定性描述，假设各场独立且命中概率相同；未校正同日或联赛相关性，不是未来命中率承诺，也不能证明优于赔率基准。不用于模型晋级。' : 'Describes sampling uncertainty assuming independent matches with a common hit probability. Not adjusted for day or league dependence, not a future hit-rate promise or evidence of beating market odds. Not used for model admission.'}</p>
          </details>}
        </article>
        <article><h3>{zh ? '同组赔率基准' : 'Paired market baseline'}</h3><strong className="review-missing-value">{zh ? '待补证' : 'Evidence pending'}</strong><p>{zh ? '需要相同场次、相同玩法和同一决策时点的完整赔率。' : 'Requires the same matches, market and full odds at the decision time.'}</p><span>{zh ? '不使用赛后赔率或其他样本代替' : 'No post-match odds or unrelated cohorts'}</span></article>
        <article><h3>{zh ? '推荐覆盖率' : 'Recommendation coverage'}</h3><strong className="review-missing-value">{zh ? '分母待核验' : 'Universe unverified'}</strong><p>{zh ? '需冻结完整候选场次范围，再计算实际发布比例。' : 'Requires a frozen eligible universe before computing the published share.'}</p><span>{zh ? '已结算场数不等于全部候选场数' : 'Settled rows are not the eligible universe'}</span></article>
      </div>
      <dl className="review-metadata">
        <div><dt>{zh ? '模型 / 策略版本' : 'Model / policy version'}</dt><dd>{isShadow ? shadow?.candidateRevisionId || (zh ? '尚未登记' : 'Not registered') : (zh ? '历史统计未提供冻结版本分组' : 'Frozen version partition unavailable')}</dd></div>
        <div><dt>{zh ? '统计窗口' : 'Statistics window'}</dt><dd>{isShadow ? (shadow?.frozenAt && date ? `${reviewShanghaiDate(shadow.frozenAt) || '—'} → ${date}` : (zh ? '窗口待核验' : 'Window unverified')) : result.from && result.through ? `${result.from} → ${result.through}` : '—'}{result.partial ? (zh ? '（不足完整窗口）' : ' (partial window)') : ''}</dd></div>
        <div><dt>{zh ? '数据更新 · 北京时间' : 'Data updated · Asia/Shanghai'}</dt><dd>{updated}</dd></div>
      </dl>
      {!isShadow && <details className="review-exclusion-audit" data-review-exclusions>
        <summary>{zh ? '统计排除与去重' : 'Exclusions and deduplication'}<span>{exclusions.complete ? (zh ? '查看完整输入审计' : 'View full input audit') : (zh ? '部分口径待核验' : 'Some counters unverified')}</span></summary>
        <p>{zh ? '完整输入口径，包含统计起点以前的记录；不随上方时间或玩法筛选变化。记录数和赛事数不可相加，不能用来反推推荐覆盖率。' : 'Full input audit, including records before the statistics start. Not filtered by the window or market above. Record and event counts must not be added or used to infer recommendation coverage.'}</p>
        <dl>{exclusions.rows.map(row => <div key={row.key} data-review-exclusion={row.key}><dt>{zh ? row.zh : row.en}</dt><dd>{count(row.value)} <small>{row.unit === 'event' ? (zh ? '场赛事' : 'events') : (zh ? '条记录' : 'records')}</small></dd></div>)}</dl>
        {!exclusions.complete && <p className="review-exclusion-warning">{zh ? '缺失或非法计数显示“—”，不表示零；不能视为已完成审计。' : 'Missing or invalid counters show “—”, not zero; the audit is incomplete.'}</p>}
        {exclusions.unknownFields > 0 && <p>{zh ? `另有 ${exclusions.unknownFields} 项未识别口径，等待接口版本核验。` : `${exclusions.unknownFields} unrecognized counters require an API version check.`}</p>}
      </details>}
      <details className="review-evidence-gaps"><summary>{zh ? '为什么暂时不能说模型更准？' : 'Why is model superiority not established?'}<span>{zh ? '查看缺失证据' : 'View evidence gaps'}</span></summary>
        <ul><li>{zh ? '版本分组尚未提供，累计不能当作本版本成绩。HAD / HHAD 按原冻结 BEST 玩法独立统计；未知玩法只留在 BEST 总账，不分配到任一玩法。' : 'Version partitions are unavailable; cumulative is not version-specific. HAD / HHAD use the original frozen BEST market. Unknown markets remain only in combined BEST.'}</li>
          <li>{zh ? '同组基准与覆盖率缺失时不计算“提升幅度”；缺失不等于表现为零。' : 'No improvement is calculated without paired baseline and coverage evidence; missing evidence is not zero performance.'}</li>
          <li>{zh ? '历史复盘与研究影子不能替代独立前瞻验证。新模型通过既定准入门槛前，保持独立观察。' : 'Historical reviews and research shadows cannot replace independent prospective validation. New models remain separate until established admission gates pass.'}</li></ul>
      </details>
    </section>
  );
};
