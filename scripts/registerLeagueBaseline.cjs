'use strict';
const fs=require('node:fs'),path=require('node:path');
const model=require('../src/services/leagueBaselineModel.cjs');
const {inspect}=require('./prepareLeagueModelRegistration.cjs');
const historySource=require('./collectLeagueTextHistory.cjs');
function build(historyPath,reportPath,league,bindings=[],preparedAt=new Date().toISOString()){
  const read=p=>{model.check(fs.statSync(p).size<=16*1024*1024,'INPUT_BOUND');return fs.readFileSync(p);};
  const historyBytes=read(historyPath),reportBytes=read(reportPath),history=JSON.parse(historyBytes),report=JSON.parse(reportBytes);
  // This replays fitting and verifies the exact report/implementation binding.
  inspect(historyBytes,reportBytes);
  const rows=[],seen=new Set();
  model.check(Array.isArray(history.files)&&history.files.length<=32,'SOURCE_FILES');
  for(const f of history.files){
    const s=historySource.SOURCES[f.league];model.check(s&&f.commit===s.commit&&f.url===historySource.url(s.repo,s.commit,f.file)
      &&path.basename(f.saved)===f.saved&&!seen.has(f.saved),'SOURCE_IDENTITY');seen.add(f.saved);
    const raw=read(path.join(path.dirname(historyPath),f.saved));model.check(raw.length===f.bytes&&model.sha(raw)===f.sha256,'SOURCE_BYTES');
    if(f.file==='LICENSE.md')model.check(raw.toString().startsWith('CC0 1.0 Universal'),'SOURCE_LICENSE');
    if(f.file.endsWith('.txt'))rows.push(...historySource.parseHistory(raw,{league:f.league,season:Number(path.basename(f.file).slice(0,4)),receivedAt:f.receivedAt}).rows.map(r=>({...r,sourceSha256:f.sha256,sourceUrl:f.url})));
  }
  model.check(historySource.hash(JSON.stringify(rows))===historySource.hash(JSON.stringify(history.rows)),'SOURCE_ROWS');
  for(const [l,s]of Object.entries(historySource.SOURCES))model.check(['LICENSE.md','README.md',...s.seasons.map(y=>`${s.directory}/${y}_${l}.txt`)].every(f=>history.files.some(r=>r.league===l&&r.file===f)),'SOURCE_COVERAGE');
  const found=report.reports.filter(r=>r.league===league);model.check(found.length===1&&found[0].statisticalGatePassed,'HOLDOUT_BLOCKED');
  const r=found[0],createdAt=preparedAt;
  model.check(Number.isFinite(Date.parse(createdAt))&&Date.parse(createdAt)<=Date.now(),'PREPARED_CLOCK');
  model.check(Date.parse(report.completedAt)<Date.parse(createdAt)&&history.files.every(f=>Number.isFinite(Date.parse(f.requestedAt))&&Date.parse(f.requestedAt)<=Date.parse(f.receivedAt)&&Date.parse(f.receivedAt)<=Date.parse(report.startedAt)),'FIT_AVAILABILITY');
  const packet=model.seal({version:model.VERSION,league,researchOnly:true,formalEligible:false,createdAt,availableAt:createdAt,
    reportSha256:model.sha(reportBytes),historySha256:model.sha(historyBytes),parameters:r.forwardCandidate,
    parametersHash:model.hash(r.forwardCandidate),bindings,
    validation:{kind:'chronological-statistical-holdout',formalEligible:false,train:'2023',selection:'2024',test:'2025',
      testRows:r.evaluation.mixed.rows,brier:r.evaluation.mixed.brier,logLoss:r.evaluation.mixed.logLoss,
      baselineBrier:r.evaluation.trainingFrequency.brier,baselineLogLoss:r.evaluation.trainingFrequency.logLoss,
      nextPeriod:r.nextSeasonEvaluation,marketCompared:false,historicalAsOfVerified:false},
    sourceFiles:history.files.map(f=>({url:f.url,sha256:f.sha256,receivedAt:f.receivedAt})),
    limitations:['research-only','market-calibration-pending','eight-week-clv-pending','nominal-venue-only','optional-team-factors-not-fitted']});
  model.check(model.verifyPacket(packet,new Date(Date.parse(createdAt)+1).toISOString()).valid,'PACKET_VERIFICATION');return packet;
}
async function main(args){
  model.check(process.versions.node.split('.')[0]==='22','NODE_VERSION');
  const [mode,history,report,league,bindingsPath,output,preparedPath,expected]=args;
  model.check(['--prepare','--apply'].includes(mode)&&args.length===(mode==='--apply'?8:6),'ARGS');
  model.check([history,report,bindingsPath,output].every(path.isAbsolute)&&!fs.existsSync(output),'PATHS');
  model.check(fs.statSync(bindingsPath).size<=256*1024,'BINDING_BOUND');
  let prepared;
  if(mode==='--apply'){model.check(path.isAbsolute(preparedPath)&&fs.statSync(preparedPath).size<=16*1024*1024,'PREPARED_BOUND');prepared=JSON.parse(fs.readFileSync(preparedPath,'utf8')).packet;}
  const packet=build(history,report,league,JSON.parse(fs.readFileSync(bindingsPath,'utf8')),prepared?.createdAt);
  if(mode==='--apply')model.check(model.hash(packet)===model.hash(prepared),'PREPARED_CHANGED');
  const fd=fs.openSync(output,'wx',0o600);let pool;
  try{
    let result={status:'prepared',productionWrites:0,modelHash:packet.contentHash,parametersHash:packet.parametersHash,packet};
    if(mode==='--apply'){
      pool=require('../server/postgresStore.cjs').createPostgresPool({applicationName:'football-league-baseline-registration',max:1});
      result=await require('./leagueBaselineRegistry.cjs').install(packet,{pool,expectedSha256:expected==='absent'?null:expected});
    }
    fs.writeFileSync(fd,JSON.stringify({...result,observedAt:new Date().toISOString()},null,2));
    console.log(JSON.stringify({status:result.status,modelHash:packet.contentHash,parametersHash:packet.parametersHash,output,formalEligible:false}));
  }catch(e){fs.writeFileSync(fd,JSON.stringify({status:'failed-or-unconfirmed',code:e.code||'REGISTRATION_FAILED'}));throw e;}
  finally{fs.closeSync(fd);if(pool)await pool.end();}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.code||'LEAGUE_MODEL_REGISTRATION_FAILED');process.exitCode=1;});
module.exports={build,main};
