import type { ResolvedQuote, ResultPool } from '../../services/marketQuotePolicy';

type Language = 'zh' | 'en';
const labels = {
  HAD: { zh: ['主胜', '平局', '客胜'], en: ['Home', 'Draw', 'Away'] },
  HHAD: { zh: ['让胜', '让平', '让负'], en: ['H. Home', 'H. Draw', 'H. Away'] }
};

function sourceLabel(quote: ResolvedQuote, language: Language) {
  if (!quote.source) return language === 'zh' ? '来源待核' : 'Source unverified';
  if (quote.provenance === 'official') return language === 'zh' ? '竞彩官方 SP' : 'Official Sporttery SP';
  if (quote.source === 'manual-visual-review') return language === 'zh' ? '人工记录 · 非竞彩 SP' : 'Manual record · not Sporttery SP';
  if (quote.source?.includes('500')) return language === 'zh' ? '500 参考' : '500 reference';
  return language === 'zh' ? '外部参考' : 'External reference';
}

/** Display only. This component cannot promote a quote into a recommendation. */
export function MarketQuoteCard({ pool, quote, language, archived = false }: {
  pool: ResultPool;
  quote?: ResolvedQuote;
  language: Language;
  archived?: boolean;
}) {
  const title = pool === 'HAD' ? (language === 'zh' ? '胜平负' : '1X2') : (language === 'zh' ? '让球胜平负' : 'Handicap result');
  const line = quote?.handicap === undefined ? null : Number(quote.handicap);
  const status = !quote ? (language === 'zh' ? '暂无可核验赔率' : 'No verified quote')
    : archived ? (language === 'zh' ? '历史记录 · 非即时赔率' : 'Archived record · not a live quote')
    : quote.freshness === 'stale' ? (language === 'zh' ? '更新滞后' : 'Update delayed')
    : quote.freshness === 'unknown' ? (language === 'zh' ? '采集时间待核' : 'Capture time unknown')
    : (language === 'zh' ? '最近采集' : 'Recently observed');
  const timestamp = quote?.updatedAt ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Shanghai'
  }).format(new Date(quote.updatedAt)) : null;
  return <section className="market-quote" data-market-pool={quote?.candidateId === 'manual' ? 'MANUAL_1X2' : pool}
    data-freshness={quote?.freshness || 'missing'} aria-label={title}>
    <header className="market-quote__heading">
      <strong>{title}{pool === 'HHAD' && line !== null && <span> · {language === 'zh' ? '主队' : 'Home'} {line > 0 ? '+' : ''}{line}</span>}</strong>
      {quote && <span className={`market-quote__source is-${quote.provenance}`}>{sourceLabel(quote, language)}</span>}
    </header>
    <dl className="market-quote__prices">
      {(['odds1', 'oddsX', 'odds2'] as const).map((key, index) => <div key={key}>
        <dt>{labels[pool][language][index]}</dt><dd>{quote ? quote.odds[key].toFixed(2) : '—'}</dd>
      </div>)}
    </dl>
    <footer className="market-quote__receipt">
      <span>{status}</span>
      {timestamp && <time dateTime={quote?.updatedAt} title={quote?.updatedAt}>{timestamp} {language === 'zh' ? '北京' : 'Beijing'}</time>}
    </footer>
  </section>;
}
