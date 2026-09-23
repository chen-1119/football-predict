'use strict';
const crypto=require('node:crypto');
const {normalizeLeagueRows}=require('./browser.cjs');
const {reconcileMappings}=require('./mapping.cjs');
const {beijingDay,validDay,selectDay}=require('./local-jingcai-day.cjs');
const VERSION='leisu-local-jingcai-v2';
const leagueUrl=value=>typeof value==='string'&&/^https:\/\/www\.leisu\.com\/data\/zuqiu\/comp-[1-9][0-9]*$/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function makePlan(input,now=Date.now()){
 const {roster,leaguePages}=input||{};
 if(roster?.version!==VERSION||!validDay(roster.businessDate)||roster.businessDate!==beijingDay(now)||!iso(roster.readAt)||now-Date.parse(roster.readAt)>30*60000||Date.parse(roster.readAt)>now+60000)throw Error('Read the current official roster before planning');
 if(!Array.isArray(leaguePages)||leaguePages.length>500||leaguePages.some(p=>!leagueUrl(p.sourceUrl)||!Array.isArray(p.rows)))throw Error('Invalid rendered competition pages');
 const fixtures=selectDay(roster.matches,roster.businessDate,now),eligible=fixtures.filter(f=>f.eligible);
 const candidates=leaguePages.flatMap(p=>normalizeLeagueRows(p.rows,p.sourceUrl));
 const mapping=reconcileMappings(eligible,candidates,roster.aliases||{},now),targets=[];
 for(const m of mapping.mappings){
  const official=eligible.find(f=>f.siteMatchId===m.siteMatchId);
  const fixture={...official,providerMatchId:m.providerMatchId,providerHomeName:m.providerHomeName,providerAwayName:m.providerAwayName,sourceUrl:m.sourceUrl};
  for(const kind of ['injuries','lineup'])targets.push({fixture,kind,sourceUrl:`https://live.leisu.com/${kind==='injuries'?'shujufenxi':'detail'}-${m.providerMatchId}`});
 }
 return {version:VERSION,cycleId:crypto.randomUUID(),cycleStartedAt:new Date(now).toISOString(),businessDate:roster.businessDate,
  fixtureInput:roster.fixtureInput,leaguePages:[...new Set(leaguePages.map(p=>p.sourceUrl))],fixtures,
  totalMatches:fixtures.length,eligibleMatches:eligible.length,matchedMatches:mapping.mappings.length,
  unmatched:mapping.unmatched,conflicts:mapping.conflicts,targets,batchSize:12};
}
function coverage(fixtures,states,fixtureInput){
 const latest=new Map();
 for(const state of states)if(['injuries','lineup'].includes(state.kind))latest.set(state.siteMatchId+':'+state.kind,state);
 const matches=fixtures.map(f=>({...f,sections:Object.fromEntries(['injuries','lineup'].map(kind=>[kind,latest.get(f.siteMatchId+':'+kind)||{status:f.eligible?'pending':'ineligible',reason:f.reason||'not-attempted'}]))}));
 const needed=matches.filter(m=>m.eligible).flatMap(m=>Object.values(m.sections));
 return {businessDate:fixtures[0]?.businessDate||null,totalMatches:fixtures.length,eligibleMatches:matches.filter(m=>m.eligible).length,
  requiredTasks:needed.length,attemptedTasks:needed.filter(s=>s.status!=='pending').length,availableTasks:needed.filter(s=>s.status==='available').length,
  collectionComplete:needed.every(s=>s.status!=='pending'),dataComplete:fixtureInput?.state==='fresh'&&needed.every(s=>s.status==='available'),fixtureInput,matches};
}
module.exports={VERSION,leagueUrl,beijingDay,iso,validDay,selectDay,makePlan,coverage};
