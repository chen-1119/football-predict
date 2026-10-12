'use strict';
// Separate prospective bulletin cohort. Never edits its source decision.
const {hash,day}=require('../../src/services/publishedForecastPolicy.cjs');
const VERSION='jincai-daily-bulletin-v1',CODES=['1','X','2'];
const ms=s=>typeof s==='number'?s:Date.parse(s);
const seal=x=>({...x,contentHash:hash(x)});
const valid=x=>{if(!x||x.version!==VERSION)return false;const {contentHash,...body}=x;return contentHash===hash(body);};
const code=n=>n>0?'1':n<0?'2':'X';
function schedule(now){
  const at=ms(now);if(!Number.isFinite(at))throw Error('Invalid bulletin clock');
  const date=day(at),start=Date.parse(date+'T00:00:00+08:00'),weekend=[0,6].includes(new Date(start+28800000).getUTCDay());
  return {businessDate:date,timezone:'Asia/Shanghai',reviewAt:new Date(start+11*3600000).toISOString(),
    earlyAt:new Date(start+11*3600000).toISOString(),earlyEnd:new Date(start+21.5*3600000).toISOString(),
    featuredAt:new Date(start+(weekend?21:20)*3600000).toISOString(),fullAt:new Date(start+(weekend?22:21)*3600000).toISOString(),
    closeAt:new Date(start+(weekend?23:22)*3600000).toISOString()};
}
function slots(now){const s=schedule(now),at=ms(now);return ['early','featured','full'].filter(k=>at>=ms(s[k+'At'])&&at<ms(k==='early'?s.earlyEnd:s.closeAt));}
function devig(odds){if(!odds||!CODES.every(c=>typeof odds[c]==='number'&&Number.isFinite(odds[c])&&odds[c]>1))return null;
  const sum=CODES.reduce((n,c)=>n+1/odds[c],0);return Object.fromEntries(CODES.map(c=>[c,1/odds[c]/sum]));}
function leader(p){if(!p||!CODES.every(c=>Number.isFinite(p[c])&&p[c]>=0&&p[c]<=1)||Math.abs(CODES.reduce((n,c)=>n+p[c],0)-1)>1e-6)return null;
  return CODES.find(c=>CODES.every(k=>k===c||p[c]>p[k]+1e-12))||null;}
