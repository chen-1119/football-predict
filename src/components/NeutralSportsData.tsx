import { useEffect, useState } from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
type Source = { url: string; receivedAt: string; sha256: string };
type Team = { name: string; providerName?: string; standing: { rank: number; points: number; played: number } | null; lastFiveComplete: boolean; scope: string; lastFive: Array<{ missing?: boolean; kickoff: string; home?: string; away?: string; score?: number[] }> };
type Official = { status: string; reason?: string; teams?: Team[]; sources?: Source[]; lineup?: { status: string; teams: Array<{ name: string; formation?: string; players: Array<{ name: string; position?: string; number?: string }> }> }; availability?: Array<{ team: string; name: string; status: string; reason: string; publishedAt: string; sourceUrl: string }>; observedAt?: string };
type Data = { version: string; eventId: string; businessDate: string; kickoff: string; names: string[]; predictionEligible: false; checkedAt: string; statistics: { status: string; reason?: string; teams?: Team[]; observedAt?: string; identityMethod?: string; sources?: Source[]; quarantined?: number }; official: Official | null; collection?: { discoveredAt: string; lastAttemptAt: string; evidence: Array<{field:string;state:string;observedAt:string;lastAttemptStatus:string}>;gaps:string[] }; limitations: string[] };
const clock = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + '（仅核实日期）' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function NeutralIdentityFallback({eventId,businessDate}:{eventId:string;businessDate:string}){
  const [value,setValue]=useState<Data|null>(null);
  useEffect(()=>{const controller=new AbortController();setValue(null);const timer=window.setTimeout(()=>controller.abort(),10000);
    fetch(buildApiUrl(`/api/sports-data?businessDate=${encodeURIComponent(businessDate)}&eventId=${encodeURIComponent(eventId)}`),{headers:getAccessAuthHeaders(),signal:controller.signal,cache:'no-store'})
      .then(async response=>{if(!response.ok)throw Error('identity');return response.json() as Promise<Data>;})
      .then(data=>{if(data.version==='neutral-match-sports-v1'&&data.eventId===eventId&&data.businessDate===businessDate&&data.predictionEligible===false&&Number.isFinite(Date.parse(data.kickoff))&&data.names?.length===2&&!controller.signal.aborted)setValue(data);})
      .catch(()=>{}).finally(()=>clearTimeout(timer));return()=>{controller.abort();clearTimeout(timer);};},[eventId,businessDate]);
  if(!value||value.eventId!==eventId||value.businessDate!==businessDate)return null;
  return <><header className="card" style={{padding:'1.25rem'}}><h1>{value.names.join(' — ')}</h1><p>{businessDate} 竞彩日 · {clock(value.kickoff)} 北京时间</p><p>已校验留存赛程身份；当前在售状态及 SP 未核验，不展示历史报价为当前报价。</p></header><NeutralSportsData eventId={eventId} businessDate={businessDate} kickoff={value.kickoff} names={value.names}/></>;
}
export function NeutralSportsData({ eventId, businessDate, kickoff, names }: { eventId: string; businessDate: string; kickoff: string; names: string[] }) {
  const [data, setData] = useState<Data | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null, disposed = false, refreshTimer: number | undefined, timeout: number | undefined;
    setData(null); setFailed(false);
    const refresh = () => {
      controller = new AbortController();
      timeout = window.setTimeout(() => controller?.abort(), 10000);
      fetch(buildApiUrl(`/api/sports-data?businessDate=${encodeURIComponent(businessDate)}&eventId=${encodeURIComponent(eventId)}`), { headers: getAccessAuthHeaders(), signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw Error('unavailable'); return response.json() as Promise<Data>; })
      .then(value => { if (value.version !== 'neutral-match-sports-v1' || value.eventId !== eventId || value.businessDate !== businessDate || Date.parse(value.kickoff) !== Date.parse(kickoff) || value.names?.[0] !== names[0] || value.names?.[1] !== names[1] || value.predictionEligible !== false) throw Error('identity'); if (!disposed) { setData(value); setFailed(false); } })
      .catch(() => { if (!disposed) setFailed(true); }).finally(() => { clearTimeout(timeout); if (!disposed) refreshTimer = window.setTimeout(refresh, 60000); });
    };
    refresh();
    return () => { disposed = true; clearTimeout(timeout); clearTimeout(refreshTimer); controller?.abort(); };
  }, [eventId,businessDate,kickoff,names[0],names[1]]);
  const current = data?.eventId === eventId && data.businessDate === businessDate ? data : null;
  const teams = current?.statistics.teams || current?.official?.teams || [];
  const sources = [...(current?.statistics.sources || []), ...(current?.official?.sources || [])];
  const archived = Boolean((current?.official as (Official & { archived?: boolean }) | null)?.archived);
  return <section className="card" style={{padding:'1.25rem',marginBlock:'1rem'}} data-neutral-sports-event={eventId}>
    <h2>球队资料 · 免费与官方来源</h2>
    {!current ? <p role="status">{failed ? '本场资料或官方身份暂时无法核验，未展示旧值。' : '正在读取本场真实采集资料…'}</p> : <>
      <p>本场核对：{current.names.join(' — ')} · {clock(current.kickoff)} 北京时间</p>
      <p>本栏球队资料独立更新，不改动已发布方向、冻结 SP 或比分；已开赛后的更新不能作为原推荐的赛前依据。</p>
      <p data-neutral-refresh>页面每分钟自动读取；最近读取：{clock(current.checkedAt)}。采集时间以各字段原时间为准。</p>
      {failed && <p role="status">本轮读取失败，以下为上次已核验资料，不能当作当前更新。</p>}
      {current.collection && <div data-neutral-collection-status><h3>自动发现与字段状态</h3><p>首次发现：{clock(current.collection.discoveredAt)}；最近采集尝试：{clock(current.collection.lastAttemptAt)}</p><ul>{current.collection.evidence.map(item=><li key={item.field}>{({standing0:'主队积分',standing1:'客队积分',history0:'主队近况',history1:'客队近况',fixture:'官方赛程',availability:'伤停停赛',lineup:'确认首发'} as Record<string,string>)[item.field]||item.field}：{({available:'已取得',partial:'不完整',retained:'更新失败，保留上次资料',stale:'已过期，仅供历史查看',archived:'赛前留存，非当前更新'} as Record<string,string>)[item.state]||item.state} · 原采集 {clock(item.observedAt)}{!['available','missing'].includes(item.lastAttemptStatus)?` · 本轮 ${item.lastAttemptStatus}`:''}</li>)}</ul>{current.collection.evidence.length===0&&<p>已发现比赛，但尚未取得通过校验的球队资料；不是采集完成。</p>}</div>}
      {current.statistics.reason && <p>{current.statistics.reason}</p>}
      {current.statistics.observedAt && <p>统计采集：{clock(current.statistics.observedAt)}；{current.statistics.identityMethod}</p>}
      {current.official?.observedAt && <p>{archived ? '赛前留存资料（非当前更新）' : '官方补充采集'}：{clock(current.official.observedAt)}；部分资料已取得不代表全部字段齐全。</p>}
      {teams.map(team => <div key={team.name}><h3>{team.name}</h3><p>{team.standing ? `排名 ${team.standing.rank} · 积分 ${team.standing.points} · 已赛 ${team.standing.played}` : '积分未核实'}</p><p>近五场：{team.lastFiveComplete ? '来源记录齐全' : '不完整'}；{team.scope}</p><ul>{team.lastFive.map((row,index) => <li key={index}>{clock(row.kickoff)} {row.missing ? '记录缺失或隔离' : `${row.home} ${row.score?.join(':')} ${row.away}`}</li>)}</ul></div>)}
      <h3>伤停与停赛</h3>
      {current.official?.availability?.length ? <ul>{current.official.availability.map((item,index) => <li key={index}>{item.team} · {item.name}：{item.status}，{item.reason}；报道 {clock(item.publishedAt)} <a href={item.sourceUrl} target="_blank" rel="noreferrer">官方原文</a></li>)}</ul> : <p>尚未取得本场可核验的完整伤停、停赛名单；不能解释为无人缺阵。</p>}
      <h3>确认首发</h3>
      {current.official?.lineup?.status === 'confirmed' ? current.official.lineup.teams.map(team => <div key={team.name}><b>{team.name} {team.formation}</b><p>{team.players.map(player => `${player.number || ''} ${player.name} ${player.position || ''}`).join('；')}</p></div>) : <p>未取得官方确认首发；未用预计阵容替代。</p>}
      {current.official?.reason && <p>{current.official.reason}</p>}
      <details><summary>来源与原件校验（{sources.length}）</summary>{sources.map((source,index) => <p key={index}><a href={source.url} target="_blank" rel="noreferrer">原始来源</a> · 接收 {clock(source.receivedAt)}<br/><small style={{overflowWrap:'anywhere'}}>SHA-256 {source.sha256}</small></p>)}</details>
      <ul>{current.limitations.map(note => <li key={note}>{note}</li>)}</ul>
    </>}
  </section>;
}
