import React from 'react';
import { BarChart3, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import type { Match } from '../../services/mockData';
import {
  buildHistoricalFeaturedPlanReview,
  featuredPlanBusinessDate,
  type FeaturedPlanReview
} from '../../services/dailyFeaturedPlans';
import '../../styles/featured-plan-review.css';

interface FeaturedPlanReviewSummaryProps {
  matches: Match[];
  language: 'zh' | 'en';
}

type Bucket = {
  available: number;
  won: number;
  lost: number;
  pending: number;
  void: number;
  hitRate: number | null;
};

const summarize = (plans: FeaturedPlanReview[]): Bucket => {
  const available = plans.filter((plan) => plan.status === 'available');
  const won = available.filter((plan) => plan.settlement === 'WON').length;
  const lost = available.filter((plan) => plan.settlement === 'LOST').length;
  const pending = available.filter((plan) => plan.settlement === 'PENDING').length;
  const voidCount = available.filter((plan) => plan.settlement === 'VOID').length;
  const settled = won + lost;
  return {
    available: available.length,
    won,
    lost,
    pending,
    void: voidCount,
    hitRate: settled > 0 ? won / settled : null
  };
};

const formatRate = (value: number | null, language: 'zh' | 'en') => (
  value === null ? (language === 'zh' ? '无样本' : 'N/A') : `${(value * 100).toFixed(1)}%`
);

const statusLabel = (plan: FeaturedPlanReview, language: 'zh' | 'en') => {
  if (plan.status !== 'available') return language === 'zh' ? '未形成' : 'Unavailable';
  if (plan.settlement === 'WON') return language === 'zh' ? '命中' : 'Hit';
  if (plan.settlement === 'LOST') return language === 'zh' ? '未中' : 'Miss';
  if (plan.settlement === 'VOID') return language === 'zh' ? '作废' : 'Void';
  return language === 'zh' ? '待结算' : 'Pending';
};

export const FeaturedPlanReviewSummary: React.FC<FeaturedPlanReviewSummaryProps> = ({ matches, language }) => {
  const review = React.useMemo(() => {
    const dates = Array.from(new Set(matches
      .map(featuredPlanBusinessDate)
      .filter(Boolean)))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, 45);
    const rows = dates.map((date) => buildHistoricalFeaturedPlanReview(matches, date));
    return {
      rows,
      two: summarize(rows.map((row) => row.two)),
      three: summarize(rows.map((row) => row.three))
    };
  }, [matches]);

  const cards = [
    { key: 'two', title: language === 'zh' ? '精选 2 场' : 'Featured 2', minimum: 'SP ≥ 2.50', bucket: review.two },
    { key: 'three', title: language === 'zh' ? '精选 3 场' : 'Featured 3', minimum: 'SP ≥ 5.00', bucket: review.three }
  ];

  return (
    <section className="featured-review" aria-label={language === 'zh' ? '已加载历史精选组合复盘' : 'Loaded-history featured plan replay'}>
      <header className="featured-review__header">
        <div>
          <span><BarChart3 size={14} aria-hidden="true" /> PRECISION REVIEW</span>
          <h2>{language === 'zh' ? '精选组合复盘 · 已加载历史' : 'Featured plan review · loaded history'}</h2>
          <p>{language === 'zh'
            ? '按当前浏览器已加载的冻结赛前正式方向确定性重放；与单场正式 BEST 命中率分开统计，不用赛后盘口补造方向。这里不是服务器全量累计统计。'
            : 'Deterministic replay from frozen formal pre-match directions currently loaded in the browser. It is separate from the single-pick formal BEST record and is not a server-complete lifetime statistic.'}</p>
        </div>
      </header>

      <div className="featured-review__scorecards">
        {cards.map(({ key, title, minimum, bucket }) => (
          <article key={key}>
            <div className="featured-review__scorecard-title"><strong>{title}</strong><span>{minimum}</span></div>
            <b className="featured-review__rate">{formatRate(bucket.hitRate, language)}</b>
            <div className="featured-review__counts">
              <span><CheckCircle2 size={13} />{language === 'zh' ? '命中' : 'Hit'} {bucket.won}</span>
              <span><XCircle size={13} />{language === 'zh' ? '未中' : 'Miss'} {bucket.lost}</span>
              <span><Clock3 size={13} />{language === 'zh' ? '待结算' : 'Pending'} {bucket.pending}</span>
            </div>
            <small>{language === 'zh' ? `已加载历史形成 ${bucket.available} 组 · 作废 ${bucket.void}` : `${bucket.available} loaded-history plans · ${bucket.void} void`}</small>
          </article>
        ))}
      </div>

      <div className="featured-review__recent">
        {review.rows.slice(0, 7).map((row) => (
          <div key={row.businessDate} className="featured-review__recent-row">
            <strong>{row.businessDate}</strong>
            {[row.two, row.three].map((plan) => (
              <span key={plan.kind} data-result={plan.settlement.toLowerCase()}>
                {plan.kind === 'TWO' ? (language === 'zh' ? '2场' : '2-pick') : (language === 'zh' ? '3场' : '3-pick')}
                {' · '}{plan.combinedSp ? `SP ${plan.combinedSp.toFixed(2)} · ` : ''}{statusLabel(plan, language)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
};
