import type { ReviewedAnalysis as Data, ReviewedAnalysisRecord, ReviewedRevisions } from '../../services/recommendationCenterView';
import { reviewedLatestRecord, settlementResultLabel } from '../../services/publishedMatchRecommendation';
import { reviewedLabel } from '../../services/reviewedPresentation';
const reviewedSp=(sp:number)=>Number(sp.toFixed(2))===sp?sp.toFixed(2):String(sp);
export function ReviewedMatchPrice({record,language}:{record:ReviewedAnalysisRecord;language:'zh'|'en'}){
 return <><strong className="compact-sp" data-publication-method="reviewed-editorial">{reviewedSp(record.sp)}</strong><small className="compact-sp-note">{language==='zh'?'发布时官方 SP · 非即时价':'Official SP at publication · Not live'}</small></>;
}
export function ReviewedMatchStatus({record,now,language}:{record:ReviewedAnalysisRecord;now:number;language:'zh'|'en'}){
 return now>=Date.parse(record.cutoffAt)?(language==='zh'?'已发布 · 待核赛果':'Published · Result pending'):(language==='zh'?'已发布 · 待开赛':'Published · Upcoming');
}
export function ReviewedMatchPick({record,now}:{record:ReviewedAnalysisRecord;now?:number}){
 return <div className="compact-pick" data-publication-method="reviewed-editorial"><small>赛前综合分析 · 人工审核</small><strong>{reviewedLabel(record)} · SP {reviewedSp(record.sp)}</strong>
  {record.review&&<small data-reviewed-revision={record.review.revision}>复核版 {record.review.revision} · {new Date(record.review.publishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</small>}
  <small>{record.scores.map(s=>s.join('-')).join(' / ')}{typeof now==='number'&&now>=Date.parse(record.cutoffAt)?' · 已截止冻结':''}</small>
  <details><summary>依据</summary><p>{record.reason}</p><p>{record.limitations.join('；')}</p>
   {record.evidence&&<p>已绑定 {record.evidence.hashes.length} 份官方资料，仅单源；未核实：{record.evidence.missing.join('、')}。资料用于人工审核，未作为已训练的概率因子。</p>}
   <a href={record.analysisUrl} target="_blank" rel="noopener noreferrer">赛前分析来源</a><p>发布报价观察：{new Date(record.quoteObservedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}；原分析SP {reviewedSp(record.originalSp)}。比分为方向相容的人工选择，非模型概率前二。</p>
   {record.review&&<p>首版保留：{reviewedLabel(record.review.original)} · SP {reviewedSp(record.review.original.sp)} · 比分 {record.review.original.scores.map(s=>s.join('-')).join(' / ')}。复核版单独结算：{settlementResultLabel(record.review.settlement,'zh')}；不增加独立比赛样本。</p>}</details></div>;
}
export function ReviewedAnalysisPanel({data,revisions,tab,now,failed}:{data?:Data;revisions?:ReviewedRevisions;tab:string;now:number;failed:boolean}){
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 if(failed||!data?.records.length||data.businessDate>today)return null;
 const historical=data.businessDate<today;
 const archived=historical?data.comboArchive:undefined,comboView=archived?.view??data;
 const firstVersion=archived?.firstVersion;
 const size=tab==='three'?3:2,combos=tab==='three'?(comboView.threeCombos??[]):(firstVersion?.combos??comboView.combos);
 // Display only the combinations already present in this validated view.
 // A closed leg changes its display status, never its frozen direction or SP.
 const saved=combos.filter(c=>c.legs.length===size&&c.legs.every(l=>{
  const record=data.records.find(r=>r.eventId===l.eventId),cutoff=Date.parse(record?.cutoffAt??'');
  return Number.isFinite(cutoff);
 }));
 const closed=(c:typeof saved[number])=>data.comboFreeze?.some(f=>f.size===size&&f.band===c.band&&f.frozen)===true||c.legs.some(l=>{const r=data.records.find(r=>r.eventId===l.eventId)!;return now>=Date.parse(r.cutoffAt)||now>=Date.parse(r.eventVersion);});
 return <section className="rc-paper" aria-label="赛前综合分析" data-publication-hash={data.publicationHash} data-reviewed-business-date={data.businessDate} data-reviewed-history={historical}><header><h2>{tab==='single'?'赛前综合分析':`精选${size}串1`}</h2><small>人工审核 · 未校准参考</small></header>
  <p>{data.businessDate} 竞彩日 · {data.records.length} 场原冻结记录{historical?' · 历史记录，非今日新荐':''}</p>
  {historical&&<p>保留原发布方向与官方 SP；已停售场次仅供历史查看。</p>}
  {archived&&tab==='two'&&(firstVersion?<p>首版组合存档 · 按原截图恢复，保留各场原方向与发布报价。</p>:<p>原线上存档：{new Date(archived.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}；展示当时已保存的组合。</p>)}
  {revisions?.state==='unavailable'&&<p role="status">复核版暂时无法核验，当前显示原发布记录。</p>}
  {revisions?.pending!==undefined&&revisions.pending>0&&<p role="status">有复核记录尚缺完整确认回执，未作为新推荐展示。</p>}
  {tab==='single'?<div className="rc-paper__records">{data.records.map(r=><article className="rc-paper__record" key={r.eventId}><strong>{r.matchNum} {r.homeTeamName} vs {r.awayTeamName}</strong><ReviewedMatchPick record={reviewedLatestRecord(r,revisions)} now={now}/>
   {revisions?.singles.some(v=>v.eventId===r.eventId)&&<details><summary>复核历史</summary>{revisions.singles.filter(v=>v.eventId===r.eventId).map(v=><p key={v.key}>复核版 {v.revision}：{reviewedLabel(v.decision)} · SP {reviewedSp(v.decision.sp)} · {v.decision.scores.map(s=>s.join('-')).join(' / ')} · {settlementResultLabel(v.settlement,'zh')}</p>)}</details>}</article>)}</div>:<div data-reviewed-combo-size={size}>
   <p>按已发布的单场方向组合；使用发布时官方 SP，非即时价。没有模型命中概率或收益验证。</p>
   {saved.map(c=><article key={c.band} className="rc-paper__record" data-reviewed-combo-band={c.band} data-reviewed-combo-state={historical?'historical':closed(c)?'closed':'open'}>
    <strong>≥{c.band} 档</strong>
    <p>{c.legs.map(l=>`${l.matchNum} ${reviewedLabel(l)} ${reviewedSp(l.sp)}`).join(' × ')} = {firstVersion&&c.product!==null?c.product.toFixed(4):c.product}{c.confidence==='低'||c.band>=10?' · 高波动':''}</p>
    {(historical||closed(c))&&<p>{closed(c)?'有场次已开赛或已停售 · 整组冻结。 ':''}历史组合，保留原方向与发布报价，不作为当前推荐。</p>}
   </article>)}
   {!saved.length&&<p data-reviewed-combo-empty={size}>{historical?`未找到该竞彩日已保存的原${size}串1组合；不追溯生成新组合。`:`暂无已保存的${size}串1组合；不会改选方向凑赔率。`}</p>}
   {saved.length>0&&combos.filter(c=>!c.legs.length).map(c=><p key={c.band}>≥{c.band} 档：无合适组合。</p>)}
   {revisions?.state==='verified'&&revisions.combos.filter(v=>v.decisions.length===size).map(v=><article key={v.key} className="rc-paper__record" data-reviewed-combo-revision={v.revision}>
    <strong>≥{v.combo.band} 档 · 复核版 {v.revision}</strong><p>{v.combo.legs.map(l=>`${l.matchNum} ${reviewedLabel(l)} ${reviewedSp(l.sp)}`).join(' × ')} = {v.combo.product}</p>
    <p>{v.frozen||v.decisions.some(d=>now>=Date.parse(d.eventVersion))?'已有场次开赛或停售 · 整组冻结，保留本版方向与SP。':'本版已单独封存；全组未开赛且在售时可追加复核版。'} {settlementResultLabel(v.settlement,'zh')}</p>
   </article>)}
   <p>含相同场次的组合风险集中；组合赔率不等于命中概率。</p>
  </div>}
 </section>;
}