function compatible(score,selection){return code(score.home-score.away+(selection.market==='HHAD'?selection.handicapLine:0))===selection.tipCode;}
function label(s){return s.market==='HAD'?{'1':'胜',X:'平','2':'负'}[s.tipCode]:{'1':'让胜',X:'让平','2':'让负'}[s.tipCode]+`(${s.handicapLine>0?'+':''}${s.handicapLine})`;}
// Missing two-source facts are unknown, never converted into healthy/zero injury.
// No unverified match payload or search snippet can upgrade these fields.
function pick({decision:d,distribution,slot,now,identity,sourceEvidence}){
  const at=ms(now),s=schedule(at),cutoff=Math.min(ms(d?.cutoffTime),ms(d?.kickoffTime),ms(identity?.saleCutoff));
  if(!slots(at).includes(slot)||!d||d.businessDate!==s.businessDate||!(at<cutoff)||at<ms(d.publishedAt)
    ||(slot==='early'&&ms(d.kickoffTime)>ms(s.earlyEnd))||!identity)return null;
  const top=leader(d.probabilities);if(!top)return null;
  const h=d.handicapAnalysis,useHandicap=Number.isSafeInteger(h?.handicapLine)&&h.handicapLine<0&&top!=='1';
  const q=useHandicap?h.marketReference:{odds:d.quoteOdds,observedAt:d.quoteObservedAt,source:d.quoteSource};
  const market=useHandicap?'HHAD':'HAD',line=useHandicap?h.handicapLine:0,tipCode=useHandicap?'2':top;
  const fair=devig(q?.odds),quoteAt=ms(q?.observedAt);
  if(!fair||!(market==='HHAD'?q.source==='sporttery:HHAD':['sporttery:HAD','sporttery:HAD:signed-live'].includes(q.source))||!Number.isFinite(quoteAt)||quoteAt>at||at-quoteAt>900000)return null;
  if(distribution?.status!=='available')return null;
  const selection={market,handicapLine:line,tipCode,odds:q.odds[tipCode]};
  const scores=distribution.topScores.filter(v=>compatible(v,selection)).slice(0,2);
  if(scores.length!==2)return null;
  const p=(useHandicap?distribution.hhadProbabilities:distribution.hadProbabilities)?.[tipCode];
  if(!Number.isFinite(p))return null;
  const evidence=require('./dailySourceEvidence.cjs').facts(sourceEvidence,d,at);
  const known=evidence.filter(f=>f.status==='verified').length;
  const confidence=known>=5?'medium':'low'; // High awaits calibrated confidence bands.
  const opened=evidence.flatMap(f=>f.sources).find(s=>s.preview===true);
  return seal({version:VERSION,kind:'pick',id:'daily-pick-'+hash([VERSION,s.businessDate,slot,d.sourceMatchId,d.eventVersion]),
    businessDate:s.businessDate,slot,publishedAt:new Date(at).toISOString(),cutoffAt:new Date(cutoff).toISOString(),
    sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,homeTeamId:d.homeTeamId,awayTeamId:d.awayTeamId,
    matchNo:d.matchNo||null,homeTeamName:d.homeTeamName,awayTeamName:d.awayTeamName,kickoffTime:d.kickoffTime,
    decisionId:d.decisionId,decisionRecordHash:d.recordHash,modelVersion:d.upstreamModelVersion||'unknown',
    modelBasis:'legacy-mixed-model-reference',formalEligible:false,modelProbability:p,marketProbability:fair[tipCode],
    quoteOdds:q.odds,marketProbabilities:fair,quoteObservedAt:q.observedAt,quoteSource:q.source,
    selection:{...selection,label:label(selection)},hadTendency:top,scores,scoreRule:'top-two-compatible-unconditional-cells',
    goals:distribution.totalGoals||[],confidence,confidenceBasis:known===6?'corroborated-facts-uncalibrated-model':'team-evidence-unverified',evidence,analysisLink:opened?.url||null,
    summary:known>=5?'已核对主要资料；原混合模型赛前参考。':'有资料未核实；仅原混合模型方向参考。',
    comboEligible:known>=4&&Boolean(opened)&&['近5场','积分排名与战意','500交叉核对'].every(n=>evidence.some(f=>f.name===n&&f.status==='verified')),
    sourceEvidenceHash:known?sourceEvidence.contentHash:null,
    valueScreen:p*selection.odds>1.05&&p-fair[tipCode]>0.05,identityHash:hash(identity)});
}
function chooseTiers(picks,now){
  const at=ms(now),candidates=picks.filter(p=>valid(p)&&p.kind==='pick'&&p.comboEligible===true&&p.valueScreen===true
    &&p.businessDate===day(at)&&at<ms(p.cutoffAt)&&at>=ms(p.quoteObservedAt)&&at-ms(p.quoteObservedAt)<=900000);
  const pairs=[];
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const a=candidates[i],b=candidates[j];if(a.sourceMatchId===b.sourceMatchId||new Set([a.homeTeamId,a.awayTeamId,b.homeTeamId,b.awayTeamId]).size!==4)continue;
    // Work in exact hundredths. Compare the unrounded product to each floor.
    const units=[a,b].map(p=>Math.round(p.selection.odds*100));
    if([a,b].some((p,k)=>Math.abs(p.selection.odds*100-units[k])>1e-8))continue;
    const product=units[0]*units[1];if(!Number.isSafeInteger(product))continue;
    pairs.push({legs:[a,b],product,totalOdds:product/10000,key:[a.id,b.id].sort().join('|')});
  }
  const used=new Set();return [2.5,5,10].map(minimum=>{
    const pair=pairs.filter(p=>!used.has(p.key)&&p.product>=minimum*10000&&(minimum>=10||p.legs.every(l=>l.confidence!=='low')))
      .sort((a,b)=>Math.min(...b.legs.map(l=>l.modelProbability))-Math.min(...a.legs.map(l=>l.modelProbability))||a.product-b.product||a.key.localeCompare(b.key))[0];
    if(!pair)return {minimum,status:'unavailable',reason:'缺少有据可核的两场选项',legs:[],totalOdds:null};
    used.add(pair.key);return {minimum,status:'available',legs:pair.legs.map(p=>({id:p.id,contentHash:p.contentHash,homeTeamName:p.homeTeamName,awayTeamName:p.awayTeamName,matchNo:p.matchNo,selection:p.selection})),
      totalOdds:pair.totalOdds,reason:'同日冻结方向；逐腿同市场价值筛选',jointProbability:null};
  });
}
function review(picks,heads,asOf,combos=[]){
  const {key,validResultEvent,settleDecision}=require('./results.cjs');
  const results=new Map(heads.filter(e=>validResultEvent(e)&&ms(e.observedAt)<=ms(asOf)).map(e=>[e.eventKey,e]));
  const seen=new Set(),rows=[],allRows=[];
  for(const p of [...picks].sort((a,b)=>ms(a.publishedAt)-ms(b.publishedAt)||a.id.localeCompare(b.id))){
    if(!valid(p)||p.kind!=='pick')continue;
    const e=results.get(key(p));
    const result=e&&(!e.homeTeamId||!e.awayTeamId)?{state:'DISPUTED',resultEventId:e.eventId}:settleDecision({...p,...p.selection},e);
    const row={id:p.id,businessDate:p.businessDate,slot:p.slot,confidence:p.confidence,market:p.selection.market,...result,
      scoreTop1:['WON','LOST'].includes(result.state)?p.scores[0].label===result.score:null,
      scoreTop2:['WON','LOST'].includes(result.state)?p.scores.some(s=>s.label===result.score):null};
    allRows.push(row);if(!seen.has(key(p))){seen.add(key(p));rows.push(row);}
  }
  const stats=r=>{const settled=r.filter(x=>['WON','LOST'].includes(x.state));const won=settled.filter(x=>x.state==='WON').length;
    return {published:r.length,settled:settled.length,won,hitRate:settled.length?won/settled.length:null,
      scoreTop1:settled.filter(x=>x.scoreTop1).length,scoreTop2:settled.filter(x=>x.scoreTop2).length,
      pending:r.filter(x=>x.state==='PENDING').length,excluded:r.filter(x=>['VOID','DISPUTED'].includes(x.state)).length};};
  const yesterday=day(ms(asOf)-86400000);
  return {definition:'first-prospective-bulletin-per-event; 90min; unknown-excluded',updatedAt:new Date(ms(asOf)).toISOString(),
    previousBusinessDate:yesterday,previous:stats(rows.filter(x=>x.businessDate===yesterday)),cumulative:stats(rows),
    confidence:Object.fromEntries(['high','medium','low'].map(c=>[c,stats(rows.filter(r=>r.confidence===c))])),
    markets:Object.fromEntries(['HAD','HHAD'].map(c=>[c,stats(rows.filter(r=>r.market===c))])),
    versions:Object.fromEntries(['early','featured','full'].map(c=>[c,stats(allRows.filter(r=>r.slot===c))])),
    combos:combos.filter(valid).map(c=>{const legs=c.legs.map(l=>{
      const original=picks.find(p=>p.id===l.id&&p.contentHash===l.contentHash&&hash(p.selection)===hash(l.selection));
      return original?allRows.find(r=>r.id===original.id):null;});
      const states=legs.map(l=>l?.state||'DISPUTED');
      return {id:c.id,businessDate:c.businessDate,minimum:c.minimum,legs:legs.map(l=>l?{id:l.id,state:l.state,resultEventId:l.resultEventId}:null),
        state:states.includes('DISPUTED')?'DISPUTED':states.includes('VOID')?'VOID':states.includes('PENDING')?'PENDING':states.every(s=>s==='WON')?'WON':'LOST'};
    }),rows};
}
module.exports={VERSION,seal,valid,schedule,slots,devig,leader,compatible,label,pick,chooseTiers,review};
