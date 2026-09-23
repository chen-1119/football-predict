import { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, Search, ArrowUpRight } from 'lucide-react';
import { useRecommendationCenter } from '../../hooks/useRecommendationCenter';
import { TeamBadge } from '../TeamBadge';
import { FollowButton } from '../FollowButton';
import type { Team } from '../../services/mockData';
import { quoteSourceLabel, comboLaneFresh, comboPreviewForSize, comboLegSelection, primarySelectionSummary, handicapExtensionText, handicapAnalysisBasis, calibrationSampleBasis, type Decision, type Settlement, type Combo, type ComboSelection, type Summary, type Outcome, type HandicapCalibrationProfile, type HandicapBreakdown } from '../../services/recommendationCenterView';
import '../../styles/recommendation-center.css';
import { SelectionQualityNote } from './SelectionQualityNote';
import type { SelectionQuality } from '../../services/recommendationCenterView';
import { DayCoverage } from './DayCoverage';
import { MarketComparison } from './MarketComparison';
import { useRecommendationReviewPage } from '../../hooks/useRecommendationReviewPage';
import type { ReviewFilters, ReviewMarket, ReviewState, ReviewedSingleRow, ReviewedComboRow } from '../../services/recommendationReviewPage';

type Language='zh'|'en';
type RecommendationTab='single'|'two'|'three';
interface Props {language:Language;onSelectMatch:(id:string)=>void;mode?:'recommendations'|'review';initialTab?:RecommendationTab;selectedTab?:RecommendationTab;onTabChange?:(tab:RecommendationTab)=>void}
const format=(s:string|null|undefined,lang:Language)=>s?new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s)):'—';
const title=(code:Outcome,zh:boolean)=>code==='1'?(zh?'主胜':'Home'):code==='X'?(zh?'平局':'Draw'):(zh?'客胜':'Away');
const resultLabel=(s:Settlement['state'],zh:boolean)=>({PENDING:zh?'待赛果':'Pending',WON:zh?'命中':'Won',LOST:zh?'未命中':'Lost',VOID:zh?'无效':'Void',DISPUTED:zh?'赛果待核':'Disputed'}[s]);
const handicapTitle=(code:Outcome,zh:boolean)=>code==='1'?(zh?'让胜':'Handicap home'):code==='X'?(zh?'让平':'Handicap draw'):(zh?'让负':'Handicap away');
function FrozenMatchTeams({d}:{d:Decision}){
  // Badge lookup follows the archived names, never a replacement current fixture.
  const team=(side:'home'|'away'):Team=>{
    const name=side==='home'?d.homeTeamName:d.awayTeamName;
    return {id:`${d.decisionId}:${side}`,name:{zh:name,en:name},shortName:{zh:name,en:name},logo:'',value:'',color:'#64748b'};
  };
  return <><span className="rc-team-label"><TeamBadge team={team('home')} size="sm" className="rc-team-badge"/><span className="rc-team-name">{d.homeTeamName}</span></span><span className="rc-team-versus">vs</span><span className="rc-team-label"><TeamBadge team={team('away')} size="sm" className="rc-team-badge"/><span className="rc-team-name">{d.awayTeamName}</span></span></>;
}
function handicapNarrative(d:Decision,zh:boolean){
  const h=d.handicapAnalysis;if(!h)return '';
  if(handicapAnalysisBasis(d)==='unconditional')return zh?'本条为旧版独立让球分析，依据完整净胜球分布；不以胜平负首选命中为前提。':'This archived standalone handicap analysis uses the full goal-margin distribution, without conditioning on the 1X2 pick.';
  if(d.tipCode==='1'&&h.handicapLine<0){
    if(h.tipCode==='1')return zh?'在主胜成立的比分路径里，净胜球分布更偏穿盘，因此让胜优先。':'Given the home-win thesis lands, the margin distribution leans to covering.';
    if(h.tipCode==='X')return zh?`在主胜成立的比分路径里，更集中在净胜${Math.abs(h.handicapLine)}球，因此让平优先。`:'Given the home-win thesis lands, the margin is concentrated exactly on the handicap.';
    if(Math.abs(h.handicapLine)===1)return zh?'主胜与主让1的让负不能同时成立；新版不会把让负作为该场伴随首选。':'A home win and -1 handicap-away cannot both occur; v2 will not publish that as the companion pick.';
    return zh?`主胜仍可能成立，但模型更偏只赢1至${Math.abs(h.handicapLine)-1}球，无法覆盖${h.handicapLineText}。这是窄胜风险，顶部不追让球。`:'A home win remains possible, but the expected winning margin is too small to cover the larger handicap. This is narrow-win risk; the top extension is a pass.';
  }
  if(d.tipCode==='2'&&h.handicapLine>0){
    if(h.tipCode==='2')return zh?'在客胜成立的比分路径里，客队净胜幅度更偏穿盘，因此让负优先。':'Given the away-win thesis lands, the away margin leans to covering.';
    if(h.tipCode==='X')return zh?`在客胜成立的比分路径里，更集中在客队净胜${Math.abs(h.handicapLine)}球，因此让平优先。`:'Given the away-win thesis lands, the away margin is concentrated exactly on the handicap.';
    if(Math.abs(h.handicapLine)===1)return zh?'客胜与主受让1的让胜不能同时成立；新版不会把让胜作为该场伴随首选。':'An away win and home +1 handicap-home cannot both occur; v2 will not publish that as the companion pick.';
    return zh?`客胜仍可能成立，但模型更偏只赢1至${Math.abs(h.handicapLine)-1}球，无法覆盖主队受让${h.handicapLineText}。这是窄胜风险，顶部不追让球。`:'An away win remains possible, but the winning margin is too small to beat the larger receiving handicap. This is narrow-win risk; the top extension is a pass.';
  }
  return zh?'该方向比较的是胜平负首选成立后的让球结果；串关另用不附加这一条件的完整让球概率。':'This companion compares handicap outcomes conditional on the 1X2 pick; combo selection uses the unconditional handicap probabilities.';
}
function HandicapBlock({d,settlement,language}:{d:Decision;settlement?:Settlement|null;language:Language}){
  const h=d.handicapAnalysis;if(!h)return null;const zh=language==='zh',pass=primarySelectionSummary(d).handicap?.status==='pass';
  return <section className="rc-handicap">
    <header><div><span>{pass?(zh?'让球概率诊断':'Handicap probability diagnostic'):h.probabilityBasis==='conditional-on-straight-primary'?(zh?'让球伴随分析':'Companion handicap analysis'):(zh?'让球分析':'Handicap analysis')} {h.handicapLineText}</span><strong>{handicapTitle(h.tipCode,zh)}</strong></div>
      <span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'待赛果':'Pending')}</span></header>
    <p>{handicapNarrative(d,zh)}</p>{pass&&<small className="rc-handicap__warning">{zh?'顶部延伸：不追让球。同向备选仅供比较，不是新增推荐；以下完整三项概率及赛果保留原记录，用于风险诊断和复盘。':'Top extension: pass the handicap. Aligned alternatives are comparisons, not additional picks; the original three-way probabilities and results remain for risk diagnosis and review.'}</small>}{h.probabilityBasis==='conditional-on-straight-primary'&&<small className="rc-handicap__basis">{zh?'以下三项为“胜平负首选成立”条件下的净胜球占比，不是独立HHAD命中率。':'The three shares below are conditional on the 1X2 thesis landing; they are not standalone HHAD hit probabilities.'}</small>}{h.overallTipCode&&h.overallTipCode!==h.tipCode&&<small className="rc-handicap__diagnostic">{zh?'独立HHAD全局最高项':'Standalone HHAD top'}：{handicapTitle(h.overallTipCode,zh)} · {zh?'未作为伴随首选':'not used as companion pick'}</small>}{h.historicalCalibration?.applied&&<small className="rc-handicap__learned">{zh?'历史盘口校准已启用':'Historical handicap calibration active'} · {h.historicalCalibration.key}</small>}
    <div className="rc-handicap__probabilities">{(['1','X','2'] as const).map(code=><div key={code} className={code===h.tipCode?'is-selected':''}><span>{handicapTitle(code,zh)}</span><strong>{(h.probabilities[code]*100).toFixed(1)}%</strong></div>)}</div>
    <div className="rc-handicap__meta"><span>{h.probabilityBasis==='conditional-on-straight-primary'?(zh?'条件卡盘占比':'Conditional land-on-line share'):(zh?'卡盘概率':'Land on line')} {(h.landOnLineProbability*100).toFixed(1)}%</span><span>{zh?'对应净胜球':'Exact margin'} {h.exactMargin>0?'+':''}{h.exactMargin}</span>
      {h.marketReference?.selectedOdds&&<span>{zh?'让球SP':'HHAD SP'} {h.marketReference.selectedOdds.toFixed(2)}</span>}</div>
  </section>;
}
function PrimaryPickHeader({d,language}:{d:Decision;language:Language}){
  const zh=language==='zh',summary=primarySelectionSummary(d),h=summary.handicap,extension=h?handicapExtensionText(h,language):null;
  return <div className="rc-primary-picks" aria-label={zh?'胜平负首选与让球延伸':'Primary 1X2 pick and handicap extension'}>
    <div className="rc-primary-pick rc-primary-pick--had"><span>{zh?'胜平负首选':'1X2 primary'}</span><strong>{title(summary.had.code,zh)}</strong><small>SP {summary.had.odds.toFixed(2)} · {(summary.had.probability*100).toFixed(1)}%</small></div>
    <span className="rc-primary-divider" aria-hidden="true">｜</span>
    <div className={`rc-primary-pick rc-primary-pick--hhad${h?.status==='pass'?' is-pass':''}`} data-handicap-extension={h?.status??'unavailable'}><span>{zh?'让球延伸':'Handicap extension'}</span>{extension?<><strong>{extension.title}</strong><small>{extension.detail}</small></>:<><strong>—</strong><small>{zh?'等待有效让球线与净胜球数据':'Awaiting valid handicap inputs'}</small></>}</div>
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
function Pick({d,settlement,handicapSettlement,quality,language,onSelectMatch,reviewSelection}:{d:Decision;settlement:Settlement;handicapSettlement?:Settlement|null;quality?:SelectionQuality|null;language:Language;onSelectMatch:(id:string)=>void;reviewSelection?:ReviewedSingleRow}){
  const zh=language==='zh';
  const selected=reviewSelection?.selectedMarket==='HHAD'?reviewSelection.selectedSettlement:settlement;
  return <article className="rc-pick" data-decision-id={d.decisionId} data-record-hash={d.recordHash}><header><span>{d.matchNo||d.sourceMatchId} · {format(d.kickoffTime,language)}</span><span className={`rc-state rc-state--${selected?.state||'PENDING'}`}>{selected?resultLabel(selected.state,zh):(zh?'待赛果':'Pending')}</span></header>
    <div className="rc-pick__main"><h3 className="rc-team-matchup"><FrozenMatchTeams d={d}/></h3>{settlement.score&&<span className="rc-match-score" aria-label={zh?'90分钟赛果':'90-minute result'}>{settlement.score.replace('-', ' : ')}</span>}</div>
    {reviewSelection&&<div className="rc-review-selection"><span>{reviewSelection.selectedMarket==='HHAD'?(zh?'归档让球方向诊断 · 非单场发布推荐':'Archived handicap diagnostic · not a published single pick'):(zh?'已发布胜平负方向':'Published 1X2 pick')}</span><strong>{reviewSelection.selectedMarket==='HHAD'&&d.handicapAnalysis?handicapTitle(d.handicapAnalysis.tipCode,zh):title(d.tipCode,zh)}</strong><small>{reviewSelection.selectedOdds==null?(zh?'冻结SP缺失':'Frozen SP unavailable'):`SP ${reviewSelection.selectedOdds.toFixed(2)}`}</small>{reviewSelection.selectedMarket==='HHAD'&&d.handicapAnalysis?.probabilityBasis==='conditional-on-straight-primary'&&<small className="rc-review-selection__basis">{zh?'此方向以胜平负首选成立为条件，可能不同于完整让球概率最高项。':'This companion is conditional on the 1X2 pick and may differ from the unconditional handicap leader.'}</small>}</div>}
    <PrimaryPickHeader d={d} language={language}/>
    <SelectionQualityNote quality={quality} language={language}/>
    <FollowButton matchId={d.matchId} decisionId={d.decisionId} compact />
    <div className="rc-card-footer"><span>{zh?'发布于':'Published'} {format(d.publishedAt,language)}</span><button type="button" className="rc-match-link" onClick={()=>onSelectMatch(d.matchId)}>{zh?'比赛详情':'Match details'}<ArrowUpRight size={14} aria-hidden="true"/></button></div>
    <details className="rc-analysis"><summary><span>{zh?'概率与让球分析':'Probabilities & handicap analysis'}</span><ChevronDown size={16} aria-hidden="true"/></summary><div className="rc-analysis__body">
      <MarketComparison decision={d} language={language}/>
      <HandicapBlock d={d} settlement={handicapSettlement} language={language}/>
    </div></details>
    <RecordDetails d={d} language={language} onSelectMatch={onSelectMatch}/>
  </article>;
}
function ComboCard({combo,settlement,language,onSelectMatch,reviewSelection}:{combo:Combo;settlement?:Settlement;language:Language;onSelectMatch:(id:string)=>void;reviewSelection?:ReviewedComboRow}){
  const zh=language==='zh';
  return <article className="rc-combo"><header><div><small>{zh?'每日精选':'Daily selection'}</small><h3>{combo.size}{zh?'串1':'-leg combo'}</h3></div><div><strong>SP {combo.totalOdds.toFixed(2)}</strong><small>{zh?'下限':'Minimum'} {combo.size===2?'2.50':'5.00'}</small></div></header>
    <div className="rc-combo__status"><span className={`rc-state rc-state--${settlement?.state||'PENDING'}`}>{settlement?resultLabel(settlement.state,zh):(zh?'即时方案 · 未冻结':'Preview · not frozen')}</span>{reviewSelection&&<span>{reviewSelection.selectedMarket==='MIXED'?(zh?'混合玩法':'Mixed markets'):reviewSelection.selectedMarket==='HHAD'?(zh?'让球胜平负':'Handicap 1X2'):(zh?'胜平负':'1X2')}</span>}<span>{combo.frozenAt?(zh?'冻结':'Frozen'):(zh?'计划冻结':'Freeze at')} {format(combo.frozenAt||combo.freezeAt,language)}</span></div>
    {combo.legs.map((leg,index)=>{const pick=comboLegSelection(combo,index),handicap=pick.market==='HHAD',result=settlement?.legs?.find(l=>l.decisionId===leg.decisionId);return <section className="rc-combo__leg" key={leg.decisionId}><div className="rc-leg-heading"><span className="rc-leg-number">{index+1}</span><div><strong className="rc-team-matchup"><FrozenMatchTeams d={leg}/></strong><small>{leg.matchNo||leg.sourceMatchId} · {format(leg.kickoffTime,language)}</small></div><strong className="rc-leg-pick"><span className={`rc-market-label${handicap?' rc-market-label--hhad':''}`}>{handicap?(zh?'让球胜平负':'Handicap 1X2'):(zh?'胜平负':'1X2')}{handicap?` ${pick.handicapLine>0?'+':''}${pick.handicapLine}`:''}</span><span>{handicap?handicapTitle(pick.tipCode,zh):title(pick.tipCode,zh)} <small>SP {pick.odds.toFixed(2)}</small></span></strong></div>
      <div className="rc-leg-meta"><span>{quoteSourceLabel(pick,language)}</span><span>{zh?'SP采集':'SP observed'} {format(pick.quoteObservedAt,language)}</span>{result&&<span>{result.score||'—'} · {resultLabel(result.state,zh)}</span>}</div>
      <RecordDetails d={leg} selection={combo.selections?.[index]} language={language} onSelectMatch={onSelectMatch}/></section>;})}
    <p className="rc-disclaimer">{zh?'可混合胜平负与让球胜平负，每场只选一腿；模型仍在验证，未将单场概率相乘作为真实串关命中率。':'1X2 and handicap 1X2 may be mixed, with one leg per match. The model remains unvalidated; multiplying single probabilities does not establish a real combo hit rate.'}</p>
  </article>;
}
function Stats({value,zh,scoped=false,diagnostic=false}:{value:Summary|undefined;zh:boolean;scoped?:boolean;diagnostic?:boolean}){return <section className="rc-stats-wrap" aria-label={zh?'历史表现汇总':'Historical performance summary'}><div className="rc-stats-heading"><strong>{diagnostic?(zh?'归档让球方向诊断':'Archived handicap direction review'):(zh?'历史表现':'Historical performance')}</strong><small>{diagnostic?(zh?'v2/v3 为胜平负首选成立后的伴随方向；非独立让球概率，也非单场已发布推荐命中率':'v2/v3 is conditional on the 1X2 pick; this is neither the independent handicap probability nor published single-pick performance'):scoped?(zh?'按当前玩法与版本统计 · 日期、状态和搜索不改变总体分母':'Current market and version · date, status and search do not alter this cohort'):(zh?'仅已结算计入命中率':'Hit rate uses settled records only')}</small></div><div className="rc-stats">{[
  [zh?'命中率':'Hit rate',value?.hitRate==null?'—':`${(value.hitRate*100).toFixed(1)}%`],
  [zh?'命中 / 已结算':'Won / Settled',value?`${value.won} / ${value.settled}`:'—'],[zh?'待赛果':'Pending results',value?.pending??'—'],
  [zh?'已发布':'Published',value?.published??'—'],[zh?'待核 / 无效':'Disputed / Void',value?`${value.disputed} / ${value.void}`:'—'],
].map(([label,v],index)=><div key={label} className={index===0?'is-primary':undefined}><span>{label}</span><strong>{v}</strong></div>)}</div></section>;}
function ReviewWindows({seven,thirty,language}:{seven?:Summary;thirty?:Summary;language:Language}){
  const zh=language==='zh';
  return <section className="rc-review-windows" aria-label={zh?'最近7日与30日成绩':'Last seven and thirty day results'}>{[[7,seven],[30,thirty]].map(([days,value])=>{const item=value as Summary|undefined;return <div key={String(days)}><span>{zh?`近${days}日`:`Last ${days} days`}</span><strong>{item?.hitRate==null?'—':`${(item.hitRate*100).toFixed(1)}%`}</strong><small>{zh?'命中 / 已结算':'Won / settled'} {item?`${item.won} / ${item.settled}`:'—'} · {zh?'待赛果':'Pending'} {item?.pending??'—'}</small></div>;})}</section>;
}
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
export function RecommendationCenter({language,onSelectMatch,mode='recommendations',initialTab='single',selectedTab,onTabChange}:Props){
  const {data,loading,failed,authorizationRequired,refresh}=useRecommendationCenter();
  const [localTab,setLocalTab]=useState(initialTab),[,setClockTick]=useState(0);
  const tab=selectedTab??localTab;
  const setTab=(next:RecommendationTab)=>{setLocalTab(next);onTabChange?.(next);setFilters(current=>({...current,market:'ALL',version:'',page:1}));};
  const [filters,setFilters]=useState<{query:string;date:string;market:ReviewMarket;version:string;state:ReviewState;page:number}>({query:'',date:'',market:'ALL',version:'',state:'ALL',page:1});
  const [debouncedQuery,setDebouncedQuery]=useState('');
  const [qualifiedOnly,setQualifiedOnly]=useState(false);
  // The interval wakes an idle page; every data render must use the actual
  // clock. A saved tick can precede a newly received lane timestamp by seconds.
  const now=Date.now();
  useEffect(()=>{const timer=window.setInterval(()=>setClockTick(tick=>tick+1),10000);return ()=>window.clearInterval(timer);},[]);
  useEffect(()=>{const timer=window.setTimeout(()=>setDebouncedQuery(filters.query.trim().normalize('NFKC')),250);return ()=>window.clearTimeout(timer);},[filters.query]);
  const zh=language==='zh',review=mode==='review';
  const modelQuality=data?.review.qualityReport;
  const reviewFilters:ReviewFilters={kind:tab,market:filters.market,date:filters.date,version:filters.version,state:filters.state,q:debouncedQuery,page:filters.page,pageSize:12};
  const reviewPage=useRecommendationReviewPage(reviewFilters,review);
  const summary=review?reviewPage.data?.summary.all:data?.review.statistics[tab==='single'?'single':tab];
  const handicapSummary=data?.review.statistics.handicap;
  const currentDay=data?.businessDate===new Date(now+8*3600000).toISOString().slice(0,10);
  const stale=!currentDay||!data?.inputAsOf||now-Date.parse(data.inputAsOf)>15*60000||data.lanes.publish?.status==='error';
  const reviewDelayed=data?.lanes.settlement?.status==='error';
  const rows=review?tab==='single'?(reviewPage.data?.rows as ReviewedSingleRow[]|undefined)||[]:[]:currentDay?data?.current.filter(row=>!qualifiedOnly||row.selectionQuality?.qualified)||[]:[];
  const size=tab==='two'?2:3;
  const frozen=review?tab==='single'?[]:(reviewPage.data?.rows as ReviewedComboRow[]|undefined)||[]:currentDay?data?.todayCombos.filter(r=>r.combo.size===size)||[]:[];
  const visibleRows=rows,visibleFrozen=frozen;
  const filteredCount=review?reviewPage.data?.total??0:tab==='single'?rows.length:frozen.length;
  const hasFilters=Boolean(filters.query.trim()||filters.date||filters.version)||filters.market!=='ALL'||filters.state!=='ALL';
  const clearFilters=()=>setFilters({query:'',date:'',market:'ALL',version:'',state:'ALL',page:1});
  const comboFresh=comboLaneFresh(data,now);
  const preview=!review&&!frozen.length?comboPreviewForSize(data,size,now,failed):undefined;
  const comboCandidates=data?.lanes.combos?.candidateCount;
  const comboUnavailable=failed||!comboFresh;
  const expired=(stamp:string|null|undefined)=>{const observed=Date.parse(stamp||'');return Number.isFinite(observed)&&now-observed>15*60000;};
  const expiredPreviewQuote=data?.previews.filter(c=>c.size===size).some(c=>c.legs.some((leg,index)=>now<Date.parse(leg.cutoffTime)&&expired(comboLegSelection(c,index).quoteObservedAt)));
  const allCurrentQuotesExpired=Boolean(data?.current.length)&&!data!.previews.some(c=>c.size===size)&&data!.current.every(row=>expired(row.decision.quoteObservedAt));
  const quoteExpired=currentDay&&(expired(data?.lanes.combos?.inputAsOf??data?.inputAsOf)||expiredPreviewQuote||allCurrentQuotesExpired);
  const comboWaitingMessage=failed?(zh?'连接恢复中，等待重新读取组合；已冻结记录仍然保留。':'Reconnecting to reload combos; frozen records are retained.'):!currentDay?(zh?'正在等待今天的赛前数据；新报价到达后自动重算，已冻结的历史记录仍可复盘。':'Waiting for today’s pre-match data. New quotes will trigger recalculation; frozen history remains available.'):quoteExpired?(zh?'报价已超过15分钟有效期，等待新报价后自动重算；已冻结记录仍然保留。':'Quotes are older than the 15-minute limit. Combos will recalculate after fresh quotes arrive; frozen records are retained.'):data?.lanes.combos?.errorCode==='SOURCE_STALE'?(zh?'当前报价未通过新鲜度校验（有效期15分钟），等待新报价后自动重算；已冻结记录仍然保留。':'Current quotes failed freshness checks (15-minute limit). Waiting for fresh quotes to recalculate; frozen records are retained.'):(zh?'串关数据正在更新，等待新报价后自动重算；已冻结记录仍然保留。':'Combo data is updating. Waiting for fresh quotes to recalculate; frozen records are retained.');
  const activeInputs=tab==='single'?data?.inputAsOf:data?.lanes.combos?.inputAsOf??data?.inputAsOf;
  return <section className="recommendation-center" aria-labelledby="rc-title">
    <header className="rc-heading"><div><span className="rc-eyebrow">{zh?'比赛日 '+(data?.businessDate||'—'):'MATCH DAY '+(data?.businessDate||'—')}</span><h1 id="rc-title">{review?(zh?'赛后复盘':'Result Review'):(zh?'今日推荐':'Today’s Recommendations')}</h1><p>{review?(zh?'查看真实赛果，复盘每一次选择。':'Review every selection against actual results.'):(zh?'先看比赛与方向，再看选择依据。':'Start with the match and pick, then explore the evidence.')}</p></div><button type="button" className="rc-refresh" onClick={()=>{refresh();if(review)reviewPage.refresh();}} disabled={loading||reviewPage.loading} aria-label={zh?'刷新推荐与复盘':'Refresh recommendations and review'}><RefreshCw size={16} aria-hidden="true"/>{loading||reviewPage.loading?(zh?'更新中':'Updating'):(zh?'刷新':'Refresh')}</button></header>
    <div className="rc-meta"><span className="rc-reference-label">{zh?'参考推荐 · 模型验证中':'Reference picks · Model unvalidated'}</span><span>{zh?'行情更新':'Inputs updated'} {format(activeInputs,language)}</span><span>{zh?'赛果核对':'Results checked'} {format(data?.resultAsOf,language)}</span></div>
    <div className="rc-tabs" role="group" aria-label={zh?'推荐类型':'Recommendation type'}>{(['single','two','three'] as const).map(t=><button key={t} type="button" aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='single'?(zh?'单场推荐':'Singles'):t==='two'?(zh?'2串1':'2-leg combo'):(zh?'3串1':'3-leg combo')}{t!=='single'&&<small>SP≥{t==='two'?'2.50':'5.00'}</small>}</button>)}</div>
    {!review&&tab==='single'&&<DayCoverage coverage={data?.coverage} businessDate={data?.businessDate||''} qualifiedOnly={qualifiedOnly} onQualifiedOnlyChange={setQualifiedOnly} onSelectMatch={onSelectMatch} language={language}/>}
    <Stats value={summary} zh={zh} scoped={review} diagnostic={review&&tab==='single'&&filters.market==='HHAD'}/>{review&&<ReviewWindows seven={reviewPage.data?.summary.windows.last7} thirty={reviewPage.data?.summary.windows.last30} language={language}/>} {tab==='single'&&modelQuality&&<div className="rc-empty" data-model-quality="unvalidated"><strong>{zh?'模型仍在验证中':'Model validation in progress'}</strong><p>{zh?'同场比较：模型':'Same-event comparison: model'} {modelQuality.hitRate==null?'—':`${(modelQuality.hitRate*100).toFixed(1)}%`} · {zh?'市场热门':'Market favorite'} {modelQuality.marketTopHitRate==null?'—':`${(modelQuality.marketTopHitRate*100).toFixed(1)}%`} · {modelQuality.settled}{zh?'场已结算':' settled'}</p><small>{zh?`目前覆盖 ${modelQuality.independentMatchDays} 个有赛果竞彩日；评估要求至少 ${modelQuality.minimumSettled} 场、${modelQuality.minimumMatchDays} 日，并优于同场市场概率。缺赛果不计入命中率，当前报告不是独立回测。`:`${modelQuality.independentMatchDays} settled match days; review requires ${modelQuality.minimumSettled} events, ${modelQuality.minimumMatchDays} days and better probability metrics than the same-event market. Missing results are excluded; this is observational, not a held-out backtest.`}</small></div>}{review&&tab==='single'&&<details className="rc-review-insights"><summary><div><strong>{zh?'让球复盘与模型校准':'Handicap review & calibration'}</strong><span>{zh?'按版本查看命中率、样本分母与验证结果':'Compare versions, denominators and validation results'}</span></div><ChevronDown size={18} aria-hidden="true"/></summary><div className="rc-review-insights__body"><HandicapPerformance breakdown={data?.review.statistics.handicapBreakdown} legacy={handicapSummary} zh={zh}/><HandicapCalibrationPanel profile={data?.review.handicapCalibration} language={language}/></div></details>}
    {authorizationRequired||review&&reviewPage.authorizationRequired?<p className="rc-notice" role="alert">{zh?'请使用网站访问权限重新登录。':'Please sign in with your website access.'}</p>:review&&reviewPage.failed&&!reviewPage.data?<p className="rc-notice" role="alert">{zh?'当前筛选读取失败，不能把缺失数据记为零成绩；请重试。':'This review filter failed to load. Missing data is not zero performance; please retry.'}</p>:failed||review&&reviewPage.failed?<p className="rc-notice" role="status">{zh?'连接恢复中；保留上次已发布记录，不将读取失败显示为零成绩。':'Reconnecting. Retaining the last published records; errors do not reset statistics.'}</p>:null}
    {!review&&!loading&&(tab==='single'?stale:!comboFresh||quoteExpired)&&<p className="rc-notice" role="status">{tab!=='single'?comboWaitingMessage:(zh?'当前显示已发布快照，行情更新延迟；旧快照不作为新串关输入。':'Published snapshots are retained while inputs are delayed; old snapshots do not create new combos.')}</p>}
    {reviewDelayed&&<p className="rc-notice">{zh?'赛果核对正在恢复，新推荐发布不受此任务影响。':'Result verification is recovering; recommendation publication is independent.'}</p>}
    {!review&&tab==='single'&&rows.length>0&&rows.every(row=>!row.decision.handicapAnalysis)&&<p className="rc-notice" role="status">{zh?'让球分析等待包含进球期望与盘口的新数据，更新后自动显示；旧冻结记录保留原内容。':'Handicap analysis will appear automatically when goal estimates and handicap lines arrive. Existing frozen records retain their original content.'}</p>}
    {(data?.excludedCorruptRecords||0)>0&&<p className="rc-notice">{zh?'有记录正在单独核验，当前统计不包含这些记录。':'Some records are quarantined for verification and excluded from these statistics.'}</p>}
    {review&&<section className="rc-review-tools" aria-label={zh?'复盘明细筛选':'Review detail filters'}><div className="rc-filters">
      <label className="rc-search"><Search size={17} aria-hidden="true"/><span className="rc-sr-only">{zh?'搜索球队或比赛编号':'Search team or match number'}</span><input type="search" value={filters.query} placeholder={zh?'搜索球队或比赛编号':'Search team or match number'} onChange={event=>setFilters(current=>({...current,query:event.target.value,page:1}))}/></label>
      <label className="rc-status-filter"><span>{zh?'竞彩日':'Match day'}</span><input type="date" value={filters.date} onChange={event=>setFilters(current=>({...current,date:event.target.value,page:1}))}/></label>
      <label className="rc-status-filter"><span>{zh?'玩法':'Market'}</span><select value={filters.market} onChange={event=>setFilters(current=>({...current,market:event.target.value as ReviewMarket,version:'',page:1}))}><option value="ALL">{tab==='single'?(zh?'胜平负基线':'1X2 baseline'):(zh?'全部玩法':'All markets')}</option>{tab!=='single'&&<option value="HAD">{zh?'胜平负':'1X2'}</option>}<option value="HHAD">{tab==='single'?(zh?'归档让球方向诊断':'Archived handicap diagnostic'):(zh?'让球胜平负':'Handicap 1X2')}</option>{tab!=='single'&&<option value="MIXED">{zh?'混合玩法':'Mixed markets'}</option>}</select></label>
      <label className="rc-status-filter"><span>{zh?'模型版本':'Model version'}</span><select value={filters.version} onChange={event=>setFilters(current=>({...current,version:event.target.value,page:1}))}><option value="">{zh?'全部版本':'All versions'}</option>{reviewPage.data?.versions.map(item=><option key={item.key} value={item.key}>{item.label} ({item.count})</option>)}</select></label>
      <label className="rc-status-filter"><span>{zh?'结算状态':'Result status'}</span><select value={filters.state} onChange={event=>setFilters(current=>({...current,state:event.target.value as ReviewState,page:1}))}><option value="ALL">{zh?'全部状态':'All results'}</option>{(['WON','LOST','PENDING','DISPUTED','VOID'] as const).map(state=><option key={state} value={state}>{resultLabel(state,zh)}</option>)}</select></label>
      {hasFilters&&<button type="button" className="rc-clear" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}
    </div><p className="rc-results-count" aria-live="polite">{!reviewPage.data?(reviewPage.loading?(zh?'正在查询当前筛选…':'Loading this filter…'):reviewPage.failed?(zh?'当前筛选读取失败，条数不可用。':'Filter failed; count unavailable.'):(zh?'正在等待复盘数据。':'Awaiting review data.')):(zh?`共 ${filteredCount} 条${hasFilters?'符合条件的':''}明细 · 第 ${filters.page} 页，每页 ${reviewFilters.pageSize} 条`:`${filteredCount} matching records · page ${filters.page}, ${reviewFilters.pageSize} per page`)}</p></section>}
    {(review?reviewPage.loading&&!reviewPage.data:loading&&!data)?<div className="rc-empty" role="status">{zh?'正在读取推荐与复盘…':'Loading recommendations and review…'}</div>:review&&!reviewPage.data?<div className="rc-empty" role="alert"><strong>{zh?'复盘暂不可用':'Review unavailable'}</strong><p>{zh?'当前筛选没有取得有效台账；请刷新重试。':'This filter has no verified ledger response. Refresh to retry.'}</p><button type="button" className="rc-link" onClick={reviewPage.refresh}>{zh?'重试读取':'Retry'}</button></div>:tab==='single'?
      <div className="rc-picks">{visibleRows.length?visibleRows.map(row=><Pick key={row.decision.decisionId} d={row.decision} settlement={row.settlement} handicapSettlement={row.handicapSettlement} quality={row.selectionQuality} language={language} onSelectMatch={onSelectMatch} reviewSelection={review?row as ReviewedSingleRow:undefined}/>):<div className="rc-empty"><strong>{review?(zh?'此条件暂无复盘记录':'No review records for these filters'):(zh?'暂时没有可展示的推荐':'No recommendations yet')}</strong><p>{review?(zh?'调整竞彩日、玩法、模型版本或结算状态再试。':'Try another day, market, model version or result status.'):(zh?'有效赛前数据到达后会自动更新，已冻结的历史记录继续保留。':'Eligible pre-match data will update automatically. Existing frozen records are retained.')}</p>{review&&hasFilters&&<button type="button" className="rc-link" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}</div>}</div>:
      <div className="rc-combos">{visibleFrozen.map(row=><ComboCard key={row.combo.id} combo={row.combo} settlement={row.settlement} language={language} onSelectMatch={onSelectMatch} reviewSelection={review?row as ReviewedComboRow:undefined}/>)}{preview&&<ComboCard combo={preview} language={language} onSelectMatch={onSelectMatch}/>}{!visibleFrozen.length&&!preview&&<div className="rc-empty"><strong>{review&&hasFilters?(zh?'没有符合条件的串关':'No matching combos'):(zh?'暂无可展示的组合':'No combo to show')}</strong><p>{review?(hasFilters?(zh?'试试其他球队名称，或选择全部结算状态。':'Try another team or select all result states.'):(zh?'暂无该类型的冻结复盘记录。':'No frozen review records for this size.')):
        comboUnavailable||quoteExpired?comboWaitingMessage:
        typeof comboCandidates==='number'&&comboCandidates<size?(zh?`当前可用${comboCandidates}场，${size}串1需要${size}场不同比赛。新场次到达后自动重算。`:`${comboCandidates} valid matches available; this combo requires ${size} distinct matches.`):
        (zh?`今日无合格组合。仅使用球队样本与模型输入已核验的参考方向；当前可用${comboCandidates??'—'}场，胜平负及让球首选尚未组成满足SP≥${size===2?'2.50':'5.00'}的${size}串1；不会改选第二方向凑SP。`:`No qualifying combo today. The available 1X2 and handicap primary picks do not form a ${size}-leg combination with SP≥${size===2?'2.50':'5.00'}; secondary directions are not substituted.`)}</p>{review&&hasFilters&&<button type="button" className="rc-link" onClick={clearFilters}>{zh?'清除筛选':'Clear filters'}</button>}</div>}</div>}
    {review&&(reviewPage.data?.pageCount||0)>1&&<nav className="rc-pagination" aria-label={zh?'复盘分页':'Review pages'}><button type="button" disabled={filters.page<=1||reviewPage.loading} onClick={()=>setFilters(current=>({...current,page:current.page-1}))}>{zh?'上一页':'Previous'}</button><span>{zh?`第 ${filters.page} / ${reviewPage.data?.pageCount} 页`:`Page ${filters.page} / ${reviewPage.data?.pageCount}`}</span><button type="button" disabled={filters.page>=(reviewPage.data?.pageCount||0)||reviewPage.loading} onClick={()=>setFilters(current=>({...current,page:current.page+1}))}>{zh?'下一页':'Next'}</button></nav>}
    <footer className="rc-footnote">{zh?'单场每场统计截止前最后一个真实发布版本；串关统计冻结时绑定的版本，两者不混算。未结算不记为未命中。':'Single statistics use the last actually published version before cutoff; combos use their bound frozen versions. Pending results are not losses.'}{review&&reviewPage.data?` ${zh?'当前筛选共有':'Filtered ledger has'} ${reviewPage.data.total}${zh?'条，按页读取完整台账。':' records, loaded page by page.'}`:''}</footer>
  </section>;
}
