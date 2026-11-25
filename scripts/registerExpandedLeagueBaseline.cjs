'use strict';
const fs=require('node:fs'),path=require('node:path');
const model=require('../src/services/leagueBaselineModel.cjs');
const {load}=require('./expandedLeagueTrainingInput.cjs');
const {inspect}=require('./runExpandedLeagueBaselineExperiment.cjs');
function build(historyPath,reportPath,league,bindings=[],preparedAt=new Date().toISOString()){
  model.check(Number.isFinite(Date.parse(preparedAt))&&Date.parse(preparedAt)<=Date.now(),'PREPARED_CLOCK');
  model.check(path.isAbsolute(reportPath)&&fs.statSync(reportPath).size<=16*1024*1024,'INPUT_BOUND');
  const history=load(historyPath,league,preparedAt),reportBytes=fs.readFileSync(reportPath),report=inspect(history,reportBytes,league);
  model.check(Date.parse(report.completedAt)<Date.parse(preparedAt),'FIT_AVAILABILITY');
  const found=report.reports.filter(result=>result.league===league);
  model.check(found.length===1&&found[0].statisticalGatePassed,'HOLDOUT_BLOCKED');
  const result=found[0],packet=model.seal({version:model.VERSION,league,researchOnly:true,formalEligible:false,
    createdAt:preparedAt,availableAt:preparedAt,reportSha256:model.sha(reportBytes),historySha256:history.sha256,
    parameters:result.forwardCandidate,parametersHash:model.hash(result.forwardCandidate),bindings,
    validation:{kind:'chronological-statistical-holdout',formalEligible:false,train:'before-2024',selection:'2024',test:'2025',
      testRows:result.evaluation.mixed.rows,brier:result.evaluation.mixed.brier,logLoss:result.evaluation.mixed.logLoss,
      baselineBrier:result.evaluation.trainingFrequency.brier,baselineLogLoss:result.evaluation.trainingFrequency.logLoss,
      nextPeriod:result.nextSeasonEvaluation,marketCompared:false,historicalAsOfVerified:false},sourceFiles:history.sourceFiles,
    limitations:['research-only','market-calibration-pending','eight-week-clv-pending','nominal-venue-only','optional-team-factors-not-fitted']});
  model.check(model.verifyPacket(packet,new Date(Date.parse(preparedAt)+1).toISOString()).valid,'PACKET_VERIFICATION');
  return packet;
}
async function main(args){
  model.check(process.versions.node.split('.')[0]==='22','NODE_VERSION');
  const [mode,history,report,league,bindingsPath,output,preparedPath,expected]=args;
  model.check(['--prepare','--apply'].includes(mode)&&args.length===(mode==='--apply'?8:6),'ARGS');
  model.check([history,report,bindingsPath,output].every(path.isAbsolute)&&!fs.existsSync(output),'PATHS');
  model.check(fs.statSync(bindingsPath).size<=256*1024,'BINDING_BOUND');
  let prepared;
  if(mode==='--apply'){
    model.check(path.isAbsolute(preparedPath)&&fs.statSync(preparedPath).size<=16*1024*1024,'PREPARED_BOUND');
    prepared=JSON.parse(fs.readFileSync(preparedPath,'utf8')).packet;
  }
  const packet=build(history,report,league,JSON.parse(fs.readFileSync(bindingsPath,'utf8')),prepared?.createdAt);
  if(mode==='--apply')model.check(model.hash(packet)===model.hash(prepared),'PREPARED_CHANGED');
  const descriptor=fs.openSync(output,'wx',0o600);let pool;
  try{
    let result={status:'prepared',productionWrites:0,modelHash:packet.contentHash,parametersHash:packet.parametersHash,packet};
    if(mode==='--apply'){
      pool=require('../server/postgresStore.cjs').createPostgresPool({applicationName:'football-expanded-league-baseline-registration',max:1});
      result=await require('./leagueBaselineRegistry.cjs').install(packet,{pool,expectedSha256:expected==='absent'?null:expected});
    }
    fs.writeFileSync(descriptor,JSON.stringify({...result,observedAt:new Date().toISOString()},null,2));
    console.log(JSON.stringify({status:result.status,modelHash:packet.contentHash,parametersHash:packet.parametersHash,output,formalEligible:false}));
  }catch(error){fs.writeFileSync(descriptor,JSON.stringify({status:'failed-or-unconfirmed',code:error.code||'REGISTRATION_FAILED'}));throw error;}
  finally{fs.closeSync(descriptor);if(pool)await pool.end();}
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.code||'LEAGUE_MODEL_REGISTRATION_FAILED');process.exitCode=1;});
module.exports={build,main};
