'use strict';
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const NOW=Date.parse('2026-09-17T10:00:00Z');
const publication=now=>({generationId:'generation-test',manifestHash:'a'.repeat(64),committedAt:new Date(now).toISOString()});
function match(id=1,now=NOW,patch={}){
 const base=withVerifiedInputEvidence({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:'2026-09-17',status:'SCHEDULED',homeTeamId:`h${id}`,awayTeamId:`a${id}`,homeTeamName:`主队${id}`,awayTeamName:`客队${id}`,leagueId:'test',kickoffTime:'2026-09-17T15:00:00Z',eventVersion:'2026-09-17T15:00:00Z',probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString(),predictions:[{marketType:'BEST',tipCode:'WATCH',recommendationAction:'reference'}]});
 // Explicit patches remain authoritative, including invalid/missing model
 // evidence used by negative tests. Do not silently repair a patched model.
 return {...base,...patch};
}
const validators={isFinal:r=>r.testOfficial===true&&r.status==='FINISHED',isVoid:r=>r.testOfficial===true&&r.resultDisposition==='VOID'};
let memoryTrust;
function memoryTrustPair(){
  if(memoryTrust)return memoryTrust;
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  memoryTrust=require('../src/services/collectorAttestation.cjs').createCollectorKeyPair({keyId:'memory-opening-fixture',independenceDomain:'synthetic-memory'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-memory-trust-')),file=path.join(dir,'registry.json');
  fs.writeFileSync(file,JSON.stringify(memoryTrust.registry),{flag:'wx'});
  const old=process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=file;
  process.once('exit',()=>{
    if(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH===file){
      if(old===undefined)delete process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;else process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=old;
    }
    fs.unlinkSync(file);fs.rmdirSync(dir);
  });
  return memoryTrust;
}
function memoryPorts(){
  let now=NOW,state={decisions:[],combos:[],results:[],lanes:{},issues:[],view:null};
  const calls=[],faults=new Set();let current=[1,2,3].map(id=>match(id)),history=[];
  // This port models new publication inputs. Pure match()/makeDecision fixtures
  // above deliberately retain the original historical validation contract.
  const {derivedTeamId}=require('../scripts/storedResultTeamIdentity.cjs');
  const attestation=require('../src/services/collectorAttestation.cjs');
  const pair=memoryTrustPair();
  const normalize=row=>{
    if(!row||typeof row!=='object')return row;
    const next=structuredClone(row),input=next.prospectiveForecastInput||next,id=String(input.sourceMatchId||'');
    if(input.homeTeamId==='h'+id)input.homeTeamId=derivedTeamId(input.homeTeamName);
    if(input.awayTeamId==='a'+id)input.awayTeamId=derivedTeamId(input.awayTeamName);
    if(next.prospectiveForecastInput){
      if(next.homeTeamId==='h'+id)next.homeTeamId=derivedTeamId(next.homeTeamName);
      if(next.awayTeamId==='a'+id)next.awayTeamId=derivedTeamId(next.awayTeamName);
    }
    input.matchNo=input.matchNo||'周四'+id.padStart(3,'0');
    if(Number.isFinite(Date.parse(input.eventVersion||input.kickoffTime)))input.eventVersion=new Date(Date.parse(input.eventVersion||input.kickoffTime)).toISOString();
    return next;
  };
  const snapshots=rows=>{
    const {SPORTTERY_CURRENT_URL,SPORTTERY_CALCULATOR_URL}=require('../scripts/sportteryEndpointContract.cjs');
    const inputs=rows.filter(r=>r&&typeof r==='object').map(r=>r.prospectiveForecastInput||r);
    const quoteTimes=inputs.map(m=>Date.parse(m.oddsReceivedAt||m.oddsUpdatedAt)).filter(Number.isFinite);
    const acquiredAt=quoteTimes.length?Math.max(...quoteTimes):now;
    const members=inputs.map(m=>{
      const event=new Date(Date.parse(m.eventVersion)+8*3600000).toISOString(),suspended=m.isOnSale===false||m.saleStatus==='SUSPENDED';
      return {matchId:Number(m.sourceMatchId),businessDate:m.businessDate,matchDate:event.slice(0,10),matchTime:event.slice(11,19),matchNumStr:m.matchNo,
        homeTeamAllName:m.homeTeamName,awayTeamAllName:m.awayTeamName,matchStatus:m.status==='SCHEDULED'?'Selling':'Finished',sellStatus:suspended?2:1,
        oddsList:[...(m.odds?[{poolCode:'HAD',h:m.odds.odds1,d:m.odds.oddsX,a:m.odds.odds2,goalLine:''}]:[]),
          ...(m.handicapOdds?[{poolCode:'HHAD',h:m.handicapOdds.odds1,d:m.handicapOdds.oddsX,a:m.handicapOdds.odds2,goalLine:m.handicapLine}]:[])],
        poolList:['HAD','HHAD'].map(poolCode=>({poolCode,poolStatus:'Selling',cbtValue:suspended?2:1,cbtAllUp:suspended?0:1,bettingAllup:suspended?0:1}))};
    });
    const list=[...new Map(members.map(row=>[hash(row),row])).values()],groups=new Map();
    for(const row of list){const all=groups.get(row.businessDate)||[];all.push(row);groups.set(row.businessDate,all);}
    return {endpoints:[['current',SPORTTERY_CURRENT_URL],['calculator',SPORTTERY_CALCULATOR_URL]].map(([method,url])=>{
      const payload={success:true,value:{matchInfoList:[...groups].map(([businessDate,subMatchList])=>({businessDate,subMatchList}))}},requestedAt=new Date(acquiredAt-500).toISOString(),receivedAt=new Date(acquiredAt).toISOString();
      const e={method,page:null,ok:true,url,requestedAt,receivedAt,sourceCycleId:'synthetic-memory-'+acquiredAt,payload,
        sourceRequest:{method:'GET',url,page:null,role:method},httpStatus:200,contentType:'application/json',rawSha256:'b'.repeat(64),rawBytes:500,headersSha256:'a'.repeat(64)};
      e.canonicalPayloadSha256=attestation.sha256CollectorJson(payload);
      const commitment=attestation.buildCollectorCommitment({endpoint:e.sourceRequest,collectorCycleId:e.sourceCycleId,requestedAt,receivedAt,
        response:{httpStatus:200,contentType:e.contentType,rawSha256:e.rawSha256,rawBytes:500,headersSha256:e.headersSha256},payload,canonicalPayloadSha256:e.canonicalPayloadSha256});
      e.collectorAttestation=attestation.signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});return e;
    })};
  };
  current=current.map(normalize);
  const ports={clock:()=>now,calls,faults,get state(){return state;},set now(v){now=v;},get now(){return now;},set current(v){current=v.map(normalize);},set history(v){history=v;},get current(){return current;},
    async transaction(lane,action){
      calls.push(['transaction',lane]);if(faults.has(lane))throw Object.assign(new Error('Injected lane failure'),{code:'INJECTED'});
      let data=structuredClone(state);
      const invoke=name=>{calls.push([name,lane]);if(faults.has(name))throw Object.assign(new Error('Injected storage failure'),{code:'STORAGE_FAILED'});};
      const repo={
        trustRegistry:pair.registry,
        async lane(k){return structuredClone(data.lanes[k]||null);},async saveLane(k,v){invoke('saveLane');data.lanes[k]=structuredClone(v);},async lanes(){return structuredClone(data.lanes);},
        async publication(){invoke('publication');return publication(now);},async current(){invoke('current');return structuredClone(current);},
        async currentInputs(startedAt){
          invoke('current');const normalized=current.map(normalize),snapshot=snapshots(normalized),hhad={},had={};
          const withHhad=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs').joinOfficialHandicap(normalized,snapshot,{now,trustRegistry:pair.registry,audit:hhad});
          const joined=require('../scripts/recommendationPlatform/liveOfficialHad.cjs').joinOfficialHad(withHhad,snapshot,{now,trustRegistry:pair.registry,audit:had});
          const next=require('../src/services/sportteryOpeningPolicy.cjs').filterNewOpeningMarkets(joined.current,snapshot,
            {asOf:new Date(now).toISOString(),trustRegistry:pair.registry});
          return {...joined,current:next,inputKnowledgeAt:new Date(now).toISOString(),...(hhad.reasonCounts['hhad-applied']?{inputCapture:{version:'current-input-capture-v2',startedAt:new Date(startedAt).toISOString(),capturedAt:new Date(now).toISOString(),
            currentHash:hash(current),marketSignalHash:hash(snapshot),joinedInputHash:hash(next),officialHandicap:hhad,officialHad:had}}:{})};
        },
        async insertDecision(d){invoke('insertDecision');if(faults.has(`match:${d.sourceMatchId}`))throw new Error('Injected item failure');
          const old=data.decisions.find(v=>v.decisionId===d.decisionId);if(old)return structuredClone(old);
          data.decisions.push(structuredClone(d));return structuredClone(d);},
        async decisions(ids){invoke('decisions');return structuredClone(data.decisions.filter(d=>ids.includes(d.decisionId)));},
        async latest(){invoke('latest');const map=new Map();for(const d of data.decisions)map.set(JSON.stringify([d.sourceMatchId,d.eventVersion]),d);return structuredClone([...map.values()]);},
        async frozenCombos(date){invoke('frozenCombos');return structuredClone(data.combos.filter(c=>!date||c.businessDate===date));},
        async insertCombo(c){invoke('insertCombo');if(data.combos.some(x=>x.businessDate===c.businessDate&&x.size===c.size))return false;data.combos.push(structuredClone(c));return true;},
        async history(){invoke('history');return history.map(normalize);},async resultHeads(){invoke('resultHeads');const map=new Map();for(const e of data.results)map.set(e.eventKey,e);return structuredClone([...map.values()]);},
        async appendResult(e){invoke('appendResult');if(!data.results.some(r=>r.eventId===e.eventId))data.results.push(structuredClone(e));},
        async issue(lane,issue){data.issues.push({lane,...issue});},async saveView(v){invoke('saveView');data.view=structuredClone(v);},
        async savepoint(action){const before=structuredClone(data);try{return {value:await action()};}catch(error){data=before;return {error};}},
      };
      const value=await action(repo);state=data;return value;
    }
  };return ports;
}
module.exports={NOW,match,publication,validators,memoryPorts};
