import type { LeagueBaselineDirections as Data } from '../../services/recommendationCenterView';
export function LeagueBaselineDirections({data,language,now,failed}:{data?:Data;language:'zh'|'en';now:number;failed:boolean}){
 const zh=language==='zh',today=new Date(now+8*3600000).toISOString().slice(0,10);
 const records=!failed&&data?.businessDate===today?data.records:[];
 return <section className="rc-paper" aria-label={zh?'球队基线方向':'Team baseline directions'}>
  <header><h2>{zh?'球队基线方向':'Team baseline directions'}</h2><small>{zh?'已训练 · 参考 · 未校准':'Trained · Reference · Uncalibrated'}</small></header>
  {records.length?<div className="rc-paper__records">{records.map(r=><article key={r.id} className="rc-paper__record" data-model-hash={r.modelHash}>
   <strong>{r.homeTeamName} vs {r.awayTeamName}</strong><div className="rc-paper__direction"><strong>{r.direction?{1:zh?'主胜':'Home',X:zh?'平局':'Draw',2:zh?'客胜':'Away'}[r.direction]:zh?'观望':'Watch'}</strong>{now>=Date.parse(r.cutoffAt)&&<small>{zh?'已截止 · 冻结记录':'Closed · Frozen record'}</small>}</div>
   <details><summary>{zh?'依据':'Evidence'}</summary><p>{zh?'球队历史训练参数计算；赔率未进入基础概率。伤停、预计首发、体能、xG、天气尚未作为训练特征。':'Calculated from trained team-history parameters. Market prices do not enter baseline probabilities; optional team factors are not fitted.'}</p>
    <p>{(['1','X','2'] as const).map(k=>`${{1:zh?'胜':'H',X:zh?'平':'D',2:zh?'负':'A'}[k]} ${(r.had[k]*100).toFixed(1)}%`).join(' · ')}</p>
    <p>{zh?'比分参考':'Score reference'} {r.scoreTop3.map(s=>`${s.home}-${s.away} ${(s.probability*100).toFixed(1)}%`).join(' · ')}</p>
    <small>{r.modelVersion} · {r.modelHash.slice(0,12)}<br/>{zh?'参数':'Parameters'} {r.parametersHash.slice(0,12)}</small>
   </details>
  </article>)}</div>:<p role="status">{failed?(zh?'球队基线读取失败。':'Team baseline unavailable.'):(zh?'等待已注册参数、球队身份与当天有效报价。':'Awaiting registered parameters, team identity and valid prices for today.')}</p>}
 </section>;
}
