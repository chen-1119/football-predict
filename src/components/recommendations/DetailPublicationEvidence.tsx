import type { DetailPublication } from '../../services/matchDetailPublication';
export function DetailPublicationEvidence({data,language}:{data:DetailPublication;language:'zh'|'en'}){
 const zh=language==='zh',r=data.reviewed,model=data.trained;
 const stamp=(s:string)=>new Date(s).toLocaleString(zh?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai'});
 return <section data-testid="detail-original-publication" data-business-date={data.businessDate}>
  <h4>{zh?'原赛前发布记录与依据':'Original pre-match publication and evidence'}</h4>
  <p>{data.businessDate} {zh?'竞彩日；保留原方向、发布报价与采用记录。':'match day; original direction, price and adoption record.'}</p>
  {r?<><p>{r.reason}</p><p>{zh?'原记录缺项：':'Original limitations: '}{r.limitations.length?r.limitations.join('；'):(zh?'原记录未列出；不等于资料完整。':'None listed; this does not establish complete evidence.')}</p>
   {r.evidence&&<p>{zh?'原采用证据：':'Adopted evidence: '}{r.evidence.hashes.length} {zh?'份，官方单源；未核实：':'official single-source records; unverified: '}{r.evidence.missing.join('、')}</p>}
   <p>{zh?'官方 SP 观察时间：':'Official SP observed: '}{stamp(r.quoteObservedAt)} · SP {r.sp}</p>
   <a href={r.analysisUrl} target="_blank" rel="noopener noreferrer">{zh?'原赛前分析来源':'Original pre-match source'}</a>
   <p>{zh?'这是人工审核参考，没有可核验的独立模型概率。最新补采资料另列，不作为该历史记录采用证明。':'Editorial reference without a verified independent model probability. Later data is shown separately and does not prove adoption by this record.'}</p></>:model?<><p>{model.modelVersion} · {model.modelHash}</p><p>{zh?'参数：':'Parameters: '}{model.parametersHash}</p>
    <p>{zh?'原球队历史模型记录；未校准。伤停、首发、体能、xG、天气尚未作为已验证权重。':'Original uncalibrated team-history model record. Optional team factors have no verified weights.'}</p></>:null}
  {data.receipts.map(p=><p key={p.track}>{p.track==='manual'?(zh?'审核发布确认：':'Editorial commit acknowledged: '):(zh?'模型采用确认：':'Model adoption acknowledged: ')}{stamp(p.ackAt)}</p>)}
 </section>;
}
