import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Bookmark, RefreshCw, Search } from 'lucide-react';
import { useAccount } from '../context/AccountContext';
import { useApp } from '../context/AppContextCore';
import { FollowButton } from '../components/FollowButton';
import { TeamBadge } from '../components/TeamBadge';
import { buildApiUrl } from '../services/runtimeUrls';
import { safeAccountReturnTo } from '../services/accountApi';
import type { Team } from '../services/mockData';
import '../styles/public-browse.css';

interface Fixture {id:string;sourceMatchId:string;matchNo:string|null;businessDate:string|null;homeTeamName:string;awayTeamName:string;homeTeamNameEn?:string;awayTeamNameEn?:string;homeTeamLogo?:string;awayTeamLogo?:string;homeTeamId?:string;awayTeamId?:string;leagueName:string|null;status:string;effectiveStatus:string|null;kickoffTime:string|null;odds:{home:number|null;draw:number|null;away:number|null};sourceUpdatedAt?:string|null;quoteStatus?:'missing'|'unverified'|'recent'|'expired'|'archived'}
interface Example {decisionId:string;matchId:string;homeTeamName:string;awayTeamName:string;publishedAt:string;cutoffTime:string;tipCode:string;odds:number|null;state:string;score:string|null;quoteSource:string|null;quoteObservedAt?:string|null;probabilities?:Record<string,number|null>}
interface Overview {businessDate:string;sourceUpdatedAt:string|null;stale:boolean;matches:Fixture[];review:{updatedAt:string|null;summary:{settled:number;won:number;pending:number|null;hitRate:number|null}|null;example:Example|null}}
const time=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'待更新';
function team(match:Fixture,side:'home'|'away'):Team {const name=match[`${side}TeamName`];return {id:match[`${side}TeamId`]||`${match.id}:${side}`,name:{zh:name,en:match[`${side}TeamNameEn`]||name},shortName:{zh:name,en:name},logo:match[`${side}TeamLogo`]||'',value:'',color:'#64748b'};}

