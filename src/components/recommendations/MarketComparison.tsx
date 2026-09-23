import type { Decision, Outcome } from '../../services/recommendationCenterView';
import { buildMarketComparison } from '../../services/marketComparison';
import './market-comparison.css';

type Language = 'zh' | 'en';
const labels: Record<'HAD' | 'HHAD', Record<Language, Record<Outcome, string>>> = {
  HAD: { zh: { '1': '主胜', X: '平局', '2': '客胜' }, en: { '1': 'Home', X: 'Draw', '2': 'Away' } },
  HHAD: { zh: { '1': '让胜', X: '让平', '2': '让负' }, en: { '1': 'Handicap home', X: 'Handicap draw', '2': 'Handicap away' } }
};

export function MarketComparison({ decision, language }: { decision: Decision; language: Language }) {
  const comparison = buildMarketComparison(decision), zh = language === 'zh';
  return <section className="market-comparison" data-decision-id={comparison.decisionId}
    aria-label={zh ? '同一决策的胜平负与让球比较' : '1X2 and handicap comparison for one decision'}>
    <header className="market-comparison__heading">
      <strong>{zh ? '两种玩法，同一决策' : 'Two markets, one decision'}</strong>
      <span>{zh ? '概率为模型估计 · 尚未验证' : 'Model estimates · not validated'}</span>
    </header>
    <div className="market-comparison__grid">
      {comparison.markets.map(market => <section key={market.pool} className="market-comparison__market" data-pool={market.pool}>
        <header><strong>{market.pool === 'HAD' ? (zh ? '胜平负' : '1X2') : (zh ? '让球胜平负' : 'Handicap 1X2')}{market.pool === 'HHAD' && market.line !== 0 ? ` · ${market.line > 0 ? '+' : ''}${market.line}` : ''}</strong>
          <small>{market.probabilityBasis === 'coherent-score-matrix'
            ? (zh ? '同一比分矩阵' : 'Same score matrix')
            : market.probabilityBasis === 'standalone-historical'
              ? (zh ? '旧版独立分布' : 'Historical standalone distribution')
              : (zh ? '缺少可核验模型分布' : 'Model distribution unavailable')}</small></header>
        <dl>{market.outcomes.map(outcome => <div key={outcome.code} className={outcome.independentLeader ? 'is-model-leader' : ''}>
          <dt>{labels[market.pool][language][outcome.code]}{outcome.independentLeader && <small>{zh ? '概率最高' : 'Highest probability'}</small>}</dt>
          <dd><strong>{outcome.probability === null ? '—' : `${(outcome.probability * 100).toFixed(1)}%`}</strong>
            <span>{zh ? '发布时 SP' : 'Published SP'} {outcome.frozenSp === null ? '—' : outcome.frozenSp.toFixed(2)}</span></dd>
        </div>)}</dl>
        <p>{market.quoteStatus === 'expired'
          ? (zh ? '发布前报价已过期，SP 不展示。' : 'Quote expired before publication; SP unavailable.')
          : market.quoteStatus === 'missing'
            ? (zh ? '未保存可核验的完整报价；缺失项不补价。' : 'Verified quote unavailable; missing prices are not filled.')
            : (zh ? 'SP 是发布时冻结价格，不是当前可购买报价。' : 'SP is frozen at publication, not a current offer.')}</p>
      </section>)}
    </div>
    {comparison.companionConditional && <p className="market-comparison__note">{zh
      ? '让球三项使用完整比分分布；下方“让球伴随分析”另有“主方向成立”条件概率，两者不能混作同一命中率。'
      : 'The handicap triplet uses the full score distribution. The companion analysis below is conditional on the 1X2 pick and has a different denominator.'}</p>}
  </section>;
}
