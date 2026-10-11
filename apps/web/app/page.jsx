import Link from 'next/link';
import data from '../lib/data.cjs';
export const dynamic = 'force-dynamic';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '未核实';
export default async function Home({ searchParams }) {
  const params = await searchParams, query = {};
  for (const field of ['date', 'cursor']) if (typeof params[field] === 'string') query[field] = params[field];
  const result = await data.loadFixtures(query);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  return <><div className="heading"><div><p className="eyebrow">中国体彩竞彩足球</p><h1>比赛赛程</h1></div><span>{today} 北京时间</span></div>
    {result.stale && <p className="notice">{result.availability === 'last-committed-snapshot' ? '更新暂时未完成，保留上次已读取的赛程。下列赔率已过期。' : result.ok ? '赛程批次较旧，请留意每场报价时间和停售时间。' : '赛程读取暂时不可用，请查看原站。'}</p>}
    {result.publication && <p className="updated">赛程入库时间：{time(result.publication.committedAt)} · 本页读取：{time(result.observedAt)}</p>}
    <section className="fixtures" aria-label="比赛赛程">{result.matches.map(match => <article className="fixture" key={match.id}>
      <div className="fixture-meta"><span>{match.matchNo || '编号待核'} · {match.businessDate || '竞彩日待核'}</span><span>{match.leagueName}</span></div>
      <h2><Link href={'/matches/' + match.id}>{match.homeTeamName} <span className="versus">vs</span> {match.awayTeamName}</Link></h2>
      <p>开球 {time(match.kickoffTime)} · 停售 {time(match.buyEndTime)}</p>
      <div className="odds">{[['主胜', match.odds.home], ['平局', match.odds.draw], ['客胜', match.odds.away]].map(([label, sp]) => <div key={label}><span>{label}</span><strong>{sp == null ? '—' : Number(sp).toFixed(2)}</strong></div>)}</div>
      <p className="updated">报价观察：{time(match.sourceUpdatedAt)} · {({ recent: '近期报价', expired: '报价过期', archived: '已截止', missing: '暂无完整胜平负报价', unverified: '报价时间未核实' })[match.quoteStatus]}</p>
    </article>)}</section>
    {result.ok && result.matches.length === 0 && <p className="notice">此日期暂无已提交的赛程。开售后采集到的新场次将由数据服务提供。</p>}
    {result.nextCursor && <Link className="next" href={'/?' + new URLSearchParams({ ...query, cursor: result.nextCursor }).toString()}>下一页</Link>}
  </>;
}