export function PublicBrowse(){
 const account=useAccount(),{language}=useApp(),location=useLocation(),{matchId}=useParams(),[params,setParams]=useSearchParams();
 const [data,setData]=useState<Overview|null>(null),[detail,setDetail]=useState<Fixture|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 const zh=language==='zh',review=location.pathname==='/review',recommendations=location.pathname==='/best',query=params.get('q')||'',date=params.get('date')||'';
 useEffect(()=>{const controller=new AbortController();let active=true;setLoading(true);setError('');setDetail(null);const timer=setTimeout(()=>controller.abort(),15000);
  void (async()=>{try{const response=await fetch(buildApiUrl('/api/public/overview'),{signal:controller.signal});if(!response.ok)throw new Error();const overview=await response.json() as Overview;if(!overview||!Array.isArray(overview.matches)||!overview.review)throw new Error();if(active)setData(overview);
   if(matchId){const response=await fetch(buildApiUrl(`/api/public/matches/${encodeURIComponent(matchId)}`),{signal:controller.signal});if(!response.ok)throw new Error();const result=await response.json();if(active)setDetail(result.match);}
  }catch{if(active)setError(zh?'内容暂时读取失败，请重试。':'Could not load content. Please retry.');}finally{clearTimeout(timer);if(active)setLoading(false);}})();
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[attempt,matchId,zh]);
 const update=(key:string,value:string)=>{const next=new URLSearchParams(params);if(value)next.set(key,value);else next.delete(key);setParams(next,{replace:true});};
 const days=[...new Set((data?.matches||[]).map(m=>m.businessDate).filter((d):d is string=>Boolean(d)))].sort();
 const selectedDay=/^\d{4}-\d{2}-\d{2}$/.test(date)?date:(days.includes(data?.businessDate||'')?data?.businessDate:days.at(-1));
 const search=query.trim().normalize('NFKC').toLocaleLowerCase();
 const matches=(data?.matches||[]).filter(m=>(!selectedDay||m.businessDate===selectedDay)&&(!search||`${m.homeTeamName} ${m.awayTeamName} ${m.homeTeamNameEn||''} ${m.awayTeamNameEn||''} ${m.matchNo||''} ${m.leagueName||''}`.normalize('NFKC').toLocaleLowerCase().includes(search)));
 const returnTo=location.pathname+location.search+location.hash,example=data?.review.example,summary=data?.review.summary;
 const cta=account.user?'/account':`/auth?returnTo=${encodeURIComponent(returnTo)}`;
 const accessExpired=Boolean(account.access.expiresAt)&&Date.parse(account.access.expiresAt!)<=Date.now();
 const accessLabel=!account.user?(zh?'尚未登录':'Sign in required'):account.access.trialAvailable?(zh?'尚未领取体验':'Trial not activated'):accessExpired?(zh?'内容权益已到期':'Content access expired'):(zh?'暂无有效内容权益':'No active content access');
 const accessAction=!account.user?(zh?'登录 / 注册后查看':'Sign in / Register'):account.access.trialAvailable?(zh?'领取3天体验':'Claim a 3-day trial'):(zh?'管理内容权益':'Manage content access');
 const card=(m:Fixture)=><article className="public-fixture" key={m.id}>
  <div className="public-fixture-meta"><span>{m.matchNo||'赛事'} · {m.leagueName||'联赛待更新'}</span><time>{time(m.kickoffTime)}</time></div>
  <Link className="public-matchup" to={`/match/${encodeURIComponent(m.id)}`} state={{openedFromList:true,fromPath:returnTo}}><span><TeamBadge team={team(m,'home')}/><strong>{m.homeTeamName}</strong></span><small>VS</small><span><TeamBadge team={team(m,'away')}/><strong>{m.awayTeamName}</strong></span></Link>
  <div className="public-odds">{(['home','draw','away'] as const).map((key,i)=><span key={key}>{(zh?['主胜','平局','客胜']:['Home','Draw','Away'])[i]}<strong>{typeof m.odds?.[key]==='number'&&Number.isFinite(m.odds[key])&&m.odds[key]!>1?m.odds[key]?.toFixed(2):'—'}</strong></span>)}</div>
  <p className="public-caption public-quote-note" role="status">{m.quoteStatus==='missing'
    ?(zh?'胜平负 SP 有缺项；缺失项不补算。':'Some 1X2 prices are missing; missing values are not inferred.')
    :m.quoteStatus==='unverified'
    ?(zh?'赛程胜平负 SP 已取得，报价时间未核验；推荐详情以发布时冻结 SP 为准。':'All fixture 1X2 prices are available, but their observation time is unverified; recommendation details use frozen publication SP.')
    :(zh?'赛程赔率快照；推荐详情以发布时冻结 SP 为准。':'Fixture quote snapshot; recommendation details use frozen publication SP.')}
    {m.quoteStatus==='expired'?(zh?' · 报价已超过15分钟':' · Quote older than 15 minutes'):''}
    {m.quoteStatus==='archived'?(zh?' · 已过赛前截止':' · Pre-match cutoff passed'):''}
    {m.sourceUpdatedAt?` · ${zh?'报价记录':'Recorded'} ${time(m.sourceUpdatedAt)}`:''}</p>
  <footer><span>{({SCHEDULED:zh?'未开赛':'Upcoming',LIVE:zh?'进行中':'Live',FINISHED:zh?'已结束':'Finished',PENDING_RESULT:zh?'待核实赛果':'Result pending',CANCELLED:zh?'已取消':'Cancelled'} as Record<string,string>)[m.effectiveStatus||m.status]|| (zh?'赛程记录':'Fixture')}</span><FollowButton matchId={m.id}/></footer>
 </article>;
 return <section className="public-browse">
  <header className="public-hero"><div><span className="public-eyebrow">90 MINUTES · {zh?'公开预览':'PUBLIC PREVIEW'}</span><h1>{matchId?(zh?'比赛资料':'Match information'):review?(zh?'每一次判断，都有记录':'Every pick has a record'):(zh?'从今天的比赛开始':'Start with today’s matches')}</h1><p>{zh?'先看赛程与真实复盘。登录后关注比赛，在同一处追踪结果。':'Browse fixtures and recorded results. Sign in to follow matches and review them in one place.'}</p></div><Link className="public-cta" to={cta}>{account.user?(zh?'我的账号与体验':'My account & trial'):(zh?'登录 / 注册':'Sign in / Register')}<ArrowRight size={17}/></Link></header>
  <nav className="public-journey" aria-label={zh?'使用流程':'Your journey'}><span>01 {zh?'看比赛':'Browse'}</span><span>02 {zh?'登录关注':'Sign in & follow'}</span><Link to="/following?tab=settled">03 {zh?'回来看结果':'Review results'} <ArrowRight size={14}/></Link></nav>
  {recommendations&&<section aria-label={zh?'每日串关入口':'Daily combo access'}><div className="public-section-title"><h2>{zh?'每日串关':'Daily combos'}</h2><small>{zh?'参考推荐 · 需有效内容权益':'Reference picks · Content access required'}</small></div><div className="public-grid">{(['two','three'] as const).map(tab=>{const target=`/best?tab=${tab}`,href=`${account.user?'/account':'/auth'}?returnTo=${encodeURIComponent(target)}`;return <article className="public-fixture" key={tab}><div className="public-section-title"><h3>{tab==='two'?(zh?'2串1':'2-leg combo'):(zh?'3串1':'3-leg combo')}</h3><strong>SP≥{tab==='two'?'2.50':'5.00'}</strong></div><p className="public-caption">{accessLabel}。{zh?'完整组合在有效体验或内容权益下查看；未登录或未开通权益不代表今天没有组合。':'Full combos require an active trial or content access. Restricted access does not mean there are no combos today.'}</p><Link className="public-cta" to={href} aria-label={`${accessAction} · ${tab==='two'?'2串1':'3串1'}`}>{accessAction}<ArrowRight size={17}/></Link></article>;})}</div><p className="public-caption">{zh?'领取体验后仍需等待合格报价；没有符合条件的比赛或报价过期时，会显示具体原因，不保证每天生成组合。':'Even with access, combos require eligible quotes. Insufficient matches or expired quotes are explained; combos are not guaranteed every day.'}</p></section>}
  {error&&<div className="public-notice" role="alert">{error}<button type="button" onClick={()=>setAttempt(n=>n+1)}><RefreshCw size={15}/>{zh?'重试':'Retry'}</button></div>}
  {loading&&!data?<div className="public-empty" role="status">{zh?'正在读取赛程与复盘…':'Loading fixtures and review…'}</div>:<>
   {matchId?<><Link className="public-back" to={safeAccountReturnTo((location.state as {fromPath?:string}|null)?.fromPath,'/fixtures')}>← {zh?'返回赛程':'Back to fixtures'}</Link>{detail?card(detail):!loading&&!error&&<p className="public-empty">{zh?'暂时没有这场比赛的资料。':'Match information is unavailable.'}</p>}<p className="public-notice">{zh?'这里展示公开赛程与赔率快照。完整赛前分析可在“我的”领取体验后查看。':'This preview contains fixtures and odds snapshots. Claim a trial in My account to view full analysis.'}</p></>:
   !review&&<section><div className="public-section-title"><h2>{zh?'竞彩日赛程':'Match-day fixtures'}</h2><small>{zh?'北京时间':'Beijing time'} · {time(data?.sourceUpdatedAt)}</small></div>
    <div className="public-filters"><label><span>{zh?'竞彩日':'Match day'}</span><select value={selectedDay||''} onChange={e=>update('date',e.target.value)}>{days.map(d=><option key={d}>{d}</option>)}{selectedDay&&!days.includes(selectedDay)&&<option value={selectedDay}>{selectedDay} · {zh?'暂无赛程':'No fixtures'}</option>}{!days.length&&<option value="">{zh?'暂无赛程':'No fixtures'}</option>}</select></label><label className="public-search"><Search size={17}/><input aria-label={zh?'搜索球队或比赛编号':'Search team or match number'} placeholder={zh?'搜索球队、联赛或编号':'Search team, league or number'} value={query} onChange={e=>update('q',e.target.value)}/></label></div>
    {data?.stale&&<p className="public-notice">{zh?'赛程更新滞后，当前展示最近一次快照。':'Fixture updates are delayed; showing the latest available snapshot.'}</p>}
    <div className="public-grid">{matches.map(card)}</div>{!matches.length&&!loading&&!error&&<div className="public-empty"><strong>{search?(zh?'没有匹配的比赛':'No matching fixtures'):(zh?'这个竞彩日暂无比赛':'No fixtures for this match day')}</strong><p>{zh?'可切换日期或清除搜索。数据更新后会在这里显示。':'Choose another date or clear the search. New data appears here when available.'}</p>{query&&<button onClick={()=>update('q','')}>{zh?'清除搜索':'Clear search'}</button>}</div>}
   </section>}
   {!matchId&&<section className="public-review"><div className="public-section-title"><h2>{zh?'公开复盘':'Public review'}</h2><Link to="/following?tab=settled"><Bookmark size={15}/>{zh?'我的关注复盘':'My followed results'}</Link></div>
    <div className="public-stats"><div><span>{zh?'已结算单场':'Settled singles'}</span><strong>{summary?.settled??'—'}</strong></div><div><span>{zh?'命中 / 已结算':'Won / settled'}</span><strong>{summary?`${summary.won} / ${summary.settled}`:'—'}</strong></div><div><span>{zh?'历史命中率':'Historical hit rate'}</span><strong>{typeof summary?.hitRate==='number'?`${(summary.hitRate*100).toFixed(1)}%`:'—'}</strong></div><div><span>{zh?'待结算':'Pending'}</span><strong>{summary?.pending??'—'}</strong></div></div>
    <p className="public-caption">{zh?'统计按单场截止前最后发布版本计算；未结算不算未命中。模型仍为参考／影子状态，历史结果不代表未来表现。':'Statistics use the last published version before cutoff. Pending results are not losses. The model remains reference / shadow; historical results do not predict future performance.'}</p>
    {example?<article className="public-example"><div><span className="public-eyebrow">{zh?'最近结算样例 · 按发布时间排序':'LATEST SETTLED EXAMPLE · BY PUBLICATION TIME'}</span><h3>{example.homeTeamName} <small>vs</small> {example.awayTeamName}</h3><p>{zh?'赛前方向':'Pre-match pick'}：{({1:zh?'主胜':'Home',X:zh?'平局':'Draw',2:zh?'客胜':'Away'} as Record<string,string>)[example.tipCode]} · SP {example.odds?.toFixed(2)||'—'} · {example.score||'—'} · {({WON:zh?'命中':'Won',LOST:zh?'未命中':'Lost',VOID:zh?'已作废':'Void',DISPUTED:zh?'赛果待核':'Disputed',PENDING:zh?'等待赛果':'Pending'} as Record<string,string>)[example.state]||(zh?'状态待核':'Unverified state')}</p><details><summary>{zh?'查看发布时间与冻结版本':'Publication time & frozen version'}</summary><p>{zh?'发布':'Published'} {time(example.publishedAt)} · {zh?'截止':'Cutoff'} {time(example.cutoffTime)}</p><p>{zh?'SP来源：':'SP source: '}{example.quoteSource||(zh?'来源未标注':'Source unavailable')} · {zh?'采集：':'Observed: '}{time(example.quoteObservedAt)}</p><p>{zh?'发布时胜平负模型概率（参考）':'Published model probabilities (reference)'}</p><div className="public-odds">{(['1','X','2'] as const).map((code,i)=><span key={code}>{(zh?['主胜','平局','客胜']:['Home','Draw','Away'])[i]}<strong>{typeof example.probabilities?.[code]==='number'&&Number.isFinite(example.probabilities[code])&&example.probabilities[code]!>=0&&example.probabilities[code]!<=1?`${(example.probabilities[code]!*100).toFixed(1)}%`:'—'}</strong></span>)}</div><code>{example.decisionId}</code></details></div><FollowButton matchId={example.matchId} decisionId={example.decisionId}/></article>:<div className="public-empty">{zh?'暂时没有可核验的已结算样例，数据到达后展示。':'No verifiable settled example is available yet.'}</div>}
   </section>}
  </>}
 </section>;
}
