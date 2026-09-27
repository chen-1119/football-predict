'use strict';
const crypto = require('node:crypto');
const VERSION = 'football-source-evidence-v1';
const PROVIDERS = Object.freeze({
  'football-data.org': { origin:'https://api.football-data.org', attribution:'football-data.org', daily:240, minute:8, delayMs:8000 },
  openligadb: { origin:'https://api.openligadb.de', attribution:'OpenLigaDB · ODbL', daily:300, minute:8, delayMs:8000 },
  'met-norway': { origin:'https://api.met.no', attribution:'MET Norway · CC BY 4.0', daily:300, minute:8, delayMs:8000 },
});
const LEAGUES = Object.freeze([
  {code:'PL', names:['英超','英格兰超级联赛','Premier League']},
  {code:'ELC', names:['英冠','英格兰冠军联赛','Championship']},
  {code:'PD', names:['西甲','西班牙甲级联赛','Primera Division','La Liga']},
  {code:'BL1', olg:'bl1', names:['德甲','德国甲级联赛','Bundesliga']},
  {code:null, olg:'bl2', names:['德乙','德国乙级联赛','2. Bundesliga']},
  {code:null, olg:'bl3', names:['德丙','3. Liga']},
  {code:'SA', names:['意甲','意大利甲级联赛','Serie A']},
  {code:'FL1', names:['法甲','法国甲级联赛','Ligue 1']},
  {code:'PPL', names:['葡超','葡萄牙超级联赛','Primeira Liga']},
  {code:'DED', names:['荷甲','荷兰甲级联赛','Eredivisie']},
  {code:'BSA', names:['巴甲','巴西甲级联赛','Campeonato Brasileiro Série A']},
  {code:'CL', names:['欧冠','欧洲冠军联赛','UEFA Champions League']},
]);
const text = v => typeof v === 'string' ? v.trim() : '';
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const id = v => (typeof v === 'string' || typeof v === 'number') && /^[1-9]\d{0,15}$/.test(String(v)) ? String(v) : null;
const norm = v => text(v).normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
function instant(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const day=v.slice(0,10), check=Date.parse(day+'T00:00:00Z');
  if (!Number.isFinite(check) || new Date(check).toISOString().slice(0,10)!==day || +v.slice(11,13)>23 || +v.slice(14,16)>59 || +v.slice(17,19)>59) return null;
  const ms=Date.parse(v); return Number.isFinite(ms)?ms:null;
}
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
const hash = v => crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
function identity(m) {
  const kickoff=instant(m?.kickoffTime), event=instant(m?.eventVersion||m?.kickoffTime);
  if (!/^sporttery_[1-9]\d*$/.test(m?.id||'') || String(m.sourceMatchId)!==m.id.replace(/^sporttery_/, '') || kickoff===null || kickoff!==event
    || !text(m.homeTeamName) || !text(m.awayTeamName) || m.homeTeamName===m.awayTeamName) return null;
  return {matchId:m.id,eventVersion:new Date(event).toISOString(),home:m.homeTeamName,away:m.awayTeamName,
    homeId:m.homeTeamId??null,awayId:m.awayTeamId??null,league:m.leagueName||m.externalSignals?.leagueName||m.leagueId||null};
}
function leagueFor(m) {
  const value=norm(m.leagueName||m.externalSignals?.leagueName||'');
  return LEAGUES.find(l=>l.names.some(n=>norm(n)===value)) || null;
}
function urlFor(job) {
  const base=PROVIDERS[job.provider]?.origin;
  if (!base) throw new Error('unsupported-provider');
  let route='';
  if(job.provider==='football-data.org') {
    if(!LEAGUES.some(l=>l.code&&l.code===job.competition)||!['matches','standings'].includes(job.kind)) throw new Error('unsupported-competition');
    route=`/v4/competitions/${job.competition}/${job.kind}`;
    if(job.kind==='matches') {
      if(![job.from,job.to].every(v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')))throw new Error('invalid-date-range');
      route+=`?dateFrom=${job.from}&dateTo=${job.to}`;
    }
  } else if(job.provider==='openligadb') {
    if(!['bl1','bl2','bl3'].includes(job.competition)||!Number.isInteger(job.season)||job.season<2000||job.season>2100||job.kind!=='matches') throw new Error('unsupported-competition');
    route=`/getmatchdata/${job.competition}/${job.season}`;
  } else {
    if(job.kind!=='weather'||number(job.lat)===null||number(job.lon)===null||Math.abs(job.lat)>90||Math.abs(job.lon)>180)throw new Error('invalid-venue');
    route=`/weatherapi/locationforecast/2.0/compact?lat=${job.lat.toFixed(4)}&lon=${job.lon.toFixed(4)}`;
  }
  return base+route;
}
function plan(matches, now, {footballDataKey='', venueBindings=[]}={}) {
  if(!Number.isFinite(now)||!Array.isArray(matches))throw new Error('invalid-input');
  const jobs=new Map(), states=[]; const from=new Date(now-120*86400000).toISOString().slice(0,10),to=new Date(now+2*86400000).toISOString().slice(0,10);
  const add=j=>{j.url=urlFor(j);j.key=hash(j.url);jobs.set(j.key,j);};
  for(const m of matches){
    const ident=identity(m),start=instant(m?.kickoffTime);
    if(!ident||m.status!=='SCHEDULED'||start<=now||start>now+48*3600000||m.resultDisposition==='VOID')continue;
    const league=leagueFor(m);
    if(league?.code&&footballDataKey) for(const kind of ['matches','standings'])add({provider:'football-data.org',kind,competition:league.code,from,to,ttlMs:kind==='matches'?1800000:6*3600000});
    if(league?.olg){const date=new Date(start);add({provider:'openligadb',kind:'matches',competition:league.olg,season:date.getUTCFullYear()-(date.getUTCMonth()<6?1:0),ttlMs:1800000});}
    const venues=venueBindings.filter(v=>v.matchId===m.id&&instant(v.eventVersion)===instant(ident.eventVersion)&&v.verified===true);
    if(venues.length===1){const v=venues[0];add({provider:'met-norway',kind:'weather',lat:v.lat,lon:v.lon,ttlMs:3600000});}
    states.push({matchId:m.id,base:league?league.code&&!footballDataKey&&!league.olg?'credentials-missing':'scheduled':'unsupported-league',weather:venues.length===1?'scheduled':'venue-unverified'});
  }
  return {jobs:[...jobs.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.url.localeCompare(b.url)),states};
}
function retryAt(headers, now, fallbackMs) {
  const raw=headers?.get?.('retry-after');
  if(!raw)return now+fallbackMs;
  const when=/^\d+$/.test(raw.trim())?now+Number(raw)*1000:Date.parse(raw);
  return Number.isFinite(when)?Math.max(now+fallbackMs,when):now+fallbackMs;
}
module.exports={VERSION,PROVIDERS,LEAGUES,text,number,integer,id,norm,instant,hash,identity,leagueFor,urlFor,plan,retryAt};
