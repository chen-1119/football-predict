import type { PrdPaperDirectionsData, PrdPaperDirection } from '../../services/recommendationCenterView';
import { prdPaperQuoteIsCurrent } from '../../services/recommendationCenterView';

type Language='zh'|'en';
const direction=(record:PrdPaperDirection,zh:boolean):string=>{
  const pick=record.paperPrimary;if(!pick)return zh?'观望':'Watch';
  const label=pick.market==='HAD'
    ?{ '1':zh?'主胜':'Home win',X:zh?'平局':'Draw','2':zh?'客胜':'Away win' }[pick.tipCode]
    :{ '1':zh?'让胜':'Handicap home win',X:zh?'让平':'Handicap draw','2':zh?'让负':'Handicap away win' }[pick.tipCode];
  return pick.market==='HAD'?label:`${zh?'主队':'Home'} ${pick.handicapLine>0?'+':''}${pick.handicapLine} · ${label}`;
};
const time=(value:string,language:Language)=>new Intl.DateTimeFormat(language==='zh'?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
export function PrdPaperDirections({data,language,now,loading=false,failed=false}:{data?:PrdPaperDirectionsData;language:Language;now:number;loading?:boolean;failed?:boolean}){
  const zh=language==='zh',today=new Date(now+8*3600000).toISOString().slice(0,10),currentDay=data?.businessDate===today;
  const records=currentDay?data?.records??[]:[],status=failed?'read-unavailable':loading&&!data?'loading':currentDay?data?.status??'awaiting-inputs':'awaiting-inputs';
  return <section className="rc-paper" aria-label={zh?'PRD纸面方向':'PRD paper directions'} data-prd-paper-status={status} data-formal-eligible="false">
    <header><div><h2>{zh?'纸面方向':'Paper directions'}</h2><small>{zh?'纸面 · 未校准':'Paper · uncalibrated'}{status==='blocked'?(zh?' · 更新待验':' · Update pending checks'):''}</small></div>{currentDay&&data&&<span>{zh?'记录更新':'Records updated'} {time(data.updatedAt,language)}</span>}</header>
    {failed?<p role="status">{zh?'纸面记录读取失败，等待重新核验。':'Paper records could not be loaded. Awaiting a verified response.'}</p>:records.length?<div className="rc-paper__records">{records.map(record=>{
      const pick=record.paperPrimary,open=status==='paper-recorded'&&prdPaperQuoteIsCurrent(record,now);
      return <article key={record.id} className="rc-paper__record" data-paper-market={pick?.market??'watch'}>
        <div><strong>{record.homeTeamName} <span>vs</span> {record.awayTeamName}</strong><small>{time(record.eventVersion,language)}</small></div>
        <div className="rc-paper__direction"><small>{pick?.market==='HHAD'?(zh?'让球胜平负':'Handicap 1X2'):(pick?zh?'胜平负':'1X2':zh?'本场纸面观察':'Paper observation')}</small><strong>{direction(record,zh)}</strong>{pick&&<small>{open?'SP':zh?'冻结 SP':'Frozen SP'} {pick.sp.toFixed(2)}</small>}</div>
        <details><summary>{zh?'依据':'Evidence'}</summary><p>{zh?'球队模型概率与同一玩法报价比较，通过两项价格门槛后记录；未完成校准及样本外验证。':'Team-model probabilities are compared with prices in the same market. Records pass both price gates; calibration and held-out validation remain incomplete.'}</p>{pick?<p>{zh?'模型估计':'Model estimate'} {(pick.probability*100).toFixed(1)}% · {zh?'市场去水':'De-vigged market'} {(pick.marketProbability*100).toFixed(1)}% · {zh?'概率差':'Edge'} {(pick.edge*100).toFixed(1)}pp · {zh?'模型 EV':'Model EV'} {(pick.expectedValue*100).toFixed(1)}%</p>:<p>{record.selectionStatus==='watch-ev-tie'?(zh?'候选估值相同，本场观望。':'Candidates have equal estimated value. Watch this match.'):(zh?'没有方向同时通过两项价格门槛，本场观望。':'No direction passed both price gates. Watch this match.')}</p>}<small>{zh?'封存于':'Recorded at'} {time(record.paperCommitObservedAt,language)}{!open&&pick?(zh?' · 仅保留纸面记录':' · Archived paper record'):''}</small></details>
      </article>;
    })}</div>:<p role="status">{status==='loading'?(zh?'正在读取纸面方向。':'Loading paper directions.'):status==='blocked'?(zh?'纸面记录暂未通过校验，等待有效输入。':'Paper records have not passed checks. Awaiting valid inputs.'):(zh?'等待当天已核验球队模型与新鲜报价；暂无纸面方向。':'Awaiting a verified team model and fresh prices for today. No paper direction yet.')}</p>}
    {currentDay&&data&&(data.blockedCount>0||data.truncated)&&<small className="rc-paper__coverage">{data.blockedCount>0?(zh?`${data.blockedCount} 场等待有效输入。`:`${data.blockedCount} matches await valid inputs.`):''}{data.truncated?(zh?' 当前仅展示部分纸面记录。':' Only part of the paper ledger is shown.'):''}</small>}
  </section>;
}
