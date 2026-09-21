import { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, Search, ArrowUpRight } from 'lucide-react';
import { useRecommendationCenter } from '../../hooks/useRecommendationCenter';
import { quoteSourceLabel, comboLaneFresh, comboPreviewForSize, comboLegSelection, primarySelectionSummary, handicapAnalysisBasis, calibrationSampleBasis, type Decision, type Settlement, type Combo, type ComboSelection, type Summary, type Outcome, type HandicapCalibrationProfile, type HandicapBreakdown } from '../../services/recommendationCenterView';
import '../../styles/recommendation-center.css';

type Language='zh'|'en';
interface Props {language:Language;onSelectMatch:(id:string)=>void;mode?:'recommendations'|'review';initialTab?:'single'|'two'|'three'}
const format=(s:string|null|undefined,lang:Language)=>s?new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s)):'—';
const title=(code:Outcome,zh:boolean)=>code==='1'?(zh?'主胜':'Home'):code==='X'?(zh?'平局':'Draw'):(zh?'客胜':'Away');
const resultLabel=(s:Settlement['state'],zh:boolean)=>({PENDING:zh?'待赛果':'Pending',WON:zh?'命中':'Won',LOST:zh?'未命中':'Lost',VOID:zh?'无效':'Void',DISPUTED:zh?'赛果待核':'Disputed'}[s]);
const handicapTitle=(code:Outcome,zh:boolean)=>code==='1'?(zh?'让胜':'Handicap home'):code==='X'?(zh?'让平':'Handicap draw'):(zh?'让负':'Handicap away');
function handicapNarrative(d:Decision,zh:boolean){
  const h=d.handicapAnalysis;if(!h)return '';
  if(handicapAnalysisBasis(d)==='unconditional')return zh?'本条为旧版独立让球分析，依据完整净胜球分布；不以胜平负首选命中为前提。':'This archived standalone handicap analysis uses the full goal-margin distribution, without conditioning on the 1X2 pick.';
  if(d.tipCode==='1'&&h.handicapLine<0){
    if(h.tipCode==='1')return zh?'在主胜成立的比分路径里，净胜球分布更偏穿盘，因此让胜优先。':'Given the home-win thesis lands, the margin distribution leans to covering.';
    if(h.tipCode==='X')return zh?`在主胜成立的比分路径里，更集中在净胜${Math.abs(h.handicapLine)}球，因此让平优先。`:'Given the home-win thesis lands, the margin is concentrated exactly on the handicap.';
    if(Math.abs(h.handicapLine)===1)return zh?'主胜与主让1的让负不能同时成立；新版不会把让负作为该场伴随首选。':'A home win and -1 handicap-away cannot both occur; v2 will not publish that as the companion pick.';
    return zh?`主胜仍成立，但更偏只赢1至${Math.abs(h.handicapLine)-1}球，无法覆盖${h.handicapLineText}，因此伴随方向为让负。`:'The home-win thesis still holds, but the expected winning margin is too small to cover the larger handicap.';
  }
  if(d.tipCode==='2'&&h.handicapLine>0){
    if(h.tipCode==='2')return zh?'在客胜成立的比分路径里，客队净胜幅度更偏穿盘，因此让负优先。':'Given the away-win thesis lands, the away margin leans to covering.';
    if(h.tipCode==='X')return zh?`在客胜成立的比分路径里，更集中在客队净胜${Math.abs(h.handicapLine)}球，因此让平优先。`:'Given the away-win thesis lands, the away margin is concentrated exactly on the handicap.';
    if(Math.abs(h.handicapLine)===1)return zh?'客胜与主受让1的让胜不能同时成立；新版不会把让胜作为该场伴随首选。':'An away win and home +1 handicap-home cannot both occur; v2 will not publish that as the companion pick.';
    return zh?`客胜仍成立，但更偏只赢1至${Math.abs(h.handicapLine)-1}球，无法覆盖主队受让${h.handicapLineText}，因此伴随方向为让胜。`:'The away-win thesis still holds, but the winning margin is too small to beat the larger receiving handicap.';
  }
  return zh?'该方向比较的是胜平负首选成立后的让球结果；串关另用不附加这一条件的完整让球概率。':'This companion compares handicap outcomes conditional on the 1X2 pick; combo selection uses the unconditional handicap probabilities.';
}
function HandicapBlock({d,settlement,language}:{d:Decision;settlement?:Settlement|null;language:Language}){
  const h=d.handicapAnalysis;if(!h)return null;const zh=language==='zh';
  return <section className="rc-handicap">
    <header><div><span>{h.probabilityBasis==='conditional-on-straight-primary'?(zh?'让球伴随分析':'Companion handicap analysis'):(zh?'让球分析':'Handicap analysis')} {h.handicapLineText}</span><strong>{handicapTitle(h.tipCode,zh)}</strong></div>
      <span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'待赛果':'Pending')}</span></header>
    <p>{handicapNarrative(d,zh)}</p>{h.probabilityBasis==='conditional-on-straight-primary'&&<small className="rc-handicap__basis">{zh?'以下三项为“胜平负首选成立”条件下的净胜球占比，不是独立HHAD命中率。':'The three shares below are conditional on the 1X2 thesis landing; they are not standalone HHAD hit probabilities.'}</small>}{h.overallTipCode&&h.overallTipCode!==h.tipCode&&<small className="rc-handicap__diagnostic">{zh?'独立HHAD全局最高项':'Standalone HHAD top'}：{handicapTitle(h.overallTipCode,zh)} · {zh?'未作为伴随首选':'not used as companion pick'}</small>}{h.historicalCalibration?.applied&&<small className="rc-handicap__learned">{zh?'历史盘口校准已启用':'Historical handicap calibration active'} · {h.historicalCalibration.key}</small>}
    <div className="rc-handicap__probabilities">{(['1','X','2'] as const).map(code=><div key={code} className={code===h.tipCode?'is-selected':''}><span>{handicapTitle(code,zh)}</span><strong>{(h.probabilities[code]*100).toFixed(1)}%</strong></div>)}</div>
    <div className="rc-handicap__meta"><span>{h.probabilityBasis==='conditional-on-straight-primary'?(zh?'条件卡盘占比':'Conditional land-on-line share'):(zh?'卡盘概率':'Land on line')} {(h.landOnLineProbability*100).toFixed(1)}%</span><span>{zh?'对应净胜球':'Exact margin'} {h.exactMargin>0?'+':''}{h.exactMargin}</span>
      {h.marketReference?.selectedOdds&&<span>{zh?'让球SP':'HHAD SP'} {h.marketReference.selectedOdds.toFixed(2)}</span>}</div>
  </section>;
}
function PrimaryPickHeader({d,language}:{d:Decision;language:Language}){
  const zh=language==='zh',summary=primarySelectionSummary(d),h=summary.handicap;
  return <div className="rc-primary-picks" aria-label={zh?'本场两个首选方向':'Primary 1X2 and handicap picks'}>
    <div className="rc-primary-pick rc-primary-pick--had"><span>{zh?'胜平负首选':'1X2 primary'}</span><strong>{title(summary.had.code,zh)}</strong><small>SP {summary.had.odds.toFixed(2)} · {(summary.had.probability*100).toFixed(1)}%</small></div>
    <span className="rc-primary-divider" aria-hidden="true">｜</span>
    <div className="rc-primary-pick rc-primary-pick--hhad"><span>{zh?'让球首选':'Handicap primary'}</span>{h?<><strong>{h.lineText} · {handicapTitle(h.code,zh)}</strong><small>{h.conditional?(zh?'条件占比 ':'Conditional share '):''}{(h.probability*100).toFixed(1)}%{h.odds?(' · SP '+h.odds.toFixed(2)):''}{h.calibrated?(zh?' · 已校准':' · calibrated'):''}</small></>:<><strong>—</strong><small>{zh?'等待有效让球线与净胜球数据':'Awaiting valid handicap inputs'}</small></>}</div>
  </div>;
}
function RecordDetails({d,selection,language,onSelectMatch}:{d:Decision;selection?:ComboSelection;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <details className="rc-details"><summary><ChevronDown size={14} aria-hidden="true"/>{zh?'分析依据与冻结版本':'Evidence & frozen version'}</summary>
    <div><p>{selection?.market==='HHAD'?(zh?'本腿选取完整让球概率中最高的方向，未使用“胜平负先命中”的条件占比；因此可以与单场卡片的伴随方向不同。盘口和SP均取自本条冻结记录。':'This leg uses the highest unconditional handicap probability, not the share conditional on a correct 1X2 pick. It may differ from the companion pick. The handicap and SP are archived with this selection.'):(zh?'胜平负首选取自完整模型概率的最大项；串关从同一决策中选择胜平负或让球玩法，每场只入选一腿。':'The 1X2 pick is the maximum of the model vector. A combo selects 1X2 or handicap from the same decision, with one leg per match.')}</p>
      <dl>{selection&&<><dt>{zh?'选定玩法':'Selected market'}</dt><dd>{selection.market==='HHAD'?(zh?'让球胜平负':'Handicap 1X2'):(zh?'胜平负':'1X2')}{selection.market==='HHAD'?` (${selection.handicapLine>0?'+':''}${selection.handicapLine})`:''}</dd><dt>{zh?'选定方向 / SP':'Pick / SP'}</dt><dd>{selection.market==='HHAD'?handicapTitle(selection.tipCode,zh):title(selection.tipCode,zh)} · {selection.odds.toFixed(2)}</dd><dt>{zh?'完整模型概率':'Unconditional model probability'}</dt><dd>{(selection.modelProbability*100).toFixed(1)}% · {zh?'尚未验证':'unvalidated'}</dd></>}<dt>{zh?'SP来源':'SP source'}</dt><dd>{quoteSourceLabel(selection??d,language)}{selection?` (${selection.quoteSource})`:''}</dd><dt>{zh?'模型生成':'Model generated'}</dt><dd>{format(d.modelGeneratedAt,language)}</dd><dt>{zh?'SP采集':'SP observed'}</dt><dd>{format(selection?.quoteObservedAt??d.quoteObservedAt,language)}</dd><dt>{zh?'实际发布':'Published'}</dt><dd>{format(d.publishedAt,language)}</dd><dt>{zh?'决策版本':'Decision ID'}</dt><dd className="rc-id">{d.decisionId}</dd>{selection&&<><dt>{zh?'串关选项版本':'Selection ID'}</dt><dd className="rc-id">{selection.selectionId}</dd></>}</dl>
      <button type="button" className="rc-link" onClick={()=>onSelectMatch(d.matchId)}>{zh?'查看球队与赛程资料':'Team & fixture information'}</button>
    </div></details>;
}
function Pick({d,settlement,handicapSettlement,language,onSelectMatch}:{d:Decision;settlement:Settlement;handicapSettlement?:Settlement|null;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <article className="rc-pick"><header><span>{d.matchNo||d.sourceMatchId} · {format(d.kickoffTime,language)}</span><span className={`rc-state rc-state--${settlement.state}`}>{resultLabel(settlement.state,zh)}</span></header>
    <div className="rc-pick__main"><h3>{d.homeTeamName} <span>vs</span> {d.awayTeamName}</h3>{settlement.score&&<span className="rc-match-score" aria-label={zh?'90分钟赛果':'90-minute result'}>{settlement.score.replace('-', ' : ')}</span>}</div>
    <PrimaryPickHeader d={d} language={language}/>
    <div className="rc-card-footer"><span>{zh?'发布于':'Published'} {format(d.publishedAt,language)}</span><button type="button" className="rc-match-link" onClick={()=>onSelectMatch(d.matchId)}>{zh?'比赛详情':'Match details'}<ArrowUpRight size={14} aria-hidden="true"/></button></div>
    <details className="rc-analysis"><summary><span>{zh?'概率与让球分析':'Probabilities & handicap analysis'}</span><ChevronDown size={16} aria-hidden="true"/></summary><div className="rc-analysis__body">
      <div className="rc-probabilities" aria-label={zh?'发布时胜平负概率':'Published outcome probabilities'}>{(['1','X','2'] as const).map(c=><div key={c} className={c===d.tipCode?'is-selected':''}><span>{title(c,zh)}</span><strong>{(d.probabilities[c]*100).toFixed(1)}%</strong><span className="rc-bar"><i style={{width:`${d.probabilities[c]*100}%`}}/></span></div>)}</div>
      <HandicapBlock d={d} settlement={handicapSettlement} language={language}/>
    </div></details>
    <RecordDetails d={d} language={language} onSelectMatch={onSelectMatch}/>
  </article>;
}
function ComboCard({combo,settlement,language,onSelectMatch}:{combo:Combo;settlement?:Settlement;language:Language;onSelectMatch:(id:string)=>void}){
  const zh=language==='zh';
  return <article className="rc-combo"><header><div><small>{zh?'每日精选':'Daily selection'}</small><h3>{combo.size}{zh?'串1':'-leg combo'}</h3></div><div><strong>SP {combo.totalOdds.toFixed(2)}</strong><small>{zh?'下限':'Minimum'} {combo.size===2?'2.50':'5.00'}</small></div></header>
    <div className="rc-combo__status"><span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'即时方案 · 未冻结':'Preview · not frozen')}</span><span>{combo.frozenAt?(zh?'冻结':'Frozen'):(zh?'计划冻结':'Freeze at')} {format(combo.frozenAt||combo.freezeAt,language)}</span></div>
    {combo.legs.map((leg,index)=>{const pick=comboLegSelection(combo,index),handicap=pick.market==='HHAD',result=settlement?.legs?.find(l=>l.decisionId===leg.decisionId);return <section className="rc-combo__leg" key={leg.decisionId}><div className="rc-leg-heading"><span className="rc-leg-number">{index+1}</span><div><strong>{leg.homeTeamName} vs {leg.awayTeamName}</strong><small>{leg.matchNo||leg.sourceMatchId} · {format(leg.kickoffTime,language)}</small></div><strong className="rc-leg-pick"><span className={`rc-market-label${handicap?' rc-market-label--hhad':''}`}>{handicap?(zh?'让球胜平负':'Handicap 1X2'):(zh?'胜平负':'1X2')}{handicap?` ${pick.handicapLine>0?'+':''}${pick.handicapLine}`:''}</span><span>{handicap?handicapTitle(pick.tipCode,zh):title(pick.tipCode,zh)} <small>SP {pick.odds.toFixed(2)}</small></span></strong></div>
      <div className="rc-leg-meta"><span>{quoteSourceLabel(pick,language)}</span><span>{zh?'SP采集':'SP observed'} {format(pick.quoteObservedAt,language)}</span>{result&&<span>{result.score||'—'} · {resultLabel(result.state,zh)}</span>}</div>
      <RecordDetails d={leg} selection={combo.selections?.[index]} language={language} onSelectMatch={onSelectMatch}/></section>;})}
    <p className="rc-disclaimer">{zh?'可混合胜平负与让球胜平负，每场只选一腿；模型仍在验证，未将单场概率相乘作为真实串关命中率。':'1X2 and handicap 1X2 may be mixed, with one leg per match. The model remains unvalidated; multiplying single probabilities does not establish a real combo hit rate.'}</p>
  </article>;
}
function Stats({value,zh}:{value:Summary|undefined;zh:boolean}){return <section className="rc-stats-wrap" aria-label={zh?'历史表现汇总':'Historical performance summary'}><div className="rc-stats-heading"><strong>{zh?'历史表现':'Historical performance'}</strong><small>{zh?'仅已结算计入命中率 · 不随明细筛选变化':'Hit rate uses settled records · filters only affect detail cards'}</small></div><div className="rc-stats">{[
  [zh?'命中率':'Hit rate',value?.hitRate==null?'—':`${(value.hitRate*100).toFixed(1)}%`],
  [zh?'命中 / 已结算':'Won / Settled',value?`${value.won} / ${value.settled}`:'—'],[zh?'待赛果':'Pending results',value?.pending??'—'],
  [zh?'已发布':'Published',value?.published??'—'],[zh?'待核 / 无效':'Disputed / Void',value?`${value.disputed} / ${value.void}`:'—'],
].map(([label,v],index)=><div key={label} className={index===0?'is-primary':undefined}><span>{label}</span><strong>{v}</strong></div>)}</div></section>;}
function HandicapPerformance({breakdown,legacy,zh}:{breakdown?:HandicapBreakdown;legacy?:Summary;zh:boolean}){
  if(!breakdown)return legacy?<div className="rc-handicap-summary"><span>{zh?'让球历史合计 · 尚未按版本拆分':'Handicap history · version split unavailable'}</span><strong>{legacy.hitRate==null?'—':`${(legacy.hitRate*100).toFixed(1)}%`}</strong><small>{zh?'命中 / 已结算':'Won / Settled'} {legacy.won} / {legacy.settled}</small></div>:null;
  const rows:Array<{key:string;label:string;scope:string;value:Summary}>=[{key:'v1',label:zh?'旧版独立让球 · v1':'Standalone handicap · v1',scope:zh?'全部旧版已结算场次':'All settled legacy matches',value:breakdown.standaloneV1}];
  for(const version of [2,3] as const){
    const all=version===2?breakdown.companionV2All:breakdown.companionV3All,conditional=version===2?breakdown.companionV2WhenHadWon:breakdown.companionV3WhenHadWon,both=version===2?breakdown.companionV2BothWon:breakdown.companionV3BothWon;
    if(!all||!conditional||!both)continue;
    const name=version===3?(zh?'统一比分模型 v3':'Coherent score model v3'):(zh?'伴随模型 v2':'Companion model v2');
    rows.push({key:`v${version}-all`,label:name+(zh?' · 让球命中':' · handicap hit'),scope:zh?'全部该版已结算场次':'All settled matches in this version',value:all},
      {key:`v${version}-conditional`,label:name+(zh?' · 主方向命中后':' · after 1X2 hit'),scope:zh?'仅胜平负首选命中的场次':'Only matches where the 1X2 pick won',value:conditional},
      {key:`v${version}-both`,label:name+(zh?' · 双方向同时命中':' · both picks hit'),scope:zh?'全部该版已结算场次':'All settled matches in this version',value:both});
  }
  return <section className="rc-performance" aria-label={zh?'按版本与样本拆分的让球命中率':'Handicap performance by version and sample'}><header><strong>{zh?'让球命中率 · 分开看样本':'Handicap hit rates · separate samples'}</strong><p>{zh?'“主方向命中后”的比例只回答条件问题，不等于让球整体命中率，也不用于串关概率。待赛果不计为未命中。':'The rate after a correct 1X2 pick is conditional. It is neither an overall handicap hit rate nor a combo probability. Pending results are not losses.'}</p></header><div className="rc-performance__rows">{rows.map(row=><article key={row.key}><div><strong>{row.label}</strong><small>{zh?'分母：':'Denominator: '}{row.scope}</small></div><div><strong>{row.value.hitRate==null?'—':`${(row.value.hitRate*100).toFixed(1)}%`}</strong><small>{zh?'命中 / 已结算':'Won / Settled'} {row.value.won} / {row.value.settled} · {zh?'待赛果':'Pending'} {row.value.pending}</small></div></article>)}</div></section>;
}
const groupLabel=(key:string,zh:boolean)=>{
  const [base,straight]=key.split('|straight:');
  const baseLabel=base==='home-give-1'?(zh?'主让1':'Home -1'):base==='home-give-2'?(zh?'主让2':'Home -2'):base==='home-give-3plus'?(zh?'主让3+':'Home -3+'):base==='home-receive-1'?(zh?'主受让1':'Home +1'):base==='home-receive-2'?(zh?'主受让2':'Home +2'):(zh?'主受让3+':'Home +3+');
  return straight?baseLabel+' · '+(straight==='1'?(zh?'主胜场景':'Home-win context'):straight==='X'?(zh?'平局场景':'Draw context'):(zh?'客胜场景':'Away-win context')):baseLabel;
};
function HandicapCalibrationPanel({profile,language}:{profile?:HandicapCalibrationProfile;language:Language}){
  const zh=language==='zh';
  const conditional=calibrationSampleBasis(profile)==='had-won';
  const groups=profile?Object.values(profile.groups).filter(g=>!conditional||g.key.includes('|straight:')).sort((a,b)=>a.key.localeCompare(b.key)):[];
  return <section className="rc-calibration"><header><div><span>{zh?'盘口强度分组复盘':'Handicap calibration by line'}</span><strong>{profile?.sampleRows??0}{conditional?(zh?'个主方向命中样本':' HAD-hit frozen samples'):(zh?'个全部样本':' total frozen samples')}</strong></div><small>{zh?'只有时间前推验证通过的分组才自动影响新让球方向。':'Only holdout-validated groups can change new handicap picks.'}</small></header>
    {groups.length?<div className="rc-calibration__grid">{groups.map(g=>{const m=g.metrics;const awayBias=g.bias['2'];return <article key={g.key} className={g.active?'is-active':''}><div className="rc-calibration__top"><strong>{groupLabel(g.key,zh)}</strong><span>{g.active?(zh?'已启用':'Active'):(zh?'观察中':'Observe')}</span></div><div className="rc-calibration__numbers"><span>{zh?'样本':'Samples'} <b>{g.rows}</b></span><span>{zh?'让负偏差':'Hcap-away bias'} <b>{awayBias>=0?'+':''}{(awayBias*100).toFixed(1)}pp</b></span><span>{zh?'实际让负':'Actual hcap-away'} <b>{(g.actualShare['2']*100).toFixed(1)}%</b></span></div>{m&&<div className="rc-calibration__metrics"><span>Brier {m.rawBrier?.toFixed(3)??'—'} → {m.calibratedBrier?.toFixed(3)??'—'}</span><span>{zh?'验证命中':'Holdout hit'} {m.rawHitRate==null?'—':(m.rawHitRate*100).toFixed(1)+'%'} → {m.calibratedHitRate==null?'—':(m.calibratedHitRate*100).toFixed(1)+'%'}</span></div>}<small>{g.active?(zh?'该组偏差会按收缩权重修正新概率，不会硬改方向。':'This group adjusts new probabilities with shrinkage, never a forced pick.'):(zh?'样本不足或样本外表现未改善，暂不改动新预测。':'No live adjustment until sample/holdout checks pass.')}</small></article>;})}</div>:<p className="rc-empty">{zh?'正在积累让球冻结样本；未达到门槛前保持原净胜球模型。':'Collecting frozen handicap samples; the raw goal-margin model remains unchanged until thresholds are met.'}</p>}</section>;
}
export function RecommendationCenter({language,onSelectMatch,mode='recommendations',initialTab='single'}:Props){
  const {data,loading,failed,authorizationRequired,refresh}=useRecommendationCenter();
  const [tab,setTab]=useState(initialTab),[,setClockTick]=useState(0);
  const [filters,setFilters]=useState<{query:string;state:'ALL'|Settlement['state'];limit:number}>({query:'',state:'ALL',limit:12});
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
  const needle=filters.query.trim().normalize('NFKC').toLocaleLowerCase();
  const matchesFilter=(decisions:Decision[],settlement:Settlement)=>!review||((filters.state==='ALL'||settlement.state===filters.state)&&(!needle||decisions.some(d=>[d.homeTeamName,d.awayTeamName,d.matchNo||'',d.sourceMatchId].some(value=>value.normalize('NFKC').toLocaleLowerCase().includes(needle)))));
  const filteredRows=rows.filter(row=>matchesFilter([row.decision],row.settlement)),filteredCombos=frozen.filter(row=>matchesFilter(row.combo.legs,row.settlement));
  const visibleRows=review?filteredRows.slice(0,filters.limit):filteredRows,visibleFrozen=review?filteredCombos.slice(0,filters.limit):filteredCombos;
  const filteredCount=tab==='single'?filteredRows.length:filteredCombos.length,displayedCount=tab==='single'?visibleRows.length:visibleFrozen.length;
  const hasFilters=Boolean(needle)||filters.state!=='ALL';
  const clearFilters=()=>setFilters({query:'',state:'ALL',limit:12});
  const comboFresh=comboLaneFresh(data,now);
  const preview=!review&&!frozen.length?comboPreviewForSize(data,size,now,failed):undefined;
  const comboCandidates=data?.lanes.combos?.candidateCount;
  const comboUnavailable=failed||!comboFresh;
  const activeInputs=tab==='single'?data?.inputAsOf:data?.lanes.combos?.inputAsOf??data?.inputAsOf;
  return <section className="recommendation-center" aria-labelledby="rc-title">
    <header className="rc-heading"><div><span className="rc-eyebrow">{zh?'比赛日 '+(data?.businessDate||'—'):'MATCH DAY '+(data?.businessDate||'—')}</span><h1 id="rc-title">{review?(zh?'赛后复盘':'Result Review'):(zh?'今日推荐':'Today’s Recommendations')}</h1><p>{review?(zh?'查看真实赛果，复盘每一次选择。':'Review every selection against actual results.'):(zh?'先看比赛与方向，再看选择依据。':'Start with the match and pick, then explore the evidence.')}</p></div><button type="button" className="rc-refresh" onClick={refresh} disabled={loading} aria-label={zh?'刷新推荐与复盘':'Refresh recommendations and review'}><RefreshCw size={16} aria-hidden="true"/>{loading?(zh?'更新中':'Updating'):(zh?'刷新':'Refresh')}</button></header>
    <div className="rc-meta"><span className="rc-reference-label">{zh?'参考推荐 · 模型验证中':'Reference picks · Model unvalidated'}</span><span>{zh?'行情更新':'Inputs updated'} {format(activeInputs,language)}</span><span>{zh?'赛果核对':'Results checked'} {format(data?.resultAsOf,language)}</span></div>
    <div className="rc-tabs" role="group" aria-label={zh?'推荐类型':'Recommendation type'}>{(['single','two','three'] as const).map(t=><button key={t} type="button" aria-pressed={tab===t} onClick={()=>{setTab(t);setFilters(current=>({...current,limit:12}));}}>{t==='single'?(zh?'单场推荐':'Singles'):t==='two'?(zh?'2串1':'2-leg combo'):(zh?'3串1':'3-leg combo')}{t!=='single'&&<small>SP≥{t==='two'?'2.50':'5.00'}</small>}</button>)}</div>
    <Stats value={summary} zh={zh}/>{review&&tab==='single'&&<details className="rc-review-insights"><summary><div><strong>{zh?'让球复盘与模型校准':'Handicap review & calibration'}</strong><span>{zh?'按版本查看命中率、样本分母与验证结果':'Compare versions, denominators and validation results'}</span></div><ChevronDown size={18} aria-hidden="true"/></summary><div className="rc-review-insights__body"><HandicapPerformance breakdown={data?.review.statistics.handicapBreakdown} legacy={handicapSummary} zh={zh}/><HandicapCalibrationPanel profile={data?.review.handicapCalibration} language={language}/></div></details>}
    {authorizationRequired?<p className="rc-notice" role="alert">{zh?'请使用网站访问权限重新登录。':'Please sign in with your website access.'}</p>:failed?<p className="rc-notice" role="status">{zh?'连接恢复中；保留上次已发布记录，不将读取失败显示为零成绩。':'Reconnecting. Retaining the last published records; errors do not reset statistics.'}</p>:null}
    {!loading&&(tab==='single'?stale:!comboFresh)&&<p className="rc-notice">{zh?'当前显示已发布快照，行情更新延迟；旧快照不作为新串关输入。':'Published snapshots are retained while inputs are delayed; old snapshots do not create new combos.'}</p>}
    {reviewDelayed&&<p className="rc-notice">{zh?'赛果核对正在恢复，新推荐发布不受此任务影响。':'Result verification is recovering; recommendation publication is independent.'}</p>}
    {!review&&tab==='single'&&rows.length>0&&rows.every(row=>!row.decision.handicapAnalysis)&&<p className="rc-notice" role="status">{zh?'让球分析等待包含进球期望与盘口的新数据，更新后自动显示；旧冻结记录保留原内容。':'Handicap analysis will appear automatically when goal estimates and handicap lines arrive. Existing frozen records retain their original content.'}</p>}
    {(data?.excludedCorruptRecords||0)>0&&<p className="rc-notice">{zh?'有记录正在单独核验，当前统计不包含这些记录。':'Some records are quarantined for verification and excluded from these statistics.'}</p>}
    {review&&<section className="rc-review-tools" aria-label={zh?'复盘明细筛选':'Review detail filters'}><div className="rc-filters"><label className="rc-search"><Search size={17} aria-hidden="true"/><span className="rc-sr-only">{zh?'搜索球队或比赛编号':'Search team or match number'}</span><input type="search" value={filters.query} placeholder={zh?'搜索球队或比赛编号':'Search team or match number'} onChange={event=>setFilters(current=>({...current,query:event.target.value,limit:12}))}/></label><label className="rc-status-filter"><span>{zh?'结算状态':'Result status'}</span><select value={filters.state} onChange={event=>setFilters(current=>({...current,state:event.target.value as typeof current.state,limit:12}))}><option value="ALL">{zh?'全部状态':'All results'}</option>{(['WON','LOST','PENDING','DISPUTED','VOID'] as const).map(state=><option key={state} value={state}>{resultLabel(state,zh)}</option>)}</select></label>{hasFilters&&<button type="button" className="rc-clear" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}</div><p className="rc-results-count" aria-live="polite">{zh?`共 ${filteredCount} 条${hasFilters?'符合条件的':''}明细 · 已显示 ${displayedCount} 条`:`${filteredCount} matching records · ${displayedCount} shown`}</p></section>}
    {loading&&!data?<div className="rc-empty" role="status">{zh?'正在读取推荐与复盘…':'Loading recommendations and review…'}</div>:tab==='single'?
      <div className="rc-picks">{visibleRows.length?visibleRows.map(row=><Pick key={row.decision.decisionId} d={row.decision} settlement={row.settlement} handicapSettlement={row.handicapSettlement} language={language} onSelectMatch={onSelectMatch}/>):<div className="rc-empty"><strong>{review&&hasFilters?(zh?'没有符合条件的比赛':'No matching matches'):(zh?'暂时没有可展示的推荐':'No recommendations yet')}</strong><p>{review&&hasFilters?(zh?'试试其他球队名称，或选择全部结算状态。':'Try another team or select all result states.'):(zh?'有效赛前数据到达后会自动更新，已冻结的历史记录继续保留。':'Eligible pre-match data will update automatically. Existing frozen records are retained.')}</p>{review&&hasFilters&&<button type="button" className="rc-link" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}</div>}</div>:
      <div className="rc-combos">{visibleFrozen.map(row=><ComboCard key={row.combo.id} combo={row.combo} settlement={row.settlement} language={language} onSelectMatch={onSelectMatch}/>)}{preview&&<ComboCard combo={preview} language={language} onSelectMatch={onSelectMatch}/>}{!visibleFrozen.length&&!preview&&<div className="rc-empty"><strong>{review&&hasFilters?(zh?'没有符合条件的串关':'No matching combos'):(zh?'暂无可展示的组合':'No combo to show')}</strong><p>{review?(hasFilters?(zh?'试试其他球队名称，或选择全部结算状态。':'Try another team or select all result states.'):(zh?'暂无该类型的冻结复盘记录。':'No frozen review records for this size.')):
        comboUnavailable?(zh?'串关数据正在更新；已冻结记录仍然保留。':'Combo data is updating; frozen records are retained.'):
        typeof comboCandidates==='number'&&comboCandidates<size?(zh?`当前可用${comboCandidates}场，${size}串1需要${size}场不同比赛。新场次到达后自动重算。`:`${comboCandidates} valid matches available; this combo requires ${size} distinct matches.`):
        (zh?`今日无合格组合。当前可用${comboCandidates??'—'}场，胜平负及让球首选尚未组成满足SP≥${size===2?'2.50':'5.00'}的${size}串1；不会改选第二方向凑SP。`:`No qualifying combo today. The available 1X2 and handicap primary picks do not form a ${size}-leg combination with SP≥${size===2?'2.50':'5.00'}; secondary directions are not substituted.`)}</p>{review&&hasFilters&&<button type="button" className="rc-link" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}</div>}</div>}
    {review&&filteredCount>displayedCount&&<div className="rc-load-more"><span>{zh?`还有 ${filteredCount-displayedCount} 条明细`:`${filteredCount-displayedCount} more records`}</span><button type="button" className="rc-link" onClick={()=>setFilters(current=>({...current,limit:current.limit+12}))}>{zh?'再显示12条':'Show 12 more'}<ChevronDown size={15} aria-hidden="true"/></button></div>}
    <footer className="rc-footnote">{zh?'单场每场统计截止前最后一个真实发布版本；串关统计冻结时绑定的版本，两者不混算。未结算不记为未命中。':'Single statistics use the last actually published version before cutoff; combos use their bound frozen versions. Pending results are not losses.'}{review&&data?` ${zh?'明细最多展示':'Detail limit:'} ${data.review.limit}${zh?'条，统计来自完整新台账。':' rows; statistics cover the complete new ledger.'}`:''}</footer>
  </section>;
}
