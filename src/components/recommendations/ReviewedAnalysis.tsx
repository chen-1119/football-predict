import type { ReviewedAnalysis as Data, ReviewedAnalysisRecord } from '../../services/recommendationCenterView';
const label={h:'主胜',d:'平局',a:'客胜'};
export function ReviewedMatchPick({record,now}:{record:ReviewedAnalysisRecord;now?:number}){
 return <div className="compact-pick" data-publication-method="reviewed-editorial"><small>赛前综合分析 · 人工审核</small><strong>{label[record.selection]} · SP {record.sp.toFixed(2)}</strong>
  <small>{record.scores.map(s=>s.join('-')).join(' / ')} · {record.confidence}信心{typeof now==='number'&&now>=Date.parse(record.cutoffAt)?' · 已截止冻结':''}</small>
  <details><summary>依据</summary><p>{record.reason}</p><p>{record.limitations.join('；')}</p><a href={record.analysisUrl} target="_blank" rel="noopener noreferrer">赛前分析来源</a><p>发布报价观察：{new Date(record.quoteObservedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}；原分析SP {record.originalSp.toFixed(2)}。比分为方向相容的人工选择，非模型概率前二。</p></details></div>;
}
export function ReviewedAnalysisPanel({data,tab,now,failed}:{data?:Data;tab:string;now:number;failed:boolean}){
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 if(failed||!data?.records.length||data.businessDate!==today||tab==='three')return null;
 return <section className="rc-paper" aria-label="赛前综合分析" data-publication-hash={data.publicationHash}><header><h2>{tab==='two'?'精选2串1':'赛前综合分析'}</h2><small>人工审核 · 未校准参考</small></header>
  {tab==='single'?<div className="rc-paper__records">{data.records.map(r=><article className="rc-paper__record" key={r.eventId}><strong>{r.matchNum} {r.homeTeamName} vs {r.awayTeamName}</strong><ReviewedMatchPick record={r} now={now}/></article>)}</div>:<div>{data.combos.map(c=><article key={c.band} className="rc-paper__record"><strong>≥{c.band} 档</strong>{c.legs.length?<p>{c.legs.map(l=>`${l.matchNum} ${label[l.selection]} ${l.sp.toFixed(2)}`).join(' × ')} = {c.product?.toFixed(4)} · {c.confidence}信心</p>:<p>无合适组合</p>}</article>)}<p>含相同场次的组合风险集中；组合赔率不等于命中概率。</p></div>}
 </section>;
}
