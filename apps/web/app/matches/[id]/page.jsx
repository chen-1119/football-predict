import Link from 'next/link';
import data from '../../../lib/data.cjs';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }) {
  const { id } = await params, value = await data.loadMatch(id);
  return { title: value?.match ? `${value.match.homeTeamName}—${value.match.awayTeamName} 赛程` : '比赛资料待更新' };
}
export default async function MatchPage({ params }) {
  const { id } = await params, value = await data.loadMatch(id), match = value?.match;
  if (!match) return <><h1>比赛资料暂时不可用</h1><Link href="/">返回赛程</Link></>;
  return <article className="fixture detail"><p className="eyebrow">{match.matchNo} · {match.leagueName} · {match.businessDate} 竞彩日</p>
    <h1>{match.homeTeamName} — {match.awayTeamName}</h1><p>开球：{match.kickoffTime ? new Date(match.kickoffTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未核实'}</p>
    <p>停售：{match.buyEndTime ? new Date(match.buyEndTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未核实'}</p>
    <p>胜平负 SP：{[match.odds.home, match.odds.draw, match.odds.away].map(sp => sp == null ? '—' : Number(sp).toFixed(2)).join(' / ')}</p>
    <p>报价观察：{match.sourceUpdatedAt || '未核实'} · {match.quoteStatus === 'recent' ? '近期报价' : '请在原站核对最新报价'}</p>
    <Link href="/best">查看已发布分析</Link></article>;
}
