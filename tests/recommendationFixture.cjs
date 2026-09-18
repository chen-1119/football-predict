'use strict';
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const NOW=Date.parse('2026-09-17T10:00:00Z');
const publication=now=>({generationId:'generation-test',manifestHash:'a'.repeat(64),committedAt:new Date(now).toISOString()});
function match(id=1,now=NOW,patch={}){return {id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:'2026-09-17',status:'SCHEDULED',homeTeamId:`h${id}`,awayTeamId:`a${id}`,homeTeamName:`主队${id}`,awayTeamName:`客队${id}`,leagueId:'test',kickoffTime:'2026-09-17T15:00:00Z',eventVersion:'2026-09-17T15:00:00Z',probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString(),predictions:[{marketType:'BEST',tipCode:'WATCH',recommendationAction:'reference'}],...patch};}
const validators={isFinal:r=>r.testOfficial===true&&r.status==='FINISHED',isVoid:r=>r.testOfficial===true&&r.resultDisposition==='VOID'};
function memoryPorts(){
  let now=NOW,state={decisions:[],combos:[],results:[],lanes:{},issues:[],view:null};
  const calls=[],faults=new Set();let current=[1,2,3].map(id=>match(id)),history=[];
  const ports={clock:()=>now,calls,faults,get state(){return state;},set now(v){now=v;},get now(){return now;},set current(v){current=v;},set history(v){history=v;},get current(){return current;},
    async transaction(lane,action){
      calls.push(['transaction',lane]);if(faults.has(lane))throw Object.assign(new Error('Injected lane failure'),{code:'INJECTED'});
      let data=structuredClone(state);
      const invoke=name=>{calls.push([name,lane]);if(faults.has(name))throw Object.assign(new Error('Injected storage failure'),{code:'STORAGE_FAILED'});};
      const repo={
        async lane(k){return structuredClone(data.lanes[k]||null);},async saveLane(k,v){invoke('saveLane');data.lanes[k]=structuredClone(v);},async lanes(){return structuredClone(data.lanes);},
        async publication(){invoke('publication');return publication(now);},async current(){invoke('current');return structuredClone(current);},
        async insertDecision(d){invoke('insertDecision');if(faults.has(`match:${d.sourceMatchId}`))throw new Error('Injected item failure');
          const old=data.decisions.find(v=>v.decisionId===d.decisionId);if(old)return structuredClone(old);
          data.decisions.push(structuredClone(d));return structuredClone(d);},
        async decisions(ids){invoke('decisions');return structuredClone(data.decisions.filter(d=>ids.includes(d.decisionId)));},
        async latest(){invoke('latest');const map=new Map();for(const d of data.decisions)map.set(JSON.stringify([d.sourceMatchId,d.eventVersion]),d);return structuredClone([...map.values()]);},
        async frozenCombos(date){invoke('frozenCombos');return structuredClone(data.combos.filter(c=>!date||c.businessDate===date));},
        async insertCombo(c){invoke('insertCombo');if(data.combos.some(x=>x.businessDate===c.businessDate&&x.size===c.size))return false;data.combos.push(structuredClone(c));return true;},
        async history(){invoke('history');return structuredClone(history);},async resultHeads(){invoke('resultHeads');const map=new Map();for(const e of data.results)map.set(e.eventKey,e);return structuredClone([...map.values()]);},
        async appendResult(e){invoke('appendResult');if(!data.results.some(r=>r.eventId===e.eventId))data.results.push(structuredClone(e));},
        async issue(lane,issue){data.issues.push({lane,...issue});},async saveView(v){invoke('saveView');data.view=structuredClone(v);},
        async savepoint(action){const before=structuredClone(data);try{return {value:await action()};}catch(error){data=before;return {error};}},
      };
      const value=await action(repo);state=data;return value;
    }
  };return ports;
}
module.exports={NOW,match,publication,validators,memoryPorts};
