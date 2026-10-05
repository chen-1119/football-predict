import { useEffect, useState } from 'react';
import { activeLotterySalesClosure } from '../services/lotterySalesCalendar';
import '../styles/sales-closure-notice.css';

export function SalesClosureNotice({ language }: { language: 'zh' | 'en' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const closure = activeLotterySalesClosure(now);
  if (!closure) return null;
  const zh = language === 'zh';
  return <aside className="sales-closure-notice" role="note" aria-label={zh ? '竞彩休市公告' : 'Lottery sales closure'}>
    <div>
      <strong>{zh ? '国庆休市 · 10月1日—4日' : 'National Day sales closure · 1–4 October'}</strong>
      <p>{zh
        ? '休市期间暂无在售竞彩。历史比赛与复盘仍可查看，恢复销售后以实际官方赛程为准。'
        : 'Lottery sales are closed. Past matches and reviews remain available; new listings depend on the official schedule after sales resume.'}</p>
    </div>
    <a href={closure.sourceUrl} target="_blank" rel="noreferrer">{zh ? '财政部公告 ↗' : 'Official notice ↗'}</a>
  </aside>;
}
