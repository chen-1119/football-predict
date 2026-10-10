import type { ReviewedAnalysis as Data, ReviewedAnalysisRecord } from '../../services/recommendationCenterView';
const label={h:'主胜',d:'平局',a:'客胜'};
const reviewedSp=(sp:number)=>Number(sp.toFixed(2))===sp?sp.toFixed(2):String(sp);
export const reviewedLabel=(r:{market:'HAD'|'HHAD';handicap?:number;selection:'h'|'d'|'a'})=>r.market==='HHAD'?`${{h:'让胜',d:'让平',a:'让负'}[r.selection]}(${r.handicap!>0?'+':''}${r.handicap})`:label[r.selection];
export function ReviewedMatchPrice({record,language}:{record:ReviewedAnalysisRecord;language:'zh'|'en'}){
 return <><strong className="compact-sp" data-publication-method="reviewed-editorial">{reviewedSp(record.sp)}</strong><small className="compact-sp-note">{language==='zh'?'发布时官方 SP · 非即时价':'Official SP at publication · Not live'}</small></>;
}
export function ReviewedMatchStatus({record,now,language}:{record:ReviewedAnalysisRecord;now:number;language:'zh'|'en'}){
 return now>=Date.parse(record.cutoffAt)?(language==='zh'?'已发布 · 待核赛果':'Published · Result pending'):(language==='zh'?'已发布 · 待开赛':'Published · Upcoming');
}
export function ReviewedMatchPick({record,now}:{record:ReviewedAnalysisRecord;now?:number}){
 return <div className="compact-pick" data-publication-method="reviewed-editorial"><small>赛前综合分析 · 人工审核</small><strong>{reviewedLabel(record)} · SP {reviewedSp(record.sp)}</strong>
  <small>{record.scores.map(s=>s.join('-')).join(' / ')}{typeof now==='number'&&now>=Date.parse(record.cutoffAt)?' · 已截止冻结':''}</small>
  <details><summary>依据</summary><p>{record.reason}</p><p>{record.limitations.join('；')}</p>
   {record.evidence&&<p>已绑定 {record.evidence.hashes.length} 份官方资料，仅单源；未核实：{record.evidence.missing.join('、')}。资料用于人工审核，未作为已训练的概率因子。</p>}
   <a href={record.analysisUrl} target="_blank" rel="noopener noreferrer">赛前分析来源</a><p>发布报价观察：{new Date(record.quoteObservedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}；原分析SP {reviewedSp(record.originalSp)}。比分为方向相容的人工选择，非模型概率前二。</p></details></div>;
}
export function ReviewedAnalysisPanel({data,tab,now,failed}:{data?:Data;tab:string;now:number;failed:boolean}){
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 if(failed||!data?.records.length||data.businessDate!==today)return null;
 const size=tab==='three'?3:2,combos=tab==='three'?(data.threeCombos??[]):data.combos;
 // A view can remain mounted while a leg passes its own sales cutoff. Never
 // turn its sealed publication price into an active/live-price recommendation.
 const active=combos.filter(c=>c.legs.length===size&&c.legs.every(l=>{
  const record=data.records.find(r=>r.eventId===l.eventId),cutoff=Date.parse(record?.cutoffAt??'');
  return Number.isFinite(cutoff)&&now<cutoff;
 }));
 const closed=combos.filter(c=>c.legs.length>0&&!active.includes(c)).length;
 return <section className="rc-paper" aria-label="赛前综合分析" data-publication-hash={data.publicationHash}><header><h2>{tab==='single'?'赛前综合分析':`精选${size}串1`}</h2><small>人工审核 · 未校准参考</small></header>
  {tab==='single'?<div className="rc-paper__records">{data.records.map(r=><article className="rc-paper__record" key={r.eventId}><strong>{r.matchNum} {r.homeTeamName} vs {r.awayTeamName}</strong><ReviewedMatchPick record={r} now={now}/></article>)}</div>:<div data-reviewed-combo-size={size}>
   <p>按已发布的单场方向组合；使用发布时官方 SP，非即时价。没有模型命中概率或收益验证。</p>
   {active.map(c=><article key={c.band} className="rc-paper__record" data-reviewed-combo-band={c.band}>
    <strong>≥{c.band} 档</strong>
    <p>{c.legs.map(l=>`${l.matchNum} ${reviewedLabel(l)} ${reviewedSp(l.sp)}`).join(' × ')} = {c.product}{c.confidence==='低'||c.band>=10?' · 高波动':''}</p>
   </article>)}
   {!active.length&&<p data-reviewed-combo-empty={size}>暂无未截止的{size}串1组合；不会改选方向凑赔率。</p>}
   {closed>0&&<p>已有 {closed} 组包含已截止场次，已从当前组合隐藏；原单场方向与发布报价保留。</p>}
   {active.length>0&&combos.filter(c=>!c.legs.length).map(c=><p key={c.band}>≥{c.band} 档：无合适组合。</p>)}
   <p>含相同场次的组合风险集中；组合赔率不等于命中概率。</p>
  </div>}
 </section>;
}
