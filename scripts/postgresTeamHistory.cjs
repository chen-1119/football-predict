'use strict';
// Bounded, read-only live model input. Never creates an aggregate/backtest seed.
const {createHash}=require('node:crypto');
const {normalizeEntity}=require('./historicalEventStore.cjs');
const {resultObservationForMatch}=require('./asOfResultTimeline.cjs');
const VERSION='postgres-team-history-v1';
const stamp=value=>{const n=Date.parse(value instanceof Date?value.toISOString():value||'');return Number.isFinite(n)?n:null;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const regular=row=>row.source_key==='football-data-co-uk'&&row.payload?.sourceDataset==='football-data.co.uk:results-csv';
// syncData supplies raw Home/AwayTeam fields before its public normalization.
// Match the builders' TeamName -> Team -> Name precedence without mutating
// the source row, its clocks or its identity/provenance fields.
function normalizeHistoryMatch(match){
 return{...match,homeTeamName:match?.homeTeamName||match?.homeTeam||match?.homeName||'',awayTeamName:match?.awayTeamName||match?.awayTeam||match?.awayName||''};
}
function projectRows(rows,{asOf,teamKey}){
 const at=stamp(asOf);if(at===null)throw new TypeError('An explicit history as-of is required');
 const groups=new Map(),rejected={};const reject=reason=>{rejected[reason]=(rejected[reason]||0)+1;};
 for(const row of rows){
  const observed=Math.max(stamp(row.observed_at)??Infinity,stamp(row.event_observed_at)??Infinity,stamp(row.available_at)??Infinity,stamp(row.ingest_completed_at)??Infinity);
  const date=String(row.match_date instanceof Date?row.match_date.toISOString().slice(0,10):row.match_date||'').slice(0,10);
  const kickoff=stamp(row.kickoff_time),eventAt=kickoff??stamp(date+'T23:59:59.999Z');
  const home=teamKey(row.home_name),away=teamKey(row.away_name);
  if(!regular(row)){reject('score-period-unverified');continue;}
  if(row.conflicted){reject('conflicting-result');continue;}
  if(!home||!away||home===away||eventAt===null||observed>at||observed<=eventAt||eventAt>=at){reject('identity-or-clock');continue;}
  if(!Number.isSafeInteger(row.home_goals)||!Number.isSafeInteger(row.away_goals)||row.home_goals<0||row.away_goals<0
    ||row.payload?.score?.home!==row.home_goals||row.payload?.score?.away!==row.away_goals){reject('invalid-score');continue;}
  const key=[date,home,away].join('|'),entry={row,key,date,eventAt,observed,home,away};const group=groups.get(key)||[];group.push(entry);groups.set(key,group);
 }
 const matches=[];
 for(const [key,group]of groups){
  if(new Set(group.map(({row})=>row.home_goals+':'+row.away_goals)).size!==1){reject('conflicting-score');continue;}
  // Same event can occur under several source/competition IDs. Count once.
  const chosen=group.sort((a,b)=>a.observed-b.observed||String(a.row.observation_id).localeCompare(String(b.row.observation_id)))[0];
  const {row,date,eventAt,observed,home,away}=chosen;
  const proof={version:VERSION,matchId:row.match_id,observationId:row.observation_id,sourceKey:row.source_key,eventSha256:row.event_sha256,
    observedAt:new Date(observed).toISOString(),sourceObservedAt:new Date(stamp(row.observed_at)).toISOString(),eventObservedAt:new Date(stamp(row.event_observed_at)).toISOString(),availableAt:new Date(stamp(row.available_at)).toISOString(),
    dateOnly:stamp(row.kickoff_time)===null,scorePeriod:'REGULAR_TIME',eventKey:key};
  matches.push({id:'pg-history:'+hash(key),sourceMatchId:'pg-history:'+hash(key),homeTeamName:home,awayTeamName:away,kickoffTime:new Date(eventAt).toISOString(),matchDate:date,status:'FINISHED',scoreHome:row.home_goals,scoreAway:row.away_goals,resultObservedAt:proof.observedAt,resultObservationSource:'postgres-history:'+row.source_key,postgresTeamHistory:proof});
 }
 matches.sort((a,b)=>Date.parse(a.kickoffTime)-Date.parse(b.kickoffTime)||a.sourceMatchId.localeCompare(b.sourceMatchId));
 return {matches,rejected,duplicateRows:rows.length-matches.length-Object.values(rejected).reduce((a,b)=>a+b,0)};
}
async function loadPostgresTeamHistory({pool,matches,asOf,teamKey,perTeamLimit=120,lookbackDays=1095}={}){
 if(typeof teamKey!=='function'||stamp(asOf)===null)throw new TypeError('teamKey and explicit asOf required');
 if(!Number.isInteger(perTeamLimit)||perTeamLimit<1||perTeamLimit>200||!Number.isInteger(lookbackDays)||lookbackDays<1||lookbackDays>1826)throw new RangeError('History query bounds invalid');
 const requests=new Map();for(const input of matches||[]){const match=normalizeHistoryMatch(input);for(const side of ['home','away']){const name=match[side+'TeamName'],key=teamKey(name);if(!key)continue;const values=requests.get(key)||new Set();for(const value of [name,match[side+'TeamNameEn'],key])if(value)values.add(normalizeEntity(value));requests.set(key,values);}}
 if(requests.size>256)throw new RangeError('Too many current teams for one model cycle');
 const requestRows=[...requests].map(([key,names])=>({key,names:[...names]}));if(!requestRows.length)return{matches:[],summary:{version:VERSION,asOf,teams:[],acceptedMatches:0}};
 const own=!pool;if(own)pool=require('../server/postgresStore.cjs').createPostgresPool({max:1,min:0,applicationName:'live-model-team-history'});
 let client;
 try{
  client=await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='12000ms'");
  const teams=(await client.query(`WITH requested AS (SELECT key,names FROM jsonb_to_recordset($1::jsonb) AS q(key text,names jsonb))
    SELECT DISTINCT requested.key,t.team_id,t.scope,t.display_name,t.normalized_name FROM requested JOIN football.historical_teams t
    ON t.normalized_name IN (SELECT jsonb_array_elements_text(requested.names)) OR EXISTS
    (SELECT 1 FROM football.historical_team_aliases a JOIN football.data_sources s USING(source_key)
     WHERE a.team_id=t.team_id AND s.enabled AND a.mapping_status IN ('exact','verified') AND a.first_seen_at<=$2::timestamptz
       AND a.normalized_alias IN (SELECT jsonb_array_elements_text(requested.names)))`,[JSON.stringify(requestRows),asOf])).rows;
  const byKey=new Map();for(const team of teams){const ids=byKey.get(team.key)||new Set();ids.add(team.team_id);byKey.set(team.key,ids);}
  const resolved=teams.filter(team=>byKey.get(team.key).size===1),ids=[...new Set(resolved.map(team=>team.team_id))];
  const rows=ids.length?(await client.query(`WITH selected AS (
    SELECT DISTINCT candidates.match_id FROM unnest($1::text[]) AS wanted(team_id) CROSS JOIN LATERAL (
      (SELECT m.match_id,m.match_date FROM football.historical_matches m WHERE m.home_team_id=wanted.team_id AND m.match_date BETWEEN ($2::timestamptz::date-$3::integer) AND $2::timestamptz::date ORDER BY m.match_date DESC,m.match_id LIMIT $4)
      UNION ALL (SELECT m.match_id,m.match_date FROM football.historical_matches m WHERE m.away_team_id=wanted.team_id AND m.match_date BETWEEN ($2::timestamptz::date-$3::integer) AND $2::timestamptz::date ORDER BY m.match_date DESC,m.match_id LIMIT $4)
    ) candidates)
    SELECT m.match_id,m.match_date::text,m.kickoff_time,m.home_team_id,m.away_team_id,h.display_name AS home_name,a.display_name AS away_name,
      r.observation_id,r.source_key,r.home_goals,r.away_goals,r.available_at,r.observed_at,e.observed_at AS event_observed_at,e.event_sha256,e.payload,i.completed_at AS ingest_completed_at,
      EXISTS(SELECT 1 FROM football.data_source_conflicts c WHERE c.match_id=m.match_id AND c.detected_at<=$2::timestamptz AND (c.resolved_at IS NULL OR c.resolved_at>$2::timestamptz)) AS conflicted
    FROM selected JOIN football.historical_matches m USING(match_id) JOIN football.historical_teams h ON h.team_id=m.home_team_id JOIN football.historical_teams a ON a.team_id=m.away_team_id
    JOIN football.historical_result_observations r USING(match_id) JOIN football.historical_source_events e ON e.source_key=r.source_key AND e.source_event_id=r.source_event_id AND e.match_id=m.match_id
    JOIN football.data_sources s ON s.source_key=r.source_key JOIN football.data_ingest_runs i ON i.run_id=e.ingest_run_id
    WHERE s.enabled AND i.status='completed' AND r.observed_at<=$2::timestamptz AND e.observed_at<=$2::timestamptz AND r.available_at<=$2::timestamptz AND i.completed_at<=$2::timestamptz
    ORDER BY m.match_date DESC,m.match_id,r.observation_id`,[ids,asOf,lookbackDays,perTeamLimit+1])).rows:[];
  const projected=projectRows(rows,{asOf,teamKey}),wantedKeys=new Set(requests.keys()),selected=new Set(),teamSummary=[];
  for(const key of wantedKeys){const mapping=!byKey.has(key)?'missing':byKey.get(key).size!==1?'ambiguous':'exact';const history=mapping==='exact'?projected.matches.filter(m=>m.homeTeamName===key||m.awayTeamName===key):[],keep=history.slice(-perTeamLimit);keep.forEach(m=>{selected.add(m.sourceMatchId);(m.postgresTeamHistory.selectedForKeys ||= []).push(key);});teamSummary.push({key,mapping,availableWindowMatches:history.length,selectedMatches:keep.length,truncated:history.length>perTeamLimit});}
  const accepted=projected.matches.filter(m=>selected.has(m.sourceMatchId));
  const summary={version:VERSION,asOf,perTeamLimit,lookbackDays,acceptedMatches:accepted.length,queryRows:rows.length,rejected:projected.rejected,duplicateRows:projected.duplicateRows,teams:teamSummary,
    ratingScope:'bounded-window-with-preserved-per-team-seed; opponent history may be incomplete',observationPolicy:'max(result observation, source observation, available time, completed ingestion)<=forecastAt',inputHash:hash(accepted.map(m=>[m.sourceMatchId,m.resultObservedAt,m.scoreHome,m.scoreAway,m.postgresTeamHistory.eventSha256,m.postgresTeamHistory.selectedForKeys]))};
  await client.query('ROLLBACK');return{matches:accepted,summary};
 }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});throw error;}finally{if(client)client.release();if(own)await pool.end();}
}
function seedCutoff(team,feature){
 const initialized=feature==='elo'?team?.latestElo!==null&&team?.latestElo!==undefined&&Number.isFinite(Number(team.latestElo))&&Number(team.latestElo)>=800&&Number(team.latestElo)<=2400:Array.isArray(team?.recent)&&team.recent.length>0;
 if(!initialized)return null;
 if(feature==='elo')return stamp(team.eloUpdatedAt?String(team.eloUpdatedAt).slice(0,10)+'T23:59:59.999Z':null);
 const recent=(team.recent||[]).map(row=>stamp(row.kickoffTime)).filter(n=>n!==null),declared=stamp(team.lastMatchDate?String(team.lastMatchDate).slice(0,10)+'T23:59:59.999Z':null);
 return recent.length?Math.max(...recent):declared;
}
function createLiveHistoryOptions({history,targets,existing=[],training=null,asOf,teamKey}){
 const at=stamp(asOf);if(at===null)throw new TypeError('asOf required');
 const covered=new Set((history.summary?.teams||[]).filter(t=>t.selectedMatches>0).map(t=>t.key));
 const live=(targets||[]).map(normalizeHistoryMatch).filter(m=>stamp(m.kickoffTime)>at&&!m.predictionMeta?.lockedAt&&m.status!=='FINISHED'&&[teamKey(m.homeTeamName),teamKey(m.awayTeamName)].some(k=>covered.has(k))).map(m=>({...m,predictionMeta:{...m.predictionMeta,generatedAt:new Date(at).toISOString()}}));
 const teams={...training?.teams},seedPolicy=[];for(const item of history.summary?.teams||[]){if(!item.selectedMatches||!teams[item.key])continue;const original=teams[item.key],cutoff=seedCutoff(original,'elo'),retain=cutoff!==null&&cutoff>=at-(history.summary.lookbackDays||1095)*86400000&&cutoff<at;teams[item.key]={...original,latestElo:retain?original.latestElo:null,matches:retain&&Number.isSafeInteger(original.eloMatches)?original.eloMatches:0,recent:[...(original.recent||[])].filter(row=>stamp(row.kickoffTime)<at).sort((a,b)=>stamp(a.kickoffTime)-stamp(b.kickoffTime))};seedPolicy.push({key:item.key,elo:retain?'retained-dated-baseline':'window-from-1500',eloCutoff:retain?new Date(cutoff).toISOString():null,seedEloCount:teams[item.key].matches,formCutoff:seedCutoff(original,'form')===null?null:new Date(seedCutoff(original,'form')).toISOString()});}
 const liveTraining=training?{...training,teams}:null;
 const eventKey=m=>[m.postgresTeamHistory?m.matchDate:new Date(stamp(m.kickoffTime)).toISOString().slice(0,10),teamKey(m.homeTeamName),teamKey(m.awayTeamName)].join('|');
 const grouped=new Map();const admissible=[];for(const input of [...existing,...history.matches]){const match=normalizeHistoryMatch(input),kickoff=stamp(match.kickoffTime);let observation=match.postgresTeamHistory?{observedMs:stamp(match.resultObservedAt),observedAt:match.resultObservedAt,source:match.resultObservationSource,fallback:false}:resultObservationForMatch(match);if(match.status!=='FINISHED'||kickoff===null||kickoff>=at||observation?.fallback||!Number.isFinite(observation?.observedMs)||observation.observedMs>at||observation.observedMs<=kickoff)continue;admissible.push({match,observation});}
 const pair=m=>[teamKey(m.homeTeamName),teamKey(m.awayTeamName)].join('|'),existingByPair=new Map();for(const {match}of admissible){if(match.postgresTeamHistory)continue;const rows=existingByPair.get(pair(match))||[];rows.push(match);existingByPair.set(pair(match),rows);}
 let ambiguousDateOverlap=0;for(const entry of admissible){const {match}=entry;if(match.postgresTeamHistory?.dateOnly&&(existingByPair.get(pair(match))||[]).some(other=>eventKey(other)!==eventKey(match)&&Math.abs(stamp(other.kickoffTime)-stamp(match.kickoffTime))<172800000)){ambiguousDateOverlap++;continue;}const key=eventKey(match),rows=grouped.get(key)||[];rows.push(entry);grouped.set(key,rows);}
 const results=[];for(const rows of grouped.values()){if(new Set(rows.map(({match})=>match.scoreHome+':'+match.scoreAway)).size!==1)continue;results.push(rows.sort((a,b)=>a.observation.observedMs-b.observation.observedMs)[0]);}results.sort((a,b)=>stamp(a.match.kickoffTime)-stamp(b.match.kickoffTime)||a.match.sourceMatchId.localeCompare(b.match.sourceMatchId));
 const requested=new Map((history.summary?.teams||[]).map(t=>[t.key,t.mapping]));
 const shouldApplyPair=match=>!match.postgresTeamHistory||[teamKey(match.homeTeamName),teamKey(match.awayTeamName)].every(key=>!requested.has(key)||requested.get(key)==='exact');
 const shouldApply=(feature,match,key)=>{const team=liveTraining?.teams?.[key];if(match.postgresTeamHistory&&requested.has(key)&&(requested.get(key)!=='exact'||match.postgresTeamHistory.selectedForKeys&&!match.postgresTeamHistory.selectedForKeys.includes(key)))return false;if(feature==='form'&&(team?.recent||[]).some(row=>[String(row.kickoffTime).slice(0,10),row.homeKey,row.awayKey].join('|')===eventKey(match)))return false;const cutoff=seedCutoff(team,feature);return cutoff===null||stamp(match.kickoffTime)>cutoff;};
 const timeline=(_,{onResult,onForecast})=>{for(const {match,observation}of results)onResult(match,observation);for(const match of live)onForecast(match,{forecastAt:new Date(at).toISOString(),forecastMs:at,appliedResults:results.length});};
 const warehouseHistory={...history.summary,liveOnly:true,appliedUniqueResults:results.length,ambiguousDateOverlap,seedPolicy};
 const historyForMatch=match=>{const keys=new Set([teamKey(match.homeTeamName),teamKey(match.awayTeamName)]);return{version:VERSION,inputHash:history.summary.inputHash,asOf,liveOnly:true,ratingScope:history.summary.ratingScope,perTeamLimit:history.summary.perTeamLimit,lookbackDays:history.summary.lookbackDays,teams:(history.summary.teams||[]).filter(t=>keys.has(t.key)),seedPolicy:seedPolicy.filter(t=>keys.has(t.key))};};
 return{matches:live,training:liveTraining,timeline,shouldApply,shouldApplyPair,chronologicalForm:true,warehouseHistory,historyForMatch,asOf};
}
module.exports={VERSION,projectRows,loadPostgresTeamHistory,seedCutoff,createLiveHistoryOptions};
