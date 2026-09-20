import { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown } from 'lucide-react';
import { useRecommendationCenter } from '../../hooks/useRecommendationCenter';
import { quoteSourceLabel, comboLaneFresh, comboPreviewForSize, primarySelectionSummary, type Decision, type Settlement, type Combo, type Summary, type Outcome, type HandicapCalibrationProfile } from '../../services/recommendationCenterView';
import '../../styles/recommendation-center.css';

type Language='zh'|'en';
interface Props {language:Language;onSelectMatch:(id:string)=>void;mode?:'recommendations'|'review';initialTab?:'single'|'two'|'three'}
const format=(s:string|null|undefined,lang:Language)=>s?new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s)):'—';
const title=(code:Outcome,zh:boolean)=>code==='1'?(zh?'主胜':'Home'):code==='X'?(zh?'平局':'Draw'):(zh?'客胜':'Away');
const resultLabel=(s:Settlement['state'],zh:boolean)=>({PENDING:zh?'待赛果':'Pending',WON:zh?'命中':'Won',LOST:zh?'未命中':'Lost',VOID:zh?'无效':'Void',DISPUTED:zh?'赛果待核':'Disputed'}[s]);
const handicapTitle=(code:Outcome,zh:boolean)=>code==='1'?(zh?'让胜':'Handicap home'):code==='X'?(zh?'让平':'Handicap draw'):(zh?'让负':'Handicap away');
function handicapNarrative(d:Decision,zh:boolean){
  const h=d.handicapAnalysis;if(!h)return '';
  if(d.tipCode==='1'&&h.handicapLine<0){
    if(h.tipCode==='1')return zh?'主胜方向下，净胜球分布更偏穿盘，让胜优先。':'Home-win view also leans to covering the handicap.';
    if(h.tipCode==='X')return zh?`主胜方向下，更集中在净胜${Math.abs(h.handicapLine)}球，让平优先。`:'Home-win view is concentrated on landing exactly on the handicap.';
    return zh?'主胜仍是胜平负首选，但净胜幅度不足，盘口更偏让负。':'Home win remains the 1X2 pick, but the margin is less likely to cover.';
  }
  if(d.tipCode==='2'&&h.handicapLine>0){
    if(h.tipCode==='2')return zh?'客胜方向下，客队净胜幅度更偏穿盘，让负优先。':'Away-win view also leans to covering the handicap.';
    if(h.tipCode==='X')return zh?`客胜方向下，更集中在客队净胜${Math.abs(h.handicapLine)}球，让平优先。`:'Away-win view is concentrated on landing exactly on the handicap.';
    return zh?'客胜仍是胜平负首选，但优势不足以穿受让盘，让胜更稳。':'Away win remains the 1X2 pick, but the margin may not cover the handicap.';
  }
  return zh?'让球方向由完整净胜球分布单独计算，不直接照搬胜平负。':'The handicap pick is derived from the full goal-margin distribution, not copied from 1X2.';
}
function HandicapBlock({d,settlement,language}:{d:Decision;settlement?:Settlement|null;language:Language}){
  const h=d.handicapAnalysis;if(!h)return null;const zh=language==='zh';
  return <section className="rc-handicap">
    <header><div><span>{zh?'让球分析':'Handicap analysis'} {h.handicapLineText}</span><strong>{handicapTitle(h.tipCode,zh)}</strong></div>
      <span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'待赛果':'Pending')}</span></header>
    <p>{handicapNarrative(d,zh)}</p>{h.historicalCalibration?.applied&&<small className="rc-handicap__learned">{zh?'历史盘口校准已启用':'Historical handicap calibration active'} · {h.historicalCalibration.key}</small>}
    <div className="rc-handicap__probabilities">{(['1','X','2'] as const).map(code=><div key={code} className={code===h.tipCode?'is-selected':''}><span>{handicapTitle(code,zh)}</span><strong>{(h.probabilities[code]*100).toFixed(1)}%</strong></div>)}</div>
    <div className="rc-handicap__meta"><span>{zh?'卡盘概率':'Land on line'} {(h.landOnLineProbability*100).toFixed(1)}%</span><span>{zh?'对应净胜球':'Exact margin'} {h.exactMargin>0?'+':''}{h.exactMargin}</span>
      {h.marketReference?.selectedOdds&&<span>{zh?'让球SP':'HHAD SP'} {h.marketReference.selectedOdds.toFixed(2)}</span>}</div>
  </section>;
}
function PrimaryPickHeader({d,language}:{d:Decision;language:Language}){
  const zh=language==='zh',summary=primarySelectionSummary(d),h=summary.handicap;
  return <div className="rc-primary-picks" aria-label={zh?'本场两个首选方向':'Primary 1X2 and handicap picks'}>
    <div className="rc-primary-pick rc-primary-pick--had"><span>{zh?'胜平负首选':'1X2 primary'}</span><strong>{title(summary.had.code,zh)}</strong><small>SP {summary.had.odds.toFixed(2)} · {(summary.had.probability*100).toFixed(1)}%</small></div>
    <span className="rc-primary-divider" aria-hidden="true">｜</span>
    <div className="rc-primary-pick rc-primary-pick--hhad"><span>{zh?'让球首选':'Handicap primary'}</span>{h?<><strong>{h.lineText} · {handicapTitle(h.code,zh)}</strong><small>{(h.probability*100).toFixed(1)}%{h.odds?(' · SP '+h.odds.toFixed(2)):''}{h.calibrated?(zh?' · 已校准':' · calibrated'):''}</small></>:<><strong>—</strong><small>{zh?'等待有效让球线与净胜球数据':'Awaiting valid handicap inputs'}</small></>}</div>
  </div>;
}
function RecordDetails({d,language,onSelectMatch}:{d:Decision;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <details className="rc-details"><summary><ChevronDown size={14} aria-hidden="true"/>{zh?'分析依据与冻结版本':'Evidence & frozen version'}</summary>
    <div><p>{zh?'唯一首选取自本次完整模型概率的最大项；串关引用相同版本，不再次更改方向。':'The primary pick is the maximum of this model vector. A combo references this exact version without changing its direction.'}</p>
      <dl><dt>{zh?'SP来源':'SP source'}</dt><dd>{quoteSourceLabel(d,language)}</dd><dt>{zh?'模型生成':'Model generated'}</dt><dd>{format(d.modelGeneratedAt,language)}</dd><dt>{zh?'SP采集':'SP observed'}</dt><dd>{format(d.quoteObservedAt,language)}</dd><dt>{zh?'实际发布':'Published'}</dt><dd>{format(d.publishedAt,language)}</dd><dt>{zh?'决策版本':'Decision ID'}</dt><dd className="rc-id">{d.decisionId}</dd></dl>
      <button type="button" className="rc-link" onClick={()=>onSelectMatch(d.matchId)}>{zh?'查看球队与赛程资料':'Team & fixture information'}</button>
    </div></details>;
}
function Pick({d,settlement,handicapSettlement,language,onSelectMatch}:{d:Decision;settlement:Settlement;handicapSettlement?:Settlement|null;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <article className="rc-pick"><header><span>{d.matchNo||d.sourceMatchId} · {format(d.kickoffTime,language)}</span><span className={`rc-state rc-state--${settlement.state}`}>{resultLabel(settlement.state,zh)}</span></header>
    <PrimaryPickHeader d={d} language={language}/>
    <div className="rc-pick__main"><div><h3>{d.homeTeamName} <span>vs</span> {d.awayTeamName}</h3><small>{zh?'发布':'Published'} {format(d.publishedAt,language)} · {quoteSourceLabel(d,language)}</small></div></div>
    <div className="rc-probabilities" aria-label={zh?'发布时胜平负概率':'Published outcome probabilities'}>{(['1','X','2'] as const).map(c=><div key={c} className={c===d.tipCode?'is-selected':''}><span>{title(c,zh)}</span><strong>{(d.probabilities[c]*100).toFixed(1)}%</strong><span className="rc-bar"><i style={{width:`${d.probabilities[c]*100}%`}}/></span></div>)}</div>
    <HandicapBlock d={d} settlement={handicapSettlement} language={language}/>
    {settlement.score&&<p className="rc-score">{zh?'90分钟赛果':'90-minute result'} <strong>{settlement.score}</strong></p>}
    <RecordDetails d={d} language={language} onSelectMatch={onSelectMatch}/>
  </article>;
}
function ComboCard({combo,settlement,language,onSelectMatch}:{combo:Combo;settlement?:Settlement;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <article className="rc-combo"><header><div><small>{zh?'每日精选':'Daily selection'}</small><h3>{combo.size}{zh?'串1':'-leg combo'}</h3></div><div><strong>SP {combo.totalOdds.toFixed(2)}</strong><small>{zh?'下限':'Minimum'} {combo.size===2?'2.50':'5.00'}</small></div></header>
    <div className="rc-combo__status"><span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'即时方案 · 未冻结':'Preview · not frozen')}</span><span>{combo.frozenAt?(zh?'冻结':'Frozen'):(zh?'计划冻结':'Freeze at')} {format(combo.frozenAt||combo.freezeAt,language)}</span></div>
    {combo.legs.map((leg,index)=>{const result=settlement?.legs?.find(l=>l.decisionId===leg.decisionId);return <section className="rc-combo__leg" key={leg.decisionId}><div className="rc-leg-heading"><span className="rc-leg-number">{index+1}</span><div><strong>{leg.homeTeamName} vs {leg.awayTeamName}</strong><small>{leg.matchNo||leg.sourceMatchId} · {format(leg.kickoffTime,language)}</small></div><strong>{title(leg.tipCode,zh)} <small>@{leg.odds.toFixed(2)}</small></strong></div>
      <div className="rc-leg-meta"><span>{quoteSourceLabel(leg,language)}</span><span>{zh?'绑定版本发布于':'Bound version published'} {format(leg.publishedAt,language)}</span>{result&&<span>{result.score||'—'} · {resultLabel(result.state,zh)}</span>}</div>
      <RecordDetails d={leg} language={language} onSelectMatch={onSelectMatch}/></section>;})}
    <p className="rc-disclaimer">{zh?'每腿绑定真实决策ID；模型概率用于排序，不代表已验证的组合命中率。':'Each leg binds an actual decision ID. Model probabilities rank selections; they are not verified combo hit rates.'}</p>
  </article>;
}
function Stats({value,zh}:{value:Summary|undefined;zh:boolean}){return <div className="rc-stats">{[
  [zh?'已发布':'Published',value?.published??'—'],[zh?'命中 / 已结算':'Won / Settled',value?`${value.won} / ${value.settled}`:'—'],
  [zh?'命中率':'Hit rate',value?.hitRate==null?'—':`${(value.hitRate*100).toFixed(1)}%`],[zh?'待核 / 无效':'Disputed / Void',value?`${value.disputed} / ${value.void}`:'—'],
].map(([label,v])=><div key={label}><span>{label}</span><strong>{v}</strong></div>)}</div>;}
const groupLabel=(key:string,zh:boolean)=>{
  const [base,straight]=key.split('|straight:');
  const baseLabel=base==='home-give-1'?(zh?'主让1':'Home -1'):base==='home-give-2'?(zh?'主让2':'Home -2'):base==='home-give-3plus'?(zh?'主让3+':'Home -3+'):base==='home-receive-1'?(zh?'主受让1':'Home +1'):base==='home-receive-2'?(zh?'主受让2':'Home +2'):(zh?'主受让3+':'Home +3+');
  return straight?baseLabel+' · '+(straight==='1'?(zh?'主胜场景':'Home-win context'):straight==='X'?(zh?'平局场景':'Draw context'):(zh?'客胜场景':'Away-win context')):baseLabel;
};
function HandicapCalibrationPanel({profile,language}:{profile?:HandicapCalibrationProfile;language:Language}){
  const zh=language==='zh';
  const groups=profile?Object.values(profile.groups).filter(g=>g.key.includes('|straight:')).sort((a,b)=>a.key.localeCompare(b.key)):[];
  return <section className="rc-calibration"><header><div><span>{zh?'盘口强度分组复盘':'Handicap calibration by line'}</span><strong>{profile?.sampleRows??0}{zh?'个冻结样本':' frozen samples'}</strong></div><small>{zh?'只有时间前推验证通过的分组才自动影响新让球方向。':'Only holdout-validated groups can change new handicap picks.'}</small></header>
    {groups.length?<div className="rc-calibration__grid">{groups.map(g=>{const m=g.metrics;const awayBias=g.bias['2'];return <article key={g.key} className={g.active?'is-active':''}><div className="rc-calibration__top"><strong>{groupLabel(g.key,zh)}</strong><span>{g.active?(zh?'已启用':'Active'):(zh?'观察中':'Observe')}</span></div><div className="rc-calibration__numbers"><span>{zh?'样本':'Samples'} <b>{g.rows}</b></span><span>{zh?'让负偏差':'Hcap-away bias'} <b>{awayBias>=0?'+':''}{(awayBias*100).toFixed(1)}pp</b></span><span>{zh?'实际让负':'Actual hcap-away'} <b>{(g.actualShare['2']*100).toFixed(1)}%</b></span></div>{m&&<div className="rc-calibration__metrics"><span>Brier {m.rawBrier?.toFixed(3)??'—'} → {m.calibratedBrier?.toFixed(3)??'—'}</span><span>{zh?'验证命中':'Holdout hit'} {m.rawHitRate==null?'—':(m.rawHitRate*100).toFixed(1)+'%'} → {m.calibratedHitRate==null?'—':(m.calibratedHitRate*100).toFixed(1)+'%'}</span></div>}<small>{g.active?(zh?'该组偏差会按收缩权重修正新概率，不会硬改方向。':'This group adjusts new probabilities with shrinkage, never a forced pick.'):(zh?'样本不足或样本外表现未改善，暂不改动新预测。':'No live adjustment until sample/holdout checks pass.')}</small></article>;})}</div>:<p className="rc-empty">{zh?'正在积累让球冻结样本；未达到门槛前保持原净胜球模型。':'Collecting frozen handicap samples; the raw goal-margin model remains unchanged until thresholds are met.'}</p>}</section>;
}
export function RecommendationCenter({language,onSelectMatch,mode='recommendations',initialTab='single'}:Props){
  const {data,loading,failed,authorizationRequired,refresh}=useRecommendationCenter();
  const [tab,setTab]=useState(initialTab),[,setClockTick]=useState(0);
  // The interval wakes an idle page; every data render must use the actual
  // clock. A saved tick can precede a newly received lane timestamp by seconds.
  const now=Date.now();
  useEffect(()=>{const timer=window.setInterval(()=>setClockTick(tick=>tick+1),10000);return ()=>window.clearInterval(timer);},[]);
  const zh=language==='zh',review=mode==='review';
  const summary=data?.review.statistics[tab==='single'?'single':tab];
  const handicapSummary=data?.review.statistics.handicap;
  const currentDay=data?.businessDate===new Date(now+8*3600000).toISOString().slice(0,10);
  const stale=!currentDay||!data?.inputAsOf||now-Date.parse(data.inputAsOf)>15*60000||data.lanes.publish?.status==='error';
  const reviewDelayed=data?.lanes.settlement?.status==='error';
  const rows=review?data?.review.singles||[]:currentDay?data?.current||[]:[];
  const size=tab==='two'?2:3;
  const frozen=(review?data?.review.combos:currentDay?data?.todayCombos:[])?.filter(r=>r.combo.size===size)||[];
  const comboFresh=comboLaneFresh(data,now);
  const preview=!review&&!frozen.length?comboPreviewForSize(data,size,now,failed):undefined;
  const comboCandidates=data?.lanes.combos?.candidateCount;
  const comboUnavailable=failed||!comboFresh;
  const activeInputs=tab==='single'?data?.inputAsOf:data?.lanes.combos?.inputAsOf??data?.inputAsOf;
  return <section className="recommendation-center" aria-labelledby="rc-title">
    <header className="rc-heading"><div><span className="rc-eyebrow">{zh?'统一决策 · 可追溯发布':'One decision · Traceable publication'}</span><h1 id="rc-title">{review?(zh?'赛后复盘':'Result Review'):(zh?'今日推荐':'Today’s Recommendations')}</h1><p>{zh?'单场与串关共用决策版本；原始方向不改，官方赛果更正同步复盘。':'Singles and combos share decision versions. Original picks remain immutable; official corrections update both records.'}</p></div><button type="button" className="rc-refresh" onClick={refresh}><RefreshCw size={16} aria-hidden="true"/>{zh?'刷新':'Refresh'}</button></header>
    <div className="rc-meta"><span>{zh?'业务日':'Match day'} {data?.businessDate||'—'}</span><span>{zh?'行情截至':'Inputs as of'} {format(activeInputs,language)}</span><span>{zh?'赛果核对':'Results checked'} {format(data?.resultAsOf,language)}</span><span>{zh?'模型验证中':'Model unvalidated'}</span></div>
    <div className="rc-tabs" role="group" aria-label={zh?'推荐类型':'Recommendation type'}>{(['single','two','three'] as const).map(t=><button key={t} type="button" aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='single'?(zh?'单场':'Singles'):t==='two'?(zh?'2串1 · SP≥2.50':'2-leg · SP≥2.50'):(zh?'3串1 · SP≥5.00':'3-leg · SP≥5.00')}</button>)}</div>
    <Stats value={summary} zh={zh}/>{review&&tab==='single'&&handicapSummary&&<div className="rc-handicap-summary"><span>{zh?'让球复盘':'Handicap review'}</span><strong>{handicapSummary.hitRate==null?'—':`${(handicapSummary.hitRate*100).toFixed(1)}%`}</strong><small>{zh?'命中 / 已结算':'Won / Settled'} {handicapSummary.won} / {handicapSummary.settled}</small></div>}{review&&tab==='single'&&<HandicapCalibrationPanel profile={data?.review.handicapCalibration} language={language}/>} 
    {authorizationRequired?<p className="rc-notice" role="alert">{zh?'请使用网站访问权限重新登录。':'Please sign in with your website access.'}</p>:failed?<p className="rc-notice" role="status">{zh?'连接恢复中；保留上次已发布记录，不将读取失败显示为零成绩。':'Reconnecting. Retaining the last published records; errors do not reset statistics.'}</p>:null}
    {!loading&&(tab==='single'?stale:!comboFresh)&&<p className="rc-notice">{zh?'当前显示已发布快照，行情更新延迟；旧快照不作为新串关输入。':'Published snapshots are retained while inputs are delayed; old snapshots do not create new combos.'}</p>}
    {reviewDelayed&&<p className="rc-notice">{zh?'赛果核对正在恢复，新推荐发布不受此任务影响。':'Result verification is recovering; recommendation publication is independent.'}</p>}
    {!review&&tab==='single'&&rows.length>0&&rows.every(row=>!row.decision.handicapAnalysis)&&<p className="rc-notice" role="status">{zh?'让球分析等待包含进球期望与盘口的新数据，更新后自动显示；旧冻结记录保留原内容。':'Handicap analysis will appear automatically when goal estimates and handicap lines arrive. Existing frozen records retain their original content.'}</p>}
    {(data?.excludedCorruptRecords||0)>0&&<p className="rc-notice">{zh?'有记录正在单独核验，当前统计不包含这些记录。':'Some records are quarantined for verification and excluded from these statistics.'}</p>}
    {loading&&!data?<div className="rc-empty" role="status">{zh?'正在读取推荐与复盘…':'Loading recommendations and review…'}</div>:tab==='single'?
      <div className="rc-picks">{rows.length?rows.map(row=><Pick key={row.decision.decisionId} d={row.decision} settlement={row.settlement} handicapSettlement={row.handicapSettlement} language={language} onSelectMatch={onSelectMatch}/>):<p className="rc-empty">{zh?'当前还没有已落库的有效赛前记录。新数据到达后自动评估发布，不等待旧正式资格。':'No persisted eligible pre-match record yet. New inputs are evaluated without the old formal-pick gate.'}</p>}</div>:
      <div className="rc-combos">{frozen.map(row=><ComboCard key={row.combo.id} combo={row.combo} settlement={row.settlement} language={language} onSelectMatch={onSelectMatch}/>)}{preview&&<ComboCard combo={preview} language={language} onSelectMatch={onSelectMatch}/>}{!frozen.length&&!preview&&<p className="rc-empty">{review?(zh?'暂无该类型的冻结复盘记录。':'No frozen review records for this size.'):
        comboUnavailable?(zh?'串关数据正在更新；已冻结记录仍然保留。':'Combo data is updating; frozen records are retained.'):
        typeof comboCandidates==='number'&&comboCandidates<size?(zh?`当前可用${comboCandidates}场，${size}串1需要${size}场不同比赛。新场次到达后自动重算。`:`${comboCandidates} valid matches available; this combo requires ${size} distinct matches.`):
        (zh?`当前可用${comboCandidates??'—'}场，尚未组成满足SP≥${size===2?'2.50':'5.00'}的${size}串1；不会改选第二方向凑SP。`:`No ${size}-leg combination of the available matches meets SP≥${size===2?'2.50':'5.00'}; directions are not substituted.`)}</p>}</div>}
    <footer className="rc-footnote">{zh?'单场每场统计截止前最后一个真实发布版本；串关统计冻结时绑定的版本，两者不混算。未结算不记为未命中。':'Single statistics use the last actually published version before cutoff; combos use their bound frozen versions. Pending results are not losses.'}{review&&data?` ${zh?'明细最多展示':'Detail limit:'} ${data.review.limit}${zh?'条，统计来自完整新台账。':' rows; statistics cover the complete new ledger.'}`:''}</footer>
  </section>;
}
