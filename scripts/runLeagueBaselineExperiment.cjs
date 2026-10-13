'use strict';
// Chronological statistical holdout on freshly acquired community data. Dates
// define train/test membership, never fabricated historical availability times.
const fs=require('node:fs'),path=require('node:path');
const {hash,parseHistory,url,SOURCES,VERSION:HISTORY_VERSION}=require('./collectLeagueTextHistory.cjs');
const VERSION='league-elo-poisson-experiment-v1', OUTCOMES=['1','X','2'];
const assert=(value,message)=>{if(!value)throw Error(message);};
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
function validateRows(rows) {
  assert(Array.isArray(rows)&&rows.length>0&&rows.length<=10000,'row count');
  const ids=new Set();
  for(const r of rows){
    assert(typeof r.id==='string'&&r.id.length>0&&['br1','fi1'].includes(r.league)&&/^20\d{2}-\d{2}-\d{2}$/.test(r.date)
      && new Date(r.date).toISOString().slice(0,10)===r.date,'date/league');
    assert(typeof r.home==='string'&&typeof r.away==='string'&&r.home!==r.away
      &&r.home.length>0&&r.away.length>0,'teams');
    assert([r.homeGoals,r.awayGoals].every(x=>Number.isInteger(x)&&x>=0&&x<=20),'goals');
    const id=JSON.stringify([r.league,r.date,r.home,r.away]);assert(!ids.has(id),'duplicate event');ids.add(id);
  }
}
function fitPoisson(rows,regularization) {
  const teams=[...new Set(rows.flatMap(r=>[r.home,r.away]))].sort(), idx=new Map(teams.map((t,i)=>[t,i]));
  const a=teams.map(()=>0),d=teams.map(()=>0);
  let homeIntercept=Math.log((rows.reduce((s,r)=>s+r.homeGoals,0)+1)/(rows.length+1));
  let awayIntercept=Math.log((rows.reduce((s,r)=>s+r.awayGoals,0)+1)/(rows.length+1));
  let steps=0,gradientNorm=null;
  for(;steps<5000;steps++){
    const ga=teams.map(()=>0),gd=teams.map(()=>0);let gh=0,gv=0;
    for(const r of rows){const h=idx.get(r.home),v=idx.get(r.away);
      const eh=Math.exp(homeIntercept+a[h]+d[v])-r.homeGoals,ev=Math.exp(awayIntercept+a[v]+d[h])-r.awayGoals;
      gh+=eh;gv+=ev;ga[h]+=eh;gd[v]+=eh;ga[v]+=ev;gd[h]+=ev;
    }
    gh/=rows.length;gv/=rows.length;
    for(let i=0;i<teams.length;i++){ga[i]=ga[i]/rows.length+regularization*a[i]/teams.length;gd[i]=gd[i]/rows.length+regularization*d[i]/teams.length;}
    gradientNorm=Math.sqrt(gh*gh+gv*gv+ga.reduce((s,g)=>s+g*g,0)+gd.reduce((s,g)=>s+g*g,0));
    if(gradientNorm<1e-5)break;
    homeIntercept=clamp(homeIntercept-.15*gh,-2,2);awayIntercept=clamp(awayIntercept-.15*gv,-2,2);
    for(let i=0;i<teams.length;i++){a[i]=clamp(a[i]-.15*ga[i],-1.25,1.25);d[i]=clamp(d[i]-.15*gd[i],-1.25,1.25);}
    const ma=a.reduce((s,x)=>s+x,0)/a.length,md=d.reduce((s,x)=>s+x,0)/d.length;
    // Recentring preserves both log-rate equations exactly.
    for(let i=0;i<a.length;i++){a[i]-=ma;d[i]-=md;}
    homeIntercept+=ma+md;awayIntercept+=ma+md;
  }
  return {teams,attack:a,defense:d,homeIntercept,awayIntercept,regularization,steps,gradientNorm,converged:gradientNorm<1e-5};
}
function fitElo(rows){
  const ratings={},counts={};let drawCount=0;
  const ordered=[...rows].sort((a,b)=>a.date.localeCompare(b.date));
  for(const day of [...new Set(ordered.map(r=>r.date))]){
    const deltas={};
    for(const r of ordered.filter(r=>r.date===day)){
      const h=ratings[r.home]??1500,a=ratings[r.away]??1500;
      const expected=1/(1+10**((a-h-55)/400));const actual=r.homeGoals===r.awayGoals?.5:r.homeGoals>r.awayGoals?1:0;
      const delta=18*(actual-expected);deltas[r.home]=(deltas[r.home]||0)+delta;deltas[r.away]=(deltas[r.away]||0)-delta;
      counts[r.home]=(counts[r.home]||0)+1;counts[r.away]=(counts[r.away]||0)+1;drawCount+=actual===.5?1:0;
    }
    for(const [t,delta]of Object.entries(deltas))ratings[t]=(ratings[t]??1500)+delta;
  }
  return {ratings,counts,drawRate:(drawCount+1)/(rows.length+3),k:18,homeAdvantage:55};
}
function fit(rows,regularization){
  assert([.05,.2].includes(regularization),'unsupported regularization');
  validateRows(rows);assert(new Set(rows.map(r=>r.league)).size===1,'one league per fit');
  const frequencies={1:1,X:1,2:1};for(const r of rows)frequencies[r.homeGoals>r.awayGoals?'1':r.homeGoals<r.awayGoals?'2':'X']++;
  for(const k of OUTCOMES)frequencies[k]/=rows.length+3;
  return {poisson:fitPoisson(rows,regularization),elo:fitElo(rows),frequencies,trainingRows:rows.length,
    through:rows.map(r=>r.date).sort().at(-1),inputHash:hash(JSON.stringify([...rows].sort((a,b)=>a.id.localeCompare(b.id))))};
}
function projection(model,home,away,poissonWeight){
  assert(Number.isFinite(poissonWeight)&&poissonWeight>=0&&poissonWeight<=1,'invalid mixture');
  const p=model.poisson,h=p.teams.indexOf(home),a=p.teams.indexOf(away);
  const lh=clamp(Math.exp(p.homeIntercept+(p.attack[h]??0)+(p.defense[a]??0)),.15,4.5);
  const la=clamp(Math.exp(p.awayIntercept+(p.attack[a]??0)+(p.defense[h]??0)),.15,4.5);
  const hp=[Math.exp(-lh)],ap=[Math.exp(-la)];for(let i=1;i<=20;i++){hp.push(hp[i-1]*lh/i);ap.push(ap[i-1]*la/i);}
  const poisson={1:0,X:0,2:0};let mass=0;
  for(let i=0;i<hp.length;i++)for(let j=0;j<ap.length;j++){const v=hp[i]*ap[j];poisson[i>j?'1':i<j?'2':'X']+=v;mass+=v;}
  for(const k of OUTCOMES)poisson[k]/=mass;
  const e=model.elo,homeExpected=1/(1+10**(((e.ratings[away]??1500)-(e.ratings[home]??1500)-e.homeAdvantage)/400));
  const draw=Math.min(e.drawRate,2*Math.min(homeExpected,1-homeExpected)*.99);
  const elo={1:homeExpected-draw/2,X:draw,2:1-homeExpected-draw/2};
  const probabilities=Object.fromEntries(OUTCOMES.map(k=>[k,poissonWeight*poisson[k]+(1-poissonWeight)*elo[k]]));
  return {probabilities,poisson,elo,homeLambda:lh,awayLambda:la,coldStart:h<0||a<0};
}
function metrics(rows,model,weight,constant=false){
  let brier=0,logLoss=0,hits=0,coldStarts=0;
  for(const r of rows){const forecast=projection(model,r.home,r.away,weight),p=constant?model.frequencies:forecast.probabilities;
    const actual=r.homeGoals>r.awayGoals?'1':r.homeGoals<r.awayGoals?'2':'X';
    const pick=[...OUTCOMES].sort((a,b)=>p[b]-p[a])[0];hits+=pick===actual?1:0;coldStarts+=forecast.coldStart?1:0;
    for(const k of OUTCOMES)brier+=(p[k]-(k===actual?1:0))**2;logLoss-=Math.log(Math.max(1e-12,p[actual]));
  }
  return {rows:rows.length,hits,accuracy:rows.length?hits/rows.length:null,brier:rows.length?brier/rows.length:null,
    logLoss:rows.length?logLoss/rows.length:null,coldStarts};
}
function experiment(rows){
  validateRows(rows);const reports=[];
  for(const league of [...new Set(rows.map(r=>r.league))]){
    const selected=rows.filter(r=>r.league===league),train=selected.filter(r=>r.date<'2024-01-01'),
      validation=selected.filter(r=>r.date>='2024-01-01'&&r.date<'2025-01-01'),test=selected.filter(r=>r.date>='2025-01-01'&&r.date<'2026-01-01');
    if(train.length<100||validation.length<100||test.length<100){
      reports.push({league,status:'blocked',reason:'insufficient-chronological-split',
        splitRows:{train:train.length,validation:validation.length,test:test.length},
        coverage:{rows:selected.length,lastDate:selected.map(r=>r.date).sort().at(-1),currentSeasonRows:selected.filter(r=>r.date>='2026-01-01').length},
        statisticalGatePassed:false,formalEligible:false,productionEligible:false});continue;
    }
    const trials=[];
    for(const regularization of [.05,.2]){const model=fit(train,regularization);for(const weight of [0,.25,.5,.75,1])trials.push({regularization,weight,metrics:metrics(validation,model,weight)});}
    // Selection only sees 2024. The 2025 labels never affect this choice/refit.
    const chosen=[...trials].sort((a,b)=>a.metrics.logLoss-b.metrics.logLoss||a.metrics.brier-b.metrics.brier)[0];
    const holdoutModel=fit([...train,...validation],chosen.regularization);
    const evaluation={mixed:metrics(test,holdoutModel,chosen.weight),poisson:metrics(test,holdoutModel,1),
      elo:metrics(test,holdoutModel,0),trainingFrequency:metrics(test,holdoutModel,0,true),market:null};
    const nextSeason=selected.filter(r=>r.date>='2026-01-01'),nextSeasonModel=nextSeason.length?fit([...train,...validation,...test],chosen.regularization):null;
    const nextSeasonEvaluation=nextSeasonModel?{period:'2026-01-01-through-source-coverage',
      trainingThrough:nextSeasonModel.through,trainingInputHash:nextSeasonModel.inputHash,
      mixed:metrics(nextSeason,nextSeasonModel,chosen.weight),trainingFrequency:metrics(nextSeason,nextSeasonModel,0,true),market:null}:null;
    const latestModel=fit(selected,chosen.regularization);
    reports.push({league,status:'evaluated-research',split:{train:'2023',validation:'2024',test:'2025'},selection:chosen,trials,
      evaluation,nextSeasonEvaluation,holdoutModel,forwardCandidate:{...latestModel,poissonWeight:chosen.weight},
      coverage:{rows:selected.length,firstDate:selected.map(r=>r.date).sort()[0],lastDate:latestModel.through,
        currentSeasonRows:selected.filter(r=>r.date>='2026-01-01').length},
      statisticalGatePassed:holdoutModel.poisson.converged&&latestModel.poisson.converged&&evaluation.mixed.brier<evaluation.trainingFrequency.brier&&evaluation.mixed.logLoss<evaluation.trainingFrequency.logLoss,
      formalEligible:false,productionEligible:false});
  }
  return {version:VERSION,reports,historicalAsOfVerified:false,prospectiveValidated:false,marketComparisonAvailable:false,
    scope:'retrospective-chronological-statistical-experiment-not-historical-decision-backtest',
    blockers:['historical-knowledge-clock-unavailable','same-time-market-baseline-unavailable','canonical-entity-mapping-unapproved',
      'prospective-calibration-and-formal-adapter-incomplete'],formalEligible:false,productionWrites:0};
}
function run(input,output){
  assert(path.isAbsolute(input)&&path.isAbsolute(output)&&!fs.existsSync(output),'absolute input and new output required');
  const bytes=fs.readFileSync(input);assert(bytes.length<=16*1024*1024,'oversized input');
  const document=JSON.parse(bytes),{contentHash,...body}=document;
  assert(document.version===HISTORY_VERSION&&hash(JSON.stringify(body))===contentHash,'history hash mismatch');
  const rederived=[],fileNames=new Set();
  for(const file of document.files){
    const source=SOURCES[file.league];assert(source&&file.commit===source.commit&&file.url===url(source.repo,source.commit,file.file),'source identity changed');
    assert(path.basename(file.saved)===file.saved&&!fileNames.has(file.saved),'unsafe or duplicate raw file');fileNames.add(file.saved);
    assert(Number.isFinite(Date.parse(file.requestedAt))&&file.requestedAt<=file.receivedAt&&file.receivedAt<new Date().toISOString(),'receipt clock');
    const raw=fs.readFileSync(path.join(path.dirname(input),file.saved));assert(hash(raw)===file.sha256&&raw.length===file.bytes,'raw history changed');
    if(file.file==='LICENSE.md')assert(raw.toString('utf8').startsWith('CC0 1.0 Universal'),'license mismatch');
    if(file.file.endsWith('.txt'))rederived.push(...parseHistory(raw,{league:file.league,season:Number(path.basename(file.file).slice(0,4)),receivedAt:file.receivedAt}).rows.map(r=>({...r,sourceSha256:file.sha256,sourceUrl:file.url})));
  }
  assert(Object.entries(SOURCES).every(([league,s])=>['LICENSE.md','README.md',...s.seasons.map(y=>`${s.directory}/${y}_${league}.txt`)].every(f=>document.files.some(r=>r.league===league&&r.file===f))),'incomplete collection');
  assert(hash(JSON.stringify(rederived))===hash(JSON.stringify(document.rows)),'rows do not match raw source');
  const startedAt=new Date().toISOString(),report=experiment(document.rows);
  const result={...report,startedAt,completedAt:new Date().toISOString(),inputSha256:hash(bytes),historyContentHash:contentHash,
    implementationSha256:hash(fs.readFileSync(__filename)),parserSha256:hash(fs.readFileSync(require.resolve('./collectLeagueTextHistory.cjs')))};
  result.contentHash=hash(JSON.stringify(result));fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});
  return {output,contentHash:result.contentHash,reports:result.reports.map(r=>({league:r.league,status:r.status,reason:r.reason,splitRows:r.splitRows,coverage:r.coverage,selection:r.selection,evaluation:r.evaluation,nextSeasonEvaluation:r.nextSeasonEvaluation,statisticalGatePassed:r.statisticalGatePassed})),formalEligible:false};
}
if(require.main===module){try{console.log(JSON.stringify(run(process.argv[2],process.argv[3])));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={VERSION,validateRows,fit,projection,metrics,experiment,run};
