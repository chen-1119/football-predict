import type { DualResearchV2Row, Outcome } from '../../services/recommendationCenterView';
import '../../styles/recommendation-center.css';

type Language = 'zh' | 'en';
const labels: Record<'HAD'|'HHAD', Record<Outcome, [string,string]>> = {
  HAD: { '1':['主胜','Home'], X:['平','Draw'], '2':['客胜','Away'] },
  HHAD: { '1':['让胜','Handicap home'], X:['让平','Handicap draw'], '2':['让负','Handicap away'] },
};

export function DualResearchV2({row,language,onSelectMatch}:{row:DualResearchV2Row;language:Language;onSelectMatch?:(id:string)=>void}){
  const zh=language==='zh';
  const date=(value:string)=>new Intl.DateTimeFormat(zh?'zh-CN':'en-GB',{
    timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,
  }).format(new Date(value));
  const settlement=row.settlement;
  return <article className="rc-dual-research" data-research-id={row.id} data-research-market-pair={row.selections.map(s=>s.market).join('+')}>
    <header><div><small>{zh?'独立研究 · 非正式推荐':'Independent study · not a formal pick'}</small>
      <h3>{row.homeTeamName} <span>vs</span> {row.awayTeamName}</h3></div>
      <span className={`rc-state rc-state--${settlement.state}`}>{settlement.state==='PENDING'?(zh?'待赛果':'Pending'):settlement.state==='WON'?(zh?'至少一项命中':'One or more won'):settlement.state==='LOST'?(zh?'两项均未中':'Both lost'):settlement.state==='VOID'?(zh?'作废':'Void'):(zh?'待核验':'Disputed')}</span></header>
    <div className="rc-dual-research__choices">{row.selections.map((selection,index)=><div key={`${selection.market}:${selection.tipCode}:${index}`}>
      <span>{selection.market==='HHAD'?(zh?'让球胜平负':'Handicap 1X2'):(zh?'胜平负':'1X2')}{selection.market==='HHAD'?` (${selection.handicapLine>0?'+':''}${selection.handicapLine})`:''}</span>
      <strong>{labels[selection.market][selection.tipCode][zh?0:1]}</strong>
      <small>SP {selection.odds.toFixed(2)} · {zh?'模型概率':'Model probability'} {(selection.modelProbability*100).toFixed(1)}%</small>
    </div>)}</div>
    <p>{zh?`双选覆盖概率为模型估计 ${(row.unionProbability*100).toFixed(1)}%，仍待独立验证。两项各计 1 单位，合计 2 单位；按各自 SP 单独结算，不是 2 串 1，SP 不相乘。`:`Estimated combined coverage ${(row.unionProbability*100).toFixed(1)}%, pending independent validation. These are two separate one-unit selections (two units total), settled at each SP, not a parlay.`}</p>
    <footer><span>{zh?'赛前记录':'Recorded before cutoff'} {date(row.recordedAt)}</span>{onSelectMatch&&<button type="button" className="rc-link" onClick={()=>onSelectMatch(row.matchId)}>{zh?'查看比赛':'View match'}</button>}</footer>
  </article>;
}
