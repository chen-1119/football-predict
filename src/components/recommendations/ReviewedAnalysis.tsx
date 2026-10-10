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
 if(failed||!data?.records.length||data.businessDate>today)return null;
 const historical=data.businessDate<today;
 const archived=historical?data.comboArchive:undefined,comboView=archived?.view??data;
 const size=tab==='three'?3:2,combos=tab==='three'?(comboView.threeCombos??[]):comboView.combos;
 // Display only the combinations already present in this validated view.
 // A closed leg changes its display status, never its frozen direction or SP.
 const saved=combos.filter(c=>c.legs.length===size&&c.legs.every(l=>{
  const record=data.records.find(r=>r.eventId===l.eventId),cutoff=Date.parse(record?.cutoffAt??'');
  return Number.isFinite(cutoff);
 }));
 const closed=(c:typeof saved[number])=>c.legs.some(l=>now>=Date.parse(data.records.find(r=>r.eventId===l.eventId)!.cutoffAt));
 return <section className="rc-paper" aria-label="赛前综合分析" data-publication-hash={data.publicationHash} data-reviewed-business-date={data.businessDate} data-reviewed-history={historical}><header><h2>{tab==='single'?'赛前综合分析':`精选${size}串1`}</h2><small>人工审核 · 未校准参考</small></header>
  <p>{data.businessDate} 竞彩日 · {data.records.length} 场原冻结记录{historical?' · 历史记录，非今日新荐':''}</p>
  {historical&&<p>保留原发布方向与官方 SP；已停售场次仅供历史查看。</p>}
  {archived&&tab!=='single'&&<p>原线上存档：{new Date(archived.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}；展示当时已保存的组合。</p>}
  {tab==='single'?<div className="rc-paper__records">{data.records.map(r=><article className="rc-paper__record" key={r.eventId}><strong>{r.matchNum} {r.homeTeamName} vs {r.awayTeamName}</strong><ReviewedMatchPick record={r} now={now}/></article>)}</div>:<div data-reviewed-combo-size={size}>
   <p>按已发布的单场方向组合；使用发布时官方 SP，非即时价。没有模型命中概率或收益验证。</p>
   {saved.map(c=><article key={c.band} className="rc-paper__record" data-reviewed-combo-band={c.band} data-reviewed-combo-state={historical?'historical':closed(c)?'closed':'open'}>
    <strong>≥{c.band} 档</strong>
    <p>{c.legs.map(l=>`${l.matchNum} ${reviewedLabel(l)} ${reviewedSp(l.sp)}`).join(' × ')} = {c.product}{c.confidence==='低'||c.band>=10?' · 高波动':''}</p>
    {(historical||closed(c))&&<p>{closed(c)?'已停售 · ':''}历史组合，保留原方向与发布报价，不作为当前推荐。</p>}
   </article>)}
   {!saved.length&&<p data-reviewed-combo-empty={size}>{historical?`未找到该竞彩日已保存的原${size}串1组合；不追溯生成新组合。`:`暂无已保存的${size}串1组合；不会改选方向凑赔率。`}</p>}
   {saved.length>0&&combos.filter(c=>!c.legs.length).map(c=><p key={c.band}>≥{c.band} 档：无合适组合。</p>)}
   <p>含相同场次的组合风险集中；组合赔率不等于命中概率。</p>
  </div>}
 </section>;
}
