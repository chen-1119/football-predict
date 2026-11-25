'use strict';
const policy=require('./reviewedAnalysis.cjs');
const evidence=require('./reviewedResearchEvidence.cjs');
const official=require('./reviewedOfficialEvent.cjs');
const VERSION='evidence-first-editorial-v1';
const check=(value,code)=>{if(!value)throw Object.assign(Error('RESEARCH_DECISION_'+code),{code:'RESEARCH_DECISION_'+code});};
const exact=(value,keys)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(','),'FIELDS');
const direction=(score,line)=>score[0]+line===score[1]?'d':score[0]+line>score[1]?'h':'a';
function choose(packet,choice,chosenAt){
 exact(choice,['market','handicap','selection','scores','reason','confidence','basisIds','comboAllowed']);
 const assessment=evidence.assess(packet,chosenAt);
 check(evidence.clock(chosenAt)<evidence.clock(packet.event.kickoff),'ALREADY_STARTED');
 check(['HAD','HHAD'].includes(choice.market)&&['h','d','a'].includes(choice.selection)
  &&(choice.market==='HAD'?choice.handicap===null:Number.isSafeInteger(choice.handicap)&&choice.handicap!==0&&Math.abs(choice.handicap)<=12),'MARKET');
 check(Array.isArray(choice.scores)&&choice.scores.length===2&&new Set(choice.scores.map(score=>JSON.stringify(score))).size===2
  &&choice.scores.every(score=>Array.isArray(score)&&score.length===2&&score.every(goal=>Number.isInteger(goal)&&goal>=0&&goal<=15)&&direction(score,choice.handicap||0)===choice.selection),'SCORES');
 check(evidence.text(choice.reason,500)&&['高','中','低'].includes(choice.confidence)&&typeof choice.comboAllowed==='boolean','CHOICE');
 check(Array.isArray(choice.basisIds)&&choice.basisIds.length>0&&choice.basisIds.length<=32&&new Set(choice.basisIds).size===choice.basisIds.length
  &&choice.basisIds.every(id=>assessment.fields.some(field=>['dual-source','single-primary'].includes(field.status)&&field.observationIds.includes(id))),'BASIS');
 check(assessment.directionEligible,'INSUFFICIENT_OR_CONFLICTING_EVIDENCE');
 return policy.seal({version:VERSION,event:structuredClone(packet.event),evidenceHash:packet.contentHash,chosenAt,choice:structuredClone(choice),assessmentHash:assessment.contentHash,
  confidence:assessment.coreComplete&&assessment.availabilityComplete?choice.confidence:'低',limitations:assessment.limitations,
  comboEligible:choice.comboAllowed&&choice.confidence!=='低'&&assessment.comboEligible,modelProbability:null,expectedValue:null,formalEligible:false});
}
function validateDirection(record,packet){
 check(record?.version===VERSION&&record.evidenceHash===packet?.contentHash,'DIRECTION_BINDING');
 check(policy.hash(choose(packet,record.choice,record.chosenAt))===policy.hash(record),'DIRECTION_REPLAY');return true;
}
function validateDirectionShape(record){
 exact(record,['version','event','evidenceHash','chosenAt','choice','assessmentHash','confidence','limitations','comboEligible','modelProbability','expectedValue','formalEligible','contentHash']);
 const {contentHash,...body}=record;check(record.version===VERSION&&policy.hash(body)===contentHash&&/^[a-f0-9]{64}$/.test(record.evidenceHash)&&/^[a-f0-9]{64}$/.test(record.assessmentHash),'DIRECTION_BINDING');
 evidence.event(record.event);evidence.clock(record.chosenAt);
 exact(record.choice,['market','handicap','selection','scores','reason','confidence','basisIds','comboAllowed']);
 check(['高','中','低'].includes(record.confidence)&&typeof record.comboEligible==='boolean'&&Array.isArray(record.limitations)&&record.limitations.length<=40&&record.limitations.every(item=>evidence.text(item,200))
  &&record.modelProbability===null&&record.expectedValue===null&&record.formalEligible===false,'DIRECTION_BINDING');
}
function validateResearchDraft(draft,asOf){
 check(draft?.version===5&&draft.strategy===VERSION&&draft.research?.version===VERSION,'VERSION');
 const research=draft.research;
 exact(research,['version','directions','evidenceKeys']);
 check(Array.isArray(research.directions)&&research.directions.length>0&&research.directions.length<=32&&Array.isArray(research.evidenceKeys)&&research.evidenceKeys.length===research.directions.length
  &&new Set(research.evidenceKeys).size===research.evidenceKeys.length&&research.evidenceKeys.every(key=>/^team-evidence-[a-f0-9]{64}$/.test(key)),'BOUND');
 check(Buffer.byteLength(JSON.stringify(draft))<=512*1024&&new Set(research.directions.map(record=>record.event.eventId)).size===research.directions.length&&Array.isArray(draft.singles),'BOUND');
 for(const record of research.directions){
  validateDirectionShape(record);check(research.evidenceKeys.includes('team-evidence-'+record.evidenceHash),'EVIDENCE_BINDING');
  check(evidence.clock(record.chosenAt)<=evidence.clock(draft.frozenAt),'DIRECTION_CLOCK');
  const rows=draft.singles.filter(row=>row.eventId===record.event.eventId);check(rows.length===1,'ROW_BINDING');const row=rows[0];
  for(const key of ['eventId','matchNum','businessDate','kickoff','teams','orderedTeamIds'])check(policy.hash(row[key])===policy.hash(record.event[key]),'ROW_BINDING');
  for(const key of ['market','handicap','selection','scores','reason'])check(policy.hash(row[key])===policy.hash(record.choice[key]),'ROW_BINDING');
  check(row.confidence===record.confidence,'ROW_BINDING');
 }
 check(draft.singles.length===research.directions.length,'ROW_BINDING');
 policy.validateDraft({...draft,version:4},asOf);return true;
}
function make(draft,context){
 validateResearchDraft(draft,context.asOf);
 check(Buffer.byteLength(JSON.stringify({draft,snapshot:context.snapshot,evidenceByEvent:context.evidenceByEvent}))<=8*1024*1024,'PUBLICATION_INPUT_BOUND');
 const legacy={...draft,version:4};delete legacy.strategy;delete legacy.research;
 const publication=official.make(legacy,{...context,evidenceByEvent:{}});
 const records=publication.records.map(record=>{
  const frozen=draft.research.directions.find(item=>item.event.eventId===record.eventId),packets=context.evidenceByEvent?.[record.eventId];
  check(Array.isArray(packets)&&packets.length===1,'ARCHIVED_EVIDENCE_REQUIRED');const packet=packets[0];validateDirection(frozen,packet);
  const page=packet.sources.find(source=>source.id===packet.observations.find(item=>item.id===frozen.choice.basisIds[0]).sourceId);
  check(draft.singles.find(row=>row.eventId===record.eventId).analysisUrl===page.url,'ROW_BINDING');
  const assessment=evidence.assess(packet,context.asOf);
  check(assessment.directionEligible,'EVIDENCE_EXPIRED');
  for(const page of context.snapshot.endpoints.filter(item=>['current','calculator'].includes(item.method)))check(evidence.clock(page.requestedAt)>=evidence.clock(frozen.chosenAt),'QUOTE_PRECEDES_DIRECTION');
  const current=context.snapshot.endpoints.find(item=>item.method==='current'),quoted=current.payload.value.matchInfoList.flatMap(group=>group.subMatchList).find(row=>String(row.matchId)===record.eventId);
  const pool=quoted.oddsList.find(item=>item.poolCode===record.market),inverse=Object.fromEntries(['h','d','a'].map(selection=>[selection,1/Number(pool[selection])])),total=inverse.h+inverse.d+inverse.a;
  const marketBaseline={kind:'normalized-inverse-sp',market:record.market,handicap:record.market==='HHAD'?record.handicap:null,probabilities:Object.fromEntries(['h','d','a'].map(selection=>[selection,inverse[selection]/total]))};
  return {...record,strategy:VERSION,confidence:assessment.coreComplete&&assessment.availabilityComplete?record.confidence:'低',
   limitations:[...new Set([...frozen.limitations,...assessment.limitations])],comboEligible:frozen.comboEligible&&assessment.comboEligible,
   research:{version:VERSION,evidenceHash:packet.contentHash,directionHash:frozen.contentHash,chosenAt:frozen.chosenAt,assessmentHash:assessment.contentHash,
    coreComplete:assessment.coreComplete,availabilityComplete:assessment.availabilityComplete,lineupsConfirmed:assessment.lineupsConfirmed,comboPolicy:assessment.comboPolicy,
    sourceCount:assessment.independentSourceCount,verification:'human-reviewed-literal-evidence'},marketBaseline,modelProbability:null,expectedValue:null,formalEligible:false};
 });
 const {contentHash,...body}=publication;void contentHash;
 return policy.seal({...body,strategy:VERSION,draftHash:policy.hash(draft),records,modelProbability:null,expectedValue:null,formalEligible:false});
}
function prepare(research,context){
 exact(research,['directions','evidence']);check(Array.isArray(research.directions)&&research.directions.length>0&&research.directions.length<=32
  &&Array.isArray(research.evidence)&&research.evidence.length===research.directions.length,'BOUND');
 const singles=research.directions.map(record=>{
  const packet=research.evidence.find(item=>item.contentHash===record.evidenceHash);validateDirection(record,packet);
  const current=context.snapshot?.endpoints?.filter(item=>item.method==='current');check(current?.length===1,'CURRENT');
  const rows=current[0].payload?.value?.matchInfoList?.flatMap(group=>group.subMatchList)?.filter(row=>String(row.matchId)===record.event.eventId);check(rows?.length===1,'EVENT');
  const pools=rows[0].oddsList?.filter(pool=>pool.poolCode===record.choice.market);check(pools?.length===1,'POOL');
  const page=packet.sources.find(source=>source.id===packet.observations.find(item=>item.id===record.choice.basisIds[0]).sourceId);
  return {...record.event,market:record.choice.market,handicap:record.choice.handicap,selection:record.choice.selection,scores:record.choice.scores,
   reason:record.choice.reason,confidence:record.confidence,analysisUrl:page.url,sp:Number(pools[0][record.choice.selection]),
   modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'};
 });
 const businessDate=singles[0]?.businessDate;
 const original={version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate,frozenAt:context.asOf,
  singles:singles.map(({classification,...row})=>{void classification;return row;})};
 const originalArchive=JSON.stringify(original);
 const draft={version:5,strategy:VERSION,eventAuthority:official.VERSION,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',businessDate,
  frozenAt:context.asOf,singles,originalArchive,originalArchiveSha256:policy.sha(originalArchive),research:{version:VERSION,directions:structuredClone(research.directions),evidenceKeys:research.evidence.map(packet=>'team-evidence-'+packet.contentHash)}};
 make(draft,{...context,evidenceByEvent:Object.fromEntries(research.evidence.map(packet=>[packet.event.eventId,[packet]]))});return draft;
}
module.exports={VERSION,choose,validateDirection,validateDraft:validateResearchDraft,validateResearchDraft,prepare,make};
