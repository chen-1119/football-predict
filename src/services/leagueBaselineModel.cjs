'use strict';
// Distinct, research-only trained model format. Never re-label this as the
// dynamic-goal V3 artifact or infer formal calibration from a fitted model.
const crypto=require('node:crypto');
const {stableStringify}=require('../../scripts/modelLearningLedger.cjs');
const {epochNanoseconds:clock}=require('./prematchV3Clock.cjs');
const VERSION='league-trained-baseline-v1',FORECAST_VERSION='league-trained-forecast-v1';
const LEAGUES=['br1','fi1'],KEY=l=>'league-baseline-'+l;
const hash=v=>crypto.createHash('sha256').update(stableStringify(v)).digest('hex');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const seal=v=>({...v,contentHash:hash(v)});
const check=(ok,code)=>{if(!ok)throw Object.assign(Error('LEAGUE_MODEL_'+code),{code:'LEAGUE_MODEL_'+code});};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=x=>typeof x==='string'&&x.length>0&&x.length<=200&&x===x.trim()&&!/[\u0000-\u001f\ufffd]/.test(x);
function verifyPacket(p,asOf){
  try{
    check(p&&p.version===VERSION&&LEAGUES.includes(p.league)&&p.researchOnly===true&&p.formalEligible===false,'SCHEMA');
    const {contentHash,...body}=p;check(hex(contentHash)&&hash(body)===contentHash,'HASH');
    check(clock(p.createdAt)!==null&&clock(p.availableAt)!==null&&clock(asOf)!==null
      &&clock(p.createdAt)<=clock(p.availableAt)&&clock(p.availableAt)<clock(asOf),'CLOCK');
    check(hex(p.reportSha256)&&hex(p.historySha256)&&hex(p.parametersHash)&&hash(p.parameters)===p.parametersHash,'PARAMETER_BINDING');
    const m=p.parameters,q=m?.poisson,n=q?.teams?.length;
    check(Number.isInteger(n)&&n>=2&&n<=128&&q.teams.every(text)&&new Set(q.teams).size===n,'TEAMS');
    check(['attack','defense'].every(k=>Array.isArray(q[k])&&q[k].length===n&&q[k].every(v=>finite(v)&&Math.abs(v)<=5))
      &&finite(q.homeIntercept)&&finite(q.awayIntercept)&&Math.abs(q.homeIntercept)<=5&&Math.abs(q.awayIntercept)<=5
      &&q.converged===true&&finite(q.gradientNorm)&&q.gradientNorm>=0&&q.gradientNorm<1e-5,'PARAMETERS');
    // Mixed Elo/Poisson HAD cannot be presented as one score distribution.
    // This first coherent adapter accepts the actually selected pure Poisson.
    check(m.poissonWeight===1&&Number.isSafeInteger(m.trainingRows)&&m.trainingRows>=300
      &&/^\d{4}-\d{2}-\d{2}$/.test(m.through)&&hex(m.inputHash),'MODEL_SCOPE');
    check(clock(m.through+'T23:59:59Z')<clock(p.createdAt),'TRAINING_CLOCK');
    const v=p.validation;check(v?.kind==='chronological-statistical-holdout'&&v.formalEligible===false
      &&Number.isSafeInteger(v.testRows)&&v.testRows>=100&&finite(v.brier)&&finite(v.logLoss)&&v.brier>=0&&v.logLoss>=0
      &&finite(v.baselineBrier)&&finite(v.baselineLogLoss)
      &&v.brier<v.baselineBrier&&v.logLoss<v.baselineLogLoss,'HOLDOUT');
    check(Array.isArray(p.bindings)&&p.bindings.length<=128,'BINDINGS');
    const ids=new Set(),names=new Set();
    for(const b of p.bindings){
      check(text(b.teamId)&&text(b.teamName)&&text(b.leagueId)&&q.teams.includes(b.modelTeam)
        &&text(b.reviewId)&&clock(b.reviewedAt)!==null&&clock(b.reviewedAt)<=clock(p.createdAt)
        &&Array.isArray(b.evidence)&&b.evidence.length>=1&&b.evidence.length<=4
        &&b.evidence.every(e=>text(e.url)&&/^https:\/\//.test(e.url)&&hex(e.sha256)),'BINDING_REVIEW');
      const id=b.leagueId+':'+b.teamId, name=b.leagueId+':'+b.modelTeam;
      check(!ids.has(id)&&!names.has(name),'BINDING_DUPLICATE');ids.add(id);names.add(name);
    }
    return {valid:true,blockers:[]};
  }catch(e){return {valid:false,blockers:[/^LEAGUE_MODEL_/.test(e.code||'')?e.code:'LEAGUE_MODEL_INVALID']};}
}
function project(parameters,home,away,line){
  const q=parameters.poisson,h=q.teams.indexOf(home),a=q.teams.indexOf(away);check(h>=0&&a>=0&&h!==a,'UNTRAINED_TEAM');
  const clamp=x=>Math.min(4.5,Math.max(.15,x));
  const homeLambda=clamp(Math.exp(q.homeIntercept+q.attack[h]+q.defense[a]));
  const awayLambda=clamp(Math.exp(q.awayIntercept+q.attack[a]+q.defense[h]));
  const hp=[Math.exp(-homeLambda)],ap=[Math.exp(-awayLambda)];
  for(let i=1;i<=20;i++){hp.push(hp[i-1]*homeLambda/i);ap.push(ap[i-1]*awayLambda/i);}
  const rows=[];let mass=0;for(let i=0;i<=20;i++)for(let j=0;j<=20;j++){const probability=hp[i]*ap[j];rows.push({home:i,away:j,probability});mass+=probability;}
  check(mass>1-1e-6,'GRID_TAIL');
  const had={'1':0,X:0,'2':0},hhad={'1':0,X:0,'2':0},totals={'0':0,'1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7+':0};
  const lineValid=Number.isSafeInteger(line)&&line!==0&&Math.abs(line)<=5;
  for(const r of rows){r.probability/=mass;const d=r.home-r.away;had[d>0?'1':d<0?'2':'X']+=r.probability;
    if(lineValid)hhad[d+line>0?'1':d+line<0?'2':'X']+=r.probability;
    totals[r.home+r.away>=7?'7+':String(r.home+r.away)]+=r.probability;}
  return {homeLambda,awayLambda,had,hhad:lineValid?{line,probabilities:hhad}:null,totals,
    scoreTop3:rows.sort((a,b)=>b.probability-a.probability||a.home-b.home||a.away-b.away).slice(0,3),tailMass:1-mass};
}
function forecast(packet,match,{asOf,cutoffAt,inputHash}={}){
  const verified=verifyPacket(packet,asOf);check(verified.valid,'PACKET_INVALID');
  check(typeof match.sourceMatchId==='string'&&/^(?:sporttery_)?[1-9][0-9]{0,15}$/.test(match.sourceMatchId)
    &&text(match.homeTeamId)&&text(match.awayTeamId)&&text(match.homeTeamName)&&text(match.awayTeamName)
    &&/^\d{4}-\d{2}-\d{2}$/.test(match.businessDate||'')
    &&new Date(Date.parse(match.businessDate+'T00:00:00Z')).toISOString().slice(0,10)===match.businessDate,'EVENT_IDENTITY');
  check(clock(cutoffAt)!==null&&clock(match.eventVersion)!==null&&clock(asOf)<clock(cutoffAt)
    &&clock(cutoffAt)<=clock(match.eventVersion)&&match.status==='SCHEDULED'&&match.isOnSale!==false
    &&!['CLOSED','STOPPED','SUSPENDED'].includes(String(match.saleStatus||'').toUpperCase())
    &&match.resultDisposition!=='VOID'&&hex(inputHash),'EVENT');
  check(match.neutral!==true,'NEUTRAL_VENUE_UNSUPPORTED');
  const find=(id,name)=>packet.bindings.filter(b=>b.leagueId===String(match.leagueId)
    &&b.teamId===id&&b.teamName===name);
  const h=find(match.homeTeamId,match.homeTeamName),a=find(match.awayTeamId,match.awayTeamName);
  check(h.length===1&&a.length===1&&h[0].teamId!==a[0].teamId,'TEAM_MAPPING_MISSING');
  const grid=project(packet.parameters,h[0].modelTeam,a[0].modelTeam,match.handicapLine);
  const ranked=Object.entries(grid.had).sort((a,b)=>b[1]-a[1]);
  return seal({version:FORECAST_VERSION,scope:'prospective-league-baseline-reference',formalEligible:false,
    modelVersion:packet.version,modelHash:packet.contentHash,parametersHash:packet.parametersHash,
    validationHash:hash(packet.validation),bindingHash:hash([h[0],a[0]]),league:packet.league,
    event:{sourceMatchId:String(match.sourceMatchId).replace(/^sporttery_/,''),eventVersion:match.eventVersion,
      businessDate:match.businessDate,homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId},
    asOf,cutoffAt,inputHash,grid,direction:ranked[0][1]-ranked[1][1]>1e-12?ranked[0][0]:null,
    optionalFactorsUsed:[],venue:'nominal-home-away;neutral-not-verified',marketProbabilityInput:false});
}
module.exports={VERSION,FORECAST_VERSION,LEAGUES,KEY,hash,sha,seal,check,verifyPacket,project,forecast};
